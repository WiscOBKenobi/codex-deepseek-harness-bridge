/** Opt-in real event wake test; run after configuring this project's local Harness paths. */
import { bridgeCall } from '../src/client.mjs';
import { atomicJson, readJson } from '../src/util.mjs';
import { projectRoot } from '../src/config.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const checkpoint=join(projectRoot,'.bridge','wake-smoke.json');
let state;
try { state=await readJson(checkpoint); } catch(error) { if(error.code!=='ENOENT')throw error; }
if (!state) {
 if (!process.env.CODEX_THREAD_ID) throw Error('Run from the intended originating Codex thread.');
 state={requestId:'wake-smoke-'+randomUUID(),codexThreadId:process.env.CODEX_THREAD_ID};
 await atomicJson(checkpoint,state);
}
if (!state.taskId) {
 const task=await bridgeCall('submit',{
  requestId:state.requestId,codexThreadId:state.codexThreadId,mode:'files',maxRuntimeSeconds:90,maxToolCalls:8,
  instruction:'This is an event-wakeup integration test. Delivery format is intentionally undecided between JSON and CSV. Ask Codex to choose via bridge_question, then stop. After Codex answers, write output/result.json containing exactly {"format":"JSON","verified":true}, read it back, and finish normally. Do not guess the format before receiving the answer.',
 });
 state.taskId=task.id;await atomicJson(checkpoint,state);
}
console.log(JSON.stringify({taskId:state.taskId,codexThreadId:state.codexThreadId,requestId:state.requestId}));
