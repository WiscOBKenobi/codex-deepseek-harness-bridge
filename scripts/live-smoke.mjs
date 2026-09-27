/** Live MCP -> daemon -> official Harness verification, using its saved key. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { atomicJson, readJson } from '../src/util.mjs';

const config=await loadConfig();
const checkpoint=join(config.dataDir,'live-smoke.json');
await mkdir(config.dataDir,{recursive:true});
let state;
try { state=await readJson(checkpoint); } catch(error) { if(error.code!=='ENOENT')throw error; }
if(process.argv.includes('--new')||!state) {
  const marker=randomUUID();
  const input=join(config.root,'examples','live-input.json');
  await writeFile(input,JSON.stringify({marker,numbers:[2,3,5,7,11]},null,2)+'\n');
  state={marker,input,requestId:'live-'+marker,startedAt:new Date().toISOString()};
  await atomicJson(checkpoint,state);
}
const client=new Client({name:'codex-ds-live-verifier',version:'0.1.0'});
const transport=new StdioClientTransport({command:config.nodePath,args:[join(config.root,'src','mcp-server.mjs')],cwd:config.root,stderr:'pipe'});
let diagnostics='';
transport.stderr?.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-2000);});
await client.connect(transport);
async function call(name,args) {
  const result=await client.callTool({name,arguments:args},undefined,{timeout:60000});
  if(result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
async function waitForTask(id) {
  let cursor=0;
  for(let round=0;round<40;round++) {
    const result=await call('get_task',{taskId:id,afterEvent:cursor,waitSeconds:15});
    cursor=result.nextCursor;
    if(result.events.length) console.log(JSON.stringify({taskId:id,status:result.task.status,toolCalls:result.task.toolCalls}));
    if(!['queued','running','cancelling'].includes(result.task.status)) {
      assert.equal(result.task.status,'succeeded',JSON.stringify(result.task.error)); return result.task;
    }
  }
  throw new Error('Live task has not completed; query its existing ID before retrying.');
}
try {
  const tools=await client.listTools();
  assert.equal(tools.tools.length,7);
  if(!state.taskId) {
    const submitted=await call('submit_task',{
      instruction:'请读取 input/live-input.json，将其中 marker 原样保留，计算 numbers 的元素数量和总和。创建 output/result.json，恰好包含 marker、count、sum、status 四个字段，status 为 passed。再读取文件验证。不要进行其他工作。',
      mode:'files',inputs:[state.input],requestId:state.requestId,maxRuntimeSeconds:180,maxToolCalls:8,
    });
    state.taskId=submitted.id; await atomicJson(checkpoint,state);
  }
  let task=await waitForTask(state.taskId);
  const before=await call('get_result',{taskId:task.id,path:'result.json'});
  let artifact=JSON.parse(before.file.content);
  assert.equal(artifact.marker,state.marker); assert.equal(artifact.count,5); assert.equal(artifact.sum,28);
  const diskPath=join(task.workspace,'output','result.json');
  assert.deepEqual(JSON.parse(await readFile(diskPath,'utf8')),artifact);
  if(!state.continued) {
    state.firstSession=task.sessionId;
    await call('continue_task',{taskId:task.id,instruction:'请继续刚才的任务。使用 edit 把 output/result.json 的 status 从 passed 改成 verified，保持 marker、count、sum 不变。读回检查，然后结束。',requestId:state.requestId+'-continue'});
    state.continued=true; await atomicJson(checkpoint,state);
  }
  task=await waitForTask(task.id);
  const result=await call('get_result',{taskId:task.id,path:'result.json'});
  artifact=JSON.parse(result.file.content);
  assert.equal(artifact.marker,state.marker);assert.equal(artifact.count,5);assert.equal(artifact.sum,28);assert.equal(artifact.status,'verified');
  assert.equal(task.sessionId,state.firstSession);
  assert.deepEqual(JSON.parse(await readFile(diskPath,'utf8')),artifact);
  assert.equal((await readJson(state.input)).marker,state.marker);
  const reviewed=await call('review_task',{taskId:task.id,status:'accepted',note:'通过官方 MCP 实际提交及继续任务；独立读取磁盘文件，核对随机 marker、5 个数之和 28、状态 verified，确认同一会话和输入未被修改。'});
  assert.equal(reviewed.review.status,'accepted');
  const report={passed:true,taskId:task.id,sessionId:task.sessionId,model:task.model,workspace:task.workspace,output:diskPath,runCount:task.runCount,review:reviewed.review.status,checkedAt:new Date().toISOString(),
    checks:['MCP 官方协议连接','真实 DeepSeek 调用','输入文件复制','实际输出文件及校验和','相同会话继续及编辑','独立磁盘核对','验收状态记录'],result:artifact};
  await atomicJson(join(config.dataDir,'live-verification.json'),report);
  state.passed=true;await atomicJson(checkpoint,state);
  console.log(JSON.stringify(report,null,2));
} finally { await client.close(); }
