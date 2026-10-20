import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRemoteMcpServer, createRemoteConfig } from '../src/remote-mcp.mjs';

const nextTick = () => new Promise(resolve => setImmediate(resolve));
const expectedTools = ['dsh_health', 'dsh_catalog', 'dsh_start_task', 'dsh_get_task',
  'dsh_wait_task', 'dsh_list_sessions', 'dsh_send_message', 'dsh_cancel_task',
  'dsh_list_interactions', 'dsh_respond_interaction'];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const internalToken = 'desktop-internal-token-for-test-only';
  const state = {
    respond: (_body, res) => res.end(JSON.stringify({ result: { client: 'grokbot', desktopPid: 12345 } })),
  };
  const desktop = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('Content-Type', 'application/json');
    await state.respond(calls.at(-1).body, res);
  });
  await new Promise(resolve => desktop.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    desktop.closeAllConnections();
    await new Promise(resolve => desktop.close(resolve));
  });
  const endpointFile = join(directory, 'endpoint.json');
  const connectionFile = join(directory, 'client-grokbot.json');
  const configFile = join(directory, 'remote-grok.json');
  await writeFile(endpointFile, JSON.stringify({ url: `http://127.0.0.1:${desktop.address().port}/rpc` }));
  const connection = { id: 'grokbot', token: internalToken, endpointFile };
  await writeFile(connectionFile, JSON.stringify(connection));
  await createRemoteConfig(configFile, 'bridge.example.com');
  const adapter = await startRemoteMcpServer({ connectionFile, configFile, port: 0 });
  t.after(() => adapter.close());
  const token = JSON.parse(await readFile(configFile, 'utf8')).bearer;
  function request(body, { headers = {}, method = 'POST', path, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(adapter.url, {
        method, agent: false, ...(path ? { path } : {}),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', ...headers },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Test request timed out')));
      req.on('error', reject);
      req.end(raw ? body : JSON.stringify(body));
    });
  }
  async function client() {
    const value = new Client({ name: 'grok-http-test', version: '1' });
    await value.connect(new StreamableHTTPClientTransport(new URL(adapter.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    t.after(() => value.close());
    return value;
  }
  return { directory, calls, state, adapter, token, internalToken, connection, connectionFile,
    configFile, endpointFile, request, client };
}

test('real SDK HTTP handshake exposes the shared tools and binds calls to Grok Bot', async t => {
  const f = await fixture(t);
  assert.notEqual(f.token, f.internalToken);
  const client = await f.client();
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), expectedTools);
  const health = await client.callTool({ name: 'dsh_health', arguments: {} });
  assert.equal(health.structuredContent.client, 'grokbot');
  assert.equal(health.isError, undefined);
  assert.deepEqual(f.calls, [{ path: '/rpc', authorization: `Bearer ${f.internalToken}`,
    body: { method: 'health', params: {} } }]);
  await nextTick();
  assert.equal(f.adapter.activeRequests, 0);
});

test('Host, Origin, bearer, path and method checks reject before any desktop call', async t => {
  const f = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const headers of [{ host: 'evil.test' }, { origin: 'https://bridge.example.com' }, { origin: '' }]) {
    assert.equal((await f.request(body, { headers })).status, 403);
  }
  assert.equal((await f.request(body, { headers: { authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await f.request(body, { headers: { authorization: `Bearer ${f.internalToken}` } })).status, 401);
  assert.equal((await f.request(body, { path: '/dsh-collaboration/mcp?token=x' })).status, 404);
  assert.equal((await f.request(body, { path: '/rpc' })).status, 404);
  for (const method of ['GET', 'DELETE', 'OPTIONS']) {
    assert.equal((await f.request(body, { method })).status, 405);
  }
  assert.equal((await f.request(body, { headers: { 'mcp-session-id': 'foreign' } })).status, 400);
  assert.equal((await f.request(body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.deepEqual(f.calls, []);
});

test('malformed JSON and oversized chunked bodies fail without leaking body text', async t => {
  const f = await fixture(t);
  const invalid = await f.request(`{"secret":"${f.token}"`, { raw: true });
  assert.equal(invalid.status, 400);
  assert(!JSON.stringify(invalid.body).includes(f.token));
  const large = await f.request('x'.repeat(129 * 1024), {
    raw: true, headers: { 'transfer-encoding': 'chunked' },
  });
  assert.equal(large.status, 413);
  assert.deepEqual(f.calls, []);
  await nextTick();
  assert.equal(f.adapter.activeRequests, 0);
});

test('stateless calls contain no admin tools and preserve desktop ownership denials', async t => {
  const f = await fixture(t);
  const client = await f.client();
  for (const name of ['approve', 'dsh_approve', 'takeover', 'save-policy']) {
    assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
  }
  assert.deepEqual(f.calls, []);
  f.state.respond = (_body, res) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ code: 'RUN_DENIED', error: 'Task belongs to another agent' }));
  };
  const denied = await client.callTool({ name: 'dsh_get_task', arguments: { runId: 'other-agent-run' } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /^RUN_DENIED:/);
  assert.equal(f.calls[0].body.method, 'get');
  const approval = await client.callTool({ name: 'dsh_respond_interaction', arguments: {
    runId: 'other-agent-run', requestId: 'request', userReply: '允许一次',
    response: { kind: 'approval', decision: 'allowed-once' },
  } });
  assert.equal(approval.isError, true);
  assert.match(approval.content[0].text, /^RUN_DENIED:/);
  assert.equal(f.calls.at(-1).body.method, 'respond-interaction');
});

test('changing the connection identity cannot redirect an existing remote adapter', async t => {
  const f = await fixture(t);
  const client = await f.client();
  await writeFile(f.connectionFile, JSON.stringify({ ...f.connection, id: 'hermes' }));
  const denied = await client.callTool({ name: 'dsh_health', arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /固定身份/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(startRemoteMcpServer({ connectionFile: f.connectionFile,
    configFile: f.configFile, port: 0 }), /固定身份/);
  await writeFile(f.connectionFile, `{"token":"${f.token}"`);
  const broken = await client.callTool({ name: 'dsh_health', arguments: {} });
  assert.equal(broken.isError, true);
  assert(!JSON.stringify(broken).includes(f.token));
});

test('endpoint changes remain loopback-only and cannot carry bearer credentials to another host', async t => {
  const f = await fixture(t);
  const client = await f.client();
  for (const url of ['https://example.com/rpc', 'http://localhost/rpc', 'http://127.0.0.1/rpc?x=1']) {
    await writeFile(f.endpointFile, JSON.stringify({ url }));
    const denied = await client.callTool({ name: 'dsh_health', arguments: {} });
    assert.equal(denied.isError, true);
  }
  assert.deepEqual(f.calls, []);
});

test('disconnect releases HTTP resources without cancelling the accepted DSH task', async t => {
  const f = await fixture(t);
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  f.state.respond = async (_body, res) => {
    markStarted();
    await hold;
    res.end(JSON.stringify({ result: { runId: 'persisted-run', status: 'running' } }));
  };
  const req = httpRequest(f.adapter.url, { method: 'POST', agent: false,
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'dsh_wait_task', arguments: { runId: 'persisted-run', seconds: 25 } } }));
  await started;
  req.destroy();
  for (let attempt = 0; f.adapter.activeRequests && attempt < 100; attempt++) await nextTick();
  assert.equal(f.adapter.activeRequests, 0);
  assert.deepEqual(f.calls.map(call => call.body.method), ['wait']);
  release();
});

test('authenticated slow requests are bounded and disconnect cleans every slot', async t => {
  const f = await fixture(t);
  const requests = Array.from({ length: 16 }, () => {
    const req = httpRequest(f.adapter.url, { method: 'POST', agent: false,
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'transfer-encoding': 'chunked' } });
    req.on('error', () => {});
    req.write('{"jsonrpc":');
    return req;
  });
  for (let attempt = 0; f.adapter.activeRequests < 16 && attempt < 100; attempt++) await nextTick();
  assert.equal(f.adapter.activeRequests, 16);
  assert.equal((await f.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 429);
  requests.forEach(req => req.destroy());
  for (let attempt = 0; f.adapter.activeRequests && attempt < 100; attempt++) await nextTick();
  assert.equal(f.adapter.activeRequests, 0);
  assert.deepEqual(f.calls, []);
});

test('remote configuration requires explicit setup and never overwrites credentials', async t => {
  const f = await fixture(t);
  const before = await readFile(f.configFile, 'utf8');
  await assert.rejects(createRemoteConfig(f.configFile, 'other.example.com'), { code: 'EEXIST' });
  assert.equal(await readFile(f.configFile, 'utf8'), before);
  for (const host of ['', undefined, 'https://example.com', 'example.com:443', 'a..b', '-bad.example']) {
    await assert.rejects(createRemoteConfig(join(f.directory, 'invalid.json'), host), /域名/);
  }
  const missing = join(f.directory, 'missing.json');
  await assert.rejects(startRemoteMcpServer({ connectionFile: f.connectionFile, configFile: missing, port: 0 }), /读取/);
  await assert.rejects(readFile(missing), { code: 'ENOENT' });
});

test('a separate listener can bind another explicitly selected client', async t => {
  const f = await fixture(t);
  for (const client of ['', null, 'bad/client']) {
    await assert.rejects(startRemoteMcpServer({
      connectionFile: f.connectionFile, configFile: f.configFile, port: 0, client,
    }), /身份格式/);
  }
  await writeFile(f.connectionFile, JSON.stringify({ ...f.connection, id: 'hermes' }));
  const listener = await startRemoteMcpServer({
    connectionFile: f.connectionFile, configFile: f.configFile, port: 0, client: 'hermes',
  });
  t.after(() => listener.close());
  const client = new Client({ name: 'other-remote-client-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: { Authorization: `Bearer ${f.token}` } },
  }));
  t.after(() => client.close());
  f.state.respond = (_body, res) => res.end(JSON.stringify({ result: { client: 'hermes' } }));
  assert.equal((await client.callTool({ name: 'dsh_health', arguments: {} })).structuredContent.client, 'hermes');
});
