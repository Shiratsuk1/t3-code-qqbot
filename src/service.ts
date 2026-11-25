import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_LINUX_SERVICE = 't3-code-qqbot';
export const DEFAULT_WINDOWS_TASK = 'T3 Code QQBot';

export type ServiceAction = 'install' | 'uninstall' | 'status' | 'start' | 'stop' | 'restart';

export function sanitizeServiceName(raw: string, platform: NodeJS.Platform): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return platform === 'win32' ? DEFAULT_WINDOWS_TASK : DEFAULT_LINUX_SERVICE;
  }
  if (platform === 'win32') {
    if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(trimmed)) {
      throw new Error(`Invalid Windows task name "${raw}". Use letters, numbers, spaces, "_", "-", or "." only.`);
    }
    return trimmed;
  }
  if (!/^[a-zA-Z0-9@._-]{1,64}$/.test(trimmed)) {
    throw new Error(`Invalid systemd service name "${raw}". Use letters, numbers, ".", "_", "-", or "@" only.`);
  }
  return trimmed.endsWith('.service') ? trimmed.slice(0, -'.service'.length) : trimmed;
}

export function renderSystemdUnit(options: {
  nodePath: string;
  cliEntry: string;
  configPath: string;
  workingDir: string;
  description?: string;
}): string {
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '[Unit]',
    `Description=${options.description ?? 'T3 Code QQBot Bridge and Official WebSocket Gateway'}`,
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${options.workingDir}`,
    'Environment=NODE_NO_WARNINGS=1',
    `ExecStart=${quote(options.nodePath)} ${quote(options.cliEntry)} start --config ${quote(options.configPath)}`,
    'Restart=always',
    'RestartSec=5',
    'KillMode=control-group',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function vbsStringLiteral(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid multiline value for Windows launcher: ${JSON.stringify(value)}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function renderWindowsLauncherVbs(options: {
  nodePath: string;
  cliEntry: string;
  configPath: string;
  workingDir: string;
  logPath: string;
}): string {
  return [
    'Option Explicit',
    'Dim sh, nodePath, cliEntry, configPath, logPath, cmd, exitCode',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${vbsStringLiteral(options.workingDir)}`,
    'sh.Environment("Process")("NODE_NO_WARNINGS") = "1"',
    `nodePath = ${vbsStringLiteral(options.nodePath)}`,
    `cliEntry = ${vbsStringLiteral(options.cliEntry)}`,
    `configPath = ${vbsStringLiteral(options.configPath)}`,
    `logPath = ${vbsStringLiteral(options.logPath)}`,
    'cmd = """" & nodePath & """ """ & cliEntry & """ start --supervise --config """ & configPath & """ --log-file """ & logPath & """"',
    'exitCode = sh.Run(cmd, 0, True)',
    'WScript.Quit exitCode',
    '',
  ].join('\r\n');
}

function encodeUtf16LeWithBom(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
}

export function renderWindowsHandoverVbs(options: {
  psExe: string;
  encodedCommand: string;
  delayMs?: number;
}): string {
  const delayMs = Math.max(200, Math.min(10_000, options.delayMs ?? 1_500));
  return [
    'Option Explicit',
    'Dim sh, cmd, exitCode',
    'Set sh = CreateObject("WScript.Shell")',
    `WScript.Sleep ${delayMs}`,
    `cmd = ${vbsStringLiteral(options.psExe)} & " -NoProfile -NonInteractive -EncodedCommand " & ${vbsStringLiteral(options.encodedCommand)}`,
    'exitCode = sh.Run(cmd, 0, True)',
    'On Error Resume Next',
    'CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName, True',
    'WScript.Quit exitCode',
    '',
  ].join('\r\n');
}

export type LegacyWindowsMigrationResult = {
  migrated: boolean;
  migratedTasks: string[];
  handoverTriggered: boolean;
};

/**
 * Automatically upgrades any Windows Scheduled Task still pointing at legacy `state\run-service.ps1`
 * to the zero-window GUI `wscript.exe` + `state\run-service.vbs` launcher.
 * When `handover` is true and a legacy powershell.exe wrapper process is currently active,
 * spawns a detached zero-window wscript handover helper to close the old console host and restart
 * the upgraded Scheduled Task cleanly.
 */
export async function migrateLegacyWindowsServiceTask(options: {
  cliEntry: string;
  configPath: string;
  handover?: boolean;
  taskNameHint?: string;
}): Promise<LegacyWindowsMigrationResult> {
  if (process.platform !== 'win32') {
    return { migrated: false, migratedTasks: [], handoverTriggered: false };
  }

  const config = await loadConfig(options.configPath).catch(() => null);
  if (!config) {
    return { migrated: false, migratedTasks: [], handoverTriggered: false };
  }

  const legacyPs1Path = join(config.stateDir, 'run-service.ps1');
  if (!options.taskNameHint && !existsSync(legacyPs1Path)) {
    return { migrated: false, migratedTasks: [], handoverTriggered: false };
  }

  const psSingle = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const launcherPath = join(config.stateDir, 'run-service.vbs');
  const logPath = join(config.stateDir, 'service.log');
  const wscriptExe = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  const psExe = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  const inspectScript = `
$ErrorActionPreference = 'Stop'
$legacy = ${psSingle(legacyPs1Path)}
$hint = ${psSingle(options.taskNameHint ?? '')}
$matched = @()
Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | ForEach-Object {
  $t = $_
  $hit = $false
  foreach ($a in $t.Actions) {
    $exec = [string]$a.Execute
    $arg = [string]$a.Arguments
    if ($arg.IndexOf($legacy, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $hit = $true
    } elseif ($hint -and $t.TaskName -eq $hint -and $exec -match '(powershell|pwsh)(\\.exe)?$' -and $arg -match 'run-service\\.ps1') {
      $hit = $true
    }
  }
  if ($hit) { $matched += $t.TaskName }
}
$hasLegacyProc = $false
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine.IndexOf($legacy, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.ProcessId -ne $PID) {
    $hasLegacyProc = $true
  }
}
[pscustomobject]@{ tasks = $matched; hasLegacyProc = $hasLegacyProc } | ConvertTo-Json -Compress
`;

  const { stdout } = await runPsEncoded(inspectScript);
  const parsed = JSON.parse(stdout.trim() || '{}') as {
    tasks?: string[] | string;
    hasLegacyProc?: boolean;
  };
  const migratedTasks = Array.isArray(parsed.tasks)
    ? parsed.tasks.filter(Boolean)
    : typeof parsed.tasks === 'string' && parsed.tasks
      ? [parsed.tasks]
      : [];

  if (migratedTasks.length === 0) {
    if (existsSync(legacyPs1Path)) {
      await unlink(legacyPs1Path).catch(() => {});
    }
    return { migrated: false, migratedTasks: [], handoverTriggered: false };
  }

  await mkdir(config.stateDir, { recursive: true });
  const launcherContent = renderWindowsLauncherVbs({
    nodePath: process.execPath,
    cliEntry: options.cliEntry,
    configPath: config.configPath,
    workingDir: config.configDir,
    logPath,
  });
  await writeFile(launcherPath, encodeUtf16LeWithBom(launcherContent));

  const taskLiterals = migratedTasks.map(name => psSingle(name)).join(', ');
  const updateTasksScript = `
$ErrorActionPreference = 'Stop'
$wscriptExe = ${psSingle(wscriptExe)}
$launcher = ${psSingle(launcherPath)}
$workDir = ${psSingle(config.configDir)}
$action = New-ScheduledTaskAction -Execute $wscriptExe -Argument "//B //Nologo \`"$launcher\`"" -WorkingDirectory $workDir
foreach ($taskName in @(${taskLiterals})) {
  Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
}
`;
  await runPsEncoded(updateTasksScript);
  await unlink(legacyPs1Path).catch(() => {});

  let handoverTriggered = false;
  if (options.handover && parsed.hasLegacyProc) {
    const primaryTask = migratedTasks[0];
    const handoverPs = `
$ErrorActionPreference = 'SilentlyContinue'
$taskName = ${psSingle(primaryTask)}
$targets = @(${psSingle(config.configPath)}, ${psSingle(legacyPs1Path)})
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    if (-not $_.CommandLine -or $_.ProcessId -eq $PID) { return $false }
    foreach ($needle in $targets) {
      if ($needle -and $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
      }
    }
    return $false
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
`;
    const encodedHandover = Buffer.from(handoverPs, 'utf16le').toString('base64');
    const handoverVbsPath = join(config.stateDir, 'migrate-handover.vbs');
    const handoverVbs = renderWindowsHandoverVbs({
      psExe,
      encodedCommand: encodedHandover,
      delayMs: 1_500,
    });
    await writeFile(handoverVbsPath, encodeUtf16LeWithBom(handoverVbs));
    const child = spawn(wscriptExe, ['//B', '//Nologo', handoverVbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    handoverTriggered = true;
  }

  return { migrated: true, migratedTasks, handoverTriggered };
}

async function runPsEncoded(script: string): Promise<{ stdout: string; stderr: string }> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const psExe = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileAsync(psExe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
}

async function probeBridgeHealth(host: string, port: number): Promise<string> {
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const text = await res.text().catch(() => '');
    return `HTTP ${res.status}${text ? ` ${text}` : ''}`;
  } catch {
    return 'unreachable';
  }
}

async function runWindowsServiceAction(
  action: ServiceAction,
  options: { taskName: string; cliEntry: string; configPath: string },
): Promise<void> {
  const psSingle = (value: string) => `'${value.replace(/'/g, "''")}'`;

  const stopProcessesScript = (targets: string[]) => {
    const literals = targets.map(t => psSingle(t)).join(', ');
    return `
$targets = @(${literals})
$skipPids = @($PID, ${process.pid})
Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    if (-not $_.CommandLine -or ($skipPids -contains $_.ProcessId)) { return $false }
    foreach ($needle in $targets) {
      if ($needle -and $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
      }
    }
    return $false
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  };

  if (action === 'install') {
    const config = await loadConfig(options.configPath);
    await mkdir(config.stateDir, { recursive: true });
    const launcherPath = join(config.stateDir, 'run-service.vbs');
    const legacyPs1Path = join(config.stateDir, 'run-service.ps1');
    const logPath = join(config.stateDir, 'service.log');
    const launcherContent = renderWindowsLauncherVbs({
      nodePath: process.execPath,
      cliEntry: options.cliEntry,
      configPath: config.configPath,
      workingDir: config.configDir,
      logPath,
    });
    await writeFile(launcherPath, encodeUtf16LeWithBom(launcherContent));
    await unlink(legacyPs1Path).catch(() => {});

    const wscriptExe = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
    const registerScript = `
$ErrorActionPreference = 'Stop'
$taskName = ${psSingle(options.taskName)}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
${stopProcessesScript([config.configPath, launcherPath, legacyPs1Path])}
$wscriptExe = ${psSingle(wscriptExe)}
$launcher = ${psSingle(launcherPath)}
$workDir = ${psSingle(config.configDir)}
$action = New-ScheduledTaskAction -Execute $wscriptExe -Argument "//B //Nologo \`"$launcher\`"" -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'T3 Code QQBot Bridge & Official WebSocket Gateway' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "INSTALLED_AND_STARTED"
`;
    await runPsEncoded(registerScript);
    console.log(`Installed & started Windows background service "${options.taskName}" (GUI zero-window wscript launcher).`);
    console.log(`  Config:   ${config.configPath}`);
    console.log(`  Launcher: ${launcherPath}`);
    console.log(`  Logs:     ${logPath}`);
    console.log(`            ${join(config.stateDir, 'bridge.log')}`);
    console.log(`            ${join(config.stateDir, 'gateway.log')}`);
    return;
  }

  if (action === 'stop' || action === 'uninstall') {
    const absConfig = resolve(options.configPath);
    const config = await loadConfig(absConfig).catch(() => null);
    const stateDir = config?.stateDir ?? join(dirname(absConfig), 'state');
    const launcherPath = join(stateDir, 'run-service.vbs');
    const legacyPs1Path = join(stateDir, 'run-service.ps1');
    const script = `
$ErrorActionPreference = 'Stop'
$taskName = ${psSingle(options.taskName)}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  ${action === 'uninstall' ? 'Unregister-ScheduledTask -TaskName $taskName -Confirm:$false' : ''}
}
${stopProcessesScript([absConfig, launcherPath, legacyPs1Path])}
`;
    await runPsEncoded(script);
    if (action === 'uninstall') {
      await unlink(launcherPath).catch(() => {});
      await unlink(legacyPs1Path).catch(() => {});
      console.log(`Uninstalled Windows background service "${options.taskName}".`);
    } else {
      console.log(`Stopped Windows background service "${options.taskName}".`);
    }
    return;
  }

  if (action === 'start') {
    const migrated = await migrateLegacyWindowsServiceTask({
      cliEntry: options.cliEntry,
      configPath: options.configPath,
      taskNameHint: options.taskName,
      handover: false,
    }).catch(() => ({ migrated: false, migratedTasks: [] as string[], handoverTriggered: false }));
    if (migrated.migrated) {
      console.log(
        `Upgraded legacy Windows Scheduled Task (${migrated.migratedTasks.join(', ')}) from run-service.ps1 to zero-window wscript launcher.`,
      );
    }
    await runPsEncoded(`$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskName ${psSingle(options.taskName)}`);
    console.log(`Started Windows background service "${options.taskName}".`);
    return;
  }

  if (action === 'restart') {
    await runWindowsServiceAction('stop', options);
    await runWindowsServiceAction('start', options);
    return;
  }

  if (action === 'status') {
    const { stdout } = await runPsEncoded(`
$task = Get-ScheduledTask -TaskName ${psSingle(options.taskName)} -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output "NOT_INSTALLED"
} else {
  $info = Get-ScheduledTaskInfo -TaskName ${psSingle(options.taskName)}
  Write-Output ("STATE=" + $task.State + ";LAST_RUN=" + $info.LastRunTime + ";LAST_RESULT=" + $info.LastTaskResult)
}
`);
    console.log(`Windows Scheduled Task "${options.taskName}": ${stdout.trim()}`);
    const config = await loadConfig(options.configPath).catch(() => null);
    if (config) {
      const health = await probeBridgeHealth(config.bridge.host, config.bridge.port);
      console.log(`Bridge health (http://${config.bridge.host}:${config.bridge.port}/health): ${health}`);
      console.log(`Logs: ${join(config.stateDir, 'service.log')}`);
    }
  }
}

async function runLinuxServiceAction(
  action: ServiceAction,
  options: { serviceName: string; cliEntry: string; configPath: string },
): Promise<void> {
  const unitName = `${options.serviceName}.service`;
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, unitName);

  if (action === 'install') {
    const config = await loadConfig(options.configPath);
    await mkdir(config.stateDir, { recursive: true });
    await mkdir(unitDir, { recursive: true });
    const unitContent = renderSystemdUnit({
      nodePath: process.execPath,
      cliEntry: options.cliEntry,
      configPath: config.configPath,
      workingDir: config.configDir,
    });
    await writeFile(unitPath, unitContent, 'utf8');
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    await execFileAsync('systemctl', ['--user', 'enable', '--now', unitName]);
    console.log(`Installed & started systemd user service "${unitName}".`);
    console.log(`  Unit:   ${unitPath}`);
    console.log(`  Config: ${config.configPath}`);
    console.log(`  Logs:   journalctl --user -u ${unitName} -f`);

    const user = process.env.USER || '';
    if (user) {
      const linger = await execFileAsync('loginctl', ['show-user', user, '-p', 'Linger'])
        .then(r => r.stdout.trim())
        .catch(() => '');
      if (linger && !linger.includes('Linger=yes')) {
        console.log(`\nTip: To keep the service running after SSH logout, run once:`);
        console.log(`  sudo loginctl enable-linger "${user}"`);
      }
    }
    return;
  }

  if (action === 'uninstall') {
    await execFileAsync('systemctl', ['--user', 'disable', '--now', unitName]).catch(() => {});
    await unlink(unitPath).catch(() => {});
    await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    console.log(`Uninstalled systemd user service "${unitName}".`);
    return;
  }

  if (action === 'start' || action === 'stop' || action === 'restart') {
    await execFileAsync('systemctl', ['--user', action, unitName]);
    console.log(`Executed "systemctl --user ${action} ${unitName}".`);
    return;
  }

  if (action === 'status') {
    const statusOut = await execFileAsync('systemctl', ['--user', 'status', '--no-pager', unitName])
      .then(r => r.stdout)
      .catch(err => err.stdout || err.stderr || String(err));
    console.log(statusOut.trim());
    const config = await loadConfig(options.configPath).catch(() => null);
    if (config) {
      const health = await probeBridgeHealth(config.bridge.host, config.bridge.port);
      console.log(`Bridge health (http://${config.bridge.host}:${config.bridge.port}/health): ${health}`);
    }
  }
}

export async function runServiceCommand(
  actionRaw: string | undefined,
  options: { cliEntry: string; configPath: string; name?: string },
): Promise<void> {
  const valid: ServiceAction[] = ['install', 'uninstall', 'status', 'start', 'stop', 'restart'];
  if (!actionRaw || !valid.includes(actionRaw as ServiceAction)) {
    throw new Error(`Usage: t3-qqbot service <${valid.join('|')}> [--config <path>] [--name <name>]`);
  }
  const action = actionRaw as ServiceAction;

  if (process.platform === 'win32') {
    const taskName = sanitizeServiceName(options.name ?? DEFAULT_WINDOWS_TASK, 'win32');
    await runWindowsServiceAction(action, {
      taskName,
      cliEntry: options.cliEntry,
      configPath: options.configPath,
    });
    return;
  }

  if (process.platform === 'linux') {
    const serviceName = sanitizeServiceName(options.name ?? DEFAULT_LINUX_SERVICE, 'linux');
    await runLinuxServiceAction(action, {
      serviceName,
      cliEntry: options.cliEntry,
      configPath: options.configPath,
    });
    return;
  }

  throw new Error(
    `Automatic service registration currently supports Windows and Linux (detected: ${process.platform}). Run "t3-qqbot start --supervise" under launchd or your process manager.`,
  );
}
