/** Protocol-level MCP checks use a fake RPC client and never call DeepSeek. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.mjs';
import { BridgeError } from '../src/util.mjs';

const TASK_ID = 'af81a57c-cf55-4efe-9549-972d3244f103';

async function connect(t, call) {
  const server = createMcpServer(call);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('official protocol discovers strict tools with appropriate side-effect annotations', async t => {
  const client = await connect(t, async () => ({}));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [
    'submit_task', 'get_task', 'get_result', 'continue_task',
    'cancel_task', 'list_tasks', 'review_task',
  ]);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.equal(tools.find(tool => tool.name === 'get_result').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'submit_task').annotations.openWorldHint, true);
  assert.equal(tools.find(tool => tool.name === 'cancel_task').annotations.idempotentHint, true);
  assert.equal(tools.find(tool => tool.name === 'review_task').annotations.readOnlyHint, false);
});

test('valid tool calls preserve RPC methods and structured file pagination', async t => {
  const calls = [];
  const client = await connect(t, async (method, params) => {
    calls.push({ method, params });
    if (method === 'result') return {
      task: { id: TASK_ID, status: 'succeeded' },
      summary: 'Files prepared',
      artifacts: [{ path: 'notes.txt', size: 10, sha256: 'a'.repeat(64) }],
      review: { status: 'pending' },
      file: { path: 'notes.txt', offset: 0, nextOffset: 5, totalBytes: 10, truncated: true, content: 'hello' },
    };
    return { id: TASK_ID, status: 'queued' };
  });
  const submission = await client.callTool({
    name: 'submit_task',
    arguments: { instruction: 'Prepare a summary', inputs: ['D:/projects/input.txt'], requestId: 'request-0001', maxRuntimeSeconds: 30, maxToolCalls: 5 },
  });
  assert.equal(submission.isError, undefined);
  assert.equal(submission.structuredContent.id, TASK_ID);
  assert.deepEqual(calls[0], {
    method: 'submit',
    params: { instruction: 'Prepare a summary', inputs: ['D:/projects/input.txt'], requestId: 'request-0001', maxRuntimeSeconds: 30, maxToolCalls: 5 },
  });
  const result = await client.callTool({ name: 'get_result', arguments: { taskId: TASK_ID, path: 'notes.txt', offset: 0, maxBytes: 5 } });
  assert.equal(result.structuredContent.file.content, 'hello');
  assert.equal(result.structuredContent.file.nextOffset, 5);
  assert.match(result.content[0].text, /review: pending/);
});

test('all tool mappings forward validated arguments', async t => {
  const calls = [];
  const client = await connect(t, async (method, params) => {
    calls.push({ method, params });
    return { task: { id: TASK_ID, status: 'succeeded' }, events: [], nextCursor: 1 };
  });
  const cases = [
    ['get_task', 'get', { taskId: TASK_ID, afterEvent: 0, waitSeconds: 1 }],
    ['continue_task', 'continue', { taskId: TASK_ID, instruction: 'Revise the summary', requestId: 'request-0002' }],
    ['cancel_task', 'cancel', { taskId: TASK_ID }],
    ['list_tasks', 'list', {}],
    ['review_task', 'review', { taskId: TASK_ID, status: 'accepted', note: 'Read the output and checked totals.' }],
  ];
  for (const [name, method, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, name);
    assert.deepEqual(calls.at(-1), { method, params: args });
  }
});

test('invalid arguments are rejected before any daemon call', async t => {
  let calls = 0;
  const client = await connect(t, async () => { calls++; return {}; });
  const cases = [
    ['submit_task', { instruction: '' }],
    ['submit_task', { instruction: '   ' }],
    ['submit_task', { instruction: 'x'.repeat(32001) }],
    ['submit_task', { instruction: 'ok', unexpected: true }],
    ['submit_task', { instruction: 'ok', inputs: Array(31).fill('a') }],
    ['submit_task', { instruction: 'ok', requestId: 'short' }],
    ['submit_task', { instruction: 'ok', requestId: 'has spaces here' }],
    ['submit_task', { instruction: 'ok', maxRuntimeSeconds: -1 }],
    ['submit_task', { instruction: 'ok', maxToolCalls: -1 }],
    ['get_task', { taskId: 'not-a-task' }],
    ['get_task', { taskId: TASK_ID, waitSeconds: 26 }],
    ['get_task', { taskId: TASK_ID, afterEvent: -1 }],
    ['get_result', { taskId: TASK_ID, maxBytes: 24001 }],
    ['get_result', { taskId: TASK_ID, path: '../input/key' }],
    ['get_result', { taskId: TASK_ID, path: 'C:/outside.txt' }],
    ['get_result', { taskId: TASK_ID, path: '/outside.txt' }],
    ['get_result', { taskId: TASK_ID, path: 'demo/../outside.txt' }],
    ['continue_task', { taskId: TASK_ID, instruction: '' }],
    ['list_tasks', { token: 'do-not-accept' }],
    ['review_task', { taskId: TASK_ID, status: 'done', note: 'checked' }],
    ['review_task', { taskId: TASK_ID, status: 'accepted', note: '' }],
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name + JSON.stringify(args).slice(0, 100));
  }
  assert.equal(calls, 0);
});

test('bridge errors are explicit and do not expose unknown exception details', async t => {
  let count = 0;
  const client = await connect(t, async () => {
    if (count++ === 0) throw new BridgeError('TASK_BUSY', 'Task is still running.');
    throw Object.assign(new Error('Authorization: Bearer private-api-key-hidden'), { code: 'TASK_BUSY' });
  });
  const known = await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
  assert.equal(known.isError, true);
  assert.match(known.content[0].text, /Task is still running/);
  const unknown = await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, 'BRIDGE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unknown), /private-api-key-hidden/);
});

test('credential and reasoning fields are suppressed while output content remains readable', async t => {
  const client = await connect(t, async () => ({
    task: { id: TASK_ID, status: 'succeeded' },
    apiKey: 'private-value-1',
    nested: { token: 'private-value-2', thinking: 'private-reasoning', access_token: 'private-value-3' },
    file: { content: 'DEEPSEEK_API_KEY=private-value-4\nAuthorization: Bearer private-value-5\nhello world' },
  }));
  const result = await client.callTool({ name: 'get_result', arguments: { taskId: TASK_ID } });
  assert.doesNotMatch(JSON.stringify(result), /private-value|private-reasoning/);
  assert.match(result.structuredContent.file.content, /hello world/);
  assert.equal(result.structuredContent.nested.thinking, '[REDACTED]');
});

test('oversized response fails explicitly instead of silently changing event cursors', async t => {
  const client = await connect(t, async () => ({
    task: { id: TASK_ID }, events: [{ text: 'x'.repeat(300000) }], nextCursor: 100,
  }));
  const result = await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'RESULT_TOO_LARGE');
  assert.ok(JSON.stringify(result).length < 1000);
});

test('stdio entry speaks the official protocol without starting a task or writing startup noise', { timeout: 10000 }, async t => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.listTools();
  assert.equal(result.tools.length, 7);
  assert.equal(stderr, '');
});

test('MCP accepts explicit agent mode and zero limits without changing the seven-tool surface',async t=>{
  const calls=[];const client=await connect(t,async(method,params)=>{calls.push({method,params});return{id:TASK_ID,status:'queued',actualMode:'agent'};});
  const args={instruction:'Run authorized local tests',mode:'agent',maxRuntimeSeconds:0,maxToolCalls:0};
  const result=await client.callTool({name:'submit_task',arguments:args});assert.equal(result.isError,undefined);assert.deepEqual(calls[0].params,args);
});
