param(
    [string]$TaskName = 'T3 Code QQBot',
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json'),
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction Stop
    $NodePath = $cmd.Source
}

$nodeVer = (& $NodePath -v).Trim()
$major = [int](($nodeVer -replace '^v', '').Split('.')[0])
if ($major -lt 24) {
    throw "Node.js 24+ is required, but '$NodePath' is $nodeVer. Pass -NodePath pointing to Node 24+."
}

$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}

$rootDir = Split-Path -Parent $PSScriptRoot
$cliEntry = Join-Path $rootDir 'dist\cli.mjs'
if (-not (Test-Path -LiteralPath $cliEntry)) {
    throw "Missing $cliEntry. Build or extract a release package first."
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
$stateDir = $config.stateDir
if (-not $stateDir) {
    $stateDir = './state'
}
if (-not [System.IO.Path]::IsPathRooted($stateDir)) {
    $stateDir = Join-Path (Split-Path -Parent $ConfigPath) $stateDir
}
$stateDir = [System.IO.Path]::GetFullPath($stateDir)
New-Item -Path $stateDir -ItemType Directory -Force | Out-Null

$logPath = Join-Path $stateDir 'service.log'
$launcherPath = Join-Path $stateDir 'run-service.vbs'
$workDir = Split-Path -Parent $ConfigPath

function Escape-VbsString([string]$Value) {
    return '"' + ($Value -replace '"', '""') + '"'
}

$vbsContent = @(
    'Option Explicit',
    'Dim sh, nodePath, cliEntry, configPath, logPath, cmd, exitCode',
    'Set sh = CreateObject("WScript.Shell")',
    ("sh.CurrentDirectory = " + (Escape-VbsString $workDir)),
    'sh.Environment("Process")("NODE_NO_WARNINGS") = "1"',
    ("nodePath = " + (Escape-VbsString $NodePath)),
    ("cliEntry = " + (Escape-VbsString $cliEntry)),
    ("configPath = " + (Escape-VbsString $ConfigPath)),
    ("logPath = " + (Escape-VbsString $logPath)),
    'cmd = """" & nodePath & """ """ & cliEntry & """ start --supervise --config """ & configPath & """ --log-file """ & logPath & """"',
    'exitCode = sh.Run(cmd, 0, True)',
    'WScript.Quit exitCode',
    ''
) -join "`r`n"

$utf16LeBom = New-Object System.Text.UnicodeEncoding($false, $true)
[System.IO.File]::WriteAllText($launcherPath, $vbsContent, $utf16LeBom)

# Use GUI-subsystem wscript.exe instead of CUI powershell.exe so Windows 10/11 (including Windows Terminal) never spawns a visible window.
$wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
$action = New-ScheduledTaskAction `
    -Execute $wscriptExe `
    -Argument "//B //Nologo `"$launcherPath`"" `
    -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'T3 Code QQBot Bridge & Official WebSocket Gateway' `
    -Force | Out-Null

Write-Host "Registered zero-window Windows Scheduled Task '$TaskName' (Node $nodeVer, wscript launcher: $launcherPath)."
Write-Host "Logs will be written to $logPath, state\bridge.log, and state\gateway.log."
Write-Host "Start it now with: Start-ScheduledTask -TaskName '$TaskName'"
