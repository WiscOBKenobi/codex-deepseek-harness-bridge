import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, installMonitor } from '../src/harness-monitor.mjs';

function fixture(options = {}) {
  const events = [];
  const handlers = new Map();
  let jobListener;
  let disposed;
  let time = 0;
  const ctx = {
    on: (name, listener) => { handlers.set(name, listener); },
    inject: (names, setup) => {
      assert.deepEqual(names, ['jobs']);
      setup({ jobs: { events: { subscribe: (filter, listener) => {
        assert.deepEqual(filter, { owners: 'all' });
        jobListener = listener;
      } } } });
    },
    effect: setup => { disposed = setup(); },
  };
  const stop = installMonitor(ctx, {
    progressIntervalMs: 5000,
    now: () => time,
    write: line => events.push(JSON.parse(line)),
    ...options,
  });
  return {
    events, handlers, ctx, stop,
    job: event => jobListener(event),
    tick: value => { time += value; },
    dispose: () => disposed(),
  };
}

test('forwards model chunks unchanged and publishes only counts at a bounded cadence', async () => {
  const f = fixture();
  const sensitive = { text: 'private reasoning and secret input', apiKey: 'do-not-copy' };
  const options = { get messages() { throw new Error('request content must not be inspected'); } };
  const output = [];
  const stream = f.handlers.get('llm/stream')(options, async function* () {
    yield sensitive;
    f.tick(1000);
    yield sensitive;
    f.tick(4000);
    yield sensitive;
  });
  for await (const chunk of stream) output.push(chunk);
  assert.equal(output.length, 3);
  assert.ok(output.every(chunk => chunk === sensitive));
  assert.deepEqual(f.events[0], { type: 'bridge_monitor', version: 1 });
  const progress = f.events.slice(1);
  assert.deepEqual(progress.map(e => [e.phase, e.chunks]), [['start', 0], ['chunk', 1], ['chunk', 3], ['end', 3]]);
  assert.equal(progress.at(-1).outcome, 'completed');
  assert.equal(progress.at(-1).elapsedMs, 5000);
  assert.equal(JSON.stringify(f.events).includes('private'), false);
  assert.equal(JSON.stringify(f.events).includes('apiKey'), false);
});

test('forwards model failure identity without logging its message or marking completion', async () => {
  const f = fixture();
  const failure = new Error('secret provider response');
  const stream = f.handlers.get('llm/stream')({}, async function* () { throw failure; });
  await assert.rejects(async () => { for await (const _chunk of stream) {} }, error => error === failure);
  assert.equal(f.events.at(-1).outcome, 'error');
  assert.equal(JSON.stringify(f.events).includes(failure.message), false);
});

test('consumer cancellation closes the upstream stream and records interrupted instead of completed', async () => {
  const f = fixture();
  let closed = false;
  const stream = f.handlers.get('llm/stream')({}, async function* () {
    try { yield { type: 'text-delta', text: 'unlogged' }; yield { type: 'text-delta' }; }
    finally { closed = true; }
  });
  await stream.next();
  await stream.return();
  assert.equal(closed, true);
  assert.equal(f.events.at(-1).outcome, 'interrupted');
});

test('concurrent tools retain their original results and independent activity identifiers', async () => {
  const f = fixture();
  const execute = f.handlers.get('tools/execute');
  let release;
  const firstResult = { content: [{ text: 'secret output' }] };
  const first = execute({ arguments: { secret: 'private' } }, () => new Promise(resolve => { release = resolve; }));
  const secondResult = { isError: true, content: [{ text: 'secret error' }] };
  assert.equal(await execute({}, async () => secondResult), secondResult);
  release(firstResult);
  assert.equal(await first, firstResult);
  const progress = f.events.slice(1);
  assert.deepEqual(progress.map(e => [e.kind, e.activeTools]), [
    ['tool_start', 1], ['tool_start', 2], ['tool_end', 1], ['tool_end', 0],
  ]);
  assert.equal(progress[0].activityId, progress[3].activityId);
  assert.equal(progress[1].activityId, progress[2].activityId);
  assert.equal(progress[2].outcome, 'error');
  assert.equal(progress[3].outcome, 'completed');
  assert.equal(JSON.stringify(f.events).includes('secret'), false);
});

test('thrown tools still settle monitor state and preserve the original error', async () => {
  const f = fixture();
  const failure = new Error('unlogged command');
  await assert.rejects(f.handlers.get('tools/execute')({}, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(
    { kind: f.events.at(-1).kind, activeTools: f.events.at(-1).activeTools, outcome: f.events.at(-1).outcome },
    { kind: 'tool_end', activeTools: 0, outcome: 'error' },
  );
  assert.equal(JSON.stringify(f.events).includes(failure.message), false);
});

test('job progress uses increasing byte totals without reading output or arbitrary labels', () => {
  const f = fixture();
  const event = total => ({ type: 'output', id: 'private-job-id', total, get content() { throw new Error('never read content'); } });
  f.job(event(10));
  f.job(event(10));
  f.tick(1000);
  f.job(event(20));
  f.tick(4000);
  f.job(event(30));
  f.job({ type: 'progress', job: { id: 'private-job-id', progress: 'sensitive output' } });
  assert.deepEqual(f.events.slice(1).map(e => e.bytes), [10, 30]);
  assert.equal(f.events[1].activityId, f.events[2].activityId);
  assert.equal(JSON.stringify(f.events).includes('private-job-id'), false);
  assert.equal(JSON.stringify(f.events).includes('sensitive'), false);
  f.job({ type: 'settled', job: { id: 'private-job-id' } });
  f.tick(5000);
  f.job(event(50));
  assert.notEqual(f.events.at(-1).activityId, f.events[1].activityId);
});

test('disposal and observer write failures never alter model execution', async () => {
  const f = fixture();
  f.dispose();
  const before = f.events.length;
  const result = { content: [] };
  assert.equal(await f.handlers.get('tools/execute')({}, async () => result), result);
  assert.equal(f.events.length, before);
  const broken = fixture({ write: () => { throw new Error('closed sink'); } });
  const received = [];
  for await (const chunk of broken.handlers.get('llm/stream')({}, async function* () { yield 42; })) received.push(chunk);
  assert.deepEqual(received, [42]);
});

test('rejects invalid cadence and exposes a content-free official plugin entry', () => {
  for (const progressIntervalMs of [0, -1, 1.5, 60001, Infinity]) {
    assert.throws(() => fixture({ progressIntervalMs }), /progressIntervalMs/);
  }
  assert.deepEqual(inject, ['llm', 'tools']);
  assert.equal(typeof apply, 'function');
});
