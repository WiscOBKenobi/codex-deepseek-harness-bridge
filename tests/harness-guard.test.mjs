import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, linkSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createToolGuard, validateWorkspace, apply } from '../src/harness-guard.mjs';

function setup(t) {
  const base = resolve('.bridge', 'test-guard');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'run-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'input'), { recursive: true });
  mkdirSync(join(workspace, 'output'));
  writeFileSync(join(workspace, 'input', 'data.txt'), 'source');
  writeFileSync(join(root, 'outside.txt'), 'untouched');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, make: (extra = {}) => createToolGuard({ workspace, maxToolCalls: 100, maxInputBytes: 1000, maxOutputBytes: 1000, ...extra }) };
}
const call = (name, file_path, extra = {}) => ({ name, arguments: { file_path, ...extra } });

test('allows reading copied input and creating or editing ordinary output', t => {
  const { workspace, make } = setup(t);
  const guard = make();
  assert.equal(guard(call('read', 'input/data.txt')), undefined);
  assert.equal(guard(call('write', 'output/new/deep.txt', { content: 'hello' })), undefined);
  writeFileSync(join(workspace, 'output', 'existing.txt'), 'hello');
  assert.equal(guard(call('edit', 'output/existing.txt', { old_string: 'hello', new_string: 'world' })), undefined);
  assert.equal(guard(call('read', join(workspace, 'output', 'existing.txt'))), undefined);
});

test('denies escape, input writes, shell, nested dispatch, escalation, and malformed paths', t => {
  const { root, make } = setup(t);
  const guard = make();
  const attempts = [
    call('read', '../outside.txt'), call('write', '../outside.txt', { content: 'changed' }),
    call('write', 'input/data.txt', { content: 'changed' }), call('read', '../workspace-other/file'),
    call('bash', 'output/file'), call('run_code', 'output/file'), call('subagent', 'output/file'),
    call('web_fetch', 'output/file'), call('write', 'output/file', { content: 'text', sandbox_permissions: 'require_escalated' }),
    call('read', 'output/file:stream'), call('read', '\\\\server\\share\\file'), call('read', '\\\\?\\C:\\file'),
    call('read', 'output/NUL.txt'), call('read', 'output/file. '), call('read', 'output/file\u0000'),
    call('read', 'https://example.invalid/file'), { name: 'read', arguments: 'file' },
  ];
  for (const attempt of attempts) assert.match(guard(attempt), /^Bridge policy:/u, JSON.stringify(attempt));
  assert.equal(readFileSync(join(root, 'outside.txt'), 'utf8'), 'untouched');
});

test('denies hardlinked files, junction escapes, and replaced workspace roots', t => {
  const { root, workspace, make } = setup(t);
  const guard = make();
  linkSync(join(root, 'outside.txt'), join(workspace, 'output', 'hard.txt'));
  assert.match(guard(call('read', 'output/hard.txt')), /Hardlinked/u);
  assert.match(guard(call('write', 'output/hard.txt', { content: 'changed' })), /Hardlinked/u);
  const outsideDirectory = join(root, 'outside');
  mkdirSync(outsideDirectory);
  writeFileSync(join(outsideDirectory, 'secret.txt'), 'private');
  symlinkSync(outsideDirectory, join(workspace, 'output', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(guard(call('read', 'output/linked/secret.txt')), /Links/u);
  assert.match(guard(call('write', 'output/linked/new.txt', { content: 'changed' })), /Links/u);
  // Remove only the verified link before teardown; no recursive traversal of its target.
  rmSync(join(workspace, 'output', 'linked'));
  renameSync(join(workspace, 'input'), join(workspace, 'old-input'));
  symlinkSync(outsideDirectory, join(workspace, 'input'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(guard(call('read', 'input/secret.txt')), /Links/u);
  rmSync(join(workspace, 'input'));
  assert.equal(readFileSync(join(root, 'outside.txt'), 'utf8'), 'untouched');
});

test('refuses a linked workspace at launch', t => {
  const { root, workspace } = setup(t);
  const link = join(root, 'workspace-link');
  symlinkSync(workspace, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateWorkspace(link), /Links/u);
  rmSync(link);
});

test('enforces cumulative byte limits, edit expansion, input caps, and call budgets', t => {
  const { workspace, make } = setup(t);
  writeFileSync(join(workspace, 'output', 'a.txt'), '123456');
  const guard = make({ maxOutputBytes: 10 });
  assert.match(guard(call('write', 'output/b.txt', { content: '12345' })), /Total output/u);
  assert.equal(guard(call('write', 'output/a.txt', { content: '1' })), undefined);
  assert.match(guard(call('edit', 'output/a.txt', { old_string: '1', new_string: '12345678901' })), /Total output/u);
  assert.match(make({ maxInputBytes: 2 })(call('read', 'input/data.txt')), /size limit/u);
  const budget = make({ maxToolCalls: 1 });
  assert.equal(budget(call('read', 'input/data.txt')), undefined);
  assert.match(budget(call('read', 'input/data.txt')), /tool-call limit/u);
});

test('installs global guard and scoped allowlist before first task', t => {
  const { workspace } = setup(t);
  let guard;
  let created;
  let allow;
  const writes = [];
  const oldWrite = process.stdout.write;
  process.stdout.write = chunk => { writes.push(String(chunk)); return true; };
  try {
    apply({ tools: { guard: value => { guard = value; } }, on: (name, handler) => { assert.equal(name, 'agent/created'); created = handler; } },
      { workspace, maxToolCalls: 10, maxInputBytes: 1000, maxOutputBytes: 1000 });
  } finally { process.stdout.write = oldWrite; }
  created({ agent: { ctx: { tools: { restrict: value => { allow = value.allow; } } } } });
  assert.deepEqual(allow, ['read', 'write', 'edit']);
  assert.match(guard(call('bash', 'input/data.txt')), /only read/u);
  assert.equal(JSON.parse(writes.join('')).type, 'bridge_guard');
});

test('allows the 200th output file and rejects the 201st while permitting overwrite', t => {
  const { workspace, make } = setup(t);
  const output = join(workspace, 'output');
  for (let index = 0; index < 199; index++) writeFileSync(join(output, 'file-' + index + '.txt'), 'x');
  const guard = make();
  assert.equal(guard(call('write', 'output/file-199.txt', { content: 'x' })), undefined);
  writeFileSync(join(output, 'file-199.txt'), 'x');
  assert.match(guard(call('write', 'output/file-200.txt', { content: 'x' })), /file count limit/u);
  assert.equal(guard(call('write', 'output/file-0.txt', { content: 'changed' })), undefined);
});

test('permits twelve output directory levels and rejects a thirteenth before creation', t => {
  const { workspace, make } = setup(t);
  const guard = make();
  const twelve = join('output', ...Array.from({ length: 12 }, (_, index) => 'd' + index));
  const thirteen = join(twelve, 'd12');
  assert.equal(guard(call('write', join(twelve, 'file.txt'), { content: 'allowed' })), undefined);
  assert.match(guard(call('write', join(thirteen, 'file.txt'), { content: 'denied' })), /directory depth limit/u);
  assert.equal(existsSync(join(workspace, thirteen)), false);
  mkdirSync(join(workspace, twelve), { recursive: true });
  writeFileSync(join(workspace, twelve, 'file.txt'), 'allowed');
  assert.equal(guard(call('edit', join(twelve, 'file.txt'), { old_string: 'allowed', new_string: 'updated' })), undefined);
  mkdirSync(join(workspace, thirteen));
  assert.match(guard(call('write', 'output/ordinary.txt', { content: 'denied' })), /directory depth limit/u);
});
