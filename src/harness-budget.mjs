/** Enforce an explicitly selected native-tool call budget before dispatch. */
export const name = 'codex-bridge-budget';
export const inject = ['tools'];
export function createCallBudget(maxToolCalls) {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) throw new Error('maxToolCalls must be a positive integer.');
  let calls = 0;
  return () => ++calls > maxToolCalls ? 'Bridge policy: tool-call limit reached.' : undefined;
}
export function apply(ctx, config) {
  ctx.tools.guard(createCallBudget(config.maxToolCalls));
}
