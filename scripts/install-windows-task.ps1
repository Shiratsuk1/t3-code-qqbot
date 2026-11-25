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

$startScript = Join-Path $PSScriptRoot 'start-windows.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Missing $startScript."
}

$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction `
    -Execute $psExe `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ConfigPath `"$ConfigPath`" -NodePath `"$NodePath`"" `
    -WorkingDirectory $rootDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'T3 Code QQBot Bridge & Official WebSocket Gateway' `
    -Force | Out-Null

Write-Host "Registered Windows Scheduled Task '$TaskName' (Node $nodeVer)."
Write-Host "Logs will be written to state\service.log, state\bridge.log, and state\gateway.log."
Write-Host "Start it now with: Start-ScheduledTask -TaskName '$TaskName'"
