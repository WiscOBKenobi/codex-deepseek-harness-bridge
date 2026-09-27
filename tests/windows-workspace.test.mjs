import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { prepareWindowsWorkspace, initializeWindowsTaskWorkspace } from '../src/windows-workspace.mjs';
import { BridgeError } from '../src/util.mjs';

async function setup(t, { specialName = false } = {}) {
  const base = resolve('.bridge', 'test-windows-workspace');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  const taskDir = specialName ? join(root, "task ' ; $variable (literal)") : root;
  const workspace = join(taskDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  t.after(async () => {
    const rel = relative(base, root);
    assert.ok(rel !== '' && rel !== '..' && !rel.startsWith('..' + sep));
    await rm(root, { recursive: true, force: true });
  });
  return { taskDir, workspace };
}

/** In-memory process transport; no test launches PowerShell or changes permissions. */
function mockProcess({ output = { ok: true, status: 'updated' }, stderr = '', exitCode = 0, hang = false, error } = {}) {
  const calls = [];
  const children = [];
  function spawnProcess(executable, args, options) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => {
        child.exitCode = null;
        child.emit('exit', null, 'SIGTERM');
        child.emit('close', null, 'SIGTERM');
      });
      return true;
    };
    child.unref = () => child;
    const call = { executable, args, options, input: '' };
    calls.push(call);
    children.push(child);
    child.stdin.on('data', chunk => { call.input += chunk.toString('utf8'); });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        child.emit('close', -1, null);
        return;
      }
      if (hang) return;
      if (stderr) child.stderr.write(stderr);
      child.stdout.end(typeof output === 'string' ? output : JSON.stringify(output));
      child.stderr.end();
      child.exitCode = exitCode;
      child.emit('exit', exitCode, null);
      child.emit('close', exitCode, null);
    }));
    return child;
  }
  return { spawnProcess, calls, children };
}

function fixedFailure(code, forbidden = 'DO_NOT_EXPOSE') {
  return error => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, code);
    assert.ok(!String(error.message).includes(forbidden));
    assert.ok(!JSON.stringify(error).includes(forbidden));
    return true;
  };
}

test('Windows workspace preparation reports an update and passes paths only through stdin', async t => {
  const options = await setup(t, { specialName: true });
  const mock = mockProcess();
  const result = await prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess });
  assert.equal(result.status, 'updated');
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.match(call.executable, /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
  assert.ok(call.args.includes('-Command'));
  assert.ok(call.args.includes('-NoProfile'));
  assert.ok(call.args.includes('-NonInteractive'));
  assert.ok(call.args.every(argument => !argument.includes(options.workspace)));
  assert.ok(call.args.every(argument => !argument.includes(options.taskDir)));
  assert.deepEqual(JSON.parse(call.input), { workspace: options.workspace });
  assert.notEqual(call.options?.shell, true);
  assert.equal(call.options?.windowsHide, true);
});

test('an already prepared Windows workspace returns unchanged on repeated preparation', async t => {
  const options = await setup(t);
  const mock = mockProcess({ output: { ok: true, status: 'unchanged' } });
  for (let index = 0; index < 2; index++) {
    const result = await prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess });
    assert.equal(result.status, 'unchanged');
  }
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.calls.map(call => JSON.parse(call.input)), [{ workspace: options.workspace }, { workspace: options.workspace }]);
});

test('non-Windows preparation does not inspect or spawn a Windows helper', async () => {
  const result = await prepareWindowsWorkspace({ workspace: 'missing', taskDir: 'missing' }, {
    platform: 'linux', spawnProcess() { assert.fail('Unexpected child process'); },
  });
  assert.deepEqual(result, { status: 'not_required' });
});

test('a valid workspace belonging to another task is rejected before process launch', async t => {
  const options = await setup(t);
  const another = await setup(t);
  const mock = mockProcess();
  await assert.rejects(prepareWindowsWorkspace({ ...options, workspace: another.workspace }, {
    platform: 'win32', spawnProcess: mock.spawnProcess,
  }), { code: 'WORKSPACE_PATH_MISMATCH' });
  assert.equal(mock.calls.length, 0);
});

test('a workspace junction is rejected before process launch', async t => {
  const options = await setup(t);
  const target = await setup(t);
  assert.equal(resolve(options.workspace), resolve(options.taskDir, 'workspace'));
  await rm(options.workspace, { recursive: true });
  await symlink(target.workspace, options.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  const mock = mockProcess();
  await assert.rejects(prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess }));
  assert.equal(mock.calls.length, 0);
});

for (const code of ['WORKSPACE_OWNER_MISMATCH', 'WORKSPACE_ACL_DENIED', 'WORKSPACE_ACL_PREPARE_FAILED']) {
  test('helper failure ' + code + ' is fixed and discards sensitive stderr', async t => {
    const options = await setup(t);
    const mock = mockProcess({ output: { ok: false, code }, stderr: 'DO_NOT_EXPOSE: secret child failure', exitCode: 1 });
    await assert.rejects(prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess }), fixedFailure(code));
  });
}

test('successful helper output does not expose incidental stderr', async t => {
  const options = await setup(t);
  const mock = mockProcess({ stderr: 'DO_NOT_EXPOSE: incidental diagnostic' });
  const result = await prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess });
  assert.equal(result.status, 'updated');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));
});

for (const [name, output, exitCode] of [
  ['unrecognized error code', { ok: false, code: 'DO_NOT_EXPOSE' }, 1],
  ['invalid JSON', 'DO_NOT_EXPOSE not JSON', 1],
  ['unrecognized status', { ok: true, status: 'DO_NOT_EXPOSE' }, 0],
  ['success payload with failing exit', { ok: true, status: 'updated' }, 1],
  ['excessive stdout', 'DO_NOT_EXPOSE'.repeat(100000), 0],
]) {
  test(name + ' is rejected without copying helper output', async t => {
    const options = await setup(t);
    const mock = mockProcess({ output, exitCode });
    await assert.rejects(prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess }), fixedFailure('WORKSPACE_ACL_PREPARE_FAILED'));
  });
}

test('a synchronous process startup failure is reported with a fixed error', async t => {
  const options = await setup(t);
  await assert.rejects(prepareWindowsWorkspace(options, {
    platform: 'win32', spawnProcess() { throw new Error('DO_NOT_EXPOSE: cannot launch'); },
  }), fixedFailure('WORKSPACE_ACL_PREPARE_FAILED'));
});

test('an asynchronous process startup failure is reported with a fixed error', async t => {
  const options = await setup(t);
  const mock = mockProcess({ error: new Error('DO_NOT_EXPOSE: cannot launch') });
  await assert.rejects(prepareWindowsWorkspace(options, { platform: 'win32', spawnProcess: mock.spawnProcess }), fixedFailure('WORKSPACE_ACL_PREPARE_FAILED'));
});

test('a helper timeout stops the child and returns a fixed error', async t => {
  const options = await setup(t);
  const mock = mockProcess({ hang: true });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(prepareWindowsWorkspace(options, {
    platform: 'win32', spawnProcess: mock.spawnProcess, timeoutMs: 25,
  }), fixedFailure('WORKSPACE_ACL_PREPARE_FAILED'));
  assert.equal(mock.children.length, 1);
  assert.equal(mock.children[0].killed, true);
});

/** Fake the official public ACL API, including the canonical root used to derive its SID. */
function mockInitializer({ failingStage, disposeFailure = false, moduleValue } = {}) {
  const calls = [];
  const canonicalRoot = 'mock-canonical-workspace';
  const sid = 'mock-workspace-sid';
  function record(stage, ...args) {
    calls.push({ stage, args });
    if (failingStage === stage || (stage === 'dispose' && disposeFailure)) {
      throw new Error('DO_NOT_EXPOSE: ' + stage + ' private diagnostic');
    }
  }
  const grant = {
    add(...args) { record('add', ...args); },
    dispose(...args) { record('dispose', ...args); },
  };
  const acl = {
    workspaceWriteSid(...args) { record('sid', ...args); return sid; },
    AclWriteGrant: { create(...args) { record('create', ...args); return grant; } },
  };
  const dependencies = {
    platform: 'win32',
    async loadAclModule(...args) { record('load', ...args); return moduleValue === undefined ? acl : moduleValue; },
    async prepareOwner(...args) { record('prepare', ...args); return { status: 'updated' }; },
    realpath(...args) { record('realpath', ...args); return canonicalRoot; },
  };
  return { calls, dependencies, canonicalRoot, sid };
}

test('empty task initialization loads the official API before preparing ownership and disposes its grant', async t => {
  const options = { ...await setup(t), harnessRoot: 'mock-harness-installation' };
  const mock = mockInitializer();
  const result = await initializeWindowsTaskWorkspace(options, mock.dependencies);
  assert.deepEqual(result, { status: 'initialized' });
  assert.deepEqual(mock.calls, [
    { stage: 'load', args: [options.harnessRoot] },
    { stage: 'prepare', args: [{ workspace: options.workspace, taskDir: options.taskDir }, { platform: 'win32' }] },
    { stage: 'realpath', args: [options.workspace] },
    { stage: 'sid', args: [mock.canonicalRoot] },
    { stage: 'create', args: [mock.sid] },
    { stage: 'add', args: [mock.canonicalRoot, true] },
    { stage: 'dispose', args: [] },
  ]);
  assert.deepEqual(await readdir(options.workspace), []);
});

test('non-Windows initialization skips path inspection, loading and ownership preparation', async () => {
  const mock = mockInitializer();
  const result = await initializeWindowsTaskWorkspace({ workspace: 'missing', taskDir: 'missing', harnessRoot: 'missing' }, {
    ...mock.dependencies, platform: 'linux',
  });
  assert.deepEqual(result, { status: 'not_required' });
  assert.deepEqual(mock.calls, []);
});

test('initialization rejects another task workspace before loading the ACL module', async t => {
  const options = await setup(t);
  const another = await setup(t);
  const mock = mockInitializer();
  await assert.rejects(initializeWindowsTaskWorkspace({ ...options, workspace: another.workspace }, mock.dependencies), {
    code: 'WORKSPACE_PATH_MISMATCH',
  });
  assert.deepEqual(mock.calls, []);
});

test('initialization rejects a workspace junction before loading the ACL module', async t => {
  const options = await setup(t);
  const target = await setup(t);
  assert.equal(resolve(options.workspace), resolve(options.taskDir, 'workspace'));
  await rm(options.workspace, { recursive: true });
  await symlink(target.workspace, options.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  const mock = mockInitializer();
  await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies));
  assert.deepEqual(mock.calls, []);
});

for (const childKind of ['file', 'directory']) {
  test('initialization preserves a nonempty workspace containing a ' + childKind, async t => {
    const options = await setup(t);
    const child = join(options.workspace, 'existing');
    if (childKind === 'file') await writeFile(child, 'preserve existing task data');
    else await mkdir(child);
    const mock = mockInitializer();
    await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies), { code: 'NONEMPTY_WORKSPACE' });
    assert.deepEqual(mock.calls, []);
    assert.deepEqual(await readdir(options.workspace), ['existing']);
    if (childKind === 'file') assert.equal(await readFile(child, 'utf8'), 'preserve existing task data');
  });
}

test('module loading failure exposes a fixed error before any ownership change', async t => {
  const options = await setup(t);
  const mock = mockInitializer({ failingStage: 'load' });
  await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies), fixedFailure('WINDOWS_SANDBOX_UNAVAILABLE'));
  assert.deepEqual(mock.calls.map(call => call.stage), ['load']);
});

for (const [name, moduleValue] of [
  ['null module', null],
  ['missing create', { AclWriteGrant: {}, workspaceWriteSid() {} }],
  ['missing workspace SID export', { AclWriteGrant: { create() {} } }],
]) {
  test(name + ' fails before any ownership change', async t => {
    const options = await setup(t);
    const mock = mockInitializer({ moduleValue });
    await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies), fixedFailure('WINDOWS_SANDBOX_UNAVAILABLE'));
    assert.deepEqual(mock.calls.map(call => call.stage), ['load']);
  });
}

test('a fixed ownership preparation failure is preserved without creating a grant', async t => {
  const options = await setup(t);
  const mock = mockInitializer();
  const ownerFailure = new BridgeError('WORKSPACE_OWNER_MISMATCH', 'Current owner is not the expected user.', 403);
  mock.dependencies.prepareOwner = async () => { mock.calls.push({ stage: 'prepare' }); throw ownerFailure; };
  await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies), error => error === ownerFailure);
  assert.deepEqual(mock.calls.map(call => call.stage), ['load', 'prepare']);
});

for (const stage of ['realpath', 'sid', 'create', 'add', 'dispose']) {
  test(stage + ' failure exposes a fixed sandbox error and releases any existing grant', async t => {
    const options = await setup(t);
    const mock = mockInitializer({ failingStage: stage });
    await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies), fixedFailure('WINDOWS_SANDBOX_PREPARE_FAILED'));
    const disposalCount = mock.calls.filter(call => call.stage === 'dispose').length;
    assert.equal(disposalCount, ['add', 'dispose'].includes(stage) ? 1 : 0);
  });
}

test('a release failure cannot replace or expose the original grant preparation failure', async t => {
  const options = await setup(t);
  const mock = mockInitializer({ failingStage: 'add', disposeFailure: true });
  await assert.rejects(initializeWindowsTaskWorkspace(options, mock.dependencies), fixedFailure('WINDOWS_SANDBOX_PREPARE_FAILED'));
  assert.deepEqual(mock.calls.map(call => call.stage), ['load', 'prepare', 'realpath', 'sid', 'create', 'add', 'dispose']);
});
