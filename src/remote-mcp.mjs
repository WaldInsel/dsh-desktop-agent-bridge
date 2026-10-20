import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDesktopCaller, createMcpServer, readDesktopConnection } from './mcp-server.mjs';

const MCP_PATH = '/dsh-collaboration/mcp';
const MAX_BODY = 128 * 1024;
const tokenShape = /^[A-Za-z0-9_-]{43,200}$/;
const hash = text => createHash('sha256').update(text).digest();

function validHost(host) {
  return typeof host === 'string' && host.length <= 253 &&
    host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export async function createRemoteConfig(file, publicHost) {
  if (!validHost(publicHost)) throw new Error('请指定有效的小写域名，不含协议、端口或路径。');
  await writeFile(file, JSON.stringify({ publicHost, bearer: randomBytes(32).toString('base64url') }) + '\n',
    { flag: 'wx', mode: 0o600 });
}

async function loadRemoteConfig(file) {
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('无法读取远程接入凭据文件。'); }
  if (!config || typeof config.bearer !== 'string' || !tokenShape.test(config.bearer) ||
    !validHost(config.publicHost)) {
    throw new Error('远程接入配置格式无效。');
  }
  return config;
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const finish = error => {
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', abort);
      if (error) { req.resume(); reject(error); }
    };
    const fail = () => finish(Object.assign(new Error('Request interrupted'), { status: 400 }));
    const abort = () => fail();
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) return finish(Object.assign(new Error('Request too large'), { status: 413 }));
      chunks.push(chunk);
    };
    const end = () => {
      finish();
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    };
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', abort);
  });
}

/** One fixed client per listener; task state stays in the existing DSH host. */
export async function startRemoteMcpServer({ connectionFile, configFile, port = 18769, client = 'grokbot' }) {
  if (typeof client !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(client)) {
    throw new Error('固定客户端身份格式无效。');
  }
  const connection = await readDesktopConnection(connectionFile, client);
  const { bearer: token, publicHost } = await loadRemoteConfig(configFile);
  if (token === connection.token) throw new Error('远程凭据必须与桌面内部凭据分开。');
  const tokenHash = hash(token);
  const call = createDesktopCaller(connectionFile, client);
  const active = new Set();
  let expectedHost;
  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, message) => {
      req.resume();
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
    };
    const countHeader = name => req.rawHeaders.filter((value, index) =>
      index % 2 === 0 && value.toLowerCase() === name).length;
    if (![expectedHost, publicHost].includes(req.headers.host) || countHeader('host') !== 1 || 'origin' in req.headers) {
      return reply(403, 'Origin or Host not allowed');
    }
    if (req.url !== MCP_PATH) return reply(404, 'Not found');
    const match = /^Bearer ([A-Za-z0-9_-]{43,200})$/i.exec(req.headers.authorization ?? '');
    if (!match || countHeader('authorization') !== 1 || !timingSafeEqual(hash(match[1]), tokenHash)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return reply(401, 'Unauthorized');
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, 'Method not allowed'); }
    if ('mcp-session-id' in req.headers) return reply(400, 'This endpoint is stateless');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reply(415, 'Content-Type must be application/json');
    }
    if (Number(req.headers['content-length']) > MAX_BODY) return reply(413, 'Request too large');
    if (active.size >= 16) return reply(429, 'Too many requests');
    const controller = new AbortController();
    let server;
    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      controller.abort();
      active.delete(cleanup);
      server?.close().catch(() => {});
    };
    const deadline = setTimeout(() => { reply(504, 'Request timed out'); cleanup(); }, 40000);
    deadline.unref();
    active.add(cleanup);
    res.once('close', cleanup);
    res.once('finish', cleanup);
    try {
      const body = await readJson(req);
      if (released) return;
      server = createMcpServer((method, args, signal) =>
        call(method, args, AbortSignal.any([signal, controller.signal])));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      reply(error.status ?? 500, error.status ? error.message : 'MCP request failed');
      cleanup();
    }
  });
  http.maxConnections = 64;
  http.maxRequestsPerSocket = 100;
  http.headersTimeout = 10000;
  http.requestTimeout = 15000;
  http.keepAliveTimeout = 5000;
  await new Promise((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', resolveListen);
  });
  expectedHost = `127.0.0.1:${http.address().port}`;
  return {
    url: `http://${expectedHost}${MCP_PATH}`,
    get activeRequests() { return active.size; },
    async close() {
      const closed = new Promise(resolveClose => http.close(resolveClose));
      for (const cleanup of active) cleanup();
      http.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      connection: { type: 'string' }, config: { type: 'string' },
      client: { type: 'string', default: 'grokbot' }, port: { type: 'string', default: '18769' },
      init: { type: 'boolean' }, 'public-host': { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('Initialize: node dist/remote-mcp.mjs --init --config <new-file> --public-host <domain>\nServe: node dist/remote-mcp.mjs --connection <client-file> --config <file> [--client grokbot] [--port 18769]');
    } else if (values.init) {
      if (!values.config) throw new Error('缺少 --config');
      await createRemoteConfig(values.config, values['public-host']);
      console.log('已创建远程凭据文件；请通过安全凭据输入框配置客户端，不要公开其内容。');
    } else {
    if (!values.connection || !values.config) throw new Error('缺少 --connection 或 --config；首次使用请先 --init。');
    if (values['public-host']) throw new Error('--public-host 仅用于 --init；服务启动读取已有配置。');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 的整数。');
    const listener = await startRemoteMcpServer({
      connectionFile: values.connection, configFile: values.config, client: values.client, port,
    });
    console.log(JSON.stringify({ url: listener.url, identity: values.client, transport: 'streamable-http' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      listener.close().then(() => process.exit(0), () => process.exit(1));
    });
    }
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '本机 MCP 端口已被占用。' : error.message);
    process.exitCode = 1;
  }
}
