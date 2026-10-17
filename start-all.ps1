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

$agentWslDir = (& $wsl.Source wslpath -a -u $agentDir).Trim()
if (-not $agentWslDir) {
    throw "Could not convert Agent Insight path for WSL: $agentDir"
}

$forceInstall = $Install.IsPresent.ToString().ToLowerInvariant()
$skipInstall = $SkipInstall.IsPresent.ToString().ToLowerInvariant()
$agentCommand = @"
set -e
cd '$agentWslDir'
if [ '$forceInstall' = 'true' ] || { [ '$skipInstall' != 'true' ] && [ ! -d node_modules ]; }; then
  npm install
fi
npx prisma generate
bash scripts/develop_start.sh
"@.Trim()

$agentPowerShellCommand = "wsl.exe bash -lc $(ConvertTo-PowerShellLiteral $agentCommand)"
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-NoExit',
    '-Command', $agentPowerShellCommand
)

Write-Host 'Started RAG and Agent Insight in separate PowerShell windows.'
