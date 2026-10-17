param(
    [switch]$Install,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

if ($Install -and $SkipInstall) {
    throw 'Install and SkipInstall cannot be used together.'
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ragDir = Join-Path $root 'rag'
$agentDir = Join-Path $root 'agent-insight'

if (-not (Test-Path (Join-Path $ragDir 'package.json'))) {
    throw "RAG project not found: $ragDir"
}
if (-not (Test-Path (Join-Path $agentDir 'package.json'))) {
    throw "Agent Insight project not found: $agentDir"
}

function ConvertTo-PowerShellLiteral([string]$value) {
    return "'" + $value.Replace("'", "''") + "'"
}

$ragInstall = if ($Install -or ((-not $SkipInstall) -and (-not (Test-Path (Join-Path $ragDir 'node_modules'))))) {
    'npm install; '
} else {
    ''
}
$ragCommand = "Set-Location -LiteralPath $(ConvertTo-PowerShellLiteral $ragDir); $ragInstall npm run build:widget; npm run serve"
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-NoExit',
    '-Command', $ragCommand
)

$wsl = Get-Command 'wsl.exe' -ErrorAction SilentlyContinue
if (-not $wsl) {
    throw 'wsl.exe was not found. Install WSL or start Agent Insight manually from Ubuntu/WSL.'
}

$wslExe = if ($wsl.Path) { $wsl.Path } else { 'wsl.exe' }
$wslDistro = @(& $wslExe -l -q 2>$null) |
    ForEach-Object { ($_ -replace "`0", '').Trim() } |
    Where-Object { $_ -match '^Ubuntu(?:-[0-9]+(?:\.[0-9]+)?)?$' } |
    Select-Object -First 1
$wslDistroArgs = if ($wslDistro) { @('-d', $wslDistro) } else { @() }
$wslPathOutput = @(& $wslExe @wslDistroArgs -e wslpath -a -u -- $agentDir 2>$null)
if ($LASTEXITCODE -ne 0) {
    throw "Could not convert Agent Insight path for WSL: $agentDir"
}
$agentWslDir = ($wslPathOutput -join "`n").Trim()
if (-not $agentWslDir) {
    throw "Could not convert Agent Insight path for WSL: $agentDir"
}

$forceInstall = if ([bool]$Install) { 'true' } else { 'false' }
$skipInstallFlag = if ([bool]$SkipInstall) { 'true' } else { 'false' }
$agentCommand = "set -e; cd '$agentWslDir'; if [ '$forceInstall' = 'true' ] || { [ '$skipInstallFlag' != 'true' ] && [ ! -d node_modules ]; }; then npm install; fi; if [ ! -d node_modules/lightningcss-linux-x64-gnu ] || [ ! -d node_modules/@tailwindcss/oxide-linux-x64-gnu ]; then if [ '$skipInstallFlag' = 'true' ]; then echo 'Linux native dependencies are missing; rerun without -SkipInstall.' >&2; exit 1; fi; npm install; fi; npx prisma generate; bash scripts/develop_start.sh; exec sleep infinity"

if ($wslDistro) {
    Start-Process -FilePath $wslExe -ArgumentList @('-d', $wslDistro, 'bash', '-lc', $agentCommand)
} else {
    Start-Process -FilePath $wslExe -ArgumentList @('bash', '-lc', $agentCommand)
}

Write-Host 'Started RAG and Agent Insight in separate PowerShell windows.'
