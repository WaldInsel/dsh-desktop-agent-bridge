import { createServer } from 'node:http';
import { z } from 'zod';
import { VERSION } from './protocol.mjs';
const envelope = z.object({ method: z.string().min(1).max(50), params: z.record(z.string(), z.unknown()).default({}) }).strict();
const runRequest = z.object({ runId: z.string().min(1).max(200) }).strict();
const waitRequest = runRequest.extend({ seconds: z.number().min(0).max(25).default(20) });

export async function startHttp(broker) {
  let expectedHost;
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const reply = (status, body) => {
      if (status >= 400) req.resume();
      res.writeHead(status); res.end(JSON.stringify(body));
    };
    if (req.headers.host !== expectedHost || req.headers.origin !== undefined) return reply(403, { error: '来源不允许。' });
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: '接口不存在。' });
    if (active >= 16) return reply(429, { error: '并发请求过多。' });
    let principal;
    try { principal = broker.authenticate(/^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]); }
    catch { return reply(401, { error: '接入凭据无效。' }); }
    active++;
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 128 * 1024) { reply(413, { error: '请求过大。' }); req.resume(); return; }
        chunks.push(chunk);
      }
      const { method, params } = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      let result;
      switch (method) {
        case 'health': result = { version: VERSION, desktopPid: process.pid, client: principal,
          desktopUi: { ...broker.adapter?.uiStatus?.(), lastPollAt: broker.lastDesktopPollAt ?? null } }; break;
        case 'catalog': result = await broker.catalog(principal); break;
        case 'start': result = await broker.start(principal, params); break;
        case 'get': result = await broker.get(principal, runRequest.parse(params).runId); break;
        case 'wait': { const p = waitRequest.parse(params); result = await broker.wait(principal, p.runId, p.seconds); break; }
        case 'list': result = { sessions: broker.list(principal) }; break;
        case 'interactions': result = await broker.interactions(principal, runRequest.parse(params).runId); break;
        case 'respond-interaction': result = await broker.respondInteraction(principal, params); break;
        case 'send': result = await broker.send(principal, params); break;
        case 'cancel': result = await broker.cancel(principal, runRequest.parse(params).runId); break;
        default: return reply(404, { error: '未提供此操作。' });
      }
      reply(200, { result });
    } catch (error) {
      reply(400, { error: error.message, code: error.code ?? 'REQUEST_FAILED' });
    } finally { active--; }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  expectedHost = `127.0.0.1:${port}`;
  return {
    url: `http://${expectedHost}/rpc`,
    async close() {
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
