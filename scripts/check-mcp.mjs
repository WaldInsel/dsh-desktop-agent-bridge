import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-smoke-'));
const token = randomBytes(32).toString('base64url');
const calls = [];
const host = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.equal(req.url, '/rpc');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { method } = JSON.parse(Buffer.concat(chunks).toString());
  calls.push(method);
  res.setHeader('content-type', 'application/json');
  if (method === 'health') res.end(JSON.stringify({ result: { client: 'smoke', online: true } }));
  else {
    res.statusCode = 400;
    res.end(JSON.stringify({ code: 'RUN_DENIED', error: 'Synthetic task belongs to another identity' }));
  }
});
const client = new Client({ name: 'built-stdio-smoke', version: '1' });
try {
  await new Promise((done, reject) => {
    host.once('error', reject);
    host.listen(0, '127.0.0.1', done);
  });
  const endpointFile = join(directory, 'endpoint.json');
  const connectionFile = join(directory, 'client-smoke.json');
  await writeFile(endpointFile, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}/rpc` }));
  await writeFile(connectionFile, JSON.stringify({ id: 'smoke', token, endpointFile }), { mode: 0o600 });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/mcp.mjs', import.meta.url)), '--connection', connectionFile],
    stderr: 'pipe',
  }));
  assert.equal((await client.listTools()).tools.length, 10);
  const health = await client.callTool({ name: 'dsh_health', arguments: {} });
  assert.equal(health.isError, undefined);
  assert.deepEqual(health.structuredContent, { client: 'smoke', online: true });
  const denied = await client.callTool({ name: 'dsh_get_task', arguments: { runId: 'foreign' } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /^RUN_DENIED:/);
  assert(!JSON.stringify(denied).includes(token));
  assert.deepEqual(calls, ['health', 'get']);
  console.log('Built stdio MCP: 10 tools, authenticated health, error propagation PASS (mock host)');
} finally {
  await client.close();
  host.closeAllConnections();
  await new Promise(done => host.close(done));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
