/** Real MCP delegation smoke: native command execution and independent test replay. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { atomicJson, readJson } from '../src/util.mjs';

const config = await loadConfig();
await mkdir(config.dataDir, { recursive: true });
const checkpoint = join(config.dataDir, 'live-agent-smoke.json');
let state;
try { state = await readJson(checkpoint); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!state || process.argv.includes('--new')) {
  state = { requestId: 'agent-smoke-' + randomUUID(), startedAt: new Date().toISOString() };
  await atomicJson(checkpoint, state);
}
const client = new Client({ name: 'native-agent-verifier', version: '0.2.0' });
await client.connect(new StdioClientTransport({
  command: config.nodePath, args: [join(config.root, 'src', 'mcp-server.mjs')], cwd: config.root, stderr: 'pipe',
}));
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  if (response.isError) throw new Error(JSON.stringify(response.structuredContent));
  return response.structuredContent;
}
try {
  if (!state.taskId) {
    const task = await call('submit_task', {
      mode: 'agent', requestId: state.requestId, maxRuntimeSeconds: 600, maxToolCalls: 25,
      instruction: [
        '在本任务工作区完成一个很小的原生编码验证，不访问其他项目、不联网、不安装依赖。',
        '1. 创建 output/sum.mjs，导出 sum(values) 函数，对有限数字求和；空数组返回0；非数字或非有限数字抛 TypeError。',
        '2. 创建 output/sum.test.mjs，用 node:test 和 node:assert/strict 至少覆盖普通求和28、空数组0、负数以及非法输入。',
        '3. 必须实际使用原生命令执行工具运行测试，将真实的 TAP 输出保存为 output/test-results.txt，确保进程退出码为0。',
        'Node可执行文件路径为 ' + config.nodePath + '。用合适的shell引号调用。不要调用其他模型或子代理。',
        '4. 创建 output/report.json，字段 marker 等于 ' + state.requestId + '，testsPassed 如实反映是否真实执行通过；若命令失败，填 false 并说明，不要声称通过。',
        '任务完成后给出简短总结。所有交付文件均放在 output/。'
      ].join('\n'),
    });
    state.taskId = task.id;
    await atomicJson(checkpoint, state);
  }
  let task, cursor = 0;
  const events = [];
  for (let round = 0; round < 80; round++) {
    const update = await call('get_task', { taskId: state.taskId, afterEvent: cursor, waitSeconds: 15 });
    cursor = update.nextCursor;
    events.push(...update.events);
    task = update.task;
    if (update.events.length) console.log(JSON.stringify({ status: task.status, mode: task.mode, toolCalls: task.toolCalls, health: task.health?.state }));
    if (!['queued', 'running', 'cancelling'].includes(task.status) && update.events.length < 40) break;
  }
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  assert.equal(task.mode, 'agent');
  const report = await call('get_result', { taskId: task.id, path: 'report.json' });
  const reportData = JSON.parse(report.file.content);
  assert.equal(reportData.marker, state.requestId);
  assert.equal(reportData.testsPassed, true, 'Agent must report real test success.');
  assert.notEqual(reportData.testsExecuted, false, 'Tests were not executed.');
  const tap = await call('get_result', { taskId: task.id, path: 'test-results.txt' });
  assert.match(tap.file.content, /TAP version 13/);
  assert.match(tap.file.content, /# fail 0/);
  const commandIds = new Set(events.filter(event => event.type === 'tool_call' && /pwsh|bash|shell|terminal/i.test(event.tool ?? '')).map(event => event.callId));
  assert.ok(events.some(event => event.type === 'tool_result' && event.status === 'completed' && commandIds.has(event.callId)), 'Successful native command execution event is required.');
  const testFile = join(task.workspace, 'output', 'sum.test.mjs');
  const replay = spawnSync(config.nodePath, ['--test', '--test-reporter=tap', testFile], {
    cwd: join(task.workspace, 'output'), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /# fail 0/);
  const source = await readFile(join(task.workspace, 'output', 'sum.mjs'), 'utf8');
  assert.match(source, /export/);
  await call('review_task', { taskId: task.id, status: 'accepted', note: '读取真实源码、测试、TAP结果；确认原生命令事件；独立重新执行生成的测试，退出码0。' });
  const result = {
    passed: true, taskId: task.id, sessionId: task.sessionId, mode: task.mode, model: task.model,
    toolCalls: task.toolCalls, checkedAt: new Date().toISOString(), independentTestExitCode: replay.status,
    checks: ['official MCP round trip', 'native command execution event', 'actual source and tests', 'actual TAP output', 'independent test replay', 'separate review record'],
  };
  await atomicJson(join(config.dataDir, 'live-agent-verification.json'), result);
  state.passed = true;
  await atomicJson(checkpoint, state);
  console.log(JSON.stringify(result, null, 2));
} finally { await client.close(); }
