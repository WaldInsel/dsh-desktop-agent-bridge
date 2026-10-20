import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [new URL('../src/client.jsx', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'text' },
  plugins: [{
    name: 'react-test-shim',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: 'react-shim' }));
      builder.onLoad({ filter: /.*/, namespace: 'react-shim' }, () => ({
        contents: `export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx; export const Fragment='fragment';
          export const useState=value=>[typeof value==='function'?value():value,()=>{}];
          export const useEffect=()=>{};
          export const useSyncExternalStore=(_subscribe,getSnapshot)=>getSnapshot();
          export default {createElement:jsx};`,
      }));
    },
  }],
});
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('one polling loop serves mounted views and stops after the last unsubscribe', async t => {
  const scheduled = [];
  const cleared = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const timer = { fn, ms }; scheduled.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => cleared.push(timer));
  let calls = 0;
  const store = ui.createCollaborationStore(async () => ({ version: String(++calls) }));
  const leaveSidebar = store.subscribe(() => {});
  const leaveSettings = store.subscribe(() => {});
  await flush();
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 2500);
  assert.equal(store.getSnapshot().data.version, '1');
  leaveSidebar();
  assert.equal(cleared.length, 0);
  leaveSettings();
  assert.equal(cleared.at(-1), scheduled[0]);
  store.dispose();
});

test('a late response after unmount cannot change the view or start another timer', async t => {
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', fn => { scheduled.push(fn); return fn; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let finish;
  const store = ui.createCollaborationStore(() => new Promise(resolve => { finish = resolve; }));
  const leave = store.subscribe(() => {});
  leave();
  finish({ version: 'late' });
  await flush();
  assert.equal(store.getSnapshot().data, null);
  assert.equal(scheduled.length, 0);
  store.dispose();
});

test('action failures stay visible through polling and successful actions refresh state', async t => {
  t.mock.method(globalThis, 'setTimeout', () => 1);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let version = 0;
  let shouldFail = true;
  const store = ui.createCollaborationStore(async method => {
    if (method === 'snapshot') return { version: String(version) };
    if (shouldFail) throw new Error('会话归属不允许');
    version++;
    return { changed: true };
  });
  const leave = store.subscribe(() => {});
  await flush();
  assert.deepEqual(await store.act({ type: 'takeover' }), { ok: false });
  assert.match(store.getSnapshot().actionError, /归属/);
  assert.equal(store.getSnapshot().busy, false);
  await store.refresh();
  assert.match(store.getSnapshot().actionError, /归属/);
  shouldFail = false;
  assert.equal((await store.act({ type: 'takeover' })).ok, true);
  assert.equal(store.getSnapshot().data.version, '1');
  assert.equal(store.getSnapshot().actionError, '');
  leave();
  store.dispose();
});

test('grouping keeps identities distinct; connection loss never makes a task completed', () => {
  const grouped = ui.groupSessions({
    clients: [{ id: 'codex', label: 'Codex', connected: false }, { id: 'hermes', label: 'Hermes', connected: true }],
    sessions: [{ sessionId: 'c1', principal: 'codex', status: 'running' }, { sessionId: 'h1', principal: 'hermes' }, { sessionId: 'o1', principal: 'old-client' }],
  });
  assert.deepEqual(grouped.map(group => [group.id, group.connected, group.sessions.map(row => row.sessionId)]), [
    ['codex', false, ['c1']], ['hermes', true, ['h1']], ['old-client', false, ['o1']],
  ]);
  assert.equal(ui.statusLabel(grouped[0].sessions[0].status), '执行中');
  assert.equal(ui.statusLabel('waiting_approval'), '等待你审批');
  assert.equal(ui.statusLabel('failed'), '失败');
  assert.equal(ui.statusLabel('idle'), '空闲');
  assert.notEqual(ui.statusLabel('future_status'), '已完成');
});

test('saving one client permission draft preserves every other client', () => {
  const original = [
    { id: 'codex', label: 'Codex', workspaceIds: ['w1'], models: ['p/m'], presets: ['safe'] },
    { id: 'hermes', label: 'Hermes', workspaceIds: ['w2'], models: ['q/n'], presets: ['read'] },
  ];
  const next = ui.replaceClientPolicy(original, { ...original[0], workspaceIds: [], parentInteractions: true });
  assert.deepEqual(next[0].workspaceIds, []);
  assert.equal(next[0].parentInteractions, true);
  assert.equal(next[1], original[1]);
  assert.deepEqual(original[0].workspaceIds, ['w1']);
  const disabled = ui.replaceClientPolicy(next, { ...next[0], parentInteractions: false });
  assert.equal(disabled[0].parentInteractions, false);
  assert.equal(disabled[1], original[1]);
});

function expand(element) {
  if (element == null || typeof element !== 'object') return element;
  if (Array.isArray(element)) return element.flatMap(item => expand(item));
  if (typeof element.type === 'function') return expand(element.type(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props?.children) } };
}

function nodes(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

test('parent interaction consent defaults off and is included in the existing policy save', async () => {
  const registrations = [];
  const effects = [];
  ui.apply({
    slots: { inject(_name, register) { return register(); }, register(options, Component) { registrations.push({ options, Component }); } },
    effect(effect) { effects.push(effect()); },
    remote: { $mount() { throw new Error('must be lazy'); } },
  });
  const clients = [
    { id: 'codex', label: 'Codex', workspaceIds: ['w1'], models: ['p/m'], presets: ['standard'] },
    { id: 'hermes', label: 'Hermes', workspaceIds: ['w2'], models: ['p/m'], presets: ['standard'], parentInteractions: true },
  ];
  const state = { data: { clients, policy: { clients }, catalog: { workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }], presets: [{ id: 'standard' }], models: [{ provider: 'p', model: 'm' }] }, sessions: [] }, busy: false };
  const actions = [];
  const store = {
    subscribe() {}, getSnapshot: () => state,
    act: async action => { actions.push(action); return { ok: true }; },
  };
  const settings = registrations.find(row => row.options.name === 'main');
  const tree = expand(settings.Component({ store, backToConversation() {} }));
  const toggles = nodes(tree, node => node.type === 'input' && node.props['aria-describedby']?.startsWith('dsh-ac-parent-interactions-'));
  assert.deepEqual(toggles.map(node => node.props.checked), [false, true]);
  assert(toggles.every(node => node.props.disabled === false));
  const forms = nodes(tree, node => node.type === 'form' && node.props.className === 'dsh-ac-card');
  await forms[1].props.onSubmit({ preventDefault() {} });
  assert.equal(actions[0].type, 'save-policy');
  assert.equal(actions[0].clients[1].parentInteractions, true);
  assert.deepEqual(actions[0].clients[0], clients[0]);
  state.busy = true;
  const busyTree = expand(settings.Component({ store, backToConversation() {} }));
  assert(nodes(busyTree, node => node.type === 'input' && node.props['aria-describedby']?.startsWith('dsh-ac-parent-interactions-'))
    .every(node => node.props.disabled));
  effects.forEach(dispose => dispose?.());
});

test('only changed resource selections drop unavailable grants', () => {
  const original = { id: 'codex', label: 'Codex', workspaceIds: ['w1', 'missing-workspace'], presets: ['standard', 'missing-preset'], models: ['p/retired'] };
  const catalog = { workspaces: [{ workspaceId: 'w1' }], presets: [{ id: 'standard' }], models: [{ provider: 'p', model: 'current' }] };
  const renamed = ui.currentClientPolicy(original, { ...original, label: 'Renamed', parentInteractions: true }, catalog);
  assert.deepEqual(renamed.workspaceIds, original.workspaceIds);
  assert.deepEqual(renamed.presets, original.presets);
  assert.deepEqual(renamed.models, original.models);
  const switched = ui.currentClientPolicy(original, {
    ...original, models: ['p/retired', 'p/current'], workspaceIds: ['w1', 'missing-workspace', 'another-missing'],
  }, catalog);
  assert.deepEqual(switched.workspaceIds, ['w1']);
  assert.deepEqual(switched.presets, original.presets);
  assert.deepEqual(switched.models, ['p/current']);
});
test('sidebar opens the native session; takeover and stop are independent actions', async () => {
  const registrations = [];
  const navigated = [];
  const effects = [];
  const ctx = {
    slots: { inject(_name, register) { return register(); }, register(options, Component) { registrations.push({ options, Component }); } },
    effect(effect) { effects.push(effect()); },
    remote: { $mount() { throw new Error('must be lazy'); } },
    layout: { selectPanel(id) { navigated.push(id); } },
    get(name) { if (name === 'uiWorkspace') return { openSession(id) { navigated.push(id); } }; throw new Error(name); },
  };
  ui.apply(ctx);
  assert.deepEqual(registrations.map(row => row.options.name), ['sidebar.footer.action', 'main']);
  const sidebar = registrations[0];
  const face = sidebar.options.inject();
  const actions = [];
  const fixture = {
    data: { clients: [{ id: 'codex', label: 'Codex', connected: false }], sessions: [
      { principal: 'codex', sessionId: 's1', title: '验收任务', control: 'agent', lastRunId: 'r1' },
    ], runs: [{ id: 'r1', status: 'running' }] },
    busy: false, actionError: '', loadError: '',
  };
  const store = { subscribe() {}, getSnapshot: () => fixture, act: async action => actions.push(action) };
  const tree = expand(sidebar.Component({ ...face, store, wide: true }));
  const buttons = nodes(tree, node => node.type === 'button');
  buttons.find(button => button.props.title?.startsWith('打开原生会话')).props.onClick();
  assert.deepEqual(navigated, ['s1']);
  await buttons.find(button => button.props['aria-label'] === '接管会话：验收任务').props.onClick();
  assert.deepEqual(actions, [{ type: 'takeover', sessionId: 's1' }]);
  await buttons.find(button => button.props['aria-label'] === '停止任务：验收任务').props.onClick();
  assert.deepEqual(actions.at(-1), { type: 'stop', sessionId: 's1' });
  assert.equal(nodes(tree, node => node.props?.className === 'dsh-ac-connection')[0].props['data-online'], false);
  assert.equal(nodes(tree, node => node.props?.className === 'dsh-ac-status')[0].props.children, '执行中');
  effects.forEach(dispose => dispose?.());
});
