import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { queueCodexMessage } from '../src/codex-wake.mjs';

const threadId = 'af81a57c-cf55-4efe-9549-972d3244f103';

test('wake transport passes literal arguments without a shell or model override', async () => {
  const message = 'literal `command` $(command)\n"quoted"';
  let invocation;
  await queueCodexMessage({ threadId, message, codexPath: 'local-codex' }, {
    execute: (file, args, options, callback) => { invocation = { file, args, options }; callback(null); },
  });
  assert.equal(invocation.file, 'local-codex');
  assert.deepEqual(invocation.args, ['queue', '--thread', threadId, '--message', message]);
  assert.equal(invocation.options.shell, undefined);
  assert.equal(invocation.options.timeout, 15000);
});

test('invalid targets and transport failures are explicit without leaking diagnostics', async () => {
  assert.throws(() => queueCodexMessage({ threadId: '--last', message: 'test' }), /Invalid/);
  await assert.rejects(queueCodexMessage({ threadId, message: 'test' }, {
    execute: (_file, _args, _options, callback) => callback(Error('private diagnostic')),
  }), { message: 'Codex queue delivery failed.' });
  await assert.rejects(queueCodexMessage({ threadId, message: 'test', codexPath: join(tmpdir(), randomUUID(), 'missing') }), /delivery failed/);
});
