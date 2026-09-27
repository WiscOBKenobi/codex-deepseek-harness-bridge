/** Keyless official-profile probe: one allowed shell write and one denied outside write. */
import { readFile } from 'node:fs/promises';

export const name = 'bridge-native-sandbox-probe';
export const inject = ['tools', 'llm', 'shell'];

const quote = value => "'" + value.replaceAll("'", "''") + "'";

export function apply(ctx, config) {
  const ready = ctx.get('appReady');
  const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('The sandbox probe requires the official dsh launcher.');
  let modelCallsBlocked = 0;
  ctx.on('llm/stream', async function* (_options, _next) {
    modelCallsBlocked++;
    throw new Error('Model calls are disabled in the keyless sandbox probe.');
  }, { prepend: true });

  const run = async () => {
    const checks = { workspaceWriteMode: ctx.shell.sandboxMode === 'workspace-write', insideShell: false, insideFile: false, outsideDenied: false, outsideUnchanged: false };
    let toolCalls = 0;
    const invoke = command => ctx.tools.execute({
      signal: AbortSignal.timeout(20000),
      callId: 'native-probe-' + (++toolCalls),
      name: 'pwsh',
      arguments: { command, description: 'Check the official local sandbox', workdir: config.workspace, timeoutMs: 15000 },
    });
    let errorCode;
    let diagnostic;
    const summarizeFailure = result => {
      const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('');
      const win32 = /Win32\s+(\d+)/u.exec(text);
      return {
        toolError: result.isError === true,
        kind: ['foreground', 'background', 'promoted'].includes(result.value?.kind) ? result.value.kind : 'none',
        exitCode: Number.isInteger(result.value?.exitCode) ? result.value.exitCode : null,
        phase: /grantWrite|SetNamedSecurityInfoW/u.test(text) ? 'acl_grant'
          : /CreateProcess|DLL_INIT|C0000142/u.test(text) ? 'process_start'
          : /sandbox.*unavailable|windows-acl-run/iu.test(text) ? 'sandbox_runner'
          : /pre-execute|denied|permission/iu.test(text) ? 'permission' : 'tool_execution',
        ...(win32 ? { win32Code: Number(win32[1]) } : {}),
      };
    };
    try {
      if (!checks.workspaceWriteMode) throw new Error('UNEXPECTED_SANDBOX_MODE');
      const inside = await invoke("$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText(" + quote(config.inside) + ', ' + quote(config.marker) + "); Write-Output 'BRIDGE_PROBE_STDOUT'");
      diagnostic = summarizeFailure(inside);
      checks.insideShell = inside.isError !== true
        && inside.value?.kind === 'foreground'
        && inside.value.exitCode === 0
        && inside.value.sandbox?.mode === 'workspace-write'
        && inside.value.sandbox.denied === false
        && inside.value.stdout.text.includes('BRIDGE_PROBE_STDOUT');
      checks.insideFile = await readFile(config.inside, 'utf8').then(value => value === config.marker, () => false);
      if (!checks.insideShell || !checks.insideFile) throw new Error('WORKSPACE_SHELL_FAILED');
      const outside = await invoke("$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText(" + quote(config.outside) + ", 'unexpected modification')");
      checks.outsideDenied = outside.isError !== true
        && outside.value?.kind === 'foreground'
        && outside.value.exitCode !== 0
        && outside.value.sandbox?.mode === 'workspace-write'
        && outside.value.sandbox.denied === true;
      checks.outsideUnchanged = await readFile(config.outside, 'utf8').then(value => value === config.marker, () => false);
    } catch (error) {
      errorCode = error?.message === 'UNEXPECTED_SANDBOX_MODE' ? 'UNEXPECTED_SANDBOX_MODE' : 'WORKSPACE_SHELL_FAILED';
    }
    const passed = Object.values(checks).every(Boolean) && modelCallsBlocked === 0;
    process.stdout.write('BRIDGE_NATIVE_SANDBOX_PROBE ' + JSON.stringify({
      passed, checks, toolCalls, modelCallsBlocked, diagnostic, ...(errorCode ? { errorCode } : {}),
    }) + '\n');
    exit(passed ? 0 : 1);
  };
  ctx.effect(() => ready.onReady(() => {
    void run().catch(() => {
      process.stdout.write('BRIDGE_NATIVE_SANDBOX_PROBE {"passed":false,"errorCode":"PROBE_FAILED"}\n');
      exit(1);
    });
  }), 'native sandbox probe');
}
