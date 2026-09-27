import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link, symlink, unlink, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { startHarness, buildChildEnvironment } from '../src/harness-runner.mjs';

test('official headless registry restricts real tools without making a model request', { timeout: 60000 }, async t => {
  const harnessRoot = resolve('../DS Harness');
  const entryPath = join(harnessRoot, 'apps/cli/src/bin.ts');
  try { await access(entryPath); await access(join(harnessRoot, 'node_modules/tsx/package.json')); }
  catch (error) { t.skip('The existing local Harness installation is required for this integration test.'); return; }
  const base = resolve('.bridge', 'test-integration');
  await mkdir(base, { recursive: true });
  const taskDir = await mkdtemp(join(base, 'run-'));
  const workspace = join(taskDir, 'workspace');
  await mkdir(join(workspace, 'input'), { recursive: true });
  await mkdir(join(workspace, 'output'));
  await mkdir(join(taskDir, 'outside'));
  await writeFile(join(workspace, 'input/source.txt'), 'copied input');
  await writeFile(join(taskDir, 'outside.txt'), 'untouched');
  await writeFile(join(taskDir, 'outside/secret.txt'), 'private');
  const linked = join(workspace, 'output/link');


  t.after(async () => { try { await unlink(linked); } catch (error) { if (error.code !== 'ENOENT') throw error; } await rm(taskDir, { recursive: true, force: true }); });
  const config = { harnessRoot, harnessHome: join(taskDir, 'harness-home'), nodePath: process.execPath,
    entryPath: resolve('tests/fixtures/harness-child.mjs'), provider: 'deepseek-official', model: 'deepseek-flash',
    reasoningEffort: 'max', maxInputBytes: 10000, maxOutputBytes: 10000 };
  const warmup = await startHarness({ config, workspace, taskDir, prompt: '{}', limits: { maxRuntimeSeconds: 10, maxToolCalls: 30 } });
  assert.equal((await warmup.done).status, 'succeeded');
  const patchPath = join(taskDir, (await readdir(taskDir)).find(path => path.endsWith('.patch.json')));
  const patch = JSON.parse(await readFile(patchPath, 'utf8'));
  const reportPath = join(taskDir, 'probe-report.json');
  const tracePath = join(taskDir, 'probe-trace.json');
  patch.push({ insert: [{ id: 'bridge-keyless-probe', name: pathToFileURL(resolve('tests/fixtures/harness-guard-probe.mjs')).href,
    config: { workspace, reportPath, tracePath } }] });
  await writeFile(patchPath, JSON.stringify(patch));
  const startedAt = Date.now();
  const require = createRequire(join(harnessRoot, 'package.json'));
  const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href,
    entryPath, 'headless', '--patch', patchPath, '--json', '-'],
    { cwd: workspace, env: buildChildEnvironment(config), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrBytes = 0, stdoutBytes = 0;
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.stdin.end('This run is vetoed before a model request.');
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  const exitCode = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  clearTimeout(timer);
  let trace = { phase: 'probe_not_mounted' };
  try { trace = JSON.parse(await readFile(tracePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const diagnostics = JSON.stringify({ elapsedMs: Date.now() - startedAt, trace, stdoutBytes, stderrBytes });
  t.diagnostic(diagnostics);
  assert.equal(exitCode, 1, 'Official CLI exit: ' + diagnostics);
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch (error) { assert.fail('Probe did not finish; agent creation stops before a model request. ' + diagnostics); }
  assert.deepEqual(report, { passed: true, tools: ['edit', 'read', 'write'], modelRequests: 0, guardDenials: 7 });
});
