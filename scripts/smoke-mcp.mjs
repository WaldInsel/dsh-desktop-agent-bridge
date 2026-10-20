import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const connection = process.argv[2];
assert(connection, 'Usage: node scripts/smoke-mcp.mjs <client-connection.json>');
const client = new Client({ name: 'dsh-collaboration-acceptance', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/mcp.mjs', import.meta.url)), '--connection', connection],
    stderr: 'pipe',
  }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
    'dsh_health', 'dsh_catalog', 'dsh_start_task', 'dsh_get_task', 'dsh_wait_task',
    'dsh_list_sessions', 'dsh_send_message', 'dsh_cancel_task',
    'dsh_list_interactions', 'dsh_respond_interaction',
  ].sort());
  for (const name of ['dsh_health', 'dsh_catalog', 'dsh_list_sessions']) {
    const result = await client.callTool({ name, arguments: {} });
    assert(!result.isError, JSON.stringify(result.content));
    console.log(JSON.stringify({ tool: name, content: result.content }));
  }
} finally {
  await client.close();
}
