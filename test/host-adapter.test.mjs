import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/host-adapter.mjs';

function harness() {
  const calls = [];
  const events = [];
  const permissions = new Map();
  const projections = { agentPreset: 'standard', title: '已有会话', modelSelection: { next: { provider: 'local', model: 'model-a', reasoningEffort: 'high' } } };
  const pending = { nextTurn: [], nextStep: [] };
  const session = { id: 'session-1' };
  const append = (type, data) => {
    const event = { seq: events.length, type, data };
    events.push(event);
    return event;
  };
  const agent = {
    id: session.id, session, status: 'idle',
    inbox: {
      get nextTurn() { return pending.nextTurn; },
      get nextStep() { return pending.nextStep; },
      remove(id) {
        for (const target of ['nextTurn', 'nextStep']) {
          const index = pending[target].findIndex(message => message.id === id);
          if (index >= 0) {
            pending[target].splice(index, 1);
            append('agent/inbox/spliced', { inserted: [], removedCount: 1, outcome: 'canceled' });
            return true;
          }
        }
        return false;
      },
    },
    followup(message) {
      pending.nextTurn.push(message);
      append('agent/inbox/spliced', { inserted: [message] });
    },
    steer(message) {
      pending.nextStep.push(message);
      append('agent/inbox/spliced', { inserted: [message] });
    },
    cancel(cause) {
      calls.push(['cancel', cause]);
      pending.nextTurn = [];
      pending.nextStep = [];
    },
  };
  const workspaces = [{ workspaceId: 'workspace-1', path: 'C:/project', title: '项目', sessionIds: [session.id] }];
  const ctx = {
    connection: { createPeer(options) {
      calls.push(['peer', options]);
      return { dispose: async () => calls.push(['peer-dispose']) };
    } },
    on: () => () => {},
    typertGateway: {
      async invoke({ namespace, method, args, peer }) {
        assert.ok(peer);
        calls.push([`${namespace}.${method}`, args]);
        if (namespace === 'session' && method === 'modelCatalog') return {
          default: { provider: 'local', model: 'model-a', reasoningEffort: 'high' },
          groups: [{ id: 'local', name: '本机', models: [{ id: 'model-a', name: '模型 A', reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }] }],
        };
        if (namespace === 'agentPresets' && method === 'list') return {
          presets: [{ id: 'standard', name: '标准', isDefault: true }, { id: 'broken', broken: 'Unavailable' }],
        };
        if (namespace === 'session' && method === 'list') return { items: [{
          sessionId: session.id, cwd: 'C:/project', running: false,
          projections: { values: projections },
        }] };
        if (namespace === 'session' && method === 'create') return { sessionId: session.id };
        if (namespace === 'session' && method === 'rename') return { title: args.request.title };
        if (namespace === 'workspace' && method === 'create') return {
          workspace: { workspaceId: 'workspace-2', path: args.request.path, title: '验收', sessionIds: [] },
          created: true,
        };
        throw new Error(`Unexpected RPC ${namespace}.${method}`);
      },
      async stream({ namespace, method, signal }) {
        assert.ok(signal);
        return (async function* () {
          if (namespace === 'workspace' && method === 'follow') yield { type: 'baseline', value: { items: workspaces } };
          else if (namespace === 'session' && method === 'follow') yield {
            type: 'snapshot', cursor: events.length - 1,
            records: events.map(event => ({ type: 'event', event })),
            hasMore: false, header: { cwd: 'C:/project' },
            projections: { values: projections },
          };
          else throw new Error(`Unexpected stream ${namespace}.${method}`);
        })();
      },
    },
    sessionController: {
      resolveAgent: async () => ({ agent }),
      agents: {
        selectForNextRequest(agent, selection) {
          calls.push(['selectForNextRequest', selection]);
          append('model/selection', selection);
          projections.modelSelection = { next: selection };
        },
        selectionFor: () => ({ current: projections.modelSelection.next }),
      },
      selectModel: () => assert.fail('Never call a model setter that changes defaults.'),
    },
    permissionPresets: {
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
      set: (session, value) => permissions.set(session.id, value),
      current: session => permissions.get(session.id) ?? 'danger-full-access',
    },
    llm: { resolveCallConfig: async selection => ({ ...selection, reasoningEffort: selection.reasoningEffort ?? 'high' }) },
    sessions: { flush: async session => calls.push(['flush', session.id]) },
    agents: { get: id => id === agent.id ? agent : undefined },
  };
  return { ctx, calls, events, append, agent, pending, projections, permissions };
}

test('catalog normalizes native providers, reasoning options, presets, and sessions', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  const catalog = await adapter.catalog();
  assert.deepEqual(catalog.workspaces, [{ workspaceId: 'workspace-1', path: 'C:/project', title: '项目' }]);
  assert.deepEqual(catalog.models[0].reasoningEfforts, ['high', 'low']);
  assert.equal(catalog.models[0].default, true);
  assert.deepEqual(catalog.presets, [{ id: 'standard', label: '标准', default: true }]);
  assert.equal(catalog.sessions[0].title, '已有会话');
  assert.deepEqual(fixture.calls[0], ['peer', { principal: { kind: 'owner' }, interactions: 'none' }]);
  await adapter.dispose();
});

test('create uses workspace RPC, pins human approval, and changes only the session model', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  const result = await adapter.create({
    workspaceId: 'workspace-1', preset: 'standard',
    selection: { provider: 'local', model: 'model-a', reasoningEffort: 'low' }, title: '协作验收',
  });
  assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(fixture.calls.find(([name]) => name === 'session.create')[1], {
    request: { workspaceId: 'workspace-1', agentPreset: 'standard' },
  });
  assert.equal(fixture.permissions.get('session-1'), 'workspace-write');
  assert.equal(fixture.events[0].type, 'model/selection');
  assert.equal(fixture.events[0].data.reasoningEffort, 'low');
  assert.ok(fixture.calls.some(([name]) => name === 'flush'));
});

test('createWorkspace uses the public workspace RPC and returns normalized metadata', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  assert.deepEqual(await adapter.createWorkspace('C:/acceptance'), {
    workspaceId: 'workspace-2', path: 'C:/acceptance', title: '验收',
  });
  assert.deepEqual(fixture.calls.find(([name]) => name === 'workspace.create')[1], {
    request: { path: 'C:/acceptance' },
  });
});

test('unsafe permission configuration and unsupported models fail before session creation', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  await assert.rejects(adapter.create({
    workspaceId: 'workspace-1', selection: { provider: 'local', model: 'model-a', reasoningEffort: 'invented' },
  }), { code: 'INVALID_REASONING_EFFORT' });
  fixture.ctx.permissionPresets.resolve = () => ({ sandbox: 'danger-full-access', approval: 'never' });
  await assert.rejects(adapter.create({ workspaceId: 'workspace-1' }), { code: 'HOST_INCOMPATIBLE' });
  assert.ok(!fixture.calls.some(([name]) => name === 'session.create'));
});

test('stable message ids deduplicate durable inbox entries and reject conflicting content', async () => {
  const fixture = harness();
  fixture.permissions.set('session-1', 'workspace-write');
  const adapter = createHostAdapter(fixture.ctx);
  const message = { text: '请核实', source: { principal: 'codex' }, messageId: 'message-1' };
  assert.equal(await adapter.send('session-1', message), 'message-1');
  assert.equal(await adapter.send('session-1', message), 'message-1');
  assert.equal(fixture.pending.nextTurn.length, 1);
  assert.equal(fixture.pending.nextTurn[0].source.kind, 'dsh-collaboration');
  assert.ok(Object.isFrozen(fixture.pending.nextTurn[0].content[0]));
  await assert.rejects(adapter.send('session-1', { ...message, text: '不同任务' }), { code: 'IDEMPOTENCY_CONFLICT' });
  fixture.permissions.set('session-1', 'danger-full-access');
  await assert.rejects(adapter.send('session-1', { ...message, messageId: 'message-2' }), { code: 'UNSAFE_SESSION_PERMISSIONS' });
});

test('takeover removes only the matching principal pending inputs and leaves the active turn alone', async () => {
  const fixture = harness();
  fixture.agent.status = 'running';
  fixture.pending.nextTurn.push(
    { id: 'own', source: { kind: 'dsh-collaboration', principal: 'codex' } },
    { id: 'other', source: { kind: 'dsh-collaboration', principal: 'hermes' } },
    { id: 'human', source: { kind: 'user' } },
  );
  fixture.pending.nextStep.push({ id: 'own-steer', source: { kind: 'dsh-collaboration', principal: 'codex' } });
  const adapter = createHostAdapter(fixture.ctx);
  const result = await adapter.takeover('session-1', 'codex');
  assert.deepEqual(result.removedMessageIds, ['own', 'own-steer']);
  assert.deepEqual(fixture.pending.nextTurn.map(message => message.id), ['other', 'human']);
  assert.equal(fixture.agent.status, 'running');
  assert.ok(!fixture.calls.some(([name]) => name === 'cancel'));
});

test('inspect requires a durable terminal event and preserves failure, cancellation, and partial output', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  assert.equal((await adapter.inspect('session-1')).status, 'idle');
  fixture.append('turn/start', { turn: 1 });
  fixture.append('assistant/message', { message: { content: [{ type: 'text', text: '答案' }] } });
  assert.equal((await adapter.inspect('session-1')).status, 'idle');
  const end = fixture.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal((await adapter.inspect('session-1')).status, 'succeeded');
  assert.equal((await adapter.inspect('session-1')).assistantText, '答案');
  end.data.reason = { kind: 'error', error: { message: 'Failed' } };
  assert.equal((await adapter.inspect('session-1')).status, 'failed');
  end.data.reason = { kind: 'aborted', reason: { kind: 'user' } };
  assert.equal((await adapter.inspect('session-1')).status, 'cancelled');
  end.data.reason = { kind: 'max-tokens' };
  assert.equal((await adapter.inspect('session-1')).status, 'incomplete');
});

test('inspect tracks approval audit pairs without answering them', async () => {
  const fixture = harness();
  fixture.agent.status = 'running';
  const adapter = createHostAdapter(fixture.ctx);
  fixture.append('approval/asked', { id: 'approval-1', toolName: 'shell', reason: 'Write outside workspace' });
  assert.equal((await adapter.inspect('session-1')).status, 'awaiting_approval');
  fixture.append('approval/decided', { id: 'approval-1', outcome: 'rejected' });
  assert.equal((await adapter.inspect('session-1')).status, 'running');
  assert.deepEqual((await adapter.inspect('session-1')).pendingApprovals, []);
});

test('pending native inputs keep the session busy between completed turns', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  fixture.append('turn/start', { turn: 1 });
  fixture.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const pendingMessage = { id: 'queued', source: { kind: 'user' } };
  for (const target of ['nextTurn', 'nextStep']) {
    fixture.pending[target].push(pendingMessage);
    const view = await adapter.inspect('session-1');
    assert.equal(view.running, true);
    assert.equal(view.status, 'running');
    await assert.rejects(adapter.selectModel('session-1', {
      provider: 'local', model: 'model-a', reasoningEffort: 'low',
    }), { code: 'SESSION_BUSY' });
    fixture.pending[target].pop();
  }
  assert.equal((await adapter.inspect('session-1')).running, false);
  assert.equal((await adapter.inspect('session-1')).status, 'succeeded');
});

test('adopt returns workspace and current resources without changing session permissions', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  const adopted = await adapter.adopt('session-1');
  assert.deepEqual(adopted, {
    workspaceId: 'workspace-1', workspace: 'C:/project', preset: 'standard',
    selection: { provider: 'local', model: 'model-a', reasoningEffort: 'high' },
    title: '已有会话', status: 'idle',
  });
  assert.equal(fixture.permissions.size, 0);
});

test('selectModel retains global defaults and rejects changing a running session', async () => {
  const fixture = harness();
  const adapter = createHostAdapter(fixture.ctx);
  const selection = { provider: 'local', model: 'model-a', reasoningEffort: 'low' };
  assert.deepEqual(await adapter.selectModel('session-1', selection), selection);
  fixture.agent.status = 'running';
  await assert.rejects(adapter.selectModel('session-1', selection), { code: 'SESSION_BUSY' });
  assert.equal(fixture.events.filter(event => event.type === 'model/selection').length, 1);
});

function interactionHarness() {
  const fixture = harness();
  const pendingNative = new Map();
  const streams = [];
  const submissions = [];
  const peers = [];
  let dispatchResult = { ok: true };
  fixture.ctx.agents.get = id => id === 'session-1' ? fixture.agent
    : id === 'session-2' ? { id, session: { id } } : undefined;
  fixture.ctx.connection.createPeer = options => {
    const peer = { options, disposed: false, async dispose() { this.disposed = true; } };
    peers.push(peer);
    return peer;
  };
  fixture.ctx.typertGateway.wireStream = {
    async open(endpoint, payload, uplink, peer, signal) {
      assert.equal(endpoint, '$events');
      assert.deepEqual(payload, { args: {} });
      assert.equal(uplink, undefined);
      assert.equal(peer.options.interactions, 'answer');
      const state = {
        peer, signal, clientId: `native-client-${streams.length + 1}`,
        frames: [...pendingNative.values()], wake: undefined, ended: false,
      };
      streams.push(state);
      return (async function* () {
        yield { type: 'ready', clientId: state.clientId, host: 'desktop' };
        const abort = () => state.wake?.();
        signal.addEventListener('abort', abort);
        try {
          while (!signal.aborted && !state.ended) {
            if (state.frames.length) yield state.frames.shift();
            else await new Promise(resolve => { state.wake = resolve; });
          }
        } finally { signal.removeEventListener('abort', abort); }
      })();
    },
  };
  fixture.ctx.typertGateway.dispatchRpc = async (endpoint, payload, signal, peer) => {
    assert.equal(endpoint, '$events/result');
    const stream = streams.find(item => item.clientId === payload.args.clientId);
    assert.equal(peer, stream?.peer);
    assert.equal(signal.aborted, false);
    submissions.push(payload.args);
    if (payload.args.outcome.kind === 'result' && dispatchResult.ok === true) {
      pendingNative.delete(payload.args.eventId);
    }
    return dispatchResult;
  };
  return {
    ...fixture, peers, submissions, pendingNative,
    async emit(frame) {
      if (frame.type === 'waterfall') pendingNative.set(frame.eventId, frame);
      if (frame.type === 'cancel') pendingNative.delete(frame.eventId);
      for (const stream of streams.filter(item => !item.signal.aborted && !item.ended)) {
        stream.frames.push(frame); stream.wake?.();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
    async end() {
      const stream = streams.at(-1);
      stream.ended = true; stream.wake?.();
      await new Promise(resolve => setImmediate(resolve));
    },
    setDispatchResult(value) { dispatchResult = value; },
  };
}

function scopedInteractionAdapter(fixture) {
  const adapter = createHostAdapter(fixture.ctx);
  adapter.setInteractionScope(sessionId => sessionId === 'session-1');
  return adapter;
}

const approvalFrame = (id = 'approval-event', sessionId = 'session-1') => ({
  type: 'waterfall', event: 'approval/request', eventId: id, agentId: sessionId,
  request: { toolName: 'write', callId: 'write-call', reason: 'Only this file write needs approval' },
});
const questionFrame = (id = 'question-event', questions) => ({
  type: 'waterfall', event: 'user-questions/request', eventId: id, agentId: 'session-1',
  request: { questions: questions ?? [{ id: 'pick', question: 'Choose one',
    options: [{ label: 'A' }, { label: 'B' }] }] },
});

test('interaction stream starts lazily with a separate answer peer and returns scoped cloned views', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  assert.equal(fixture.peers.length, 1);
  assert.equal(fixture.peers[0].options.interactions, 'none');
  await Promise.all([adapter.ensureInteractions(), adapter.ensureInteractions()]);
  assert.equal(fixture.peers.length, 2);
  fixture.append('tool/call', { callId: 'write-call', name: 'write',
    arguments: '{"file_path":"test.txt","content":"test"}' });
  await fixture.emit(approvalFrame());
  await fixture.emit(approvalFrame('foreign-event', 'session-2'));
  await fixture.emit(questionFrame());
  const listed = await adapter.listInteractions('session-1');
  assert.deepEqual(listed.map(item => item.kind), ['approval', 'question']);
  assert(listed.every(item => !Object.hasOwn(item, 'nativeId')));
  assert.notEqual(listed[0].id, 'approval-event');
  assert.equal(listed[0].toolCall.name, 'write');
  assert.equal(listed[0].sessionId, 'session-1');
  assert(!Number.isNaN(Date.parse(listed[0].createdAt)));
  listed[1].questions[0].options[0].label = 'Mutated';
  assert.equal((await adapter.listInteractions('session-1'))[1].questions[0].options[0].label, 'A');
  assert.deepEqual(fixture.submissions, [{
    clientId: 'native-client-1', eventId: 'foreign-event', outcome: { kind: 'next' },
  }]);
  assert.deepEqual(await adapter.listInteractions('session-2'), []);
});

test('approval replies reject foreign scopes, invalid decisions and extras before a single submission', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  await adapter.ensureInteractions();
  await fixture.emit(approvalFrame());
  const [{ id }] = await adapter.listInteractions('session-1');
  assert.throws(() => adapter.validateInteractionResponse('session-2', id,
    { kind: 'approval', decision: 'allowed-once' }), { code: 'INTERACTION_SESSION_DENIED' });
  for (const response of [
    { kind: 'approval', decision: 'allow-always' },
    { kind: 'approval', decision: 'cancelled' },
    { kind: 'approval', decision: 'allowed-once', always: true },
    { kind: 'question', answers: [] },
  ]) {
    assert.throws(() => adapter.validateInteractionResponse('session-1', id, response),
      { code: 'INTERACTION_INVALID_RESPONSE' });
  }
  assert.equal((await adapter.listInteractions('session-1')).length, 1);
  assert.equal(adapter.validateInteractionResponse('session-1', id,
    { kind: 'approval', decision: 'allowed-once' }), undefined);
  assert.equal(fixture.submissions.length, 0);
  const responses = await Promise.allSettled([1, 2].map(() => adapter.respondInteraction(
    'session-1', id, { kind: 'approval', decision: 'allowed-once' })));
  assert.equal(responses.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(responses.find(result => result.status === 'fulfilled').value, { status: 'submitted' });
  assert.equal(responses.find(result => result.status === 'rejected').reason.code, 'INTERACTION_NOT_PENDING');
  assert.deepEqual(fixture.submissions, [{
    clientId: 'native-client-1', eventId: 'approval-event',
    outcome: { kind: 'result', value: 'allowed-once' },
  }]);
  assert.deepEqual(await adapter.listInteractions('session-1'), []);
});

test('native UI winning or cancelling removes the bridge request and rejects stale replies', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  await adapter.ensureInteractions();
  await fixture.emit(approvalFrame());
  const [{ id }] = await adapter.listInteractions('session-1');
  await fixture.emit({ type: 'cancel', eventId: 'approval-event' });
  await assert.rejects(adapter.respondInteraction('session-1', id,
    { kind: 'approval', decision: 'rejected' }), { code: 'INTERACTION_NOT_PENDING' });
  assert.deepEqual(await adapter.listInteractions('session-1'), []);
  assert.deepEqual(fixture.submissions, []);
});

test('question validation matches every native id, option and selection mode without consuming invalid answers', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  await adapter.ensureInteractions();
  await fixture.emit(questionFrame());
  const [{ id }] = await adapter.listInteractions('session-1');
  for (const answers of [
    [], [{ id: 'other', selected: ['A'] }], [{ id: 'pick', selected: ['unknown'] }],
    [{ id: 'pick', selected: ['A', 'B'] }], [{ id: 'pick', selected: ['A', 'A'] }],
    [{ id: 'pick', selected: ['A'], custom: 'Another answer' }],
    [{ id: 'pick', selected: [], custom: 42 }], [{ id: 'pick', selected: [], extra: true }],
    [{ id: 'pick', selected: [] }, { id: 'pick', selected: [] }],
  ]) {
    assert.throws(() => adapter.validateInteractionResponse('session-1', id,
      { kind: 'question', answers }), { code: 'INTERACTION_INVALID_RESPONSE' });
  }
  assert.equal((await adapter.listInteractions('session-1')).length, 1);
  const answer = { kind: 'question', answers: [{ id: 'pick', selected: [], custom: 'My answer' }] };
  assert.deepEqual(await adapter.respondInteraction('session-1', id, answer), { status: 'submitted' });
  assert.deepEqual(fixture.submissions[0].outcome, { kind: 'result', value: { answers: answer.answers } });
  await fixture.emit(questionFrame('multi', [{ id: 'many', question: 'Choose', multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }] }]));
  const [multi] = await adapter.listInteractions('session-1');
  await adapter.respondInteraction('session-1', multi.id, { kind: 'question',
    answers: [{ id: 'many', selected: ['A', 'B'], custom: 'And this' }] });
  assert.equal(fixture.submissions.length, 2);
});

test('uncertain native submission is not replayed and only claims submitted on RPC success', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  await adapter.ensureInteractions();
  await fixture.emit(approvalFrame());
  const [{ id }] = await adapter.listInteractions('session-1');
  fixture.setDispatchResult({ ok: false, error: { code: 'temporary' } });
  await assert.rejects(adapter.respondInteraction('session-1', id,
    { kind: 'approval', decision: 'rejected' }), { code: 'INTERACTION_SUBMISSION_FAILED' });
  await assert.rejects(adapter.respondInteraction('session-1', id,
    { kind: 'approval', decision: 'rejected' }), { code: 'INTERACTION_NOT_PENDING' });
  assert.equal(fixture.submissions.length, 1);
});

test('stream disposal and unavailable host support fail closed without answering a pending prompt', async () => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  await adapter.ensureInteractions();
  await fixture.emit(questionFrame());
  await adapter.dispose();
  assert(fixture.peers.every(peer => peer.disposed));
  assert.deepEqual(fixture.submissions, []);
  await assert.rejects(adapter.listInteractions('session-1'), { code: 'HOST_DISPOSED' });
  const plain = createHostAdapter(harness().ctx);
  await assert.rejects(plain.ensureInteractions(), { code: 'HOST_INCOMPATIBLE' });
  await plain.dispose();
});

test('unexpected native stream end invalidates every pending request', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  await adapter.ensureInteractions();
  await fixture.emit(approvalFrame());
  await fixture.end();
  await assert.rejects(adapter.listInteractions('session-1'), { code: 'INTERACTIONS_UNAVAILABLE' });
  assert.throws(() => adapter.validateInteractionResponse('session-1', 'approval-event',
    { kind: 'approval', decision: 'allowed-once' }), { code: 'INTERACTIONS_UNAVAILABLE' });
  assert.deepEqual(fixture.submissions, []);
});

test('interaction forwarding declines every session by default and fails closed on a scope exception', async t => {
  const fixture = interactionHarness();
  const adapter = createHostAdapter(fixture.ctx);
  t.after(() => adapter.dispose());
  await adapter.refreshInteractionScope();
  assert.equal(fixture.peers.length, 1);
  await adapter.ensureInteractions();
  await fixture.emit(approvalFrame());
  assert.deepEqual(await adapter.listInteractions('session-1'), []);
  adapter.setInteractionScope(() => { throw new Error('Invalid policy'); });
  await fixture.emit(questionFrame());
  assert.deepEqual(await adapter.listInteractions('session-1'), []);
  assert.deepEqual(fixture.submissions.map(item => item.outcome), [{ kind: 'next' }, { kind: 'next' }]);
  assert.throws(() => adapter.setInteractionScope(undefined), { code: 'INVALID_INTERACTION_SCOPE' });
});

test('scope removal releases pending requests and returning control replays them with fresh public ids', async t => {
  const fixture = interactionHarness();
  const adapter = createHostAdapter(fixture.ctx);
  t.after(() => adapter.dispose());
  let enabled = true;
  adapter.setInteractionScope(sessionId => enabled && sessionId === 'session-1');
  await adapter.ensureInteractions();
  await fixture.emit(approvalFrame());
  await fixture.emit(questionFrame());
  const before = await adapter.listInteractions('session-1');
  assert.equal(before.length, 2);
  enabled = false;
  assert.throws(() => adapter.validateInteractionResponse('session-1', before[0].id,
    { kind: 'approval', decision: 'allowed-once' }), { code: 'INTERACTION_SCOPE_DENIED' });
  assert.deepEqual(await adapter.listInteractions('session-1'), []);
  await adapter.refreshInteractionScope();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.peers[0].disposed, false);
  assert.equal(fixture.peers[1].disposed, true);
  assert.deepEqual(await adapter.listInteractions('session-1'), []);
  assert.equal(fixture.pendingNative.size, 2);
  assert.deepEqual(fixture.submissions.map(item => item.outcome),
    [{ kind: 'next' }, { kind: 'next' }, { kind: 'next' }, { kind: 'next' }]);
  enabled = true;
  await adapter.refreshInteractionScope();
  await new Promise(resolve => setImmediate(resolve));
  const returned = await adapter.listInteractions('session-1');
  assert.equal(returned.length, 2);
  assert(returned.every(item => !before.some(old => old.id === item.id)));
  assert.equal(fixture.peers.length, 4);
  assert.equal(fixture.peers[0].disposed, false);
  for (const old of before) {
    assert.throws(() => adapter.validateInteractionResponse('session-1', old.id,
      { kind: 'approval', decision: 'allowed-once' }), { code: 'INTERACTION_NOT_PENDING' });
  }
  await fixture.emit({ type: 'cancel', eventId: 'question-event' });
  assert.deepEqual((await adapter.listInteractions('session-1')).map(item => item.kind), ['approval']);
  const approval = returned.find(item => item.kind === 'approval');
  await adapter.respondInteraction('session-1', approval.id, { kind: 'approval', decision: 'rejected' });
  assert.deepEqual(fixture.submissions.at(-1), {
    clientId: 'native-client-3', eventId: 'approval-event', outcome: { kind: 'result', value: 'rejected' },
  });
});

test('refresh preserves still-owned native requests without declining them and serializes peer replacement', async t => {
  const fixture = interactionHarness();
  const adapter = scopedInteractionAdapter(fixture);
  t.after(() => adapter.dispose());
  await adapter.ensureInteractions();
  await fixture.emit(questionFrame());
  const [old] = await adapter.listInteractions('session-1');
  await Promise.all([adapter.refreshInteractionScope(), adapter.refreshInteractionScope(), adapter.ensureInteractions()]);
  await new Promise(resolve => setImmediate(resolve));
  const [current] = await adapter.listInteractions('session-1');
  assert.notEqual(current.id, old.id);
  assert.equal(fixture.pendingNative.size, 1);
  assert.deepEqual(fixture.submissions, []);
  assert.equal(fixture.peers.filter(peer => !peer.disposed).length, 2);
  await adapter.dispose();
  assert(fixture.peers.every(peer => peer.disposed));
});
