import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Broker, verifyToken } from '../src/broker.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-broker-test-'));
  const projects = [join(root, 'one'), join(root, 'two')];
  await Promise.all(projects.map(path => mkdir(path)));
  const views = new Map(), calls = [], interactions = new Map();
  let interactionScope;
  const append = (id, type, data) => {
    const view = views.get(id);
    view.events.push({ seq: ++view.lastSeq, type, data });
  };
  const adapter = {
    async catalog() {
      return {
        workspaces: [
          { workspaceId: 'one', path: projects[0] },
          { workspaceId: 'one-alias', path: join(projects[0], '.') },
          { workspaceId: 'two', path: projects[1] },
        ],
        presets: [{ id: 'standard', label: '标准' }],
        models: [{ provider: 'local', model: 'model', reasoningEfforts: ['high'] }],
        sessions: [],
      };
    },
    async create(input) {
      const sessionId = `session-${views.size + 1}`;
      views.set(sessionId, { sessionId, running: false, lastSeq: 0, events: [], pendingApprovals: [], pendingQuestions: [] });
      calls.push({ type: 'create', sessionId, input });
      return { sessionId };
    },
    async inspect(id) { return structuredClone(views.get(id)); },
    async send(sessionId, input) {
      calls.push({ type: 'send', sessionId, input });
      append(sessionId, 'user/message', { id: input.messageId, source: input.source });
      append(sessionId, 'turn/start', {});
      views.get(sessionId).running = true;
    },
    async cancel(sessionId) {
      calls.push({ type: 'cancel', sessionId });
      finish(sessionId, 'aborted');
    },
    async takeover(sessionId, principal) { calls.push({ type: 'takeover', sessionId, principal }); },
    async selectModel(sessionId, input) { calls.push({ type: 'selectModel', sessionId, input }); },
    async ensureInteractions() {},
    setInteractionScope(predicate) { interactionScope = predicate; },
    async listInteractions(sessionId) { return structuredClone(interactions.get(sessionId) ?? []); },
    validateInteractionResponse() {},
    async respondInteraction(sessionId, id, response) {
      calls.push({ type: 'interaction', sessionId, id, response });
      interactions.set(sessionId, (interactions.get(sessionId) ?? []).filter(item => item.id !== id));
    },
  };
  function finish(id, kind = 'completed', text = '任务结果') {
    append(id, 'assistant/message', { message: { content: [{ type: 'text', text }] } });
    append(id, 'turn/end', { reason: { kind, ...(kind === 'aborted' ? { reason: { kind: 'user' } } : {}) } });
    views.get(id).running = false;
  }
  let broker = await new Broker(adapter, join(root, 'state')).init();
  t.after(async () => {
    await broker.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('dsh-broker-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const tokens = {};
  for (const id of ['codex', 'hermes']) {
    const { connectionFile } = await broker.action({ type: 'create-client', id, label: id });
    tokens[id] = JSON.parse(await readFile(connectionFile, 'utf8')).token;
  }
  const policies = ['codex', 'hermes'].map(id => ({
    id, label: id, workspaceIds: ['one', 'one-alias', 'two'],
    presets: ['standard'], models: ['local/model'],
  }));
  await broker.action({ type: 'save-policy', clients: policies });
  const input = (requestId, extra = {}) => ({
    requestId, task: `执行 ${requestId}`, workspaceId: 'one', preset: 'standard',
    selection: { provider: 'local', model: 'model', reasoningEffort: 'high' }, ...extra,
  });
  return {
    get broker() { return broker; }, get interactionScope() { return interactionScope; },
    adapter, calls, views, tokens, policies, input, append, finish, interactions,
    async restart() {
      await broker.close();
      broker = await new Broker(adapter, join(root, 'state')).init();
    },
  };
}

test('client credentials determine identity; catalog and state do not return credential hashes', async t => {
  const f = await fixture(t);
  assert.equal(f.broker.authenticate(f.tokens.codex), 'codex');
  assert.equal(f.broker.authenticate(f.tokens.hermes), 'hermes');
  assert.throws(() => f.broker.authenticate('codex'), { code: 'UNAUTHORIZED' });
  assert.equal(verifyToken('x', 'not-a-hash'), false);
  assert.equal(verifyToken(null, '0'.repeat(64)), false);
  const snapshot = await f.broker.snapshot();
  assert.ok(snapshot.clients.every(client => !('tokenHash' in client) && !('token' in client)));
  assert.equal(JSON.stringify(await f.broker.catalog('codex')).includes(f.tokens.codex), false);
});

test('a client cannot read, continue, message, or cancel another client session', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('owned'));
  assert.equal(f.broker.list('hermes').length, 0);
  await assert.rejects(f.broker.get('hermes', run.runId), { code: 'RUN_DENIED' });
  await assert.rejects(f.broker.cancel('hermes', run.runId), { code: 'RUN_DENIED' });
  await assert.rejects(f.broker.send('hermes', { requestId: 'spoof', sessionId: run.sessionId, text: '注入' }), { code: 'SESSION_DENIED' });
  await assert.rejects(f.broker.start('hermes', f.input('continue', { sessionId: run.sessionId })), { code: 'SESSION_DENIED' });
  await assert.rejects(f.broker.start('codex', f.input('spoof-source', { principal: 'hermes' })));
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
  assert.equal(f.calls.find(call => call.type === 'send').input.source.principal, 'codex');
});

test('concurrent retries execute a task once; changing its payload is rejected', async t => {
  const f = await fixture(t), input = f.input('retry');
  const [first, second] = await Promise.all([f.broker.start('codex', input), f.broker.start('codex', input)]);
  assert.equal(first.runId, second.runId);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
  await assert.rejects(f.broker.start('codex', { ...input, task: '不同内容' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.restart();
  assert.equal((await f.broker.start('codex', input)).runId, first.runId);
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('supplement retries are deduplicated and cannot change accepted text', async t => {
  const f = await fixture(t), run = await f.broker.start('codex', f.input('task'));
  const input = { requestId: 'supplement', sessionId: run.sessionId, text: '补充限制', mode: 'steer' };
  const [one, two] = await Promise.all([f.broker.send('codex', input), f.broker.send('codex', input)]);
  assert.equal(one.messageId, two.messageId);
  assert.equal(f.calls.filter(call => call.type === 'send').length, 2);
  await assert.rejects(f.broker.send('codex', { ...input, text: '不同补充' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('canonical project paths serialize across clients and workspace aliases while other projects run', async t => {
  const f = await fixture(t);
  const one = await f.broker.start('codex', f.input('first'));
  const two = await f.broker.start('hermes', f.input('second', { workspaceId: 'one-alias' }));
  const independent = await f.broker.start('hermes', f.input('third', { workspaceId: 'two' }));
  assert.equal(one.status, 'running');
  assert.equal(two.status, 'queued');
  assert.equal(independent.status, 'running');
  assert.deepEqual(f.calls.filter(call => call.type === 'send').map(call => call.sessionId), [one.sessionId, independent.sessionId]);
  f.finish(one.sessionId);
  await f.broker.refresh();
  assert.equal((await f.broker.get('hermes', two.runId)).status, 'running');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 3);
});

test('resource revocation cancels a queued task before dispatch', async t => {
  const f = await fixture(t);
  const one = await f.broker.start('codex', f.input('one'));
  const two = await f.broker.start('hermes', f.input('two'));
  await f.broker.action({ type: 'save-policy', clients: [{ ...f.policies[1], models: [] }] });
  f.finish(one.sessionId);
  const result = await f.broker.get('hermes', two.runId);
  assert.equal(result.status, 'cancelled');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('supplements cannot start a queued session and bypass its project lock', async t => {
  const f = await fixture(t);
  await f.broker.start('codex', f.input('busy'));
  const queued = await f.broker.start('hermes', f.input('queued'));
  await assert.rejects(f.broker.send('hermes', { requestId: 'bypass', sessionId: queued.sessionId, text: '立即开始' }));
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('supplements cannot restart an idle completed session outside task admission', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('complete'));
  f.finish(run.sessionId);
  await f.broker.refresh();
  await assert.rejects(f.broker.send('codex', { requestId: 'untracked', sessionId: run.sessionId, text: '再做一个任务' }));
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('revoked resources cannot still receive external supplements', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('active'));
  await f.broker.action({ type: 'save-policy', clients: [{ ...f.policies[0], workspaceIds: [] }] });
  await assert.rejects(f.broker.send('codex', { requestId: 'revoked', sessionId: run.sessionId, text: '继续修改' }));
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('takeover preserves current execution, rejects external writes and calls inbox withdrawal', async t => {
  const f = await fixture(t), run = await f.broker.start('codex', f.input('running'));
  await f.broker.action({ type: 'takeover', sessionId: run.sessionId });
  assert.deepEqual(f.calls.filter(call => call.type === 'takeover'), [{ type: 'takeover', sessionId: run.sessionId, principal: 'codex' }]);
  assert.equal(f.calls.some(call => call.type === 'cancel'), false);
  const result = await f.broker.get('codex', run.runId);
  assert.equal(result.control, 'user');
  assert.equal(result.status, 'running');
  await assert.rejects(f.broker.send('codex', { requestId: 'late', sessionId: run.sessionId, text: '接管后发消息' }), { code: 'USER_CONTROL' });
  await assert.rejects(f.broker.cancel('codex', run.runId), { code: 'USER_CONTROL' });
  await f.broker.action({ type: 'release', sessionId: run.sessionId });
  assert.equal((await f.broker.get('codex', run.runId)).control, 'agent');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('takeover withdraws an unstarted task and release does not replay it', async t => {
  const f = await fixture(t);
  const running = await f.broker.start('codex', f.input('running'));
  const queued = await f.broker.start('codex', f.input('queued'));
  await f.broker.action({ type: 'takeover', sessionId: queued.sessionId });
  await f.broker.action({ type: 'release', sessionId: queued.sessionId });
  f.finish(running.sessionId);
  await f.broker.refresh();
  assert.equal((await f.broker.get('codex', queued.runId)).status, 'cancelled');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('cancelled unstarted tasks cannot acquire later user-authored results', async t => {
  const f = await fixture(t);
  await f.broker.start('codex', f.input('running'));
  const queued = await f.broker.start('codex', f.input('queued'));
  await f.broker.action({ type: 'takeover', sessionId: queued.sessionId });
  f.finish(queued.sessionId, 'completed', '用户接管后自己的私有任务结果');
  const old = await f.broker.get('codex', queued.runId);
  assert.equal(old.status, 'cancelled');
  assert.equal(old.text, '');
});

test('idle alone is not success; actual end reasons, approvals and questions are distinguished', async t => {
  const f = await fixture(t);
  for (const [kind, expected] of [['completed', 'completed'], ['error', 'failed'], ['aborted', 'cancelled'], ['blocked', 'blocked'], ['max-tokens', 'blocked']]) {
    const run = await f.broker.start('codex', f.input(kind));
    const view = f.views.get(run.sessionId);
    view.running = false;
    assert.notEqual((await f.broker.get('codex', run.runId)).status, 'completed');
    view.running = true;
    view.pendingApprovals = [{ id: 'approval-1', tool: 'write' }];
    assert.equal((await f.broker.wait('codex', run.runId, 0)).status, 'waiting_approval');
    view.pendingApprovals = [];
    view.pendingQuestions = [{ requestId: 'question-1', questions: ['目标？'] }];
    assert.equal((await f.broker.wait('codex', run.runId, 0)).status, 'waiting_input');
    view.pendingQuestions = [];
    f.finish(run.sessionId, kind);
    assert.equal((await f.broker.get('codex', run.runId)).status, expected);
  }
});

test('interrupted assistant output is incomplete even if the terminal reason says completed', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('partial'));
  f.finish(run.sessionId, 'completed', '只有部分输出');
  const view = f.views.get(run.sessionId);
  view.events.findLast(event => event.type === 'assistant/message').data.interrupted = true;
  view.status = 'incomplete';
  const result = await f.broker.get('codex', run.runId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.text, '只有部分输出');
});

test('a later unfinished native turn cannot reuse an earlier successful terminal event', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('two-turns'));
  f.finish(run.sessionId, 'completed', '第一轮结果');
  f.append(run.sessionId, 'turn/start', { turn: 2 });
  f.append(run.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '第二轮未完成' }] }, interrupted: true });
  f.views.get(run.sessionId).status = 'idle';
  const result = await f.broker.get('codex', run.runId);
  assert.equal(result.status, 'unknown');
  const queued = await f.broker.start('hermes', f.input('wait-for-uncertain-work'));
  assert.equal(queued.status, 'queued');
});

test('pending native inputs keep the project locked after an earlier turn ends', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('followup-pending'));
  f.finish(run.sessionId);
  Object.assign(f.views.get(run.sessionId), { running: true, status: 'running' });
  const queued = await f.broker.start('hermes', f.input('same-project'));
  assert.equal((await f.broker.get('codex', run.runId)).status, 'running');
  assert.equal((await f.broker.get('hermes', queued.runId)).status, 'queued');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('unresolved approval or question takes precedence over an idle completed turn', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('await-human'));
  f.finish(run.sessionId);
  const view = f.views.get(run.sessionId);
  view.pendingApprovals = [{ id: 'approval-pending' }];
  view.status = 'awaiting_approval';
  assert.equal((await f.broker.get('codex', run.runId)).status, 'waiting_approval');
  view.pendingApprovals = [];
  view.pendingQuestions = [{ requestId: 'question-pending' }];
  view.status = 'awaiting_input';
  assert.equal((await f.broker.get('codex', run.runId)).status, 'waiting_input');
});

test('host or hook aborts are distinguished from an explicit user cancellation', async t => {
  const f = await fixture(t);
  for (const cause of ['parent', 'disposed', 'hook']) {
    const run = await f.broker.start('codex', f.input(`abort-${cause}`));
    f.finish(run.sessionId, 'aborted', '中止前的输出');
    f.views.get(run.sessionId).events.at(-1).data.reason.reason = { kind: cause };
    f.views.get(run.sessionId).status = 'failed';
    assert.equal((await f.broker.get('codex', run.runId)).status, 'failed', cause);
  }
});

test('completed result text remains bounded when its session is reused', async t => {
  const f = await fixture(t);
  const first = await f.broker.start('codex', f.input('first'));
  f.finish(first.sessionId, 'completed', '第一项结果');
  const original = await f.broker.get('codex', first.runId);
  assert.equal(original.text, '第一项结果');
  const second = await f.broker.start('codex', f.input('second', { sessionId: first.sessionId }));
  f.finish(second.sessionId, 'completed', '第二项结果');
  assert.equal((await f.broker.get('codex', second.runId)).text, '第二项结果');
  const old = await f.broker.get('codex', first.runId);
  assert.equal(old.text, '第一项结果');
  assert.equal(old.status, 'completed');
  assert.equal(old.lastSeq, original.lastSeq);
});

test('completed result does not inherit a later task pending approvals or questions', async t => {
  const f = await fixture(t);
  const first = await f.broker.start('codex', f.input('first'));
  f.finish(first.sessionId);
  await f.broker.refresh();
  await f.broker.start('codex', f.input('second', { sessionId: first.sessionId }));
  Object.assign(f.views.get(first.sessionId), {
    pendingApprovals: [{ id: 'later-approval' }], pendingQuestions: [{ requestId: 'later-question' }],
  });
  const old = await f.broker.get('codex', first.runId);
  assert.deepEqual(old.pendingApprovals, []);
  assert.deepEqual(old.pendingQuestions, []);
});

test('ambiguous submission is retained without automatically resending after host restart', async t => {
  const f = await fixture(t);
  f.adapter.send = async (sessionId, input) => {
    f.calls.push({ type: 'send', sessionId, input });
    throw new Error('连接在提交之后中断，结果未知');
  };
  const run = await f.broker.start('codex', f.input('unknown'));
  assert.equal(run.status, 'unknown');
  await f.restart();
  assert.equal((await f.broker.get('codex', run.runId)).status, 'unknown');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
  assert.equal((await f.broker.start('codex', f.input('unknown'))).runId, run.runId);
});

test('ambiguous supplement retries do not resend or claim acceptance', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('original'));
  f.adapter.send = async (sessionId, input) => {
    f.calls.push({ type: 'send', sessionId, input });
    throw new Error('发送补充后连接中断');
  };
  const message = { requestId: 'uncertain', sessionId: run.sessionId, text: '补充' };
  await assert.rejects(f.broker.send('codex', message), /连接中断/);
  assert.equal((await f.broker.send('codex', message)).status, 'unknown');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 2);
});

test('an unconfirmed submission cannot claim later unrelated native work after restart', async t => {
  const f = await fixture(t);
  f.adapter.send = async () => { throw new Error('Submission outcome is unknown'); };
  const run = await f.broker.start('codex', f.input('unconfirmed'));
  f.append(run.sessionId, 'turn/start', {});
  f.append(run.sessionId, 'user/message', { id: 'human-message', source: { kind: 'user' } });
  f.finish(run.sessionId, 'completed', 'Unrelated private result');
  await f.restart();
  const result = await f.broker.get('codex', run.runId);
  assert.equal(result.status, 'unknown');
  assert.equal(result.text, '');
  const queued = await f.broker.start('hermes', f.input('still-locked'));
  assert.equal(queued.status, 'queued');
});

test('native consumption can reconcile an uncertain submission without resending it', async t => {
  const f = await fixture(t);
  const send = f.adapter.send;
  f.adapter.send = async (...args) => {
    await send(...args);
    throw new Error('Lost acknowledgement after native consumption');
  };
  const run = await f.broker.start('codex', f.input('consumed'));
  f.finish(run.sessionId, 'completed', 'Confirmed task result');
  await f.restart();
  const result = await f.broker.get('codex', run.runId);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Confirmed task result');
  assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
});

test('stopping an uncertain active task retains its project lock until native execution ends', async t => {
  for (const viaUi of [true, false]) {
    const f = await fixture(t);
    const send = f.adapter.send;
    f.adapter.send = async (...args) => {
      await send(...args);
      throw new Error('Native work began but acknowledgement was lost');
    };
    const run = await f.broker.start('codex', f.input(`stop-uncertain-${viaUi}`));
    f.adapter.cancel = async () => {};
    if (viaUi) await f.broker.action({ type: 'stop', sessionId: run.sessionId });
    else await f.broker.cancel('codex', run.runId);
    f.adapter.send = send;
    const queued = await f.broker.start('hermes', f.input(`wait-for-stop-${viaUi}`));
    assert.equal(queued.status, 'queued');
    assert.equal(f.calls.filter(call => call.type === 'send').length, 1);
    f.finish(run.sessionId, 'aborted');
    await f.broker.refresh();
    assert.equal((await f.broker.get('codex', run.runId)).status, 'cancelled');
    assert.equal((await f.broker.get('hermes', queued.runId)).status, 'running');
  }
});

test('closing rejects new operations while previously queued work is drained and saved', async t => {
  const f = await fixture(t);
  let release;
  const pending = f.broker.serial(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.broker.close();
  const rejected = assert.rejects(f.broker.start('codex', f.input('too-late')), { code: 'BROKER_CLOSED' });
  release();
  await Promise.all([pending, closing]);
  await rejected;
  const saved = JSON.parse(await readFile(f.broker.file, 'utf8'));
  assert.equal(saved.runs.length, 0);
  assert.equal(f.calls.filter(call => call.type === 'send').length, 0);
});

async function parentFixture(t) {
  const f = await fixture(t);
  await f.broker.action({ type: 'save-policy', clients: [{ ...f.policies[0], parentInteractions: true }] });
  const run = await f.broker.start('codex', f.input('parent-reply'));
  f.interactions.set(run.sessionId, [{ id: 'native-request', kind: 'approval', sessionId: run.sessionId,
    toolName: 'write', reason: 'Outside workspace', toolCall: { path: '/exact/path.txt' } }]);
  const requestId = (await f.broker.interactions('codex', run.runId)).requests[0].requestId;
  const reply = { runId: run.runId, requestId, userReply: '允许创建这个文件一次',
    response: { kind: 'approval', decision: 'allowed-once' } };
  return { ...f, run, reply };
}

test('parent interactions default off and cannot cross client ownership', async t => {
  const f = await fixture(t);
  const run = await f.broker.start('codex', f.input('disabled'));
  assert.equal(run.parentInteractions, false);
  assert.equal((await f.broker.catalog('codex')).parentInteractions, false);
  await assert.rejects(f.broker.interactions('codex', run.runId), { code: 'PARENT_INTERACTIONS_DISABLED' });
  await assert.rejects(f.broker.interactions('hermes', run.runId), { code: 'RUN_DENIED' });
  await assert.rejects(f.broker.respondInteraction('hermes', { runId: run.runId, requestId: 'foreign',
    userReply: '允许', response: { kind: 'approval', decision: 'allowed-once' } }), { code: 'RUN_DENIED' });
  assert.equal(f.calls.filter(call => call.type === 'interaction').length, 0);
});

test('resource revocation removes the answer peer scope as well as rejecting parent replies', async t => {
  for (const resource of ['workspaceIds', 'presets', 'models']) {
    const f = await parentFixture(t);
    assert.equal(f.interactionScope(f.run.sessionId), true);
    await f.broker.action({ type: 'save-policy',
      clients: [{ ...f.policies[0], [resource]: [], parentInteractions: true }] });
    assert.equal(f.interactionScope(f.run.sessionId), false, resource);
    await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'RESOURCE_DENIED' });
    assert.equal(f.calls.filter(call => call.type === 'interaction').length, 0);
  }
});

test('one-time human replies are audited and cannot grant permanent access or replay', async t => {
  const f = await parentFixture(t);
  await assert.rejects(f.broker.respondInteraction('codex', { ...f.reply, userReply: '' }));
  await assert.rejects(f.broker.respondInteraction('codex', {
    ...f.reply, response: { kind: 'approval', decision: 'allowed-always' },
  }));
  assert.equal(f.broker.state.interactionReplies.length, 0);
  assert.equal((await f.broker.respondInteraction('codex', f.reply)).status, 'submitted');
  assert.equal(f.calls.filter(call => call.type === 'interaction').length, 1);
  assert.equal(f.broker.state.interactionReplies[0].userReply, f.reply.userReply);
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'INTERACTION_ALREADY_SUBMITTED' });
  const saved = JSON.parse(await readFile(f.broker.file, 'utf8'));
  assert.equal(saved.interactionReplies[0].status, 'submitted');
});

test('takeover then release and opt-out then opt-in invalidate previously listed requests', async t => {
  const f = await parentFixture(t);
  await f.broker.action({ type: 'takeover', sessionId: f.run.sessionId });
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'USER_CONTROL' });
  await f.broker.action({ type: 'release', sessionId: f.run.sessionId });
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'INTERACTION_EXPIRED' });
  const fresh = (await f.broker.interactions('codex', f.run.runId)).requests[0].requestId;
  assert.notEqual(fresh, f.reply.requestId);
  await f.broker.action({ type: 'save-policy', clients: [{ ...f.policies[0], parentInteractions: false }] });
  await assert.rejects(f.broker.interactions('codex', f.run.runId), { code: 'PARENT_INTERACTIONS_DISABLED' });
  await f.broker.action({ type: 'save-policy', clients: [{ ...f.policies[0], parentInteractions: true }] });
  await assert.rejects(f.broker.respondInteraction('codex', { ...f.reply, requestId: fresh }), { code: 'INTERACTION_EXPIRED' });
  assert.equal(f.calls.filter(call => call.type === 'interaction').length, 0);
});

test('stop and task cancellation revoke replies immediately even before native cancellation arrives', async t => {
  for (const viaUi of [true, false]) {
    const f = await parentFixture(t);
    f.adapter.cancel = async () => {};
    if (viaUi) await f.broker.action({ type: 'stop', sessionId: f.run.sessionId });
    else await f.broker.cancel('codex', f.run.runId);
    await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'INTERACTION_RUN_INACTIVE' });
    assert.equal(f.calls.filter(call => call.type === 'interaction').length, 0);
  }
});

test('invalid question responses do not consume requests; uncertain dispatch never retries', async t => {
  const f = await parentFixture(t);
  f.adapter.validateInteractionResponse = () => { throw new Error('Invalid selected option'); };
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), /Invalid selected option/);
  assert.equal(f.broker.state.interactionReplies.length, 0);
  f.adapter.validateInteractionResponse = () => {};
  f.adapter.respondInteraction = async () => { throw new Error('Connection lost after dispatch'); };
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), /Connection lost/);
  assert.equal(f.broker.state.interactionReplies[0].status, 'unknown');
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'INTERACTION_ALREADY_SUBMITTED' });
});

test('native resolution and completed tasks invalidate pending parent requests', async t => {
  const f = await parentFixture(t);
  f.interactions.set(f.run.sessionId, []);
  await assert.rejects(f.broker.respondInteraction('codex', f.reply), { code: 'INTERACTION_EXPIRED' });
  f.finish(f.run.sessionId);
  await assert.rejects(f.broker.interactions('codex', f.run.runId), { code: 'INTERACTION_RUN_INACTIVE' });
  assert.equal(f.calls.filter(call => call.type === 'interaction').length, 0);
});
