import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LINUX_SERVICE,
  DEFAULT_WINDOWS_TASK,
  renderSystemdUnit,
  renderWindowsWrapperPs1,
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

test('renderWindowsWrapperPs1 runs --supervise with Continue error policy around 2>&1', () => {
  const ps1 = renderWindowsWrapperPs1({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliEntry: 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\t3-code-qqbot\\dist\\cli.mjs',
    configPath: "C:\\Users\\O'Brien\\t3-qqbot\\config.json",
    stateDir: "C:\\Users\\O'Brien\\t3-qqbot\\state",
  });
  assert.match(ps1, /--supervise --config \$ConfigPath/);
  assert.match(ps1, /\$ErrorActionPreference = 'Continue'/);
  assert.match(ps1, /O''Brien/);
});
