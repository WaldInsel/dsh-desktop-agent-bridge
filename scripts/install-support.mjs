import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = 'dsh-agent-collaboration';
const begin = `# BEGIN ${plugin}`;
const end = `# END ${plugin}`;
const entries = ['package.json', 'dist', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const finished = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

async function optional(path) {
  try { return await fs.readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function same(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

async function unchanged(path, expected) {
  requireThat(same(await optional(path), expected), `Concurrent change detected: ${path}`);
}

function inside(path, parent) {
  const value = relative(parent, path);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

async function treeHash(path) {
  const hash = createHash('sha256');
  async function visit(current, name) {
    const info = await fs.lstat(current);
    requireThat(!info.isSymbolicLink(), `Symbolic links are not supported in managed package files: ${current}`);
    if (info.isDirectory()) {
      hash.update(`directory:${JSON.stringify(name)}\n`);
      for (const child of (await fs.readdir(current)).sort()) await visit(join(current, child), `${name}/${child}`);
    } else {
      requireThat(info.isFile(), `Unsupported package file: ${current}`);
      const bytes = await fs.readFile(current);
      hash.update(`file:${JSON.stringify(name)}:${bytes.length}\n`).update(bytes);
    }
  }
  try { await visit(path, ''); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return hash.digest('hex');
}

function managedBlock(text, required) {
  const starts = [...text.matchAll(/^# BEGIN dsh-agent-collaboration\r?$/gm)];
  const ends = [...text.matchAll(/^# END dsh-agent-collaboration\r?$/gm)];
  if (!starts.length && !ends.length) {
    requireThat(!required, 'Managed plugin configuration not found.');
    requireThat(!/\b(?:id|name):[^\r\n]*\b(?:agent-collaboration|dsh-agent-collaboration)\b/.test(text),
      'An unmanaged plugin entry exists. Inspect it before installing.');
    return null;
  }
  requireThat(starts.length === 1 && ends.length === 1 && starts[0].index < ends[0].index,
    'Managed plugin markers are duplicated or incomplete.');
  const start = starts[0].index;
  const finish = ends[0].index + ends[0][0].length + (text[ends[0].index + ends[0][0].length] === '\n' ? 1 : 0);
  const block = text.slice(start, finish);
  const invalid = () => { throw new Error('Managed block must contain only one plugin insert with known fields; inspect it manually.'); };
  const physical = block.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < physical.length; i++) {
    let line = physical[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const quoted = /^( {6}name| {8}(?:stateDirectory|initialWorkspace)): "/.exec(line);
    if (quoted) {
      const indentation = quoted[1].length - quoted[1].trimStart().length;
      while ((line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1) {
        const continuation = physical[++i];
        if (!continuation || !new RegExp(`^ {${indentation + 1},}\\S`).test(continuation)) invalid();
        line = line.slice(0, -1) + continuation.trimStart();
      }
    }
    lines.push(line);
  }
  if (lines[0] !== '- insert:' || lines[1] !== '    - id: agent-collaboration') invalid();
  const fields = new Set(), config = new Set();
  let inConfig = false;
  for (const line of lines.slice(2)) {
    const field = /^      (name|disabled|config):(.*)$/.exec(line);
    if (field) {
      const [, key, value] = field;
      if (fields.has(key)) invalid();
      fields.add(key);
      inConfig = key === 'config';
      if (key === 'config' ? value.trim() !== '' : !value.trim()) invalid();
      if (key === 'disabled' && !/^(true|false)$/.test(value.trim())) invalid();
      continue;
    }
    const setting = /^        (stateDirectory|initialWorkspace):\s*(\S.*)$/.exec(line);
    if (!inConfig || !setting || config.has(setting[1])) invalid();
    config.add(setting[1]);
  }
  if (!fields.has('name') || !fields.has('config')) invalid();
  const parsedBlock = lines.join('\n');
  for (const key of ['name', ...config]) scalar(parsedBlock, key);
  const outside = text.slice(0, start) + text.slice(finish);
  requireThat(!/\b(?:id|name):[^\r\n]*\b(?:agent-collaboration|dsh-agent-collaboration)\b/.test(outside),
    'Another plugin entry exists outside the managed block.');
  return { start, finish, block, parsedBlock };
}

function scalar(block, key) {
  const matches = [...block.matchAll(new RegExp(`^\\s+${key}:\\s*([^\\r\\n]+)\\r?$`, 'gm'))];
  requireThat(matches.length <= 1, `Duplicate ${key} in plugin configuration.`);
  if (!matches.length) return undefined;
  const text = matches[0][1].trim();
  if (text.startsWith('"')) {
    try { const value = JSON.parse(text); if (typeof value === 'string') return value; } catch {}
    throw new Error(`Unsupported ${key}; use a plain JSON-quoted string.`);
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  requireThat(!/[#[\]{}&*!|>]/.test(text), `Unsupported ${key}; use a plain JSON-quoted string.`);
  return text;
}

function livePid(pid) {
  requireThat(Number.isSafeInteger(pid) && pid > 0, 'Invalid DSH process marker; inspect it before maintenance.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function noLiveEndpoint(stateDir) {
  const bytes = await optional(join(stateDir, 'endpoint.json'));
  if (!bytes) return;
  let endpoint;
  try { endpoint = JSON.parse(bytes); } catch { throw new Error('Invalid endpoint.json; inspect it before maintenance.'); }
  requireThat(!livePid(endpoint.pid), 'Close DSH before maintenance; its collaboration endpoint is still running.');
}

async function acquireLock(path) {
  let handle;
  try { handle = await fs.open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Maintenance lock exists: ${path}. Close DSH/other maintenance commands; inspect stale locks manually.`);
  }
  try {
    await handle.writeFile(String(process.pid));
    const identity = await handle.stat();
    return {
      async check() {
        const current = await fs.lstat(path);
        requireThat(current.ino === identity.ino && current.dev === identity.dev &&
          (await fs.readFile(path, 'utf8')) === String(process.pid), `Maintenance lock changed: ${path}`);
      },
      async release() {
        try {
          const current = await fs.lstat(path);
          if (current.ino === identity.ino && current.dev === identity.dev &&
              (await fs.readFile(path, 'utf8')) === String(process.pid)) await fs.unlink(path);
        } finally { await handle.close(); }
      },
    };
  } catch (error) { await handle.close(); throw error; }
}

async function atomicConfig(path, expected, bytes) {
  const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await unchanged(path, expected);
    await fs.rename(temp, path);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

// Offline maintenance uses the host's own lock, so a starting host cannot load a half-replaced package.
export async function maintain(operation, options = {}) {
  requireThat(['install', 'update', 'uninstall'].includes(operation), 'Unknown maintenance operation.');
  requireThat(operation === 'install' || !options.initialWorkspace, '--initial-workspace is only supported for install.');
  const home = resolve(options.home ?? homedir());
  const profile = resolve(options.profile ?? join(home, '.dsh', 'profiles', 'desktop'));
  const root = resolve(options.sourceRoot ?? sourceRoot);
  await fs.mkdir(profile, { recursive: true });
  const realProfile = await fs.realpath(profile);
  const patchPath = join(realProfile, 'cordis.patch.yml');
  const modules = join(realProfile, 'node_modules');
  const target = join(modules, plugin);
  const id = randomUUID();
  const stage = join(modules, `.${plugin}-stage-${id}`);
  const previous = join(modules, `.${plugin}-previous-${id}`);
  const locks = [], warnings = [];
  let oldMoved = false, installed = false, committed = false, stageOwned = false, stagedHash, backup;
  try {
    locks.push(await acquireLock(join(realProfile, `.${plugin}-maintenance.lock`)));
    const original = await optional(patchPath);
    const text = original?.toString('utf8') ?? '';
    requireThat(!original || Buffer.from(text).equals(original), 'Configuration must be UTF-8; no files changed.');
    const managed = managedBlock(text, operation !== 'install');
    requireThat(operation !== 'install' || !managed, 'Plugin is already installed; use update-local.mjs.');
    const configuredState = managed && scalar(managed.parsedBlock, 'stateDirectory');
    requireThat(!managed || configuredState,
      'Legacy managed block has no stateDirectory. Close DSH and add its existing absolute stateDirectory under config before maintenance.');
    const defaultState = join(home, '.dsh', 'agent-collaboration');
    requireThat(!configuredState || isAbsolute(configuredState), 'Installed stateDirectory must be an absolute path.');
    const stateDir = resolve(options.stateDir ?? configuredState ?? defaultState);
    if (managed) requireThat(resolve(configuredState) === stateDir,
      '--state-dir does not match the installed configuration.');
    if (managed) {
      const name = scalar(managed.parsedBlock, 'name');
      requireThat(name === plugin || name === pathToFileURL(join(target, 'dist', 'host.mjs')).href,
        'Managed plugin entry points to a different package.');
    }
    backup = resolve(options.backup ?? join(home, '.dsh', 'backups', plugin, `${Date.now()}-${id}`));
    requireThat(!inside(root, target) && !inside(target, root), 'Source and installed package must be separate.');
    requireThat(!inside(stateDir, target) && !inside(target, stateDir), 'State and installed package must be separate.');
    requireThat(!inside(backup, target) && !inside(target, backup) &&
      !inside(backup, stateDir) && !inside(stateDir, backup), 'Backup must be separate from package and state directories.');
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await noLiveEndpoint(stateDir);
    locks.push(await acquireLock(join(stateDir, 'host.lock')));
    const statePath = join(stateDir, 'state.json');
    const stateBytes = await optional(statePath);
    if (stateBytes) {
      let state;
      try { state = JSON.parse(stateBytes); } catch { throw new Error('Invalid state.json; no files changed.'); }
      requireThat(Array.isArray(state.runs) && state.runs.every(run => finished.has(run?.status) && run.admission !== 'dispatching'),
        'Unfinished collaboration tasks exist. Resolve them in DSH before maintenance.');
    }
    const guard = async () => {
      await unchanged(patchPath, original);
      await unchanged(statePath, stateBytes);
      await noLiveEndpoint(stateDir);
      for (const lock of locks) await lock.check();
    };
    await fs.mkdir(modules, { recursive: true });
    requireThat(await fs.realpath(modules) === modules, 'The profile node_modules directory must not be a symbolic link.');
    const oldHash = await treeHash(target);
    requireThat(operation === 'install' ? oldHash === null : oldHash !== null,
      operation === 'install' ? 'Destination already exists; no files overwritten.' : 'Installed package is missing.');
    if (oldHash !== null) {
      const metadata = JSON.parse(await fs.readFile(join(target, 'package.json'), 'utf8'));
      requireThat(metadata.name === plugin, 'Destination is not the expected plugin package.');
    }
    let nextConfig = original;
    if (operation === 'install') {
      let initialWorkspace;
      if (options.initialWorkspace) {
        initialWorkspace = resolve(options.initialWorkspace);
        requireThat((await fs.stat(initialWorkspace)).isDirectory(), 'Initial workspace must be an existing directory.');
      }
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const addition = [begin, '- insert:', '    - id: agent-collaboration',
        `      name: ${JSON.stringify(pathToFileURL(join(target, 'dist', 'host.mjs')).href)}`,
        '      config:', `        stateDirectory: ${JSON.stringify(stateDir)}`,
        ...(initialWorkspace ? [`        initialWorkspace: ${JSON.stringify(initialWorkspace)}`] : []),
        end, ''].join(newline);
      nextConfig = Buffer.from(text + (text && !text.endsWith('\n') ? newline : '') + addition);
    } else if (operation === 'uninstall') {
      nextConfig = Buffer.from(text.slice(0, managed.start) + text.slice(managed.finish));
    }
    if (operation !== 'uninstall') {
      const metadata = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
      requireThat(metadata.name === plugin, 'Source is not the expected plugin package.');
      for (const entry of ['host.mjs', 'client.mjs', 'mcp.mjs', 'remote-mcp.mjs']) {
        requireThat((await fs.stat(join(root, 'dist', entry))).isFile(), 'Build the plugin before installing or updating.');
      }
      await fs.mkdir(stage);
      stageOwned = true;
      const sourceHashes = new Map();
      for (const entry of entries) {
        const before = await treeHash(join(root, entry));
        requireThat(before !== null, `Required package file missing: ${entry}`);
        sourceHashes.set(entry, before);
        await fs.cp(join(root, entry), join(stage, entry), { recursive: true, force: false, errorOnExist: true });
        requireThat(await treeHash(join(stage, entry)) === before && await treeHash(join(root, entry)) === before,
          `Source changed while staging: ${entry}`);
      }
      stagedHash = await treeHash(stage);
      for (const [entry, hash] of sourceHashes) {
        requireThat(await treeHash(join(root, entry)) === hash, `Source changed while staging: ${entry}`);
      }
    }
    await guard();
    await fs.mkdir(dirname(backup), { recursive: true });
    await fs.mkdir(backup, { mode: 0o700 });
    if (original) await fs.writeFile(join(backup, 'cordis.patch.yml'), original, { flag: 'wx', mode: 0o600 });
    if (oldHash !== null) {
      await fs.cp(target, join(backup, 'package'), { recursive: true, force: false, errorOnExist: true });
      requireThat(await treeHash(join(backup, 'package')) === oldHash, 'Package changed during backup.');
    }
    await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify({
      operation, at: new Date().toISOString(), profile: realProfile, stateDirectory: stateDir,
      packageDirectory: target, configExisted: original !== null, packageExisted: oldHash !== null,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await guard();
    requireThat(await treeHash(target) === oldHash, 'Installed package changed concurrently.');
    if (oldHash !== null) { await fs.rename(target, previous); oldMoved = true; }
    if (operation !== 'uninstall') { await fs.rename(stage, target); installed = true; }
    await guard();
    requireThat(await treeHash(target) === (installed ? stagedHash : null), 'Package changed before commit.');
    if (!same(original, nextConfig)) await atomicConfig(patchPath, original, nextConfig);
    committed = true;
    return { operation, packageDirectory: target, config: patchPath, stateDirectory: stateDir, backup,
      statePreserved: true, restartRequired: true, warnings };
  } catch (error) {
    if (installed) {
      try {
        requireThat(await treeHash(target) === stagedHash, 'Package changed concurrently; automatic rollback would overwrite it.');
        await fs.rename(target, stage);
        installed = false;
      } catch (rollbackError) { warnings.push(rollbackError.message); }
    }
    if (oldMoved && !installed) {
      try {
        requireThat(await treeHash(target) === null, 'Destination reappeared; original package retained for manual recovery.');
        await fs.rename(previous, target);
        oldMoved = false;
      } catch (rollbackError) { warnings.push(rollbackError.message); }
    }
    throw new Error(`${error.message}${backup ? ` Backup: ${backup}.` : ''}${warnings.length ? ` Recovery: ${warnings.join(' ')}` : ''}`);
  } finally {
    // These are unique siblings created by this operation; never remove a user-selected directory.
    for (const path of [...(stageOwned ? [stage] : []), ...(committed && oldMoved ? [previous] : [])]) {
      try { await fs.rm(path, { recursive: true, force: true }); }
      catch (error) { warnings.push(`Cleanup needed: ${path} (${error.code})`); }
    }
    for (const lock of locks.reverse()) {
      try { await lock.release(); }
      catch (error) { warnings.push(`Lock cleanup failed: ${error.message}`); }
    }
  }
}

export async function runCli(operation, argv = process.argv.slice(2)) {
  const help = `DSH Desktop Agent Bridge ${operation} (close DSH first)\n` +
    `Usage: node scripts/${operation}-local.mjs [--home <user-home>] [--profile <profile-directory>]\n` +
    `  [--state-dir <state-directory>] [--backup <new-backup-directory>]` +
    (operation === 'install' ? ' [--initial-workspace <existing-directory>]' : '') +
    '\nDefaults: ~/.dsh/profiles/desktop and ~/.dsh/agent-collaboration.\n' +
    'Installation grants no resources by default. Configure clients in the DSH collaboration settings.\n' +
    'Uninstall preserves state, credentials, sessions and external MCP registrations.\n';
  if (argv.includes('--help')) { console.log(help); return; }
  try {
    const names = { '--home': 'home', '--profile': 'profile', '--state-dir': 'stateDir', '--backup': 'backup',
      ...(operation === 'install' ? { '--initial-workspace': 'initialWorkspace' } : {}) };
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
      const key = names[argv[i]];
      requireThat(key && argv[i + 1] && !argv[i + 1].startsWith('--') && !(key in options), `Invalid argument: ${argv[i]}\n${help}`);
      options[key] = argv[i + 1];
    }
    console.log(JSON.stringify(await maintain(operation, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
