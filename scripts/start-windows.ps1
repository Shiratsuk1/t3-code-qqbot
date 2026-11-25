param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json'),
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw 'Node.js 24+ not found on PATH. Pass -NodePath explicitly.'
    }
    $NodePath = $cmd.Source
}

$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}

$rootDir = Split-Path -Parent $PSScriptRoot
$cliEntry = Join-Path $rootDir 'dist\cli.mjs'
if (-not (Test-Path -LiteralPath $cliEntry)) {
    throw "Missing $cliEntry. Run npm run build first (or use a release package)."
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
$stateDir = $config.stateDir
if (-not $stateDir) {
    $stateDir = './state'
}
if (-not [System.IO.Path]::IsPathRooted($stateDir)) {
    $stateDir = Join-Path (Split-Path -Parent $ConfigPath) $stateDir
}
New-Item -Path $stateDir -ItemType Directory -Force | Out-Null
$logPath = Join-Path $stateDir 'service.log'

# Foreground/manual Windows runner. For zero-window background startup, use `t3-qqbot service install`
# or `scripts\install-windows-task.ps1` (which registers GUI-subsystem wscript.exe + run-service.vbs).
$env:NODE_NO_WARNINGS = '1'
& $NodePath $cliEntry start --supervise --config $ConfigPath --log-file $logPath
exit $LASTEXITCODE
