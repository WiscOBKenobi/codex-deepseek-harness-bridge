/** Initialize only the task directory permission required by Harness's Windows label API. */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { readdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectPlainPath } from './harness-guard.mjs';
import { BridgeError } from './util.mjs';

// The directory is read from stdin JSON. No user-controlled text enters PowerShell code.
const INITIALIZE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Fail([string]$code) {
  [Console]::Out.Write('{"ok":false,"code":"' + $code + '"}')
  exit 1
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.workspace -isnot [string] -or [string]::IsNullOrWhiteSpace($request.workspace)) { Fail 'WORKSPACE_ACL_PREPARE_FAILED' }
  $workspace = [System.IO.Path]::GetFullPath($request.workspace)
  $directory = Get-Item -LiteralPath $workspace -Force
  if (-not $directory.PSIsContainer) { Fail 'WORKSPACE_ACL_PREPARE_FAILED' }
  $ancestor = $directory
  while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'WORKSPACE_ACL_PREPARE_FAILED' }
    $ancestor = $ancestor.Parent
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $acl = Get-Acl -LiteralPath $workspace
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { Fail 'WORKSPACE_OWNER_MISMATCH' }
  $rights = [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $principals = @($sid.Value, 'S-1-1-0', 'S-1-5-11') + @($identity.Groups | ForEach-Object { $_.Value })
  $allowed = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if (($rule.FileSystemRights -band $rights) -eq 0) { continue }
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and $principals -contains $rule.IdentityReference.Value) { Fail 'WORKSPACE_ACL_DENIED' }
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -eq $sid.Value) { $allowed = $true }
  }
  if ($allowed) {
    [Console]::Out.Write('{"ok":true,"status":"unchanged"}')
    exit 0
  }
  $fresh = Get-Item -LiteralPath $workspace -Force
  if (($fresh.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'WORKSPACE_ACL_PREPARE_FAILED' }
  $latestAcl = Get-Acl -LiteralPath $workspace
  if ($latestAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { Fail 'WORKSPACE_OWNER_MISMATCH' }
  $accessSection = [System.Security.AccessControl.AccessControlSections]::Access
  if ($latestAcl.GetSecurityDescriptorSddlForm($accessSection) -ne $acl.GetSecurityDescriptorSddlForm($accessSection)) { Fail 'WORKSPACE_ACL_PREPARE_FAILED' }
  $acl = $latestAcl
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid, $rights,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $workspace -AclObject $acl
  $after = Get-Acl -LiteralPath $workspace
  if ($after.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { Fail 'WORKSPACE_OWNER_MISMATCH' }
  [Console]::Out.Write('{"ok":true,"status":"updated"}')
} catch {
  Fail 'WORKSPACE_ACL_PREPARE_FAILED'
}
`;

const FAILURE_MESSAGES = Object.freeze({
  WORKSPACE_OWNER_MISMATCH: 'Windows 任务目录所有者不是当前用户；没有自动更改权限或所有者。',
  WORKSPACE_ACL_DENIED: 'Windows 任务目录存在拒绝所需权限的规则；没有覆盖该规则。',
  WORKSPACE_ACL_PREPARE_FAILED: '无法初始化 Windows 任务目录权限；未关闭 Harness 沙箱，请检查本机目录权限。',
});
function failure(code = 'WORKSPACE_ACL_PREPARE_FAILED') {
  return new BridgeError(code, FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES.WORKSPACE_ACL_PREPARE_FAILED, 403);
}

/** Add only current-owner WRITE_OWNER on this directory; never inherit it or change ownership. */
export async function prepareWindowsWorkspace({ workspace, taskDir }, {
  platform = process.platform, spawnProcess = spawn, timeoutMs = 15000,
} = {}) {
  if (platform !== 'win32') return { status: 'not_required' };
  if (resolve(workspace) !== resolve(taskDir, 'workspace')) {
    throw new BridgeError('WORKSPACE_PATH_MISMATCH', '只能初始化当前任务的专用 workspace 目录。', 403);
  }
  workspace = inspectPlainPath(workspace, { directory: true });
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let child;
  try {
    child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', INITIALIZE_ACL], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw failure(); }
  return new Promise((resolveResult, reject) => {
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, timeoutMs);
    timer.unref();
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 4096) { output = ''; failed = true; child.kill(); }
    });
    child.stderr.resume();
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(output); }
      catch { reject(failure()); return; }
      if (!result || typeof result !== 'object' || Array.isArray(result)) { reject(failure()); return; }
      if (!failed && code === 0 && result.ok === true && ['updated', 'unchanged'].includes(result.status)) {
        resolveResult({ status: result.status }); return;
      }
      reject(failure(Object.hasOwn(FAILURE_MESSAGES, result.code) ? result.code : undefined));
    });
    child.stdin.end(JSON.stringify({ workspace }));
  });
}

/** Load the installed, built public Harness ACL exports without starting a model or agent. */
async function loadAclModule(harnessRoot) {
  try {
    const manifest = join(harnessRoot, 'packages', 'sandbox', 'sandbox-windows-acl', 'package.json');
    await access(manifest);
    const require = createRequire(manifest);
    const entry = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl');
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.AclWriteGrant?.create !== 'function' || typeof module.workspaceWriteSid !== 'function') throw new Error('Missing public ACL exports.');
    return module;
  } catch { throw new BridgeError('WINDOWS_SANDBOX_UNAVAILABLE', '已安装的 Harness 缺少可用的 Windows 沙箱模块，请完成对应版本的构建；没有关闭沙箱。', 503); }
}

/** Prepare an empty root before descendants are created, so they inherit official capability and Low labels. */
export async function initializeWindowsTaskWorkspace({ workspace, taskDir, harnessRoot }, {
  platform = process.platform, prepareOwner = prepareWindowsWorkspace, loadAclModule: loadAcl = loadAclModule, realpath = realpathSync.native,
} = {}) {
  if (platform !== 'win32') return { status: 'not_required' };
  if (resolve(workspace) !== resolve(taskDir, 'workspace')) throw new BridgeError('WORKSPACE_PATH_MISMATCH', '只能初始化当前任务的专用 workspace 目录。', 403);
  workspace = inspectPlainPath(workspace, { directory: true });
  if ((await readdir(workspace)).length) throw new BridgeError('NONEMPTY_WORKSPACE', 'Windows 沙箱初始化只接受新建的空任务目录；请保留已有文件并另行处理。', 409);
  let acl;
  try {
    acl = await loadAcl(harnessRoot);
    if (typeof acl.AclWriteGrant?.create !== 'function' || typeof acl.workspaceWriteSid !== 'function') throw new Error('Missing ACL module.');
  } catch { throw new BridgeError('WINDOWS_SANDBOX_UNAVAILABLE', '已安装的 Harness 缺少可用的 Windows 沙箱模块，请完成对应版本的构建；没有关闭沙箱。', 503); }
  await prepareOwner({ workspace, taskDir }, { platform });
  let grant, failed = false;
  try {
    const canonicalRoot = realpath(workspace);
    grant = acl.AclWriteGrant.create(acl.workspaceWriteSid(canonicalRoot));
    grant.add(canonicalRoot, true);
  } catch { failed = true; }
  finally {
    if (grant) { try { grant.dispose(); } catch { failed = true; } }
  }
  if (failed) throw new BridgeError('WINDOWS_SANDBOX_PREPARE_FAILED', '无法初始化新任务目录的 Windows 原生沙箱；没有降低权限或开始模型任务。', 500);
  return { status: 'initialized' };
}
