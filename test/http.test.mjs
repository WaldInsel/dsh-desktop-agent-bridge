import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startHttp } from '../src/http.mjs';

async function fixture(t) {
  const calls = [];
  const broker = {
    authenticate(token) {
      if (token !== 'codex-token') throw new Error('unauthorized');
      return 'codex';
    },
    async catalog(principal) { calls.push(['catalog', principal]); return { client: principal }; },
    async start(principal, params) { calls.push(['start', principal, params]); return { runId: 'run-1', status: 'running' }; },
    async get(principal, runId) { calls.push(['get', principal, runId]); return { runId, status: 'running' }; },
    async wait(principal, runId, seconds) { calls.push(['wait', principal, runId, seconds]); return { runId, status: 'running' }; },
    list(principal) { calls.push(['list', principal]); return []; },
    async send(principal, params) { calls.push(['send', principal, params]); return {}; },
    async cancel(principal, runId) { calls.push(['cancel', principal, runId]); return {}; },
    async action() { throw new Error('admin action must never be reachable'); },
  };
  const server = await startHttp(broker);
  t.after(() => server.close());
  function request(body, { headers = {}, method = 'POST', path, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(server.url, {
        method, agent: false, ...(path ? { path } : {}),
        headers: { authorization: 'Bearer codex-token', 'content-type': 'application/json', ...headers },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('test request timed out')));
      req.on('error', reject);
      req.end(raw ? body : JSON.stringify(body));
    });
  }
  return { broker, calls, server, request };
}

test('RPC uses authenticated identity rather than client-provided labels', async t => {
  const f = await fixture(t);
  const health = await f.request({ method: 'health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.result.client, 'codex');
  assert.equal(health.headers['cache-control'], 'no-store');
  await f.request({ method: 'start', params: { principal: 'hermes', task: 'work' } });
  assert.equal(f.calls[0][1], 'codex');
  const invalid = await f.request({ method: 'start' }, { headers: { authorization: 'Bearer wrong-token' } });
  assert.equal(invalid.status, 401);
  const rawToken = await f.request({ method: 'health' }, { headers: { authorization: 'codex-token' } });
  assert.equal(rawToken.status, 401);
  assert.equal(f.calls.length, 1);
});

test('HTTP exposes no unscoped approval, takeover, adoption or policy-management operations', async t => {
  const f = await fixture(t);
  for (const method of ['action', 'takeover', 'release', 'stop', 'adopt', 'approve', 'answer', 'create-client', 'save-policy', 'snapshot']) {
    const response = await f.request({ method, params: { sessionId: 's', type: method } });
    assert.equal(response.status, 404, method);
  }
  assert.deepEqual(f.calls, []);
});

test('loopback Host and absent Origin are required before credentials are evaluated', async t => {
  const f = await fixture(t);
  for (const headers of [{ host: 'evil.example' }, { host: 'localhost:123' }, { origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' }]) {
    assert.equal((await f.request({ method: 'health' }, { headers })).status, 403);
  }
  assert.equal((await f.request({ method: 'health' }, { method: 'GET' })).status, 404);
  assert.equal((await f.request({ method: 'health' }, { path: '/rpc/extra' })).status, 404);
});

test('malformed JSON, oversized requests and invalid operation parameters do not reach broker', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('{invalid', { raw: true })).status, 400);
  assert.equal((await f.request({ method: 'get', params: { runId: '' } })).status, 400);
  assert.equal((await f.request({ method: 'get', params: { runId: 'run', principal: 'hermes' } })).status, 400);
  assert.equal((await f.request({ method: 'wait', params: { runId: 'run', seconds: 26 } })).status, 400);
  assert.equal((await f.request({ method: 'health', extra: true })).status, 400);
  assert.equal((await f.request('x'.repeat(129 * 1024), { raw: true })).status, 413);
  assert.deepEqual(f.calls, []);
});

test('broker ownership errors return an error code without another client result', async t => {
  const f = await fixture(t);
  f.broker.get = async () => { throw Object.assign(new Error('该任务不属于当前客户端'), { code: 'RUN_DENIED' }); };
  const result = await f.request({ method: 'get', params: { runId: 'other-run' } });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'RUN_DENIED');
  assert.equal('result' in result.body, false);
});

test('client disconnect does not cancel an accepted task and it remains retrievable', async t => {
  const f = await fixture(t);
  let accept, release;
  const accepted = new Promise(resolve => { accept = resolve; });
  const work = new Promise(resolve => { release = resolve; });
  let completed = false;
  f.broker.start = async principal => {
    assert.equal(principal, 'codex');
    accept();
    await work;
    completed = true;
    return { runId: 'surviving-run', status: 'completed' };
  };
  f.broker.get = async (_principal, runId) => ({ runId, status: completed ? 'completed' : 'running' });
  const req = httpRequest(f.server.url, { method: 'POST', agent: false, headers: { authorization: 'Bearer codex-token' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ method: 'start', params: {} }));
  await accepted;
  req.destroy();
  release();
  await work;
  await new Promise(resolve => setImmediate(resolve));
  const result = await f.request({ method: 'get', params: { runId: 'surviving-run' } });
  assert.equal(result.body.result.status, 'completed');
  assert.equal(f.calls.some(call => call[0] === 'cancel'), false);
});
