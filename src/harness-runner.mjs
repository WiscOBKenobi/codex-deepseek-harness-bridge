/** Supervise one official headless invocation and expose bounded, non-reasoning events. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { validateWorkspace } from './harness-guard.mjs';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const KILL_AFTER_MS = 2500;
const HEARTBEAT_MS = 15_000;

/** Redact common credential spellings and cap text before persistence or presentation. */
export function redactText(value, maximum = 12000) {
  return String(value ?? '')
    .replace(/\b(?:sk|ghp|github_pat)-?[a-zA-Z0-9_-]{16,}\b/gu, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"'<>]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_ -]?key|authorization|access[_ -]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;\]}]+/giu, '$1[REDACTED]')
    .slice(0, maximum);
}

/** Reuse Harness-managed credentials, preserve endpoint routing, and pin task-local policy. */
export function buildChildEnvironment(config, inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (key.toUpperCase() !== 'DEEPSEEK_API_KEY') env[key] = value;
  }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  env[pathKey] = [dirname(config.nodePath), join(config.harnessRoot, 'node_modules', '.bin'), env[pathKey] ?? ''].join(delimiter);
  env.DSH_HOME = config.harnessHome;
  env.TSX_TSCONFIG_PATH = join(config.harnessRoot, 'tsconfig.json');
  env.DSH_TELEMETRY_MODE = 'DISABLED';
  env.DSH_PERMISSION_MODE = 'workspace-write';
  env.DSH_TOOLS_MODE = 'native';
  env.OTEL_SDK_DISABLED = 'true';
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error('Invalid inherited Git configuration.');
  env['GIT_CONFIG_KEY_' + count] = 'safe.directory';
  env['GIT_CONFIG_VALUE_' + count] = config.harnessRoot.replaceAll('\\', '/');
  env.GIT_CONFIG_COUNT = String(count + 1);
  return env;
}

export function createPatch(config, workspace, limits, mode = 'files') {
  const patch = [
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'agent-default-model', config: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
    { insert: [{ id: 'codex-bridge-monitor', name: pathToFileURL(join(sourceDir, 'harness-monitor.mjs')).href, config: { progressIntervalMs: 5000 } }] },
  ];
  if (mode === 'files') patch.push(
    { id: 'agent-instructions', disabled: true },
    { id: 'skill-filesystem', disabled: true },
    { insert: [{
      id: 'codex-bridge-guard',
      name: pathToFileURL(join(sourceDir, 'harness-guard.mjs')).href,
      config: { workspace, maxToolCalls: limits.maxToolCalls, maxInputBytes: config.maxInputBytes, maxOutputBytes: config.maxOutputBytes },
    }] },
  );
  if (mode === 'agent' && limits.maxToolCalls > 0) patch.push({ insert: [{ id: 'codex-bridge-budget', name: pathToFileURL(join(sourceDir, 'harness-budget.mjs')).href, config: { maxToolCalls: limits.maxToolCalls } }] });
  return patch;
}

function diagnosticSummary(text) {
  if (!text) return undefined;
  if (/401|unauthorized|invalid.{0,20}(?:key|credential)/iu.test(text)) return 'Harness reported an authentication failure.';
  if (/429|rate.?limit|insufficient.{0,20}(?:balance|quota)/iu.test(text)) return 'Harness reported a quota or rate limit.';
  if (/Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/iu.test(text)) return 'Harness could not load a required module.';
  if (/ECONN|ENOTFOUND|fetch failed|socket|connection/iu.test(text)) return 'Harness reported a network connection failure.';
  return 'Harness emitted diagnostics; raw stderr was not retained.';
}

function terminateTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}

/** Start a task; cancellation is idempotent and settles only after the child actually closes. */
export async function startHarness({ config, workspace, taskDir, prompt, sessionId, limits, mode = 'files', onEvent = () => {} }) {
  if (!['files', 'agent'].includes(mode)) throw new Error('Invalid task mode.');
  if (mode === 'agent' && !config.enableNativeAgent) throw new Error('Native agent execution has not been enabled in local configuration.');
  workspace = validateWorkspace(workspace);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A task prompt is required.');
  if (!Number.isFinite(limits.maxRuntimeSeconds) || limits.maxRuntimeSeconds < 0
      || !Number.isSafeInteger(limits.maxToolCalls) || limits.maxToolCalls < 0) throw new Error('Invalid task limits.');
  await mkdir(taskDir, { recursive: true });
  const patchPath = join(taskDir, 'run-' + randomUUID() + '.patch.json');
  await writeFile(patchPath, JSON.stringify(createPatch(config, workspace, limits, mode), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const args = ['--import', pathToFileURL(join(sourceDir, 'child-lifecycle.mjs')).href];
  if (config.entryPath.endsWith('.ts')) {
    const require = createRequire(join(config.harnessRoot, 'package.json'));
    args.push('--import', pathToFileURL(require.resolve('tsx/esm')).href);
  }
  args.push(config.entryPath, 'headless', '--patch', patchPath, '--json');
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');
  const child = spawn(config.nodePath, args, {
    cwd: workspace, env: buildChildEnvironment(config),
    windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let finalText = '';
  let currentSession = sessionId;
  let toolCalls = 0;
  let finalSeen = false;
  let guardReady = mode === 'agent';
  let monitorReady = false;
  let turnEnd;
  let streamError;
  let failureMessage;
  let stopStatus;
  let closed = false;
  let forcedTimer;
  let stderr = '';
  let stderrBytes = 0;
  let streamBytes = 0;
  let pending = '';
  let pendingBytes = 0;
  const decoder = new StringDecoder('utf8');
  const emit = event => {
    try { onEvent(event); }
    catch (error) { /* A failed subscriber cannot detach supervision or expose raw event text. */ }
  };
  let resolveDone;
  const done = new Promise(resolveDoneValue => { resolveDone = resolveDoneValue; });
  function stop(status, message) {
    if (closed || stopStatus) return;
    stopStatus = status;
    if (message) failureMessage = message;
    if (child.connected) child.send({ type: 'codex-bridge-stop' }, error => { if (error) terminateTree(child); });
    else terminateTree(child);
    forcedTimer = setTimeout(() => terminateTree(child), KILL_AFTER_MS);
    forcedTimer.unref();
  }
  function fail(message) {
    streamError ??= message;
    stop('failed', message);
  }
  function readEvent(line) {
    if (!line.trim() || streamError) return;
    let event;
    try { event = JSON.parse(line); }
    catch (error) { fail('Harness returned malformed JSON output.'); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      fail('Harness returned an invalid event.'); return;
    }
    if (event.type === 'bridge_monitor') {
      if (monitorReady || event.version !== 1) { fail('Harness monitor handshake failed.'); return; }
      monitorReady = true;
      emit({ type: 'monitor_ready', mode });
      return;
    }
    if (event.type === 'bridge_progress') {
      if (!monitorReady || event.version !== 1 || !['model_stream', 'tool_start', 'tool_end', 'job_output'].includes(event.kind)) { fail('Harness returned invalid monitor metadata.'); return; }
      const progress = { type: 'progress', kind: event.kind };
      for (const key of ['activeTools', 'chunks', 'bytes', 'activityId', 'elapsedMs']) {
        if (Number.isSafeInteger(event[key]) && event[key] >= 0) progress[key] = event[key];
      }
      if (['start', 'chunk', 'end'].includes(event.phase)) progress.phase = event.phase;
      emit(progress);
      return;
    }
    if (event.type === 'bridge_guard') {
      if (guardReady || event.version !== 1 || JSON.stringify(event.tools) !== '["read","write","edit"]') {
        fail('Harness guard handshake failed.'); return;
      }
      guardReady = true;
      emit({ type: 'guard_ready', tools: ['read', 'write', 'edit'] });
      return;
    }
    if (event.type === 'error') {
      failureMessage = redactText(event.message, 1600) || 'Harness reported a startup error.';
      emit({ type: 'error', message: failureMessage });
      return;
    }
    if (!guardReady || !monitorReady) { fail('Harness emitted task data before its required plugins were ready.'); return; }
    if (event.type === 'thinking') return;
    switch (event.type) {
      case 'session':
        if (typeof event.sessionId !== 'string' || !event.sessionId || (sessionId && event.sessionId !== sessionId)) {
          fail('Harness returned a mismatched session.'); return;
        }
        currentSession = event.sessionId;
        emit({ type: 'session', sessionId: redactText(currentSession, 256) });
        return;
      case 'status': {
        const safe = { type: 'status', phase: redactText(event.phase, 80) };
        if (Number.isSafeInteger(event.turn)) safe.turn = event.turn;
        if (Number.isSafeInteger(event.step)) safe.step = event.step;
        if (event.phase === 'turn_end') {
          turnEnd = event.reason?.kind;
          safe.reason = redactText(turnEnd, 80);
          if (turnEnd === 'error') failureMessage = redactText(event.reason?.error?.message, 1600) || 'Harness turn failed.';
        }
        emit(safe);
        return;
      }
      case 'tool_call':
        toolCalls++;
        emit({ type: 'tool_call', callId: redactText(event.callId, 160), tool: redactText(event.tool, 80),
          filePath: redactText(event.input?.file_path, 1000) });
        if (limits.maxToolCalls > 0 && toolCalls > limits.maxToolCalls) stop('failed', 'Task tool-call limit exceeded.');
        return;
      case 'tool_result':
        emit({ type: 'tool_result', callId: redactText(event.callId, 160), status: event.status === 'completed' ? 'completed' : 'error' });
        return;
      case 'text':
        emit({ type: 'text', text: redactText(event.text, 4000) });
        return;
      case 'final':
        if (typeof event.text !== 'string' || finalSeen) { fail('Harness returned an invalid final event.'); return; }
        finalSeen = true;
        finalText = redactText(event.text, 24000);
        emit({ type: 'final', text: finalText });
        return;
      default:
        fail('Harness returned an unsupported event type.');
    }
  }
  function readChunk(chunk) {
    streamBytes += chunk.length;
    if ((config.maxStreamBytes ?? MAX_STREAM_BYTES) > 0 && streamBytes > (config.maxStreamBytes ?? MAX_STREAM_BYTES)) { fail('Harness output stream exceeded its size limit.'); return; }
    pending += decoder.write(chunk);
    let boundary;
    while ((boundary = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { fail('Harness event exceeded its size limit.'); return; }
      readEvent(line);
    }
    pendingBytes = Buffer.byteLength(pending);
    if (pendingBytes > MAX_LINE_BYTES) { pending = ''; fail('Harness event exceeded its size limit.'); }
  }
  child.stdout.on('data', readChunk);
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    stderr = (stderr + chunk.toString('utf8')).slice(-8192);
  });
  child.on('error', error => { failureMessage = 'Harness process could not start (' + (error.code ?? 'PROCESS_ERROR') + ').'; });
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE' && !stopStatus) failureMessage = 'Harness could not receive the task prompt.';
  });
  let timer;
  if (limits.maxRuntimeSeconds > 0) {
    const deadline = Date.now() + limits.maxRuntimeSeconds * 1000;
    const checkDeadline = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { stop('timed_out', 'Task runtime limit exceeded.'); return; }
      timer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
      timer.unref();
    };
    checkDeadline();
  }
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), HEARTBEAT_MS);
  heartbeat.unref();
  emit({ type: 'heartbeat' });
  child.on('close', (exitCode, signal) => {
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    clearTimeout(forcedTimer);
    pending += decoder.end();
    if (pending.trim() && !streamError) readEvent(pending);
    const successful = !failureMessage && !streamError && guardReady && monitorReady && currentSession && finalSeen && turnEnd === 'completed' && exitCode === 0;
    const status = stopStatus ?? (successful ? 'succeeded' : 'failed');
    resolveDone({
      status, actualMode: mode, sessionId: currentSession, finalText, exitCode, toolCalls,
      ...(status !== 'succeeded' ? { error: failureMessage ?? streamError ?? 'Harness exited without a completed turn.' } : {}),
      diagnostics: { guardReady, monitorReady, turnEnd, signal, stderrBytes, streamBytes, stderrSummary: diagnosticSummary(stderr) },
    });
    stderr = '';
  });
  child.stdin.end(prompt);
  return {
    done,
    async cancel() { stop('cancelled', 'Task cancelled by the caller.'); await done; },
  };
}
