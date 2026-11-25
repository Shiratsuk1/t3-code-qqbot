import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseWindowsT3Cmd, resolveT3Command, sanitizeChildEnv } from '../src/t3-cli.ts';

const SAMPLE_T3_CMD = `@echo off
rem Written by T3 Code: runs the desktop app's bundled t3 CLI.
setlocal EnableExtensions DisableDelayedExpansion
set "T3CODE_CLI_PATH=C:\\Users\\Alice\\.t3\\bin\\t3.cmd"
if not defined T3CODE_HOME set "T3CODE_HOME=C:\\Users\\Alice\\.t3"
set "ELECTRON_RUN_AS_NODE=1"
set "T3CODE_DESKTOP_CLI_LAUNCHER=1"
:run
"C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe" "C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\resources\\server.asar\\apps\\server\\dist\\bin.mjs" %*
set "t3_exit=%ERRORLEVEL%"
exit /b %t3_exit%
`;

test('parseWindowsT3Cmd extracts Electron exe, ignores t3_exit, and respects caller T3CODE_HOME', () => {
  const parsedDefault = parseWindowsT3Cmd(SAMPLE_T3_CMD);
  assert.ok(parsedDefault);
  assert.equal(parsedDefault.executable, 'C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe');
  assert.deepEqual(parsedDefault.prefix, [
    'C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\resources\\server.asar\\apps\\server\\dist\\bin.mjs',
  ]);
  assert.equal(parsedDefault.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(parsedDefault.env.T3CODE_DESKTOP_CLI_LAUNCHER, '1');
  assert.equal(parsedDefault.env.T3CODE_HOME, 'C:\\Users\\Alice\\.t3');
  assert.equal(parsedDefault.env.t3_exit, undefined);

  const parsedCustom = parseWindowsT3Cmd(SAMPLE_T3_CMD, { env: { T3CODE_HOME: 'D:\\CustomT3' } });
  assert.ok(parsedCustom);
  assert.equal(parsedCustom.env.T3CODE_HOME, undefined);

  const callWrapper = `@echo off\nset ELECTRON_RUN_AS_NODE=1\ncall "C:\\Program Files\\T3\\t3.exe" --flag %*\n`;
  const parsedCall = parseWindowsT3Cmd(callWrapper);
  assert.ok(parsedCall);
  assert.equal(parsedCall.executable, 'C:\\Program Files\\T3\\t3.exe');
  assert.deepEqual(parsedCall.prefix, ['--flag']);
  assert.equal(parsedCall.env.ELECTRON_RUN_AS_NODE, '1');
});

test('sanitizeChildEnv strips QQ credentials case-insensitively including QQ_CREDENTIALS_FILE', () => {
  const cleaned = sanitizeChildEnv({
    PATH: '/usr/bin',
    QQ_APP_ID: '1',
    qq_app_secret: 'secret',
    Qq_Bridge_Secret: 'bridge',
    QQ_CREDENTIALS_FILE: '/etc/creds.json',
    HOME: '/home/user',
  });
  assert.equal(cleaned.PATH, '/usr/bin');
  assert.equal(cleaned.HOME, '/home/user');
  assert.equal('QQ_APP_ID' in cleaned, false);
  assert.equal('qq_app_secret' in cleaned, false);
  assert.equal('Qq_Bridge_Secret' in cleaned, false);
  assert.equal('QQ_CREDENTIALS_FILE' in cleaned, false);
});

test('resolveT3Command auto-detects Windows t3.cmd and Linux ~/.t3/bin/t3', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 't3-qqbot-home-'));
  try {
    const binDir = join(fakeHome, '.t3', 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 't3.cmd'), SAMPLE_T3_CMD, 'utf8');
    await writeFile(join(binDir, 't3'), '#!/bin/sh\necho ok\n', 'utf8');

    const winResolved = await resolveT3Command(
      { origin: 'http://127.0.0.1:3773', executable: 'auto', prefix: [], env: {} },
      { platform: 'win32', homeDir: fakeHome, env: {} },
    );
    assert.equal(
      winResolved.executable,
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe',
    );
    assert.equal(winResolved.env.ELECTRON_RUN_AS_NODE, '1');

    const linuxResolved = await resolveT3Command(
      { origin: 'http://127.0.0.1:3773', executable: 'auto', prefix: [], env: {} },
      { platform: 'linux', homeDir: fakeHome, env: {} },
    );
    assert.equal(linuxResolved.executable, join(binDir, 't3'));
    assert.deepEqual(linuxResolved.prefix, []);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});
