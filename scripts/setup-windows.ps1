param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dialogTitle = '配置 Codex + DeepSeek Harness'

# Relative machine settings are resolved against this project, never the caller's directory.
function Resolve-ProjectPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $projectRoot $Value))
}

function Select-Directory([string]$Label, [string]$Candidate) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Container)) {
        $answer = [Windows.Forms.MessageBox]::Show(
            ($Label + [Environment]::NewLine + $Candidate + [Environment]::NewLine + [Environment]::NewLine + '使用这个文件夹吗？选择“否”可另选文件夹。'),
            $dialogTitle, [Windows.Forms.MessageBoxButtons]::YesNoCancel, [Windows.Forms.MessageBoxIcon]::Question)
        if ($answer -eq [Windows.Forms.DialogResult]::Yes) { return $Candidate }
        if ($answer -eq [Windows.Forms.DialogResult]::Cancel) { return $null }
    }
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    try {
        $picker.Description = $Label
        $picker.ShowNewFolderButton = $false
        if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Container)) { $picker.SelectedPath = $Candidate }
        if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return $null }
        return [IO.Path]::GetFullPath($picker.SelectedPath)
    } finally { $picker.Dispose() }
}

try {
    if ($SelfTest) {
        foreach ($scriptName in @('setup-windows.ps1', 'launch.ps1')) {
            $parseTokens = $null
            $parseErrors = $null
            [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $scriptName), [ref]$parseTokens, [ref]$parseErrors) | Out-Null
            if ($parseErrors.Count -gt 0) { throw ('PowerShell 语法检查失败：' + $scriptName) }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'setup.mjs') -PathType Leaf)) { throw '缺少 scripts/setup.mjs。' }
        Write-Output 'Windows 配置入口检查通过；未修改配置、未调用模型。'
        exit 0
    }

    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.Application]::EnableVisualStyles()
    $settingsPath = Join-Path $projectRoot 'config.json'
    $settings = $null
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        try { $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { throw 'config.json 不是有效的 JSON。请先修复该文件；配置程序不会覆盖无法读取的现有设置。' }
    }
    $harnessCandidate = if ($settings -and $settings.harnessRoot) { Resolve-ProjectPath $settings.harnessRoot } else { Resolve-ProjectPath '../DS Harness' }
    $harnessRoot = Select-Directory '选择已经下载并安装好依赖的 DeepSeek Harness 源码文件夹。' $harnessCandidate
    if (-not $harnessRoot) { exit 2 }
    if (-not (Test-Path -LiteralPath (Join-Path $harnessRoot 'package.json') -PathType Leaf)) { throw '所选 Harness 文件夹没有 package.json。请选择 Harness 源码根目录。' }
    $homeCandidate = if ($settings -and $settings.harnessHome) { Resolve-ProjectPath $settings.harnessHome } else { Join-Path $harnessRoot '.local\dsh-home' }
    $harnessHome = Select-Directory '选择 Harness 数据文件夹（含已保存 API 设置的 .credentials.yaml）。不会读取或复制密钥。' $homeCandidate
    if (-not $harnessHome) { exit 2 }

    $nodeCandidates = @()
    if ($settings -and $settings.nodePath) { $nodeCandidates += (Resolve-ProjectPath $settings.nodePath) }
    $nodeCandidates += (Join-Path $harnessRoot '.local\runtime\node.exe')
    $pathNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pathNode) { $nodeCandidates += $pathNode.Source }
    $nodeFile = $null
    foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $versionOutput = & $candidate --version 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and $versionOutput.Trim() -match '^v(\d+)\.') {
            if ([int]$Matches[1] -ge 24) { $nodeFile = [IO.Path]::GetFullPath($candidate); break }
        }
    }
    if (-not $nodeFile) { throw '找不到 Node.js 24 或更高版本。请先安装合适版本，或在 config.json 的 nodePath 中指定已有 node.exe。此程序不会安装 Node 或 Harness。' }

    $needsDependencies = -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@modelcontextprotocol\sdk\package.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\zod\package.json') -PathType Leaf)
    if ($needsDependencies) {
        $answer = [Windows.Forms.MessageBox]::Show('项目依赖尚未安装。现在联网安装本项目锁定的依赖吗？这不会调用模型，也不会安装或升级 Node、Harness。安装期间可能需要几分钟。', $dialogTitle, [Windows.Forms.MessageBoxButtons]::OKCancel, [Windows.Forms.MessageBoxIcon]::Information)
        if ($answer -ne [Windows.Forms.DialogResult]::OK) { exit 2 }
        $npmFile = Join-Path (Split-Path -Parent $nodeFile) 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npmFile -PathType Leaf)) {
            $pathNpm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $pathNpm) { throw '找不到已安装的 npm。请修复现有 Node/npm 环境后再次配置。' }
            $npmFile = $pathNpm.Source
        }
        $installLog = Join-Path ([IO.Path]::GetTempPath()) ('codex-dsh-install-' + [guid]::NewGuid().ToString('N') + '.log')
        $installErrorLog = $installLog + '.err'
        $previousPath = $env:PATH
        $previousNpmLogsMax = $env:npm_config_logs_max
        try {
            $env:PATH = (Split-Path -Parent $nodeFile) + [IO.Path]::PathSeparator + $previousPath
            $env:npm_config_logs_max = '0'
            $npmCommand = '""' + $npmFile + '" ci --ignore-scripts --no-audit --no-fund"'
            $installProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $npmCommand) -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $installLog -RedirectStandardError $installErrorLog
            if ($installProcess.ExitCode -ne 0) { throw ('项目依赖安装失败（npm 退出码 ' + $installProcess.ExitCode + '）。请检查网络、代理或 npm 源设置后重试。现有配置尚未修改。') }
        } finally {
            $env:PATH = $previousPath
            $env:npm_config_logs_max = $previousNpmLogsMax
            foreach ($temporaryLog in @($installLog, $installErrorLog)) {
                if (Test-Path -LiteralPath $temporaryLog -PathType Leaf) { Remove-Item -LiteralPath $temporaryLog -Force }
            }
        }
    }

    $setupOutput = & $nodeFile (Join-Path $PSScriptRoot 'setup.mjs') --harness-root $harnessRoot --harness-home $harnessHome --node-path $nodeFile 2>&1 | Out-String
    $setupStatus = $LASTEXITCODE
    if ($setupStatus -ne 0) {
        $safeMessage = $setupOutput.Trim()
        $safeMessage = $safeMessage -replace '(?i)sk-[a-z0-9_-]{8,}', '[已隐藏密钥]' -replace '(?i)(Bearer\s+)[^\s"'']+', '$1[已隐藏]'
        if ($safeMessage.Length -gt 1600) { $safeMessage = $safeMessage.Substring(0, 1600) }
        throw ('配置失败：' + [Environment]::NewLine + $safeMessage)
    }
    [Windows.Forms.MessageBox]::Show(('本机配置完成。' + [Environment]::NewLine + [Environment]::NewLine + '请在 Codex 中打开本项目文件夹，并信任该项目；必要时重新打开任务，让 MCP 配置生效。之后直接在 Codex 中安排工作。' + [Environment]::NewLine + [Environment]::NewLine + '“打开任务面板”是可选的监控和手动管理入口。此配置过程没有调用 DeepSeek。'), $dialogTitle, [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    exit 0
} catch {
    if ($SelfTest) { Write-Output $_.Exception.Message; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置失败', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}
