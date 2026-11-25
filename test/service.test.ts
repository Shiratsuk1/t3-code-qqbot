import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LINUX_SERVICE,
  DEFAULT_WINDOWS_TASK,
  renderSystemdUnit,
  renderWindowsLauncherVbs,
  sanitizeServiceName,
} from '../src/service.ts';

test('sanitizeServiceName validates platform-specific service/task names', () => {
  assert.equal(sanitizeServiceName('', 'win32'), DEFAULT_WINDOWS_TASK);
  assert.equal(sanitizeServiceName('', 'linux'), DEFAULT_LINUX_SERVICE);
  assert.equal(sanitizeServiceName('my-qqbot.service', 'linux'), 'my-qqbot');
  assert.equal(sanitizeServiceName('My QQBot 2', 'win32'), 'My QQBot 2');
  assert.throws(() => sanitizeServiceName('bad;rm -rf /', 'linux'), /Invalid systemd service name/);
  assert.throws(() => sanitizeServiceName('bad"name', 'win32'), /Invalid Windows task name/);
});

test('renderSystemdUnit outputs valid systemd user unit with ExecStart, Restart, and KillMode', () => {
  const unit = renderSystemdUnit({
    nodePath: '/usr/bin/node',
    cliEntry: '/opt/t3-qqbot/dist/cli.mjs',
    configPath: '/home/alice/t3-qqbot/config.json',
    workingDir: '/home/alice/t3-qqbot',
  });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/t3-qqbot\/dist\/cli\.mjs" start --config "\/home\/alice\/t3-qqbot\/config\.json"/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /KillMode=control-group/);
  assert.doesNotMatch(unit, /network-online\.target/);
});

test('renderWindowsLauncherVbs launches node.exe hidden via WScript.Shell.Run(..., 0, True) with --log-file', () => {
  const vbs = renderWindowsLauncherVbs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliEntry: 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\t3-code-qqbot\\dist\\cli.mjs',
    configPath: 'C:\\Users\\张三\\t3 "qqbot"\\config.json',
    workingDir: 'C:\\Users\\张三\\t3 "qqbot"',
    logPath: 'C:\\Users\\张三\\t3 "qqbot"\\state\\service.log',
  });
  assert.match(vbs, /CreateObject\("WScript\.Shell"\)/);
  assert.match(vbs, /sh\.Environment\("Process"\)\("NODE_NO_WARNINGS"\) = "1"/);
  assert.match(vbs, /t3 ""qqbot""/);
  assert.match(vbs, /start --supervise --config/);
  assert.match(vbs, /--log-file/);
  assert.match(vbs, /sh\.Run\(cmd, 0, True\)/);
  assert.match(vbs, /WScript\.Quit exitCode/);
  assert.doesNotMatch(vbs, /powershell/i);
  assert.throws(
    () =>
      renderWindowsLauncherVbs({
        nodePath: 'node.exe',
        cliEntry: 'cli.mjs',
        configPath: 'bad\npath',
        workingDir: 'C:\\work',
        logPath: 'service.log',
      }),
    /Invalid multiline value/,
  );
});
