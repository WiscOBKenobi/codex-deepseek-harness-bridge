/** Run an explicit, keyless sandbox smoke through an official dsh profile. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { buildChildEnvironment } from '../src/harness-runner.mjs';
import { validateWorkspace } from '../src/harness-guard.mjs';

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--workspace') {
  console.log('Usage: node scripts/probe-native-sandbox.mjs --run --workspace <existing task workspace>');
  console.log('No API calls or ACL repair. The official sandbox may initialize its normal workspace ACL and Low label.');
  console.log('Run only after that exact workspace has been authorized and prepared for the official sandbox.');
  process.exitCode = args.includes('--help') || args.length === 0 ? 0 : 1;
} else {
  await main(resolve(args[2]));
}

async function main(requestedWorkspace) {
  if (process.platform !== 'win32') throw new Error('This diagnostic targets the official Windows sandbox.');
  const config = await loadConfig();
  const workspace = validateWorkspace(requestedWorkspace);
  const part = relative(config.tasksDir, workspace);
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) {
    throw new Error('The diagnostic workspace must be an existing task under this project.');
  }
  const marker = 'native-sandbox-probe-' + randomUUID();
  const probeDir = join(config.dataDir, 'native-sandbox-probes', marker);
  await mkdir(join(probeDir, 'outside'), { recursive: true });
  const outside = join(probeDir, 'outside', 'sentinel.txt');
  const inside = join(workspace, 'output', marker + '.txt');
  await writeFile(outside, marker, { flag: 'wx' });
  const home = join(probeDir, 'home');
  await mkdir(home);
  const plugin = fileURLToPath(new URL('./native-sandbox-probe-plugin.mjs', import.meta.url));
  const patch = [
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'agent-instructions', disabled: true },
    { id: 'skill-filesystem', disabled: true },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'tool-pwsh', config: { promoteOnTimeout: false, enableRunInBackground: false } },
    { insert: [{ id: 'bridge-native-sandbox-probe', name: pathToFileURL(plugin).href, config: { workspace, inside, outside, marker } }] },
  ];
  const patchPath = join(probeDir, 'probe.patch.json');
  await writeFile(patchPath, JSON.stringify(patch, null, 2) + '\n', { flag: 'wx' });
  const nodeArgs = [];
  if (config.entryPath.endsWith('.ts')) {
    const require = createRequire(join(config.harnessRoot, 'package.json'));
    nodeArgs.push('--import', pathToFileURL(require.resolve('tsx/esm')).href);
  }
  nodeArgs.push(config.entryPath, 'headless', '--patch', patchPath);
  const env = buildChildEnvironment({ ...config, harnessHome: home });
  env.DSH_AGENTS_HOME = join(probeDir, 'agents');
  env.DSH_TELEMETRY_DISABLED = '1';
  const child = spawn(config.nodePath, nodeArgs, {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', outputOverflow = false, stderrSeen = false, timedOut = false;
  const kill = () => {
    if (!child.pid || child.exitCode !== null) return;
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); });
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 65536) { outputOverflow = true; kill(); return; }
    stdout += chunk;
  });
  child.stderr.on('data', () => { stderrSeen = true; });
  const timeout = setTimeout(() => { timedOut = true; kill(); }, 60000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveExit(code));
  }).finally(() => clearTimeout(timeout));
  const prefix = 'BRIDGE_NATIVE_SANDBOX_PROBE ';
  let childReport;
  const line = stdout.split(/\r?\n/u).find(value => value.startsWith(prefix));
  if (line) {
    try { childReport = JSON.parse(line.slice(prefix.length)); }
    catch (error) { childReport = { passed: false, errorCode: 'INVALID_PROBE_REPORT' }; }
  }
  const outsideUnchanged = await readFile(outside, 'utf8').then(value => value === marker, () => false);
  const insideWritten = await readFile(inside, 'utf8').then(value => value === marker, () => false);
  const report = {
    passed: childReport?.passed === true && exitCode === 0 && outsideUnchanged && insideWritten && !timedOut && !outputOverflow,
    apiCalls: 0, workspace, probeDir, exitCode, timedOut, outputOverflow, stderrSeen,
    independentChecks: { outsideUnchanged, insideWritten },
    probe: childReport ?? { passed: false, errorCode: 'PROBE_REPORT_MISSING' },
  };
  await writeFile(join(probeDir, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
