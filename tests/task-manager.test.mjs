import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { TaskManager } from '../src/task-manager.mjs';
import { atomicJson } from '../src/util.mjs';
import { randomUUID } from 'node:crypto';

async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(),'codex-ds-manager-'));
  t.after(async()=>{ assert(!relative(tmpdir(),root).startsWith('..')); await rm(root,{recursive:true,force:true}); });
  const config={root,tasksDir:join(root,'tasks'),readRoots:[root],model:'test-model',maxRuntimeSeconds:30,maxToolCalls:10,maxInputBytes:10000,maxOutputBytes:10000};
  const manager=await new TaskManager(config,{runner}).init();
  t.after(()=>manager.shutdown());
  return {manager,config,root};
}
async function terminal(manager,id) {
  for(let count=0;count<150;count++){
    const {task}=await manager.get(id);
    if(!['queued','running','cancelling'].includes(task.status)) return task;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('task did not finish');
}
function controlledRunner() {
  const calls=[];
  const runner=async opts=>{
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    const sessionId=opts.sessionId??'fixture-session';
    opts.onEvent({type:'session',sessionId});
    const call={...opts,finish:value=>finish({status:'succeeded',sessionId,finalText:'完成',exitCode:0,toolCalls:0,...value})};
    calls.push(call);
    return {done,cancel:async()=>call.finish({status:'cancelled',exitCode:1})};
  };
  return {calls,runner};
}
async function started(calls,n=1) { for(let i=0;i<100&&calls.length<n;i++) await new Promise(r=>setTimeout(r,5)); assert.equal(calls.length,n); }

test('idempotent submit copies explicit input and collects actual output, then records review',async t=>{
  const fake=controlledRunner(); const {manager,root}=await fixture(t,fake.runner);
  const input=join(root,'numbers.json'); await writeFile(input,'[2,3,5]');
  const request={instruction:'求和',inputs:[input],requestId:'request-123'};
  const first=await manager.submit(request);
  const again=await manager.submit(request);
  assert.equal(first.id,again.id);
  await assert.rejects(manager.submit({...request,instruction:'另一个任务'}),{code:'IDEMPOTENCY_CONFLICT'});
  await started(fake.calls);
  assert.equal(await readFile(join(first.workspace,'input','numbers.json'),'utf8'),'[2,3,5]');
  await writeFile(join(first.workspace,'output','result.json'),'{"sum":10}');
  fake.calls[0].finish();
  const finished=await terminal(manager,first.id);
  assert.equal(finished.status,'succeeded');
  assert.equal(finished.review.status,'pending');
  const result=await manager.result(first.id,{path:'result.json'});
  assert.equal(result.file.content,'{"sum":10}');
  assert.equal(result.artifacts.length,1); assert.equal(result.artifacts[0].sha256.length,64);
  await manager.review(first.id,{status:'accepted',note:'独立检查总和为10。'});
  assert.equal((await manager.get(first.id)).task.review.status,'accepted');
  assert.equal(await readFile(input,'utf8'),'[2,3,5]');
});
test('queued cancellation never starts a second runtime; active cancellation waits and leaves outputs',async t=>{
  const fake=controlledRunner(); const {manager}=await fixture(t,fake.runner);
  const a=await manager.submit({instruction:'a'}); await started(fake.calls);
  const b=await manager.submit({instruction:'b'});
  assert.equal((await manager.cancel(b.id)).status,'cancelled');
  await writeFile(join(a.workspace,'output','partial.txt'),'保留');
  await manager.cancel(a.id);
  assert.equal((await terminal(manager,a.id)).status,'cancelled');
  assert.equal(fake.calls.length,1);
  assert.equal((await manager.result(a.id,{path:'partial.txt'})).file.content,'保留');
});
test('continue preserves cwd/session and resets review; repeated request does not enqueue twice',async t=>{
  const fake=controlledRunner(); const {manager}=await fixture(t,fake.runner);
  const a=await manager.submit({instruction:'先做第一步'}); await started(fake.calls); fake.calls[0].finish();
  await terminal(manager,a.id);
  await manager.review(a.id,{status:'accepted',note:'检查过。'});
  const request={instruction:'继续第二步',requestId:'continue-123'};
  await manager.continue(a.id,request); await manager.continue(a.id,request); await started(fake.calls,2);
  assert.equal(fake.calls[1].sessionId,'fixture-session');
  assert.equal(fake.calls[1].workspace,a.workspace);
  assert.equal((await manager.get(a.id)).task.review.status,'pending');
  fake.calls[1].finish(); await terminal(manager,a.id);
  assert.equal((await manager.get(a.id)).task.runCount,2);
});
test('invalid paths, secret inputs, unbounded limits and review while running fail explicitly',async t=>{
  const fake=controlledRunner(); const {manager,root}=await fixture(t,fake.runner);
  await assert.rejects(manager.submit({instruction:'x',inputs:['relative.txt']}),{code:'INVALID_INPUT'});
  await assert.rejects(manager.submit({instruction:'x',inputs:[join(root,'..','outside.txt')]}),{code:'INPUT_ROOT_DENIED'});
  const secret=join(root,'.env'); await writeFile(secret,'secret');
  await assert.rejects(manager.submit({instruction:'x',inputs:[secret]}),{code:'SENSITIVE_INPUT'});
  await assert.rejects(manager.submit({instruction:'x',maxRuntimeSeconds:31}),{code:'INVALID_ARGUMENT'});
  const a=await manager.submit({instruction:'x'}); await started(fake.calls);
  await assert.rejects(manager.review(a.id,{status:'accepted',note:'x'}),{code:'TASK_BUSY'});
  await assert.rejects(manager.result(a.id,{path:'../input/foo'}),{code:'PATH_DENIED'});
  fake.calls[0].finish({status:'failed',error:'failure'}); await terminal(manager,a.id);
  await assert.rejects(manager.review(a.id,{status:'accepted',note:'x'}),{code:'TASK_NOT_SUCCEEDED'});
});
test('restart marks active records interrupted and does not restart paid work',async t=>{
  const fake=controlledRunner(); const {manager,config}=await fixture(t,fake.runner);
  const id=randomUUID(), workspace=join(config.tasksDir,id,'workspace');
  await mkdir(join(workspace,'output'),{recursive:true});
  const record={schemaVersion:1,id,workspace,instruction:'恢复',inputs:[],model:'test-model',createdAt:new Date().toISOString(),status:'running',events:[],eventSeq:0,review:{status:'pending'},runs:[{}],requests:{},limits:{maxRuntimeSeconds:30,maxToolCalls:10},sessionId:'previous-session'};
  await atomicJson(join(config.tasksDir,id,'task.json'),record);
  const restarted=await new TaskManager(config,{runner:fake.runner}).init(); t.after(()=>restarted.shutdown());
  assert.equal((await restarted.get(id)).task.status,'interrupted'); assert.equal((await restarted.get(id)).task.mode,'files'); assert.equal(fake.calls.length,0);
  await restarted.continue(id,{instruction:'已核对文件，请继续'});
  await started(fake.calls); assert.equal(fake.calls[0].sessionId,'previous-session'); assert.equal(fake.calls[0].mode,'files'); fake.calls[0].finish(); await terminal(restarted,id);
});
test('tool events have stable cursors and no reasoning is persisted',async t=>{
  const fake=controlledRunner(); const {manager}=await fixture(t,fake.runner);
  const a=await manager.submit({instruction:'events'}); await started(fake.calls);
  fake.calls[0].onEvent({type:'thinking',text:'private reasoning'});
  fake.calls[0].onEvent({type:'tool_call',tool:'read'});
  fake.calls[0].finish(); await terminal(manager,a.id);
  const first=await manager.get(a.id);
  assert(first.events.some(e=>e.type==='tool_call'));
  assert(!first.events.some(e=>e.type==='thinking'));
  assert.equal((await manager.get(a.id,{afterEvent:first.nextCursor})).events.length,0);
});

test('a queued cancellation winning the lock cannot be restarted by the pump',async t=>{
 const fake=controlledRunner();const {manager}=await fixture(t,fake.runner);
 manager.pumping=true;
 const submitted=await manager.submit({instruction:'cancel race'});
 manager.pumping=false;
 const cancelled=manager.cancel(submitted.id);
 void manager.pump();
 assert.equal((await cancelled).status,'cancelled');
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(fake.calls.length,0);
 assert.equal((await manager.get(submitted.id)).task.status,'cancelled');
});
test('cancel during async startup waits for the new process controller to close',async t=>{
 let release,entered;const entering=new Promise(resolve=>{entered=resolve;});
 const runner=async opts=>{
   entered();
   await new Promise(resolve=>{release=resolve;});
   let finish;const done=new Promise(resolve=>{finish=resolve;});
   return {done,cancel:async()=>finish({status:'cancelled',exitCode:1,finalText:'',toolCalls:0})};
 };
 const {manager}=await fixture(t,runner);
 const task=await manager.submit({instruction:'startup race'});
 await entering;
 let ended=false;
 const cancellation=manager.cancel(task.id).then(value=>{ended=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(ended,false);
 release();
 assert.equal((await cancellation).status,'cancelled');
});
test('prototype-named idempotency keys work and labelled secrets never enter a task record',async t=>{
 const fake=controlledRunner();const {manager}=await fixture(t,fake.runner);
 await assert.rejects(manager.submit({instruction:'password=private-value'}),{code:'SENSITIVE_INPUT'});
 for(const key of ['constructor','__proto__','toString']){
   const req={instruction:'idempotency '+key,requestId:key};
   const a=await manager.submit(req);const b=await manager.submit(req);assert.equal(a.id,b.id);
 }
 await started(fake.calls);
 await manager.shutdown();
});

test('review snapshot becomes stale when an output changes after acceptance',async t=>{
 const fake=controlledRunner();const {manager}=await fixture(t,fake.runner);
 const task=await manager.submit({instruction:'artifact review'});await started(fake.calls);
 await writeFile(join(task.workspace,'output','report.txt'),'first');fake.calls[0].finish();await terminal(manager,task.id);
 await manager.review(task.id,{status:'accepted',note:'Checked first revision.'});
 assert.equal((await manager.result(task.id)).reviewStale,false);
 await writeFile(join(task.workspace,'output','report.txt'),'changed');
 assert.equal((await manager.result(task.id)).reviewStale,true);
});
