/** Keyless subprocess fixture for the public supervisor API. */
import { writeFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const settings = JSON.parse(prompt);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const sessionIndex = process.argv.indexOf('--session-id');
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : 'fixture-session-123';
if (settings.mode === 'malformed') { process.stdout.write('not-json\n'); setInterval(() => {}, 1000); }
else if (settings.mode === 'oversize') { process.stdout.write('x'.repeat(300000)); setInterval(() => {}, 1000); }
else {
  if (settings.mode !== 'no-monitor') emit({ type: 'bridge_monitor', version: 1 });
  if (settings.mode !== 'no-guard' && !settings.agent) emit({ type: 'bridge_guard', version: 1, tools: ['read', 'write', 'edit'] });
  emit({ type: 'session', sessionId });
  for (let bytes = 0; bytes < (settings.streamBytes ?? 0); bytes += 64000) emit({ type: 'thinking', text: 'x'.repeat(64000) });
  if (settings.mode === 'hang') {
    emit({ type: 'text', text: 'pid:' + process.pid });
    if (settings.pidFile) writeFileSync(settings.pidFile, String(process.pid));
    if (settings.ignoreStop) process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else {
    emit({ type: 'thinking', text: 'PRIVATE_REASONING_SHOULD_NOT_ESCAPE sk-fake0000000000000000000000000' });
    for (let index = 0; index < (settings.toolCalls ?? 1); index++) {
      emit({ type: 'tool_call', callId: 'call-' + index, tool: 'read', input: { file_path: 'input/data.txt', content: 'content omitted from log' } });
      emit({ type: 'tool_result', callId: 'call-' + index, status: 'completed', result: 'unlogged raw tool output' });
    }
    emit({ type: 'status', phase: 'turn_end', reason: settings.mode === 'turn-error'
      ? { kind: 'error', error: { message: 'api_key=example-secret' } } : { kind: 'completed' } });
    if (settings.mode !== 'no-final') emit({ type: 'final', text: settings.answer ?? 'fixture complete' });
    if (settings.mode === 'exit-error' || settings.mode === 'turn-error') process.exitCode = 1;
  }
}
