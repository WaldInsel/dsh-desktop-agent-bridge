import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintain } from '../scripts/install-support.mjs';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const original = '# unrelated settings\r\n- insert:\r\n    - id: other-plugin\r\n      config: { enabled: true }\r\n';

async function fixture(t) {
  // Match the installer's real paths, including Windows TEMP casing and short names.
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-installer-test-')));
  t.after(async () => {
    assert.equal(dirname(resolve(base)), await fs.realpath(tmpdir()));
    assert.match(base, /dsh-installer-test-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  const home = join(base, 'home'), sourceRoot = join(base, 'source');
  const profile = join(home, '.dsh', 'profiles', 'desktop');
  const stateDir = join(home, '.dsh', 'agent-collaboration');
  const target = join(profile, 'node_modules', 'dsh-agent-collaboration');
  const patch = join(profile, 'cordis.patch.yml');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(join(sourceRoot, 'dist'), { recursive: true });
  await fs.writeFile(patch, original);
  await fs.writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'dsh-agent-collaboration', version: '0.1.0' }));
  for (const file of ['host.mjs', 'client.mjs', 'mcp.mjs', 'remote-mcp.mjs']) {
    await fs.writeFile(join(sourceRoot, 'dist', file), `// old ${file}\n`);
  }
  for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await fs.writeFile(join(sourceRoot, file), `fixture ${file}\n`);
  }
  let count = 0;
  return {
    base, home, sourceRoot, profile, stateDir, target, patch,
    run: (operation, options = {}) => maintain(operation, {
      home, sourceRoot, backup: join(base, 'backups', `${operation}-${++count}`), ...options,
    }),
  };
}

async function state(f, value) {
  await fs.mkdir(f.stateDir, { recursive: true });
  await fs.writeFile(join(f.stateDir, 'state.json'), JSON.stringify(value));
}

async function absent(path) {
  await assert.rejects(fs.stat(path), { code: 'ENOENT' });
}

async function unlocked(f) {
  await absent(join(f.profile, '.dsh-agent-collaboration-maintenance.lock'));
  await absent(join(f.stateDir, 'host.lock'));
}

test('fresh install backs up exact configuration, includes licenses, and grants no resources', async t => {
  const f = await fixture(t);
  const result = await f.run('install');
  const patch = await fs.readFile(f.patch, 'utf8');
  assert.ok(patch.startsWith(original));
  assert.equal(patch.match(/id: agent-collaboration/g).length, 1);
  assert.ok(patch.includes(`stateDirectory: ${JSON.stringify(f.stateDir)}`));
  assert.ok(!patch.includes('initialWorkspace'));
  assert.equal(await fs.readFile(join(result.backup, 'cordis.patch.yml'), 'utf8'), original);
  for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.equal(await fs.readFile(join(f.target, file), 'utf8'), `fixture ${file}\n`);
  }
  await absent(join(f.stateDir, 'state.json'));
  await unlocked(f);
});

test('explicit profile and state directories work; update finds configured state without a repeated option', async t => {
  const f = await fixture(t);
  const profile = join(f.base, 'custom-profile'), stateDir = join(f.base, 'custom-state');
  const result = await f.run('install', { profile, stateDir });
  assert.equal(result.stateDirectory, stateDir);
  assert.ok((await fs.readFile(result.config, 'utf8')).includes(JSON.stringify(stateDir)));
  const updated = await f.run('update', { profile });
  assert.equal(updated.stateDirectory, stateDir);
  assert.equal((await fs.readFile(f.patch, 'utf8')), original);
  await absent(f.stateDir);
});

test('initial workspace is explicitly opt-in and must exist', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('install', { initialWorkspace: join(f.base, 'missing') }), { message: /ENOENT/ });
  assert.equal(await fs.readFile(f.patch, 'utf8'), original);
  const workspace = join(f.base, 'project');
  await fs.mkdir(workspace);
  await f.run('install', { initialWorkspace: workspace });
  assert.ok((await fs.readFile(f.patch, 'utf8')).includes(`initialWorkspace: ${JSON.stringify(workspace)}`));
});

test('update replaces package, backs up old files, and preserves config, state and other packages', async t => {
  const f = await fixture(t);
  await f.run('install');
  await state(f, { version: 1, runs: [{ status: 'completed', admission: 'accepted' }], clients: [{ id: 'fixture' }] });
  const savedState = await fs.readFile(join(f.stateDir, 'state.json'));
  const savedConfig = await fs.readFile(f.patch);
  const unrelated = join(f.profile, 'node_modules', 'other-plugin');
  await fs.mkdir(unrelated);
  await fs.writeFile(join(unrelated, 'keep.txt'), 'keep');
  await fs.writeFile(join(f.target, 'dist', 'removed-in-new-release.mjs'), 'old asset');
  await fs.writeFile(join(f.sourceRoot, 'dist', 'host.mjs'), '// new host\n');
  const result = await f.run('update');
  assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// new host\n');
  assert.equal(await fs.readFile(join(result.backup, 'package', 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
  assert.equal(await fs.readFile(join(result.backup, 'package', 'dist', 'removed-in-new-release.mjs'), 'utf8'), 'old asset');
  await absent(join(f.target, 'dist', 'removed-in-new-release.mjs'));
  assert.deepEqual(await fs.readFile(f.patch), savedConfig);
  assert.deepEqual(await fs.readFile(join(f.stateDir, 'state.json')), savedState);
  assert.equal(await fs.readFile(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  await unlocked(f);
});

test('uninstall removes only its managed block and package; retains state and credentials', async t => {
  const f = await fixture(t);
  await f.run('install');
  await state(f, { runs: [] });
  const client = join(f.stateDir, 'client-fixture.json');
  await fs.writeFile(client, '{"fixture":true}\n');
  const result = await f.run('uninstall');
  assert.equal(await fs.readFile(f.patch, 'utf8'), original);
  assert.equal(await fs.readFile(client, 'utf8'), '{"fixture":true}\n');
  assert.equal(await fs.readFile(join(f.stateDir, 'state.json'), 'utf8'), '{"runs":[]}');
  await absent(f.target);
  assert.ok((await fs.stat(join(result.backup, 'package', 'dist', 'host.mjs'))).isFile());
  await unlocked(f);
});

test('all unfinished/uncertain states refuse update and uninstall without changing files', async t => {
  const f = await fixture(t);
  await f.run('install');
  const patch = await fs.readFile(f.patch);
  for (const status of ['preparing', 'queued', 'running', 'waiting_approval', 'waiting_input', 'unknown']) {
    await state(f, { runs: [{ status }] });
    for (const operation of ['update', 'uninstall']) {
      await assert.rejects(f.run(operation), /Unfinished collaboration tasks/);
    }
    assert.deepEqual(await fs.readFile(f.patch), patch);
    assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
  }
  await unlocked(f);
});

test('live endpoint, host lock, and concurrent installer lock are refused', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.stateDir, { recursive: true });
  await fs.writeFile(join(f.stateDir, 'endpoint.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.run('install'), /endpoint is still running/);
  await fs.unlink(join(f.stateDir, 'endpoint.json'));
  await fs.writeFile(join(f.stateDir, 'host.lock'), String(process.pid));
  await assert.rejects(f.run('install'), /Maintenance lock exists/);
  assert.equal(await fs.readFile(join(f.stateDir, 'host.lock'), 'utf8'), String(process.pid));
  await fs.unlink(join(f.stateDir, 'host.lock'));
  const lock = join(f.profile, '.dsh-agent-collaboration-maintenance.lock');
  await fs.writeFile(lock, String(process.pid));
  await assert.rejects(f.run('install'), /Maintenance lock exists/);
  assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
  assert.equal(await fs.readFile(f.patch, 'utf8'), original);
});

test('malformed state and mismatched state directory cannot bypass task checks', async t => {
  const f = await fixture(t);
  await f.run('install');
  await fs.writeFile(join(f.stateDir, 'state.json'), '{broken');
  await assert.rejects(f.run('update'), /Invalid state.json/);
  await assert.rejects(f.run('update', { stateDir: join(f.base, 'wrong-state') }), /does not match/);
  await fs.writeFile(f.patch, (await fs.readFile(f.patch, 'utf8')).replace(/^        stateDirectory:.*\r?\n/m, ''));
  await assert.rejects(f.run('update', { stateDir: join(f.base, 'wrong-state') }), /no stateDirectory/);
});

test('legacy blocks cannot use a different home to bypass their actual state checks', async t => {
  const f = await fixture(t);
  await f.run('install');
  await state(f, { runs: [{ status: 'running' }] });
  const legacy = (await fs.readFile(f.patch, 'utf8')).replace(/^        stateDirectory:.*\r?\n/m,
    `        initialWorkspace: ${JSON.stringify(f.base)}\r\n`);
  await fs.writeFile(f.patch, legacy);
  const fakeHome = join(f.base, 'different-home');
  for (const operation of ['update', 'uninstall']) {
    await assert.rejects(f.run(operation, { home: fakeHome, profile: f.profile }), /no stateDirectory/);
    assert.equal(await fs.readFile(f.patch, 'utf8'), legacy);
    assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
  }
  await absent(fakeHome);
  await unlocked(f);
});

test('managed markers cannot hide other plugins, instructions, duplicate or unknown fields', async t => {
  const f = await fixture(t);
  await f.run('install');
  const installed = await fs.readFile(f.patch, 'utf8');
  const additions = [
    '- insert:\n    - id: other-plugin\n      name: important-plugin\n',
    '    - id: other-plugin\n      name: important-plugin\n',
    '- remove: important-plugin\n',
    '      unknown: true\n',
    '        unknown: true\n',
    '      name: dsh-agent-collaboration\n',
    '        initialWorkspace: &shared-path /project\n',
  ];
  for (const addition of additions) {
    const mixed = installed.replace('# END dsh-agent-collaboration', `${addition}# END dsh-agent-collaboration`);
    await fs.writeFile(f.patch, mixed);
    for (const operation of ['update', 'uninstall']) {
      await assert.rejects(f.run(operation), /Managed block must contain only|Unsupported initialWorkspace/);
      assert.equal(await fs.readFile(f.patch, 'utf8'), mixed);
      assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
    }
  }
  await unlocked(f);
});

test('duplicate/unmanaged configuration and foreign destination packages are preserved', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.patch, `${original}- insert:\n    - id: agent-collaboration\n`);
  await assert.rejects(f.run('install'), /unmanaged plugin entry/);
  await fs.writeFile(f.patch, original);
  await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(join(f.target, 'package.json'), '{"name":"other-package"}');
  await assert.rejects(f.run('install'), /Destination already exists/);
  assert.equal(await fs.readFile(join(f.target, 'package.json'), 'utf8'), '{"name":"other-package"}');
});

test('missing build or license fails before changing the installed package', async t => {
  const f = await fixture(t);
  await f.run('install');
  await fs.unlink(join(f.sourceRoot, 'LICENSE'));
  await assert.rejects(f.run('update'), /Required package file missing: LICENSE/);
  assert.equal(await fs.readFile(join(f.target, 'LICENSE'), 'utf8'), 'fixture LICENSE\n');
  await unlocked(f);
});

test('preexisting backup directory is never reused or overwritten', async t => {
  const f = await fixture(t);
  const backup = join(f.base, 'existing-backup');
  await fs.mkdir(backup);
  await fs.writeFile(join(backup, 'keep.txt'), 'keep');
  await assert.rejects(f.run('install', { backup }), /EEXIST/);
  assert.equal(await fs.readFile(join(backup, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(f.patch, 'utf8'), original);
  await absent(f.target);
});

test('failed package replacement restores original package and configuration', async t => {
  const f = await fixture(t);
  await f.run('install');
  const patch = await fs.readFile(f.patch);
  await fs.writeFile(join(f.sourceRoot, 'dist', 'host.mjs'), '// updated\n');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (String(from).includes('-stage-') && to === f.target) throw new Error('simulated replacement failure');
    return rename(from, to);
  });
  await assert.rejects(f.run('update'), /simulated replacement failure/);
  assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
  assert.deepEqual(await fs.readFile(f.patch), patch);
  await unlocked(f);
});

test('failed configuration commit rolls back installation and uninstall', async t => {
  const f = await fixture(t);
  const rename = fs.rename;
  let failCommit = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (failCommit && to === f.patch) throw new Error('simulated config failure');
    return rename(from, to);
  });
  await assert.rejects(f.run('install'), /simulated config failure/);
  await absent(f.target);
  assert.equal(await fs.readFile(f.patch, 'utf8'), original);
  failCommit = false;
  await f.run('install');
  const installedConfig = await fs.readFile(f.patch);
  failCommit = true;
  await assert.rejects(f.run('uninstall'), /simulated config failure/);
  assert.deepEqual(await fs.readFile(f.patch), installedConfig);
  assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
  await unlocked(f);
});

test('concurrent configuration edit after package swap is preserved while package rolls back', async t => {
  const f = await fixture(t);
  await f.run('install');
  const concurrent = (await fs.readFile(f.patch, 'utf8')) + '# another application saved this\n';
  await fs.writeFile(join(f.sourceRoot, 'dist', 'host.mjs'), '// updated\n');
  const rename = fs.rename;
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (!changed && String(from).includes('-stage-') && to === f.target) {
      changed = true;
      await fs.writeFile(f.patch, concurrent);
    }
  });
  await assert.rejects(f.run('update'), /Concurrent change detected/);
  assert.equal(await fs.readFile(f.patch, 'utf8'), concurrent);
  assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
  await unlocked(f);
});

test('concurrent state write after package swap aborts and preserves the new state', async t => {
  const f = await fixture(t);
  await f.run('install');
  await state(f, { runs: [] });
  const rename = fs.rename;
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (!changed && String(from).includes('-stage-') && to === f.target) {
      changed = true;
      await state(f, { runs: [{ status: 'running' }] });
    }
  });
  await assert.rejects(f.run('update'), /Concurrent change detected/);
  assert.equal(await fs.readFile(join(f.stateDir, 'state.json'), 'utf8'), '{"runs":[{"status":"running"}]}');
  assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
});

test('rollback refuses to overwrite a concurrently edited replacement package', async t => {
  const f = await fixture(t);
  await f.run('install');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (String(from).includes('-stage-') && to === f.target) {
      await fs.writeFile(join(f.target, 'dist', 'host.mjs'), '// concurrent human edit\n');
      await fs.appendFile(f.patch, '# concurrent config\n');
    }
  });
  await assert.rejects(f.run('update'), /automatic rollback would overwrite it/);
  assert.equal(await fs.readFile(join(f.target, 'dist', 'host.mjs'), 'utf8'), '// concurrent human edit\n');
  const preserved = (await fs.readdir(join(f.profile, 'node_modules'))).filter(name => name.includes('-previous-'));
  assert.equal(preserved.length, 1);
  assert.equal(await fs.readFile(join(f.profile, 'node_modules', preserved[0], 'dist', 'host.mjs'), 'utf8'), '// old host.mjs\n');
});

test('CLI supports temporary home and reports bad arguments without using real DSH files', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.sourceRoot, 'scripts'));
  for (const file of ['install-local.mjs', 'update-local.mjs', 'uninstall-local.mjs', 'install-support.mjs']) {
    await fs.copyFile(join(scripts, file), join(f.sourceRoot, 'scripts', file));
  }
  for (const operation of ['install', 'update', 'uninstall']) {
    const result = spawnSync(process.execPath, [join(f.sourceRoot, 'scripts', `${operation}-local.mjs`), '--home', f.home], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).operation, operation);
  }
  const invalid = spawnSync(process.execPath, [join(f.sourceRoot, 'scripts', 'install-local.mjs'), '--home', f.home, '--wat'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid argument/);
  assert.equal(await fs.readFile(f.patch, 'utf8'), original);
});
