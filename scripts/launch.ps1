param([ValidateSet('open','stop','check','check-quiet')][string]$Action = 'open')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
try {
    $settingsPath = Join-Path $projectRoot 'config.json'
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        if ($Action -eq 'check-quiet') { throw '尚未配置本机，请双击“配置本机.cmd”。' }
        $powershellFile = Join-Path $PSHOME 'powershell.exe'
        & $powershellFile -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File (Join-Path $PSScriptRoot 'setup-windows.ps1')
        $setupStatus = $LASTEXITCODE
        if ($setupStatus -ne 0) { exit $setupStatus }
    }
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($settings.nodePath)) {
        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $nodeCommand) { throw '找不到 Node 运行环境，请双击“配置本机.cmd”。' }
        $nodeFile = $nodeCommand.Source
    } elseif ([IO.Path]::IsPathRooted($settings.nodePath)) {
        $nodeFile = [IO.Path]::GetFullPath($settings.nodePath)
    } else {
        $nodeFile = [IO.Path]::GetFullPath((Join-Path $projectRoot $settings.nodePath))
    }
    if (-not (Test-Path -LiteralPath $nodeFile -PathType Leaf)) { throw '找不到 Node 运行环境，请双击“配置本机.cmd”或核对 config.json 中的 nodePath。' }
    $operation = if ($Action -eq 'check-quiet') { 'check' } else { $Action }
    $result = & $nodeFile (Join-Path $projectRoot 'src\launcher.mjs') $operation 2>&1 | Out-String
    $exitStatus = $LASTEXITCODE
    if ($Action -eq 'check-quiet') { Write-Output $result; exit $exitStatus }
    if ($exitStatus -ne 0) { throw $result }
    if ($Action -eq 'check') {
        $parsed = $result | ConvertFrom-Json
        $lines = @('环境检查完成', ('当前模型：' + $parsed.model))
        foreach ($item in $parsed.checks) { $lines += (($(if ($item.ok) { '通过' } else { '失败' })) + '：' + $item.label) }
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show(($lines -join [Environment]::NewLine), 'Codex + DeepSeek Harness') | Out-Null
    }
    if ($Action -eq 'stop') {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show('任务服务已停止，活动任务已经结束。', 'Codex + DeepSeek Harness') | Out-Null
    }
} catch {
    if ($Action -eq 'check-quiet') { Write-Output $_.Exception.Message; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, '启动失败') | Out-Null
    exit 1
}
