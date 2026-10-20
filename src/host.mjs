import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlink, open, mkdir } from 'node:fs/promises';
import Schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createHostAdapter } from './host-adapter.mjs';
import { Broker, atomicJson } from './broker.mjs';
import { startHttp } from './http.mjs';
import { VERSION, hostManifest } from './protocol.mjs';

export const name = 'agent-collaboration';
export const inject = ['typert', 'connection', 'typertGateway', 'sessionController', 'sessions', 'agents', 'permissionPresets', 'llm'];
export const Config = Schema.object({
  stateDirectory: Schema.string().default(join(homedir(), '.dsh', 'agent-collaboration')).description('协作数据与本机接入凭据目录'),
  initialWorkspace: Schema.string().default('').description('首次初始化时创建并授权给 Codex 的工作区；留空则在协作设置中配置'),
});
class CollaborationService extends TypertRemoteService {
  constructor(ctx, ready) { super(ctx, 'agentCollaboration'); this.ready = ready; }
  async snapshot() {
    const broker = await this.ready;
    broker.lastDesktopPollAt = new Date().toISOString();
    return broker.snapshot();
  }
  async action(request) { return (await this.ready).action(request); }
}
export function apply(ctx, config) {
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  new CollaborationService(ctx, ready);
  ctx.effect(() => ctx.typert.register(hostManifest), 'agent-collaboration.remote');
  ctx.effect(async function* () {
    const adapter = createHostAdapter(ctx);
    let broker, http, timer, lock;
    const endpoint = join(config.stateDirectory, 'endpoint.json');
    const lockPath = join(config.stateDirectory, 'host.lock');
    try {
      await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
      try {
        lock = await open(lockPath, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const { readFile } = await import('node:fs/promises');
        const pid = Number(await readFile(lockPath, 'utf8'));
        let live = true;
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
        if (live) throw new Error('已有协作宿主使用此数据目录。');
        await unlink(lockPath);
        lock = await open(lockPath, 'wx');
      }
      await lock.writeFile(String(process.pid));
      broker = await new Broker(adapter, config.stateDirectory).init();
      if (config.initialWorkspace && broker.state.clients.length === 0) {
        await adapter.createWorkspace(config.initialWorkspace);
        const catalog = await adapter.catalog();
        const workspace = catalog.workspaces.find(w =>
          w.path.replaceAll('\\', '/').toLowerCase() === config.initialWorkspace.replaceAll('\\', '/').toLowerCase());
        const model = catalog.models.find(m => m.default);
        const preset = catalog.presets.find(p => p.default);
        if (!workspace || !model || !preset) throw new Error('无法确定初始工作区、默认模型或能力包；未授权任何资源。');
        await broker.action({ type: 'create-client', id: 'codex', label: 'Codex' });
        await broker.action({ type: 'save-policy', clients: [{
          id: 'codex', label: 'Codex', workspaceIds: [workspace.workspaceId],
          presets: [preset.id], models: [`${model.provider}/${model.model}`],
        }] });
      }
      http = await startHttp(broker);
      await atomicJson(endpoint, { url: http.url, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() });
      resolveReady(broker);
      timer = setInterval(() => broker.refresh().catch(error => {
        ctx.logger?.warn?.(`协作状态同步失败: ${error.message}`);
      }), 1500);
      timer.unref?.();
    } catch (error) {
      rejectReady(error);
      if (timer) clearInterval(timer);
      await http?.close();
      await lock?.close();
      if (lock) await unlink(lockPath).catch(() => {});
      await adapter.dispose?.();
      throw error;
    }
    yield async () => {
      clearInterval(timer);
      await broker.close();
      await http.close();
      await adapter.dispose?.();
      await unlink(endpoint).catch(() => {});
      await lock.close();
      await unlink(lockPath).catch(() => {});
    };
  }, 'agent-collaboration.host');
}
