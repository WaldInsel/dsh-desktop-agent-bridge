import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { clientDescriptors, PACKAGE_NAME } from './protocol.mjs';
import css from './client.css';

const PANEL_ID = 'agent-collaboration';
const ACTIVE = new Set(['queued', 'preparing', 'unknown', 'running', 'waiting_approval', 'waiting_input', 'waiting_answer', 'waiting_for_approval', 'waiting_for_input', 'awaiting_approval', 'awaiting_input']);
const STATUS = {
  queued: '排队中', preparing: '准备中', unknown: '状态待核实', running: '执行中', waiting_approval: '等待你审批',
  waiting_for_approval: '等待你审批', waiting_input: '等待你回答',
  awaiting_approval: '等待你审批', awaiting_input: '等待你回答',
  waiting_for_input: '等待你回答', waiting_answer: '等待你回答',
  completed: '已完成', succeeded: '已完成', failed: '失败', blocked: '需要处理', cancelled: '已停止',
  canceled: '已停止', interrupted: '已中断', idle: '空闲',
};

export function statusLabel(status) {
  return STATUS[status] || (status ? `状态：${status}` : '状态待确认');
}

export function groupSessions(data) {
  const groups = new Map((data?.clients || []).map(client => [client.id, { ...client, sessions: [] }]));
  for (const session of data?.sessions || []) {
    if (!groups.has(session.principal)) {
      groups.set(session.principal, { id: session.principal, label: session.principal, connected: false, sessions: [] });
    }
    groups.get(session.principal).sessions.push(session);
  }
  return [...groups.values()];
}

export function replaceClientPolicy(clients, changed) {
  return clients.map(client => client.id === changed.id ? { ...client, ...changed } : client);
}

// One subscription loop serves both surfaces; late responses cannot revive an unmounted view.
export function createCollaborationStore(remote) {
  let state = { data: null, loadError: '', actionError: '', busy: false };
  let timer;
  let epoch = 0;
  let sequence = 0;
  let disposed = false;
  const listeners = new Set();
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const request = ++sequence;
    const generation = epoch;
    try {
      const data = await remote('snapshot');
      if (!disposed && listeners.size && generation === epoch && request === sequence) publish({ data, loadError: '' });
    } catch (error) {
      if (!disposed && listeners.size && generation === epoch && request === sequence) publish({ loadError: error.message || String(error) });
    }
  };
  const poll = async generation => {
    await refresh();
    if (!disposed && listeners.size && generation === epoch) timer = setTimeout(() => poll(generation), 2500);
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) void poll(++epoch);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          epoch++;
          clearTimeout(timer);
        }
      };
    },
    refresh,
    async act(action) {
      if (disposed || state.busy) return { ok: false };
      publish({ busy: true, actionError: '' });
      try {
        const value = await remote('action', action);
        await refresh();
        return { ok: true, value };
      } catch (error) {
        publish({ actionError: error.message || String(error) });
        return { ok: false };
      } finally {
        publish({ busy: false });
      }
    },
    dispose() {
      disposed = true;
      epoch++;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}

function Icon({ kind = 'agents' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'settings'
      ? <><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /><circle cx="8" cy="7" r="2" /><circle cx="16" cy="17" r="2" /></>
      : <><rect x="7" y="3" width="10" height="7" rx="2" /><path d="M12 10v4M5 14h14M5 14v3M19 14v3" /><rect x="2" y="17" width="6" height="4" rx="1" /><rect x="16" y="17" width="6" height="4" rx="1" /></>}
  </svg>;
}

function ErrorNotice({ state, store }) {
  const error = state.actionError || state.loadError;
  if (!error) return null;
  return <div className="dsh-ac-error" role="alert">
    <span>{error}</span>
    {state.loadError && <button type="button" onClick={() => void store.refresh()} title="重新读取协作状态">重试</button>}
  </div>;
}

function Connection({ client }) {
  const lastSeen = client.lastSeen ? new Date(client.lastSeen).toLocaleString() : '尚未连接';
  return <span className="dsh-ac-connection" data-online={Boolean(client.connected)} title={`连接状态；最近连接：${lastSeen}`}>
    <span className="dsh-ac-dot" />{client.connected ? '在线' : '离线'}
  </span>;
}

function SessionRow({ session, run, store, busy, openSession }) {
  const status = run?.status || session.status;
  const human = session.control === 'user';
  const error = run?.error && (typeof run.error === 'string' ? run.error : run.error.message || '任务执行失败');
  const description = `打开原生会话：${session.title || session.sessionId}；${statusLabel(status)}${human ? '；你已接管' : ''}${error ? `；${error}` : ''}`;
  return <li className="dsh-ac-session" data-control={session.control}>
    <button type="button" className="dsh-ac-session-open" onClick={() => openSession(session.sessionId)}
      title={description} aria-label={description}>
      <span className="dsh-ac-title">{session.title || '未命名协作会话'}</span>
      <span className="dsh-ac-status" data-state={status}>{statusLabel(status)}</span>
    </button>
    <div className="dsh-ac-row-actions">
      <button type="button" disabled={busy} onClick={() => void store.act({ type: human ? 'release' : 'takeover', sessionId: session.sessionId })}
        title={human ? '你已接管；交还指挥权，不会重放已撤回的指令' : '接管指挥权；当前工作继续，撤回外部排队指令'}
        aria-label={`${human ? '交还' : '接管'}会话：${session.title || session.sessionId}`}>{human ? '交还' : '接管'}</button>
      {ACTIVE.has(status) && <button type="button" className="dsh-ac-stop" disabled={busy}
        onClick={() => void store.act({ type: 'stop', sessionId: session.sessionId })}
        title="停止当前任务；保留已产生的文件改动" aria-label={`停止任务：${session.title || session.sessionId}`}>停止</button>}
    </div>
  </li>;
}

function CollaborationSidebar({ store, openSettings, openSession, wide = true }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expanded, setExpanded] = useState(true);
  const groups = groupSessions(state.data);
  const runs = new Map((state.data?.runs || []).map(run => [run.id, run]));
  if (!wide) return <div className="dsh-ac dsh-ac-rail">
    <style>{css}</style>
    <button type="button" className="dsh-ac-icon" onClick={openSettings} title="Agent 协作" aria-label="打开 Agent 协作"><Icon /></button>
  </div>;
  return <section className="dsh-ac dsh-ac-sidebar" aria-label="Agent 协作">
    <style>{css}</style>
    <div className="dsh-ac-heading">
      <button type="button" className="dsh-ac-heading-label" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        title={expanded ? '收起 Agent 协作' : '展开 Agent 协作'}>
        <span className="dsh-ac-chevron" data-open={expanded}>›</span><Icon /><span>Agent 协作</span>
        <span className="dsh-ac-count">{state.data?.sessions?.length || 0}</span>
      </button>
      <button type="button" className="dsh-ac-icon" onClick={openSettings} title="协作设置与授权" aria-label="打开协作设置与授权"><Icon kind="settings" /></button>
    </div>
    {expanded && <div className="dsh-ac-scroll">
      <ErrorNotice state={state} store={store} />
      {!state.data && !state.loadError && <p className="dsh-ac-empty" role="status">正在读取协作状态…</p>}
      {state.data && !groups.length && <p className="dsh-ac-empty">暂无协作 Agent。<button type="button" onClick={openSettings}>添加连接</button></p>}
      {groups.map(group => <details className="dsh-ac-group" key={group.id} open>
        <summary title={`展开或收起 ${group.label || group.id} 的协作会话`}>
          <span className="dsh-ac-client-name">{group.label || group.id}</span><Connection client={group} />
        </summary>
        {group.sessions.length ? <ul>
          {group.sessions.map(session => <SessionRow key={session.sessionId} session={session} run={runs.get(session.lastRunId)}
            store={store} busy={state.busy} openSession={openSession} />)}
        </ul> : <p className="dsh-ac-empty">等待分派任务</p>}
      </details>)}
    </div>}
  </section>;
}

function ChoiceList({ legend, options, selected = [], onChange, disabled }) {
  const missing = selected.filter(id => !options.some(option => option.id === id));
  const choices = [...options, ...missing.map(id => ({ id, label: `${id}（当前不可用）` }))];
  return <fieldset className="dsh-ac-choices" disabled={disabled}>
    <legend>{legend}</legend>
    {!choices.length && <span className="dsh-ac-hint">暂无可用资源</span>}
    {choices.map(option => <label key={option.id} title={option.description || option.label}>
      <input type="checkbox" checked={selected.includes(option.id)}
        onChange={event => onChange(event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id))} />
      <span>{option.label}</span>
    </label>)}
  </fieldset>;
}

export function currentClientPolicy(original, draft, catalog) {
  const changed = key => JSON.stringify(draft[key]) !== JSON.stringify(original[key]);
  return {
    ...draft,
    workspaceIds: changed('workspaceIds') ? draft.workspaceIds.filter(id => (catalog.workspaces || []).some(row => row.workspaceId === id)) : draft.workspaceIds,
    presets: changed('presets') ? draft.presets.filter(id => (catalog.presets || []).some(row => row.id === id)) : draft.presets,
    models: changed('models') ? draft.models.filter(id => (catalog.models || []).some(row => `${row.provider}/${row.model}` === id)) : draft.models,
  };
}
function ClientPolicy({ client, state, store }) {
  const [draft, setDraft] = useState(client);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const connection = state.data.clients.find(row => row.id === client.id) || client;
  const catalog = state.data.catalog || {};
  useEffect(() => { if (!dirty) setDraft(client); }, [client, dirty]);
  const change = (key, value) => {
    setDraft(previous => ({ ...previous, [key]: value }));
    setDirty(true);
    setSaved(false);
  };
  const save = async event => {
    event.preventDefault();
    const result = await store.act({ type: 'save-policy', clients: replaceClientPolicy(state.data.policy.clients, currentClientPolicy(client, draft, catalog)) });
    if (result.ok) { setDirty(false); setSaved(true); }
  };
  return <form className="dsh-ac-card" onSubmit={save}>
    <div className="dsh-ac-card-heading">
      <h3>{client.label || client.id} <code>{client.id}</code></h3>
      <Connection client={connection} />
    </div>
    <label className="dsh-ac-field">显示名称
      <input value={draft.label || ''} onChange={event => change('label', event.target.value)} maxLength={80} required disabled={state.busy} />
    </label>
    <div className="dsh-ac-policy-grid">
      <ChoiceList legend="允许的工作区" selected={draft.workspaceIds} disabled={state.busy}
        options={(catalog.workspaces || []).map(row => ({ id: row.workspaceId, label: row.title || row.path, description: row.path }))}
        onChange={value => change('workspaceIds', value)} />
      <ChoiceList legend="允许的能力包" selected={draft.presets} disabled={state.busy}
        options={(catalog.presets || []).map(row => ({ id: row.id, label: row.label || row.id }))}
        onChange={value => change('presets', value)} />
      <ChoiceList legend="允许的模型" selected={draft.models} disabled={state.busy}
        options={(catalog.models || []).map(row => ({ id: `${row.provider}/${row.model}`, label: row.label || row.model,
          description: `${row.provider}/${row.model}；思考强度：${row.reasoningEfforts?.join('、') || '模型默认'}` }))}
        onChange={value => change('models', value)} />
    </div>
    <p className="dsh-ac-hint">仅可选择已授权资源；更改授权类别时会移除其中当前不可用的资源。空列表表示不授权；模型与思考强度由 Agent 在创建任务时选择。</p>
    <label className="dsh-ac-toggle">
      <input type="checkbox" checked={Boolean(draft.parentInteractions)} disabled={state.busy}
        aria-describedby={`dsh-ac-parent-interactions-${client.id}`}
        onChange={event => change('parentInteractions', event.target.checked)} />
      <span>在父 Agent 处审批与回答</span>
    </label>
    <p className="dsh-ac-hint" id={`dsh-ac-parent-interactions-${client.id}`}>
      父 Agent 先询问你再回传，需信任其不会自行代批。审批仅允许一次或拒绝；DSH 仍可直接处理，接管后暂停转发。
    </p>
    {connection.connectionFile && <p className="dsh-ac-path">连接文件 <code>{connection.connectionFile}</code></p>}
    <div className="dsh-ac-form-actions">
      <button type="submit" className="dsh-ac-primary" disabled={state.busy || !dirty}>保存授权</button>
      {dirty && <button type="button" disabled={state.busy} onClick={() => { setDraft(client); setDirty(false); }}>取消修改</button>}
      {saved && <span className="dsh-ac-saved" role="status">已保存</span>}
    </div>
  </form>;
}

function CollaborationSettings({ store, backToConversation }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [clientId, setClientId] = useState('');
  const [label, setLabel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [notice, setNotice] = useState('');
  const clients = state.data?.policy?.clients || [];
  const owned = new Set((state.data?.sessions || []).map(row => row.sessionId));
  const ordinary = (state.data?.catalog?.sessions || []).filter(row => !owned.has(row.sessionId));
  const create = async event => {
    event.preventDefault();
    setNotice('');
    const result = await store.act({ type: 'create-client', id: clientId.trim(), label: label.trim() });
    if (result.ok) {
      setClientId(''); setLabel('');
      setNotice('客户端已创建。请在下方选择允许的资源并保存授权，再配置客户端连接。');
    }
  };
  const adopt = async event => {
    event.preventDefault();
    setNotice('');
    const result = await store.act({ type: 'adopt', sessionId, clientId: recipient });
    if (result.ok) { setSessionId(''); setNotice('会话已交接，可在左侧 Agent 协作区打开。'); }
  };
  return <main className="dsh-ac dsh-ac-settings">
    <style>{css}</style>
    <div className="dsh-ac-page-heading">
      <button type="button" onClick={backToConversation} title="返回原生对话">← 返回对话</button>
      <h2><Icon />Agent 协作</h2>
      <p>使用当前 DSH 桌面执行任务。你始终保留审批、接管和停止权限。</p>
    </div>
    <ErrorNotice state={state} store={store} />
    {notice && <p className="dsh-ac-notice" role="status">{notice}</p>}
    {!state.data && !state.loadError && <p role="status">正在读取协作设置…</p>}
    {state.data && <>
      <section className="dsh-ac-card">
        <h3>添加本机 Agent</h3>
        <form className="dsh-ac-inline-form" onSubmit={create}>
          <label className="dsh-ac-field">客户端标识
            <input value={clientId} onChange={event => setClientId(event.target.value)} placeholder="例如 codex" required
              pattern="[a-z][a-z0-9_-]{0,47}" title="1 至 48 位，以小写字母开头，可包含数字、下划线或连字符" disabled={state.busy} />
          </label>
          <label className="dsh-ac-field">显示名称
            <input value={label} onChange={event => setLabel(event.target.value)} placeholder="例如 Codex" required maxLength={80} disabled={state.busy} />
          </label>
          <button type="submit" className="dsh-ac-primary" disabled={state.busy || !clientId.trim() || !label.trim()}>创建连接</button>
        </form>
        <p className="dsh-ac-hint">每个 Agent 使用独立连接身份；连接文件包含凭据，请仅交给对应的本机客户端。</p>
      </section>
      {clients.map(client => <ClientPolicy key={client.id} client={client} state={state} store={store} />)}
      <section className="dsh-ac-card">
        <h3>交接普通会话</h3>
        <p className="dsh-ac-hint">选择后明确交接，该 Agent 才能读取并继续这条会话；协作会话不能在 Agent 之间转移。</p>
        <form className="dsh-ac-inline-form" onSubmit={adopt}>
          <label className="dsh-ac-field">普通会话
            <select value={sessionId} onChange={event => setSessionId(event.target.value)} required disabled={state.busy}>
              <option value="">选择会话</option>
              {ordinary.map(row => <option key={row.sessionId} value={row.sessionId}>{row.title || row.sessionId}{row.running ? '（执行中）' : ''}</option>)}
            </select>
          </label>
          <label className="dsh-ac-field">交给
            <select value={recipient} onChange={event => setRecipient(event.target.value)} required disabled={state.busy}>
              <option value="">选择 Agent</option>
              {clients.map(client => <option key={client.id} value={client.id}>{client.label || client.id}</option>)}
            </select>
          </label>
          <button type="submit" disabled={state.busy || !sessionId || !recipient}>确认交接</button>
        </form>
      </section>
      <p className="dsh-ac-hint">接管会撤回尚未执行的外部指令，当前工作继续；“停止”单独停止任务。客户端离线时，DSH 已开始的任务仍继续。</p>
    </>}
  </main>;
}

export const inject = ['slots', 'remote', 'layout', 'uiWorkspace'];

export function apply(ctx) {
  let mount;
  const remote = async (method, ...args) => {
    mount ||= ctx.remote.$mount({ package: PACKAGE_NAME, descriptors: clientDescriptors });
    try { await mount; } catch (error) { mount = undefined; throw error; }
    const result = await ctx.get('remote.agentCollaboration')[method](...args);
    if (!result.ok) throw new Error(`${result.error?.code || '请求失败'}：${result.error?.message || '协作服务未返回结果'}`);
    return result.value;
  };
  const store = createCollaborationStore(remote);
  ctx.effect(() => () => store.dispose(), 'agent-collaboration: view polling');
  const face = () => ({
    store,
    openSettings: () => ctx.layout.selectPanel(PANEL_ID),
    backToConversation: () => ctx.layout.selectPanel(null),
    openSession: sessionId => ctx.get('uiWorkspace').openSession(sessionId),
  });
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: PANEL_ID, order: 10, inject: face,
  }, CollaborationSidebar));
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, inject: face,
  }, CollaborationSettings));
}
