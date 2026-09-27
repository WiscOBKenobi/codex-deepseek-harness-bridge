/** Official stdio MCP entry point; the daemon continues working after disconnect. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBridgeTools } from './tools.mjs';

/**
 * Load the daemon client only when a task tool is called.
 * @param {string} method Daemon RPC method.
 * @param {object} params Validated tool arguments.
 * @returns {Promise<object>} Daemon response.
 */
async function bridgeCall(method, params) {
  const client = await import('./client.mjs');
  return client.bridgeCall(method, params);
}

/**
 * Create an unconnected MCP server, allowing an injected RPC client in tests.
 * @param {(method:string,params:object)=>Promise<object>} call Daemon RPC client.
 * @returns {McpServer} Configured server; the caller owns its transport.
 */
export function createMcpServer(call = bridgeCall) {
  const server = new McpServer({ name: 'codex-ds-harness', version: '0.2.0' });
  registerBridgeTools(server, call);
  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 512 * 1024 });
  let closing;
  const close = () => {
    closing ??= server.close().catch(() => {
      process.stderr.write('MCP transport close failed.\n');
      process.exitCode = 1;
    });
    return closing;
  };
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('MCP server could not start. Check the local installation.\n');
    process.exitCode = 1;
  });
}
