/** Observe Harness execution metadata without retaining request, model, or tool content. */
export const name = 'codex-bridge-monitor';
export const inject = ['llm', 'tools'];

/**
 * Install an effect-scoped monitor. Progress records describe observed events,
 * not a promise that a quiet process is stuck or that work is succeeding.
 */
export function installMonitor(ctx, {
  progressIntervalMs = 5000,
  write = line => process.stdout.write(line),
  now = () => performance.now(),
} = {}) {
  if (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1 || progressIntervalMs > 60000) {
    throw new Error('progressIntervalMs must be an integer between 1 and 60000.');
  }
  const started = now();
  let disposed = false;
  let sequence = 0;
  let activeTools = 0;
  const jobs = new Map();
  const emit = event => {
    if (disposed) return;
    try { write(JSON.stringify(event) + '\n'); }
    catch (error) {
      // A failed observer sink must not alter the model or tool outcome.
      disposed = true;
    }
  };
  const progress = (kind, activityId, fields) => {
    emit({
      type: 'bridge_progress', version: 1, kind, activityId,
      elapsedMs: Math.max(0, Math.round(now() - started)), ...fields,
    });
  };

  ctx.on('llm/stream', async function* (_options, next) {
    const activityId = ++sequence;
    let chunks = 0;
    let lastReported = -Infinity;
    let outcome = 'interrupted';
    progress('model_stream', activityId, { phase: 'start', chunks });
    try {
      for await (const chunk of next()) {
        chunks++;
        const timestamp = now();
        if (timestamp - lastReported >= progressIntervalMs) {
          lastReported = timestamp;
          progress('model_stream', activityId, { phase: 'chunk', chunks });
        }
        yield chunk;
      }
      outcome = 'completed';
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      progress('model_stream', activityId, { phase: 'end', chunks, outcome });
    }
  });

  ctx.on('tools/execute', async (_execution, next) => {
    const activityId = ++sequence;
    activeTools++;
    progress('tool_start', activityId, { activeTools });
    let outcome = 'error';
    try {
      const result = await next();
      outcome = result.isError === true ? 'error' : 'completed';
      return result;
    } finally {
      activeTools--;
      progress('tool_end', activityId, { activeTools, outcome });
    }
  });

  ctx.inject(['jobs'], jobContext => {
    jobContext.jobs.events.subscribe({ owners: 'all' }, event => {
      if (event.type === 'removed' || event.type === 'settled') {
        jobs.delete(event.job.id);
        return;
      }
      if (event.type !== 'output') return;
      let state = jobs.get(event.id);
      if (!state) {
        state = { activityId: ++sequence, total: 0, lastReported: -Infinity };
        jobs.set(event.id, state);
      }
      if (event.total <= state.total) return;
      state.total = event.total;
      const timestamp = now();
      if (timestamp - state.lastReported < progressIntervalMs) return;
      state.lastReported = timestamp;
      progress('job_output', state.activityId, { bytes: state.total });
    });
  });

  const dispose = () => { disposed = true; jobs.clear(); };
  ctx.effect(() => dispose, 'bridge metadata monitor');
  emit({ type: 'bridge_monitor', version: 1 });
  return dispose;
}

/** Mount the observer through an ordinary official Harness profile overlay. */
export function apply(ctx, config = {}) {
  installMonitor(ctx, { progressIntervalMs: config.progressIntervalMs ?? 5000 });
}
