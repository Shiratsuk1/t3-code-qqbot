import { execFile } from 'node:child_process';
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

export function renderWindowsWrapperPs1(options: {
  nodePath: string;
  cliEntry: string;
  configPath: string;
  stateDir: string;
}): string {
  const psSingle = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$NodePath = ${psSingle(options.nodePath)}`,
    `$CliEntry = ${psSingle(options.cliEntry)}`,
    `$ConfigPath = ${psSingle(options.configPath)}`,
    `$StateDir = ${psSingle(options.stateDir)}`,
    'New-Item -Path $StateDir -ItemType Directory -Force | Out-Null',
    '$LogPath = Join-Path $StateDir \'service.log\'',
    '$env:NODE_NO_WARNINGS = \'1\'',
    '$prev = $ErrorActionPreference',
    '$ErrorActionPreference = \'Continue\'',
    'try {',
    '    & $NodePath $CliEntry start --supervise --config $ConfigPath 2>&1 | ForEach-Object {',
    '        $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }',
    '        Add-Content -LiteralPath $LogPath -Encoding utf8 -Value (\'[{0:yyyy-MM-dd HH:mm:ss}] {1}\' -f [DateTime]::Now, $text)',
    '    }',
    '    $code = $LASTEXITCODE',
    '} finally {',
    '    $ErrorActionPreference = $prev',
    '}',
    'exit $code',
    '',
  ].join('\r\n');
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

  if (action === 'install') {
    const config = await loadConfig(options.configPath);
    await mkdir(config.stateDir, { recursive: true });
    const wrapperPath = join(config.stateDir, 'run-service.ps1');
    const wrapperContent = renderWindowsWrapperPs1({
      nodePath: process.execPath,
      cliEntry: options.cliEntry,
      configPath: config.configPath,
      stateDir: config.stateDir,
    });
    await writeFile(wrapperPath, wrapperContent, 'utf8');

    const psExe = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const registerScript = `
$ErrorActionPreference = 'Stop'
$taskName = ${psSingle(options.taskName)}
$psExe = ${psSingle(psExe)}
$wrapper = ${psSingle(wrapperPath)}
$workDir = ${psSingle(config.configDir)}
$action = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$wrapper\`"" -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'T3 Code QQBot Bridge & Official WebSocket Gateway' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "INSTALLED_AND_STARTED"
`;
    await runPsEncoded(registerScript);
    console.log(`Installed & started Windows background service "${options.taskName}".`);
    console.log(`  Config:  ${config.configPath}`);
    console.log(`  Wrapper: ${wrapperPath}`);
    console.log(`  Logs:    ${join(config.stateDir, 'service.log')}`);
    console.log(`           ${join(config.stateDir, 'bridge.log')}`);
    console.log(`           ${join(config.stateDir, 'gateway.log')}`);
    return;
  }

  const stopProcessesScript = (configPath: string) => `
$cfg = ${psSingle(configPath)}
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($cfg, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;

  if (action === 'stop' || action === 'uninstall') {
    const absConfig = resolve(options.configPath);
    const script = `
$ErrorActionPreference = 'Stop'
$taskName = ${psSingle(options.taskName)}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  ${action === 'uninstall' ? 'Unregister-ScheduledTask -TaskName $taskName -Confirm:$false' : ''}
}
${stopProcessesScript(absConfig)}
`;
    await runPsEncoded(script);
    if (action === 'uninstall') {
      const config = await loadConfig(absConfig).catch(() => null);
      if (config) {
        await unlink(join(config.stateDir, 'run-service.ps1')).catch(() => {});
      }
      console.log(`Uninstalled Windows background service "${options.taskName}".`);
    } else {
      console.log(`Stopped Windows background service "${options.taskName}".`);
    }
    return;
  }

  if (action === 'start') {
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
