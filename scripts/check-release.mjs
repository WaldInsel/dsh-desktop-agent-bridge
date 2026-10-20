import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, lstat, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { VERSION, PACKAGE_NAME } from '../src/protocol.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.name, PACKAGE_NAME);
assert.equal(manifest.version, VERSION);
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.private, true, 'npm publication is intentionally disabled');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' }).split('\0').filter(Boolean);
assert(files.length > 0, 'Initialize the source repository before checking release files');
const forbidden = /(?:^|\/)(?:node_modules|dist|work|artifacts|\.dsh|\.env[^/]*|state\.json|endpoint\.json|host\.lock|client-[^/]*\.json|remote-[^/]*\.json|[^/]*acceptance\.json|[^/]*\.(?:pem|key|p12|pfx|tgz))$/i;
for (const file of new Set(files)) {
  assert(!forbidden.test(file) && !/^(?:dist|work|artifacts|node_modules)\//.test(file),
    `Runtime/generated file in source publication: ${file}`);
  assert(!(await lstat(file)).isSymbolicLink(), `Do not publish symlinks: ${file}`);
  const content = await readFile(file, 'utf8');
  const secrets = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|["']bearer["']\s*:\s*["'][A-Za-z0-9_-]{43,}/;
  assert(!secrets.test(content), `Possible credential in ${file}; review without logging its value`);
  assert(!/[A-Za-z]:[\\/]+Users[\\/]+(?!you[\\/]|example[\\/]|<[^>]+>)[^\\/\s"']+/.test(content),
    `User-specific absolute path in ${file}`);
  if (file.endsWith('.md')) {
    for (const [, link] of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(?:https?:|#|mailto:)/.test(link)) continue;
      const target = link.split('#')[0];
      if (target) await access(resolve(dirname(file), decodeURIComponent(target)));
    }
  }
}
assert(process.env.npm_execpath, 'Run this check with npm run check:release');
const packed = spawnSync(process.execPath,
  [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
assert.equal(packed.status, 0, packed.stderr);
const [archive] = JSON.parse(packed.stdout);
const names = archive.files.map(file => file.path);
const required = ['package.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
  'cordis.patch.yml', 'dist/host.mjs', 'dist/client.mjs', 'dist/mcp.mjs',
  'dist/remote-mcp.mjs', 'dist/THIRD_PARTY_LICENSES.txt',
  'scripts/install-local.mjs', 'scripts/install-support.mjs',
  'scripts/update-local.mjs', 'scripts/uninstall-local.mjs'];
for (const name of required) assert(names.includes(name), `Package missing ${name}`);
for (const name of names) {
  assert(required.includes(name) || /^(?:dist\/[^/]+\.(?:mjs|map)|docs\/[^/]+\.md)$/.test(name),
    `Unexpected package entry: ${name}`);
}
assert(archive.unpackedSize < 25 * 1024 * 1024, 'Unexpected package growth; inspect bundled dependencies');
console.log(JSON.stringify({
  sourceFiles: files.length, packageFiles: names.length, unpackedBytes: archive.unpackedSize,
  version: VERSION, status: 'PASS',
}));
