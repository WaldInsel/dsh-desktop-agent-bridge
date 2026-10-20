import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDesktopCaller, createMcpServer } from './mcp-server.mjs';

const index = process.argv.indexOf('--connection');
if (index < 0 || !process.argv[index + 1]) throw new Error('用法: node mcp.mjs --connection <client-xxx.json>');
const call = createDesktopCaller(process.argv[index + 1]);
const server = createMcpServer(call);
await server.connect(new StdioServerTransport());
const heartbeat = setInterval(() => call('health').catch(() => {}), 20000);
heartbeat.unref();
process.stdin.on('end', () => { clearInterval(heartbeat); server.close().catch(() => {}); });
