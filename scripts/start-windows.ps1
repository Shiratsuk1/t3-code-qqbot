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

$env:NODE_NO_WARNINGS = '1'

# PowerShell 5.1 converts native stderr lines into ErrorRecords when using 2>&1;
# switch to Continue around the native command so warnings never abort the service.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $NodePath $cliEntry start --config $ConfigPath 2>&1 | ForEach-Object {
        $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
        $line = '[{0:yyyy-MM-dd HH:mm:ss}] {1}' -f [DateTime]::Now, $text
        Add-Content -LiteralPath $logPath -Encoding utf8 -Value $line
    }
    $exitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
}

exit $exitCode
