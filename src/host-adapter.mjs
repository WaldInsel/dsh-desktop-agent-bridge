import { randomUUID } from 'node:crypto';

function fail(message, code = 'HOST_INCOMPATIBLE') {
  throw Object.assign(new Error(message), { code });
}

function sessionSummary(item) {
  const values = item.projections?.values ?? {};
  const title = values.title?.title ?? values.title?.text ?? values.title ?? item.title;
  return {
    sessionId: item.sessionId,
    title: typeof title === 'string' ? title : item.sessionId,
    cwd: values.workingDirectory ?? item.cwd,
    preset: values.agentPreset ?? '',
    running: item.running === true,
  };
}

function terminalStatus(reason, interrupted) {
  if (reason?.kind === 'completed') return interrupted ? 'incomplete' : 'succeeded';
  if (reason?.kind === 'max-tokens') return 'incomplete';
  if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') return 'cancelled';
  return 'failed';
}

/** The ordinary control peer cannot answer; the optional interaction peer is separate. */
export function createHostAdapter(ctx) {
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  let disposed = false;
  let interactions;
  let interactionScope = () => false;
  let interactionRefresh = Promise.resolve();
  const pendingQuestions = new Map();
  const offQuestions = ctx.on?.('user-questions/request', async (request, next) => {
    const sessionId = request.agent?.session.id;
    if (!sessionId) return next();
    const pending = { requestId: randomUUID(), questions: request.questions };
    const entries = pendingQuestions.get(sessionId) ?? new Set();
    entries.add(pending);
    pendingQuestions.set(sessionId, entries);
    try {
      return await next();
    } finally {
      entries.delete(pending);
      if (!entries.size) pendingQuestions.delete(sessionId);
    }
  }, { prepend: true, global: true });

  const invoke = (namespace, method, args) => {
    if (disposed) fail('DSH collaboration adapter is disposed.', 'HOST_DISPOSED');
    return ctx.typertGateway.invoke({ namespace, method, args, peer });
  };

  async function first(namespace, method, args) {
    if (disposed) fail('DSH collaboration adapter is disposed.', 'HOST_DISPOSED');
    const abort = new AbortController();
    let iterator;
    try {
      const stream = await ctx.typertGateway.stream({ namespace, method, args, peer, signal: abort.signal });
      iterator = stream[Symbol.asyncIterator]();
      const result = await iterator.next();
      if (result.done) fail(`${namespace}.${method} returned no baseline.`);
      return result.value;
    } finally {
      abort.abort();
      await iterator?.return?.();
    }
  }

  async function agentFor(sessionId) {
    const found = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in found) throw found.error;
    return found.agent;
  }

  async function history(sessionId) {
    const address = { kind: 'session', sessionId };
    const snapshot = await first('session', 'follow', {
      request: { address, maxMessages: 100, assistantStream: true },
    });
    if (snapshot.type !== 'snapshot') fail('session.follow returned an incompatible snapshot.');
    let events = snapshot.records.map(record => record.event);
    let hasMore = snapshot.hasMore;
    while (hasMore) {
      const beforeSeq = events[0]?.seq;
      if (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) fail('Session history pagination made no progress.');
      const page = await invoke('session', 'page', {
        request: { address, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 100 },
      });
      const older = page.records.map(record => record.event);
      if (!older.length || older.at(-1).seq >= beforeSeq) fail('Session history pagination returned overlapping events.');
      events = [...older, ...events];
      hasMore = page.hasMore;
    }
    return { ...snapshot, events };
  }

  function requireHumanPermissions() {
    const spec = ctx.permissionPresets.resolve('workspace-write');
    if (spec.sandbox !== 'workspace-write' || spec.approval !== 'ask') {
      fail('The workspace-write permission preset must use workspace-write confinement and human approval.');
    }
  }

  async function catalog() {
    const [workspaceFrame, modelCatalog, presetCatalog, sessionCatalog] = await Promise.all([
      first('workspace', 'follow', {}),
      invoke('session', 'modelCatalog', {}),
      invoke('agentPresets', 'list', {}),
      invoke('session', 'list', { _request: {} }),
    ]);
    if (workspaceFrame.type !== 'baseline') fail('workspace.follow returned an incompatible baseline.');
    return {
      workspaces: workspaceFrame.value.items.map(({ workspaceId, path, title }) => ({ workspaceId, path, title })),
      models: modelCatalog.groups.flatMap(group => group.models.map(model => ({
        provider: group.id,
        model: model.id,
        label: `${group.name ?? group.id} / ${model.name ?? model.id}`,
        reasoningEfforts: model.reasoning?.efforts.map(effort => effort.id) ?? [],
        default: group.id === modelCatalog.default?.provider && model.id === modelCatalog.default?.model,
        ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort }),
      }))),
      presets: presetCatalog.presets.filter(preset => !preset.broken).map(preset => ({
        id: preset.id,
        label: preset.name ?? preset.id,
        default: preset.isDefault === true,
      })),
      sessions: sessionCatalog.items.map(sessionSummary),
    };
  }

  async function createWorkspace(path) {
    const { workspace } = await invoke('workspace', 'create', { request: { path } });
    return { workspaceId: workspace.workspaceId, path: workspace.path, title: workspace.title };
  }

  async function create({ workspaceId, preset, selection, title }) {
    requireHumanPermissions();
    const available = await catalog();
    if (!available.workspaces.some(workspace => workspace.workspaceId === workspaceId)) {
      fail('Choose an existing DSH workspace.', 'INVALID_WORKSPACE');
    }
    const presetId = preset || available.presets.find(item => item.default)?.id;
    if (!presetId || !available.presets.some(item => item.id === presetId)) {
      fail('Choose an available DSH capability preset.', 'INVALID_PRESET');
    }
    const sessionSelection = await validateSelection(selection, available.models);
    const created = await invoke('session', 'create', {
      request: { workspaceId, agentPreset: presetId },
    });
    const agent = await agentFor(created.sessionId);
    ctx.permissionPresets.set(agent.session, 'workspace-write');
    if (ctx.permissionPresets.current(agent.session) !== 'workspace-write') {
      fail('DSH did not retain the required permission preset.');
    }
    ctx.sessionController.agents.selectForNextRequest(agent, sessionSelection);
    if (title) await invoke('session', 'rename', { request: { sessionId: created.sessionId, title } });
    await ctx.sessions.flush(agent.session);
    return { sessionId: created.sessionId, preset: presetId, selection: sessionSelection };
  }

  async function validateSelection(selection, models) {
    const selected = selection ?? models.find(model => model.default);
    const model = models.find(item => item.provider === selected?.provider && item.model === selected?.model);
    if (!model) fail('Choose an available DSH model.', 'INVALID_MODEL');
    if (selected.reasoningEffort !== undefined && !model.reasoningEfforts.includes(selected.reasoningEffort)) {
      fail('The selected model does not support this reasoning effort.', 'INVALID_REASONING_EFFORT');
    }
    const resolved = await ctx.llm.resolveCallConfig({
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    });
    const normalized = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    };
    // shortcut: DSH 0.2.1 controller seam; require an explicit adapter update when this method changes.
    if (typeof ctx.sessionController.agents?.selectForNextRequest !== 'function') {
      fail('This DSH version lacks the session-only model selection method.');
    }
    return normalized;
  }

  async function selectModel(sessionId, selection) {
    const normalized = await validateSelection(selection, (await catalog()).models);
    const agent = await agentFor(sessionId);
    if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      fail('Choose the next model after the current turn and pending inputs end.', 'SESSION_BUSY');
    }
    ctx.sessionController.agents.selectForNextRequest(agent, normalized);
    await ctx.sessions.flush(agent.session);
    return normalized;
  }

  async function inspect(sessionId) {
    const snapshot = await history(sessionId);
    const { events } = snapshot;
    const agent = ctx.agents.get(sessionId);
    const hasPending = (agent?.inbox.nextTurn.length ?? 0) + (agent?.inbox.nextStep.length ?? 0) > 0;
    const running = agent?.status === 'running' || hasPending;
    const approvals = new Map();
    let lastStart;
    let lastEnd;
    let lastAssistant;
    const text = [];
    for (const event of events) {
      if (event.type === 'turn/start') lastStart = event;
      if (event.type === 'turn/end') lastEnd = event;
      if (event.type === 'approval/asked') approvals.set(event.data.id, event.data);
      if (event.type === 'approval/decided') approvals.delete(event.data.id);
      if (event.type === 'assistant/message') {
        lastAssistant = event;
        const content = event.data.message?.content ?? [];
        const rendered = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (rendered) text.push(rendered);
      }
    }
    const values = snapshot.projections?.values ?? {};
    const questions = [
      ...pendingQuestions.get(sessionId) ?? [],
      ...(values.userQuestions?.active ?? []).filter(question => question.state === 'open'),
    ];
    let status = 'idle';
    if (approvals.size) status = 'awaiting_approval';
    else if (questions.length) status = 'awaiting_input';
    else if (running) status = 'running';
    else if (lastEnd && (!lastStart || lastEnd.seq > lastStart.seq)) {
      status = terminalStatus(lastEnd.data.reason, lastAssistant?.data.interrupted === true);
    }
    return {
      sessionId, running, status, events,
      lastSeq: snapshot.cursor,
      assistantText: text.join('\n\n'),
      assistantStream: snapshot.assistantStream,
      pendingApprovals: [...approvals.values()],
      pendingQuestions: questions,
      selection: values.modelSelection?.next ?? values.modelSelection?.lastUsed,
      preset: values.agentPreset ?? '',
      cwd: values.workingDirectory ?? snapshot.header?.cwd,
      endingReason: lastEnd?.data.reason,
      title: typeof values.title === 'string' ? values.title : sessionId,
    };
  }

  async function send(sessionId, { text, source, mode = 'queue', messageId = randomUUID() }) {
    if (typeof text !== 'string' || !text.trim()) fail('A nonempty message is required.', 'INVALID_MESSAGE');
    if (!['queue', 'steer'].includes(mode)) fail('Unsupported message delivery mode.', 'INVALID_MESSAGE');
    if (typeof source?.principal !== 'string' || !source.principal) fail('An authenticated source principal is required.', 'INVALID_PRINCIPAL');
    const agent = await agentFor(sessionId);
    requireHumanPermissions();
    if (ctx.permissionPresets.current(agent.session) !== 'workspace-write') {
      fail('Select workspace-write with human approval in this DSH session before handing it to an external agent.', 'UNSAFE_SESSION_PERMISSIONS');
    }
    const snapshot = await history(sessionId);
    const accepted = snapshot.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted : event.type === 'user/message' ? [event.data] : []);
    const existing = accepted.find(message => message.id === messageId);
    if (existing) {
      if (existing.source?.principal !== source.principal
        || existing.content?.map(block => block.text ?? '').join('') !== text) {
        fail('This message identifier already belongs to a different request.', 'IDEMPOTENCY_CONFLICT');
      }
      return messageId;
    }
    const message = Object.freeze({
      id: messageId,
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text })]),
      source: Object.freeze({ kind: 'dsh-collaboration', principal: source.principal, rpcId: messageId }),
    });
    if (mode === 'steer') agent.steer(message);
    else agent.followup(message);
    await ctx.sessions.flush(agent.session);
    return messageId;
  }

  async function takeover(sessionId, principal) {
    const agent = await agentFor(sessionId);
    const removed = [];
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (message.source.kind === 'dsh-collaboration' && message.source.principal === principal
        && agent.inbox.remove(message.id)) removed.push(message.id);
    }
    await ctx.sessions.flush(agent.session);
    return { removedMessageIds: removed };
  }

  async function cancel(sessionId) {
    const agent = await agentFor(sessionId);
    agent.cancel({ kind: 'user' });
    return { accepted: true };
  }

  async function adopt(sessionId) {
    const agent = await agentFor(sessionId);
    const [state, workspaceFrame] = await Promise.all([
      inspect(sessionId),
      first('workspace', 'follow', {}),
    ]);
    if (workspaceFrame.type !== 'baseline') fail('workspace.follow returned an incompatible baseline.');
    const workspace = workspaceFrame.value.items.find(item => item.sessionIds.includes(sessionId));
    if (!workspace) fail('This session is not attached to a DSH workspace.', 'INVALID_WORKSPACE');
    const selection = state.selection ?? ctx.sessionController.agents.selectionFor(agent).current;
    return {
      workspaceId: workspace.workspaceId,
      workspace: workspace.path,
      preset: state.preset,
      selection: { ...selection },
      title: state.title,
      status: state.status,
    };
  }

  function setInteractionScope(predicate) {
    if (typeof predicate !== 'function') fail('An interaction scope predicate is required.', 'INVALID_INTERACTION_SCOPE');
    interactionScope = predicate;
  }

  function hasInteractionScope(sessionId) {
    try { return interactionScope(sessionId) === true; }
    catch { return false; }
  }

  async function startInteractions() {
    if (disposed) fail('DSH collaboration adapter is disposed.', 'HOST_DISPOSED');
    if (interactions?.error) fail('The native interaction stream is unavailable.', 'INTERACTIONS_UNAVAILABLE');
    if (interactions) return interactions.ready;
    if (typeof ctx.typertGateway.wireStream?.open !== 'function'
      || typeof ctx.typertGateway.dispatchRpc !== 'function') {
      fail('This DSH version lacks the native interaction stream.');
    }
    const state = {
      peer: ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }),
      abort: new AbortController(), pending: new Map(), byNative: new Map(),
      clientId: null, iterator: null, closing: false,
    };
    interactions = state;
    const submit = (eventId, outcome) => ctx.typertGateway.dispatchRpc('$events/result', {
      args: { clientId: state.clientId, eventId, outcome },
    }, state.abort.signal, state.peer);
    state.submit = submit;
    const receive = async frame => {
      if (frame.type === 'cancel') {
        state.pending.delete(state.byNative.get(frame.eventId));
        state.byNative.delete(frame.eventId);
        return;
      }
      if (frame.type !== 'waterfall') return;
      const sessionId = ctx.agents.get(frame.agentId)?.session.id;
      const kind = frame.event === 'approval/request' ? 'approval'
        : frame.event === 'user-questions/request' ? 'question' : null;
      if (!kind || !sessionId || !hasInteractionScope(sessionId)) {
        await submit(frame.eventId, { kind: 'next' });
        return;
      }
      if (typeof frame.eventId !== 'string' || !frame.eventId || !frame.request
        || (kind === 'question' && !Array.isArray(frame.request.questions))) {
        fail('The native interaction frame is incompatible.');
      }
      if (state.byNative.has(frame.eventId)) return;
      if (state.pending.size >= 256) fail('Too many native interactions.', 'INTERACTION_CAPACITY');
      const request = frame.request;
      // Each replay gets a fresh public id; native gateway ids never cross the adapter boundary.
      const id = randomUUID();
      state.byNative.set(frame.eventId, id);
      state.pending.set(id, {
        id, nativeId: frame.eventId, kind, sessionId, createdAt: new Date().toISOString(),
        ...(kind === 'approval' ? {
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        } : { questions: structuredClone(request.questions) }),
      });
    };
    state.ready = (async () => {
      const deadline = setTimeout(() => state.abort.abort(new Error('Native interaction startup timed out')), 5000);
      deadline.unref();
      try {
        // shortcut: DSH 0.2.1 native wire transport; fail closed if its reserved endpoints change.
        const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} },
          undefined, state.peer, state.abort.signal);
        state.iterator = stream[Symbol.asyncIterator]();
        const first = await state.iterator.next();
        if (state.abort.signal.aborted || first.done || first.value?.type !== 'ready'
          || typeof first.value.clientId !== 'string' || !first.value.clientId) {
          fail('The native interaction stream returned no ready frame.');
        }
        state.clientId = first.value.clientId;
        state.loop = (async () => {
          try {
            while (!state.abort.signal.aborted) {
              const item = await state.iterator.next();
              if (item.done) break;
              await receive(item.value);
            }
            if (!state.abort.signal.aborted) fail('The native interaction stream ended.');
          } catch (error) {
            if (!state.abort.signal.aborted) state.error = error;
          } finally {
            state.pending.clear();
            state.byNative.clear();
            state.abort.abort();
            try { await state.peer.dispose(); }
            catch (error) { state.error = error; }
          }
        })();
        return { ready: true };
      } catch (error) {
        state.error = error;
        state.abort.abort();
        await state.peer.dispose();
        throw error;
      } finally { clearTimeout(deadline); }
    })();
    return state.ready;
  }

  async function ensureInteractions() {
    await interactionRefresh;
    return startInteractions();
  }

  async function closeInteractions(state) {
    state.closing = true;
    state.pending.clear();
    state.byNative.clear();
    state.abort.abort();
    await state.peer.dispose();
    await Promise.allSettled([state.ready, state.loop]);
    await state.iterator?.return?.();
  }

  function refreshInteractionScope() {
    const refresh = interactionRefresh.then(async () => {
      if (disposed) fail('DSH collaboration adapter is disposed.', 'HOST_DISPOSED');
      const state = interactions;
      if (!state) return; // Keep the optional native answer peer lazy.
      state.closing = true;
      await state.ready.catch(() => {});
      try {
        if (!state.abort.signal.aborted) {
          for (const item of [...state.pending.values()]) {
            if (hasInteractionScope(item.sessionId)) continue;
            state.pending.delete(item.id);
            state.byNative.delete(item.nativeId);
            await state.submit(item.nativeId, { kind: 'next' });
          }
        }
      } finally {
        await closeInteractions(state);
        if (interactions === state) interactions = undefined;
      }
      // DSH only replays pending waterfalls to a new client. Closing the old peer does not
      // decline still-owned requests; the separate none peer and native UI are untouched.
      if (!disposed) await startInteractions();
    });
    interactionRefresh = refresh.catch(() => {});
    return refresh;
  }

  async function listInteractions(sessionId) {
    await ensureInteractions();
    const state = interactions;
    const selected = [...state.pending.values()].filter(item =>
      item.sessionId === sessionId && hasInteractionScope(sessionId));
    if (!selected.length) return [];
    const events = selected.some(item => item.kind === 'approval' && item.callId)
      ? (await history(sessionId)).events : [];
    return selected.filter(item => !state.closing && state.pending.get(item.id) === item
      && hasInteractionScope(item.sessionId)).map(item => {
      const toolCall = events.find(event => event.type === 'tool/call' && event.data.callId === item.callId)?.data;
      const { nativeId, ...view } = item;
      return structuredClone({ ...view, ...(toolCall ? { toolCall } : {}) });
    });
  }

  function interactionResponse(sessionId, id, response) {
    if (disposed) fail('DSH collaboration adapter is disposed.', 'HOST_DISPOSED');
    if (interactions?.error) fail('The native interaction stream is unavailable.', 'INTERACTIONS_UNAVAILABLE');
    const item = interactions?.closing ? undefined : interactions?.pending.get(id);
    if (!item) fail('This interaction is no longer pending.', 'INTERACTION_NOT_PENDING');
    if (item.sessionId !== sessionId) fail('This interaction belongs to another session.', 'INTERACTION_SESSION_DENIED');
    if (!hasInteractionScope(sessionId)) fail('Interaction forwarding is disabled for this session.', 'INTERACTION_SCOPE_DENIED');
    const invalid = () => fail('The response does not match the native interaction.', 'INTERACTION_INVALID_RESPONSE');
    if (!response || response.kind !== item.kind) invalid();
    let value;
    if (item.kind === 'approval') {
      if (Object.keys(response).some(key => !['kind', 'decision'].includes(key))
        || !['allowed-once', 'rejected'].includes(response.decision)) invalid();
      value = response.decision;
    } else {
      if (Object.keys(response).some(key => !['kind', 'answers'].includes(key))
        || !Array.isArray(response.answers) || response.answers.length !== item.questions.length
        || new Set(response.answers.map(answer => answer?.id)).size !== response.answers.length) invalid();
      for (const question of item.questions) {
        const answer = response.answers.find(candidate => candidate?.id === question.id);
        if (!answer || Object.keys(answer).some(key => !['id', 'selected', 'custom'].includes(key))
          || !Array.isArray(answer.selected)
          || new Set(answer.selected).size !== answer.selected.length
          || answer.selected.some(label => typeof label !== 'string' || !question.options?.some(option => option.label === label))
          || (answer.custom !== undefined && typeof answer.custom !== 'string')
          || (!question.multiSelect && answer.selected.length + (answer.custom?.trim() ? 1 : 0) > 1)) invalid();
      }
      value = { answers: structuredClone(response.answers) };
    }
    return value;
  }

  function validateInteractionResponse(sessionId, id, response) {
    interactionResponse(sessionId, id, response);
  }

  async function respondInteraction(sessionId, id, response) {
    await ensureInteractions();
    const value = interactionResponse(sessionId, id, response);
    const state = interactions;
    const item = state.pending.get(id);
    // Delete before awaiting: neither duplicates nor uncertain transport failures replay a grant.
    state.pending.delete(id);
    state.byNative.delete(item.nativeId);
    const result = await state.submit(item.nativeId, { kind: 'result', value });
    if (result?.ok !== true) fail('The native interaction response could not be submitted.', 'INTERACTION_SUBMISSION_FAILED');
    return { status: 'submitted' };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    offQuestions?.();
    pendingQuestions.clear();
    await interactionRefresh;
    if (interactions) await closeInteractions(interactions);
    await peer.dispose();
  }

  function uiStatus() {
    const modules = ctx.get('clientModules');
    const entry = modules?.graph().entries.find(item => item.id === 'dsh-agent-collaboration');
    return { published: !!entry, entry: entry ?? null };
  }

  return { catalog, createWorkspace, create, inspect, send, takeover, cancel, selectModel, adopt,
    setInteractionScope, refreshInteractionScope, ensureInteractions, listInteractions,
    validateInteractionResponse, respondInteraction, dispose, uiStatus };
}
