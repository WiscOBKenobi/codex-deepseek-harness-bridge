import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { startHarness, createPatch } from '../src/harness-runner.mjs';
import { createCallBudget } from '../src/harness-budget.mjs';

async function temporary(t) {
  // Harness rejects path aliases; hosted Windows TEMP can use an 8.3 path.
  const base=resolve('.bridge','test-runtime-v2');
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'case-'));
  t.after(async()=>{const part=relative(base,root);assert(part&&part!=='..'&&!part.startsWith('..'+sep));await rm(root,{recursive:true,force:true});});
  return root;
}
async function managerFixture(t) {
  const root=await temporary(t), calls=[];
  const config={root,tasksDir:join(root,'tasks'),readRoots:[root],model:'test-model',defaultMode:'agent',enableNativeAgent:true,maxRuntimeSeconds:0,maxToolCalls:0,stallWarningSeconds:300,maxInputBytes:10000,maxOutputBytes:10000};
  const manager=await new TaskManager(config,{runner:async options=>{
    let settle;
    const done=new Promise(resolve=>{settle=resolve;});
    options.onEvent({type:'session',sessionId:options.sessionId??'test-session'});
    const call={...options,settle:value=>settle({status:'succeeded',sessionId:options.sessionId??'test-session',finalText:'done',exitCode:0,toolCalls:0,...value})};
    calls.push(call);
    return {done,cancel:async()=>call.settle({status:'cancelled'})};
  }}).init();
  t.after(()=>manager.shutdown());
  return {root,config,manager,calls};
}
async function until(condition) {
  for(let n=0;n<200;n++){if(await condition())return;await delay(5);}
  assert.fail('Expected state was not reached.');
}
async function runnerFixture(t) {
  const taskDir=await temporary(t),workspace=join(taskDir,'workspace');
  await mkdir(join(workspace,'input'),{recursive:true});await mkdir(join(workspace,'output'));
  const config={harnessRoot:taskDir,harnessHome:join(taskDir,'home'),nodePath:process.execPath,entryPath:resolve('tests/fixtures/harness-child.mjs'),enableNativeAgent:true,provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'max',maxInputBytes:10000,maxOutputBytes:10000};
  return {config,workspace,taskDir,prompt:'{}',limits:{maxRuntimeSeconds:0,maxToolCalls:0}};
}

test('portable example defaults keep native execution gated and preserve selected model',async t=>{
  const root=await temporary(t);
  await writeFile(join(root,'config.example.json'),JSON.stringify({harnessRoot:'upstream',entryPath:'dist/cli.mjs',provider:'my-provider',model:'my-model',reasoningEffort:'high'}));
  const config=await loadConfig(root);
  assert.equal(config.configSource,'config.example.json');assert.equal(config.nodePath,process.execPath);
  assert.equal(config.entryPath,join(root,'upstream','dist','cli.mjs'));
  assert.equal(config.model,'my-model');assert.equal(config.reasoningEffort,'high');
  assert.equal(config.defaultMode,'files');assert.equal(config.enableNativeAgent,false);
  assert.equal(config.maxRuntimeSeconds,0);assert.equal(config.maxToolCalls,0);assert.equal(config.stallWarningSeconds,300);
  await writeFile(join(root,'config.json'),JSON.stringify({defaultMode:'agent'}));
  await assert.rejects(loadConfig(root),{code:'NATIVE_AGENT_DISABLED'});
});

test('malformed config never exposes its contents in an error',async t=>{
  const root=await temporary(t);await writeFile(join(root,'config.json'),'{invalid-private-value');
  await assert.rejects(loadConfig(root),error=>error.code==='INVALID_CONFIG'&&!String(error).includes('invalid-private-value'));
});

test('agent default permits coding prompt; files selection keeps restriction and idempotency includes mode',async t=>{
  const {manager,calls,config}=await managerFixture(t);
  const task=await manager.submit({instruction:'Run local tests',requestId:'mode-1234'});
  await until(()=>calls.length===1);
  assert.equal(task.mode,'agent');assert.equal(task.actualMode,'agent');assert.deepEqual(task.limits,{maxRuntimeSeconds:0,maxToolCalls:0});
  assert.equal(calls[0].mode,'agent');assert.match(calls[0].prompt,/运行命令/);assert.doesNotMatch(calls[0].prompt,/只能调用 read/);
  await assert.rejects(manager.submit({instruction:'Run local tests',requestId:'mode-1234',mode:'files'}),{code:'IDEMPOTENCY_CONFLICT'});
  calls[0].settle();await until(()=>manager.getTask(task.id).status==='succeeded');
  const second=await manager.submit({instruction:'Write notes',mode:'files'});await until(()=>calls.length===2);
  assert.equal(second.mode,'files');assert.match(calls[1].prompt,/只能调用 read/);calls[1].settle();
  config.enableNativeAgent=false;
  await assert.rejects(manager.submit({instruction:'x',mode:'agent'}),{code:'NATIVE_AGENT_DISABLED'});
  await assert.rejects(manager.continue(task.id,{instruction:'again'}),{code:'NATIVE_AGENT_DISABLED'});
});

test('heartbeat does not reset stale progress or kill a long active tool; actual progress recovers health',async t=>{
  const {manager,calls}=await managerFixture(t);
  const task=await manager.submit({instruction:'Run slow tests'});await until(()=>calls.length===1);await manager.serial;
  calls[0].onEvent({type:'tool_call',callId:'slow',tool:'pwsh'});await manager.serial;
  const record=manager.getTask(task.id);record.lastProgressAt=new Date(Date.now()-600000).toISOString();
  const before=record.lastProgressAt;calls[0].onEvent({type:'heartbeat'});await manager.serial;
  const {task:stillRunning}=await manager.get(task.id);
  assert.equal(stillRunning.status,'running');assert.equal(stillRunning.health.state,'suspected_stall');
  assert.equal(stillRunning.lastProgressAt,before);assert.ok(stillRunning.lastHeartbeatAt);assert.equal(stillRunning.health.activeToolCount,1);
  assert.equal((await manager.result(task.id)).task.health.state,'suspected_stall');
  calls[0].onEvent({type:'progress',kind:'model_stream'});await manager.serial;
  assert.equal((await manager.get(task.id)).task.health.state,'healthy');
  await manager.cancel(task.id);assert.equal((await manager.get(task.id)).task.health.state,'stopped');
});

test('continuation retains original mode and limits when default configuration changes',async t=>{
  const {manager,calls,config}=await managerFixture(t);
  const task=await manager.submit({instruction:'First',mode:'files',maxRuntimeSeconds:60,maxToolCalls:9});await until(()=>calls.length===1);
  calls[0].settle();await until(()=>manager.getTask(task.id).status==='succeeded');
  config.defaultMode='agent';await manager.continue(task.id,{instruction:'Next'});await until(()=>calls.length===2);
  assert.equal(calls[1].mode,'files');assert.equal(calls[1].sessionId,'test-session');assert.deepEqual(calls[1].limits,{maxRuntimeSeconds:60,maxToolCalls:9});
  calls[1].settle();
});

test('zero deadlines stay running until explicit cancellation and large finite deadlines do not wrap',async t=>{
  for(const seconds of [0,3000000]){
    const options=await runnerFixture(t),events=[];
    const run=await startHarness({...options,prompt:JSON.stringify({mode:'hang'}),limits:{maxRuntimeSeconds:seconds,maxToolCalls:0},onEvent:event=>events.push(event)});
    let finished=false;run.done.then(()=>{finished=true;});
    await until(()=>events.some(e=>e.type==='session'));await delay(80);
    assert.equal(finished,false);assert.ok(events.some(e=>e.type==='heartbeat'));
    await run.cancel();assert.equal((await run.done).status,'cancelled');
  }
});

test('native runner requires explicit enablement and preserves the upstream sandbox',async t=>{
  const options=await runnerFixture(t);
  await assert.rejects(startHarness({...options,config:{...options.config,enableNativeAgent:false},mode:'agent'}),/not been enabled/);
  const patch=createPatch(options.config,options.workspace,options.limits,'agent');
  assert.equal(patch.some(item=>item.id==='agent-instructions'),false);
  assert.equal(JSON.stringify(patch).includes('codex-bridge-guard'),false);
  assert.equal(patch.find(item=>item.id==='sandbox-policy').config.mode,'workspace-write');
  const events=[],run=await startHarness({...options,mode:'agent',prompt:JSON.stringify({agent:true,toolCalls:7}),onEvent:event=>events.push(event)});
  const outcome=await run.done;assert.equal(outcome.status,'succeeded');assert.equal(outcome.actualMode,'agent');assert.equal(outcome.toolCalls,7);
  assert.ok(events.some(e=>e.type==='monitor_ready'));assert.equal(events.some(e=>e.type==='guard_ready'),false);
});

test('finite native call budget rejects dispatch after its explicit limit',()=>{
  const guard=createCallBudget(2);
  assert.equal(guard(),undefined);assert.equal(guard(),undefined);assert.match(guard(),/limit reached/);assert.match(guard(),/limit reached/);
  assert.throws(()=>createCallBudget(0),/positive integer/);
});

test('legacy file tasks preserve idempotent submission across upgrade and restart',async t=>{
  const {config}=await managerFixture(t),id=randomUUID(),goal='Legacy task',inputs=[],limits={maxRuntimeSeconds:0,maxToolCalls:0};
  const digest=createHash('sha256').update(JSON.stringify({kind:'submit',goal,inputs,limits})).digest('hex');
  const directory=join(config.tasksDir,id),workspace=join(directory,'workspace');
  await mkdir(join(workspace,'input'),{recursive:true});await mkdir(join(workspace,'output'));
  await writeFile(join(directory,'task.json'),JSON.stringify({schemaVersion:1,id,workspace,instruction:goal,inputs,model:'test-model',createdAt:new Date().toISOString(),status:'succeeded',events:[],eventSeq:0,review:{status:'pending'},runs:[{}],requests:{'legacy-1234':digest},limits,sessionId:'original-session'}));
  let launches=0;const runner=async()=>{launches++;throw new Error('Must not restart paid work');};
  for(let pass=0;pass<2;pass++){
    const restored=await new TaskManager(config,{runner}).init();t.after(()=>restored.shutdown());
    assert.equal((await restored.submit({instruction:goal,mode:'files',requestId:'legacy-1234'})).id,id);
    await restored.save(restored.getTask(id));await restored.shutdown();
  }
  assert.equal(launches,0);
});

test('long protocol streams stay bounded per event while cumulative quota remains configurable',async t=>{
  const options=await runnerFixture(t);
  const request={...options,prompt:JSON.stringify({streamBytes:5*1024*1024})};
  const bounded=await startHarness(request);assert.equal((await bounded.done).status,'failed');assert.match((await bounded.done).error,/stream exceeded/);
  const long=await startHarness({...request,config:{...options.config,maxStreamBytes:0}});const result=await long.done;
  assert.equal(result.status,'succeeded');assert.ok(result.diagnostics.streamBytes>4*1024*1024);
});
