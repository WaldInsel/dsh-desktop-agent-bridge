import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { writeLicenseNotices } from './license-notices.mjs';
import { VERSION, PACKAGE_NAME } from '../src/protocol.mjs';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.version, VERSION, 'package.json and protocol version must match');
assert.equal(manifest.name, PACKAGE_NAME, 'The internal plugin name must stay compatible');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const shared = { bundle: true, format: 'esm', sourcemap: true, minify: false, metafile: true };
const results = [];
results.push(await build({
  ...shared, platform: 'node', target: 'node22',
  entryPoints: ['src/host.mjs'], outfile: 'dist/host.mjs',
  external: ['@deepseek-ai/*'],
}));
results.push(await build({
  ...shared, platform: 'node', target: 'node22',
  entryPoints: ['src/mcp.mjs'], outfile: 'dist/mcp.mjs',
  banner: { js: '#!/usr/bin/env node' },
}));
results.push(await build({
  ...shared, platform: 'node', target: 'node22',
  entryPoints: ['src/remote-mcp.mjs'], outfile: 'dist/remote-mcp.mjs',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
}));
results.push(await build({
  ...shared, format: 'cjs', platform: 'browser', target: 'es2022',
  entryPoints: ['src/client.jsx'], outfile: 'dist/client.mjs',
  loader: { '.css': 'text' },
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  jsx: 'automatic',
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-agent-collaboration",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
}));
await writeLicenseNotices(results.map(result => result.metafile));
let loaded;
runInNewContext(await readFile('dist/client.mjs', 'utf8'), {
  window: { __ModuleLoader__: { load: descriptor => { loaded = descriptor; } } },
});
assert.equal(loaded.id, 'dsh-agent-collaboration');
const client = loaded.factory(name => {
  assert(['react', 'react/jsx-runtime'].includes(name), `Unexpected client dependency: ${name}`);
  return {};
});
assert.equal(typeof client.apply, 'function');
assert(client.inject.includes('slots'));
