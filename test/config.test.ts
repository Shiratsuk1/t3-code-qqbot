import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_ATTACHMENT_HOSTS,
  findBindingForScope,
  isLoopbackOrigin,
  isSameOrInsidePath,
  loadCredentials,
  loadGatewayConfig,
  parseConfig,
  samePath,
  scopeToHash,
} from '../src/config.ts';
import { digest } from '../src/protocol.ts';

test('scopeToHash accepts plain c2c/group scopes and sha256 hashes', () => {
  const plain = scopeToHash('c2c:USER_OPENID_123');
  assert.equal(plain, digest('c2c:USER_OPENID_123'));
  assert.equal(scopeToHash(`sha256:${plain.toUpperCase()}`), plain);
  assert.equal(scopeToHash('group:GROUP_OPENID_456'), digest('group:GROUP_OPENID_456'));
  assert.throws(() => scopeToHash('invalid-scope'), /Invalid binding scope/);
});

test('isLoopbackOrigin allows loopback only', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:3773'), true);
  assert.equal(isLoopbackOrigin('http://localhost:3773'), true);
  assert.equal(isLoopbackOrigin('http://[::1]:3773'), true);
  assert.equal(isLoopbackOrigin('http://192.168.1.5:3773'), false);
  assert.equal(isLoopbackOrigin('https://example.com'), false);
});

test('parseConfig resolves relative paths, normalizes hosts, validates bounds, and rejects non-loopback origins', () => {
  const basePath = join(tmpdir(), 't3-qqbot-cfg-test', 'config.json');
  const parsed = parseConfig(
    {
      stateDir: './state',
      credentialsFile: './credentials.json',
      t3: { origin: 'http://127.0.0.1:3773' },
      bridge: { port: 18773 },
      attachmentHosts: ['MULTIMEDIA.NT.QQ.COM'],
      bindings: [
        {
          scope: 'c2c:TEST_USER',
          workspace: './my-workspace',
          threadId: 'REPLACE_WITH_T3_THREAD_ID',
        },
      ],
    },
    basePath,
  );
  assert.deepEqual(parsed.attachmentHosts, ['multimedia.nt.qq.com']);
  assert.equal(parsed.bindings.length, 1);
  assert.equal(parsed.bindings[0].threadId, undefined);
  assert.equal(findBindingForScope(parsed, 'c2c:TEST_USER')?.rawScope, 'c2c:TEST_USER');
  assert.equal(findBindingForScope(parsed, 'c2c:OTHER_USER'), undefined);

  const defaultHosts = parseConfig(
    { stateDir: './state', t3: { origin: 'http://127.0.0.1:3773' }, bridge: { port: 18773 }, bindings: [] },
    basePath,
  );
  assert.deepEqual(defaultHosts.attachmentHosts, DEFAULT_ATTACHMENT_HOSTS);

  assert.throws(
    () =>
      parseConfig(
        {
          stateDir: './state',
          t3: { origin: 'http://10.0.0.5:3773' },
          bridge: { port: 18773 },
          bindings: [],
        },
        basePath,
      ),
    /must target loopback/,
  );

  assert.throws(
    () =>
      parseConfig(
        {
          stateDir: './state',
          t3: { origin: 'http://127.0.0.1:3773' },
          bridge: { port: 18773, maxMessageChars: 0 },
          bindings: [],
        },
        basePath,
      ),
    /Invalid bridge\.maxMessageChars/,
  );
});

test('loadGatewayConfig supports minimal split-host gateway config without stateDir or t3.origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-gwcfg-'));
  try {
    const gwConfigPath = join(dir, 'gateway.json');
    const credsPath = join(dir, 'credentials.json');
    await writeFile(
      gwConfigPath,
      JSON.stringify({ gateway: { bridgeUrl: 'http://127.0.0.1:18773/events' } }),
      'utf8',
    );
    await writeFile(
      credsPath,
      JSON.stringify({ appId: 'a', appSecret: 's', bridgeSecret: 'b' }),
      'utf8',
    );
    const loaded = await loadGatewayConfig(gwConfigPath);
    assert.equal(loaded.gateway.bridgeUrl, 'http://127.0.0.1:18773/events');
    assert.equal(loaded.credentialsFile, credsPath);
    assert.equal(loaded.stateDir, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('samePath and isSameOrInsidePath handle platform case sensitivity and path separators', () => {
  assert.equal(samePath('C:\\Work\\Proj', 'c:\\work\\proj', 'win32'), true);
  assert.equal(samePath('/opt/Proj', '/opt/proj', 'linux'), false);
  assert.equal(isSameOrInsidePath('/opt/proj/sub/dir', '/opt/proj', 'linux'), true);
  assert.equal(isSameOrInsidePath('/opt/proj2', '/opt/proj', 'linux'), false);
});

test('loadCredentials supports file, env override without ENOENT, and optional bridgeSecret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-creds-'));
  try {
    const file = join(dir, 'credentials.json');
    await writeFile(
      file,
      JSON.stringify({ appId: 'file-app', appSecret: 'file-secret', bridgeSecret: 'file-bridge' }),
      'utf8',
    );
    const fromFile = await loadCredentials({ credentialsFile: file }, {});
    assert.deepEqual(fromFile, {
      appId: 'file-app',
      appSecret: 'file-secret',
      bridgeSecret: 'file-bridge',
    });

    // Missing default credentialsFile does NOT fail when env vars provide all required fields
    const missingFile = join(dir, 'missing.json');
    const envOnly = await loadCredentials(
      { credentialsFile: missingFile },
      { QQ_APP_ID: 'env-app', QQ_APP_SECRET: 'env-sec', QQ_BRIDGE_SECRET: 'env-br' },
    );
    assert.deepEqual(envOnly, {
      appId: 'env-app',
      appSecret: 'env-sec',
      bridgeSecret: 'env-br',
    });

    // publish.ts mode: requireBridgeSecret=false succeeds without bridgeSecret
    const mediaOnly = await loadCredentials(
      { credentialsFile: missingFile },
      { QQ_APP_ID: 'env-app', QQ_APP_SECRET: 'env-sec' },
      { requireBridgeSecret: false },
    );
    assert.equal(mediaOnly.appId, 'env-app');
    assert.equal(mediaOnly.appSecret, 'env-sec');

    await writeFile(
      file,
      JSON.stringify({ appId: 'REPLACE_WITH_APP', appSecret: 's', bridgeSecret: 'b' }),
      'utf8',
    );
    await assert.rejects(() => loadCredentials({ credentialsFile: file }, {}), /placeholder values/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
