/** Exercise the real Cordis tool registry, then veto agent creation before any model request. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'bridge-keyless-probe';
export const inject = ['tools', 'agents', 'llm'];
export function apply(ctx, config) {
  let modelRequests = 0;
  const startedAt = Date.now(), phases = [];
  const trace = phase => { phases.push({ phase, elapsedMs: Date.now() - startedAt }); writeFileSync(config.tracePath, JSON.stringify({ phase, modelRequests, phases }) + '\n'); };
  trace('probe_mounted');
  ctx.on('llm/stream', async function* () { modelRequests++; trace('model_request_vetoed'); throw new Error('BRIDGE_KEYLESS_MODEL_REQUEST_BLOCKED'); });
  ctx.on('agent/created', async ({ agent }) => {
    trace('agent_created');
    const tools = ctx.tools.schemas(agent).map(tool => tool.name).sort();
    assert.deepEqual(tools, ['edit', 'read', 'write']);
    const invoke = (name, args, scoped = true) => ctx.tools.execute({
      callId: randomUUID(), name, arguments: args, ...(scoped ? { agent } : {}), signal: new AbortController().signal,
    });
    trace('reading_input');
    const read = await invoke('read', { file_path: 'input/source.txt' });
    assert.equal(read.isError, false);
    trace('writing_output');
    const write = await invoke('write', { file_path: 'output/result.txt', content: 'guard integration' });
    assert.equal(write.isError, false);
    assert.equal(readFileSync(join(config.workspace, 'output', 'result.txt'), 'utf8'), 'guard integration');
    trace('creating_fixture_links');
    linkSync(join(config.workspace, '..', 'outside.txt'), join(config.workspace, 'output', 'hard.txt'));
    symlinkSync(join(config.workspace, '..', 'outside'), join(config.workspace, 'output', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    trace('checking_denials');
    for (const [name, args, scoped] of [
      ['read', { file_path: '../outside.txt' }, true],
      ['write', { file_path: '../outside.txt', content: 'changed' }, true],
      ['write', { file_path: 'input/source.txt', content: 'changed' }, true],
      ['read', { file_path: 'output/link/secret.txt' }, true],
      ['read', { file_path: 'output/hard.txt' }, true],
      ['pwsh', { command: 'Write-Output blocked' }, true],
      ['pwsh', { command: 'Write-Output blocked' }, false],
    ]) {
      const result = await invoke(name, args, scoped);
      assert.equal(result.isError, true, 'expected denial: ' + name + ' ' + JSON.stringify(args));
    }
    assert.equal(readFileSync(join(config.workspace, '..', 'outside.txt'), 'utf8'), 'untouched');
    assert.equal(readFileSync(join(config.workspace, 'input', 'source.txt'), 'utf8'), 'copied input');
    writeFileSync(config.reportPath, JSON.stringify({ passed: true, tools, modelRequests, guardDenials: 7 }) + '\n');
    trace('probe_completed');
    throw new Error('BRIDGE_KEYLESS_PROBE_COMPLETE');
  });
}
