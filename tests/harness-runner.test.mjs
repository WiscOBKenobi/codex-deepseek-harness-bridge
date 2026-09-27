import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarness, buildChildEnvironment, redactText } from '../src/harness-runner.mjs';
const fixture = resolve('tests/fixtures/harness-child.mjs');
async function setup(t) {
  const base = resolve('.bridge', 'test-runner');
  await mkdir(base, { recursive: true });
  const taskDir = await mkdtemp(join(base, 'run-'));
  const workspace = join(taskDir, 'workspace');
  await mkdir(join(workspace, 'input'), { recursive: true });
  await mkdir(join(workspace, 'output'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const config = { harnessRoot: taskDir, harnessHome: join(taskDir, 'home'), nodePath: process.execPath, entryPath: fixture,
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', maxInputBytes: 10000, maxOutputBytes: 10000 };
  return { config, workspace, taskDir, prompt: '{}', limits: { maxRuntimeSeconds: 10, maxToolCalls: 5 } };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function until(check, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await delay(30); }
  assert.fail('Timed out waiting for process state.');
}

test('successful natural exit requires guard, session, completed turn, final and exit zero', async t => {
  const events = [];
  const run = await startHarness({ ...await setup(t), onEvent: event => events.push(event) });
  const result = await run.done;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.finalText, 'fixture complete');
  assert.equal(result.sessionId, 'fixture-session-123');
  assert.ok(events.some(event => event.type === 'guard_ready'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING|unlogged|content omitted|sk-fake/u);
  await run.cancel();
  assert.equal((await run.done).status, 'succeeded');
});

for (const mode of ['exit-error', 'turn-error', 'no-final', 'no-guard', 'no-monitor', 'malformed', 'oversize']) {
  test('fails closed for ' + mode, async t => {
    const run = await startHarness({ ...await setup(t), prompt: JSON.stringify({ mode }) });
    const result = await run.done;
    assert.equal(result.status, 'failed');
    assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /example-secret/u);
  });
}

test('forwards exact continuation identity and contains a throwing subscriber', async t => {
  const run = await startHarness({ ...await setup(t), sessionId: 'saved-session-456', onEvent() { throw new Error('subscriber'); } });
  const result = await run.done;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.sessionId, 'saved-session-456');
});

test('idempotent cancellation waits until the ignored-stop process is gone', async t => {
  let pid;
  const run = await startHarness({ ...await setup(t), prompt: JSON.stringify({ mode: 'hang', ignoreStop: true }),
    onEvent: event => { if (event.type === 'text' && event.text.startsWith('pid:')) pid = Number(event.text.slice(4)); } });
  await until(() => pid !== undefined);
  await Promise.all([run.cancel(), run.cancel()]);
  assert.equal((await run.done).status, 'cancelled');
  assert.equal(alive(pid), false);
});

test('runtime timeout kills the child and retains timed_out independently of exit code', async t => {
  const options = await setup(t);
  let pid;
  const run = await startHarness({ ...options, prompt: JSON.stringify({ mode: 'hang' }),
    limits: { ...options.limits, maxRuntimeSeconds: 0.3 },
    onEvent: event => { if (event.type === 'text' && event.text.startsWith('pid:')) pid = Number(event.text.slice(4)); } });
  const result = await run.done;
  assert.equal(result.status, 'timed_out');
  if (pid) assert.equal(alive(pid), false);
});

test('tool budget fails even if fixture claims a completed final', async t => {
  const options = await setup(t);
  const run = await startHarness({ ...options, prompt: JSON.stringify({ toolCalls: 3 }), limits: { ...options.limits, maxToolCalls: 2 } });
  assert.equal((await run.done).status, 'failed');
  assert.match((await run.done).error, /tool-call/u);
});

test('missing executable is an explicit failed outcome', async t => {
  const options = await setup(t);
  const run = await startHarness({ ...options, config: { ...options.config, nodePath: join(options.taskDir, 'missing-node.exe') } });
  const result = await run.done;
  assert.equal(result.status, 'failed');
  assert.match(result.error, /could not start/u);
});

test('child exits after abrupt owner death', async t => {
  const options = await setup(t);
  const pidFile = join(options.taskDir, 'child.pid');
  options.prompt = JSON.stringify({ mode: 'hang', pidFile });
  const owner = spawn(process.execPath, [resolve('tests/fixtures/harness-owner.mjs'), JSON.stringify(options)],
    { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (owner.exitCode === null) owner.kill('SIGKILL'); });
  let pid;
  await until(async () => {
    try { pid = Number(await readFile(pidFile, 'utf8')); return pid > 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  owner.kill('SIGKILL');
  await until(() => !alive(pid));
});

test('environment uses managed credentials while preserving endpoint routing and Git config', () => {
  const env = buildChildEnvironment({ nodePath: process.execPath, harnessRoot: resolve('.'), harnessHome: resolve('.bridge/home') },
    { Path: 'existing', DeepSeek_API_KEY: 'fake-key', DEEPSEEK_BASE_URL: 'https://example.invalid/v1',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: 'z' });
  assert.equal(env.DeepSeek_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_BASE_URL, 'https://example.invalid/v1');
  assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write');
  assert.equal(env.DSH_TOOLS_MODE, 'native');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'x.y');
});

test('redacts common credentials and caps returned text', () => {
  assert.doesNotMatch(redactText('Bearer fake-value api_key=secret-value sk-fake00000000000000000000'), /fake-value|secret-value|sk-fake/u);
  assert.equal(redactText('123456', 3), '123');
});
