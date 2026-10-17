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

function Stop-WindowsPortProcess([int]$port) {
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($owner in $owners) {
        $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($process -and $process.Name -in @('node', 'npm', 'python', 'java')) {
            Write-Host "Stopping process $($process.Id) on port $port..."
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

$wsl = Get-Command 'wsl.exe' -ErrorAction SilentlyContinue
if (-not $wsl) {
    throw 'wsl.exe was not found. Install WSL or start Agent Insight manually from Ubuntu/WSL.'
}

$wslExe = if ($wsl.Path) { $wsl.Path } else { 'wsl.exe' }
function Invoke-WslSilently([object[]]$arguments) {
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        return @(& $wslExe @arguments 2>$null)
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

$wslDistro = @(Invoke-WslSilently @('-l', '-q')) |
    ForEach-Object { ($_ -replace "`0", '').Trim() } |
    Where-Object { $_ -match '^Ubuntu(?:-[0-9]+(?:\.[0-9]+)?)?$' } |
    Select-Object -First 1
$wslDistroArgs = if ($wslDistro) { @('-d', $wslDistro) } else { @() }
$wslPathOutput = @(Invoke-WslSilently @($wslDistroArgs + @('-e', 'wslpath', '-a', '-u', '--', $agentDir)))
$agentWslDir = ($wslPathOutput -join "`n").Trim()
if (-not $agentWslDir) {
    throw "Could not convert Agent Insight path for WSL: $agentDir"
}

function Stop-ExistingServices {
    Write-Host 'Stopping existing RAG and Agent Insight services...'
    Stop-WindowsPortProcess 8787

    $ragPattern = [regex]::Escape($ragDir)
    $ragShells = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^powershell(\.exe)?$' -and
        $_.CommandLine -and
        $_.CommandLine -match $ragPattern -and
        $_.CommandLine -match 'npm run serve'
    })
    foreach ($shell in $ragShells) {
        Stop-Process -Id $shell.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $stopAgentCommand = "set +e; if command -v fuser >/dev/null 2>&1; then fuser -k -n tcp 3000 >/dev/null 2>&1; fi; exit 0"
    Invoke-WslSilently @($wslDistroArgs + @('bash', '-lc', $stopAgentCommand)) | Out-Null

    $agentProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'wsl.exe' -and
        $_.CommandLine -and
        $_.CommandLine.Contains($agentWslDir) -and
        $_.CommandLine -match 'develop_start\.sh|sleep infinity|next/dist/bin/next'
    })
    foreach ($process in $agentProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 500
}

Stop-ExistingServices

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

$forceInstall = if ([bool]$Install) { 'true' } else { 'false' }
$skipInstallFlag = if ([bool]$SkipInstall) { 'true' } else { 'false' }
$agentCommand = "set -e; cd '$agentWslDir'; if [ '$forceInstall' = 'true' ] || { [ '$skipInstallFlag' != 'true' ] && [ ! -d node_modules ]; }; then npm install; fi; if [ ! -d node_modules/lightningcss-linux-x64-gnu ] || [ ! -d node_modules/@tailwindcss/oxide-linux-x64-gnu ]; then if [ '$skipInstallFlag' = 'true' ]; then echo 'Linux native dependencies are missing; rerun without -SkipInstall.' >&2; exit 1; fi; npm install; fi; npx prisma generate; bash scripts/develop_start.sh; exec sleep infinity"

if ($wslDistro) {
    Start-Process -FilePath $wslExe -ArgumentList @('-d', $wslDistro, 'bash', '-lc', $agentCommand)
} else {
    Start-Process -FilePath $wslExe -ArgumentList @('bash', '-lc', $agentCommand)
}

Write-Host 'Started RAG and Agent Insight in separate PowerShell windows.'
