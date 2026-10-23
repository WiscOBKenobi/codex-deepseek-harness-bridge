/** Paid, opt-in question/answer smoke using an explicitly selected local Harness. */
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { TaskManager } from '../src/task-manager.mjs';
const config = await loadConfig();
assert(process.env.BRIDGE_HARNESS_ROOT && process.env.BRIDGE_HARNESS_HOME, 'Set BRIDGE_HARNESS_ROOT and BRIDGE_HARNESS_HOME; keys stay in Harness.');
config.harnessRoot = resolve(process.env.BRIDGE_HARNESS_ROOT);
config.harnessHome = resolve(process.env.BRIDGE_HARNESS_HOME);
config.entryPath = resolve(process.env.BRIDGE_HARNESS_ENTRY ?? join(config.harnessRoot, 'apps/cli/src/bin.ts'));
config.tasksDir = join(config.dataDir, 'question-smoke-' + randomUUID());
config.maxRuntimeSeconds = 90;
config.maxToolCalls = 8;
await mkdir(config.tasksDir, {recursive:true});
const manager = await new TaskManager(config).init();
async function wait(id) {
 const deadline = Date.now() + 100000;
 while(Date.now() < deadline) {
  const result = await manager.get(id);
  if(!['queued','running','cancelling'].includes(result.task.status)) return result.task;
  await new Promise(resolve => setTimeout(resolve, 250));
 }
 throw new Error('Smoke deadline exceeded');
}
try {
 const task = await manager.submit({instruction:'This is a question protocol test. The required delivery format is intentionally undecided: JSON or CSV. Ask Codex to choose using bridge_question, then stop this turn. Do not create deliverables until answered.',requestId:'question-smoke-'+randomUUID()});
 const paused = await wait(task.id);
 console.log(JSON.stringify({stage:'question', status:paused.status, error:paused.error}));
 assert.equal(paused.status,'awaiting_answer');
 await manager.continue(task.id,{instruction:'Choose JSON. Write output/result.json containing exactly {"format":"JSON","verified":true}, read it back, and finish normally. Do not ask again.',requestId:'answer-smoke-'+randomUUID()});
 const done = await wait(task.id);
 assert.equal(done.status,'succeeded');assert.equal(done.sessionId,paused.sessionId);
 const result=await manager.result(task.id,{path:'result.json'});
 assert.deepEqual(JSON.parse(result.file.content),{format:'JSON',verified:true});
 console.log(JSON.stringify({stage:'answer',status:done.status,questionRounds:done.questionBudget.used}));
} finally { await manager.shutdown(); }
