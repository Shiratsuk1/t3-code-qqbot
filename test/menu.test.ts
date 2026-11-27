import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyConfigSet, createDefaultRawConfig, maskSecret, runConfigSet, runInitWizard } from '../src/menu.ts';

test('maskSecret redacts secrets cleanly', () => {
  assert.equal(maskSecret(undefined), '(not set)');
  assert.equal(maskSecret('REPLACE_WITH_QQ_BOT_APP_ID'), '(placeholder)');
  assert.equal(maskSecret('12345'), '***');
  assert.equal(maskSecret('102123456789'), '102***789');
});

test('applyConfigSet updates typed fields, syncs default bridgeUrl, and rejects bad values', () => {
  const base = createDefaultRawConfig();
  const updatedPort = applyConfigSet(base, 'bridge.port', '19001');
  assert.equal(updatedPort.bridge.port, 19001);
  assert.equal(updatedPort.gateway?.bridgeUrl, 'http://127.0.0.1:19001/events');

  const updatedBool = applyConfigSet(updatedPort, 'gateway.requireMentionInGroup', 'false');
  assert.equal(updatedBool.gateway?.requireMentionInGroup, false);

  const updatedPrefix = applyConfigSet(updatedBool, 'gateway.stripPrefix', '/ai');
  assert.equal(updatedPrefix.gateway?.stripPrefix, '/ai');

  const updatedSettle = applyConfigSet(updatedPrefix, 'bridge.autoSettleThread', 'true');
  assert.equal(updatedSettle.bridge.autoSettleThread, true);

  const updatedStream = applyConfigSet(updatedSettle, 'bridge.enableStreaming', 'false');
  assert.equal(updatedStream.bridge.enableStreaming, false);

  const updatedMute = applyConfigSet(updatedStream, 't3.muteMobileCompletionThreadId', 'mcp:thread-123');
  assert.equal(updatedMute.t3.muteMobileCompletionThreadId, 'mcp:thread-123');

  const updatedAtt = applyConfigSet(updatedMute, 'attachments.maxInboundBytes', String(300 * 1024 * 1024));
  assert.equal(updatedAtt.attachments?.maxInboundBytes, 300 * 1024 * 1024);

  assert.throws(() => applyConfigSet(base, 'bridge.port', 'not-a-port'), /Invalid integer/);
  assert.throws(() => applyConfigSet(base, 'gateway.requireMentionInGroup', 'maybe'), /Invalid boolean/);
  assert.throws(() => applyConfigSet(base, 'unknown.key', '1'), /Unknown config key/);
});

test('runConfigSet validates and atomically persists changes to disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-menu-'));
  const cfgPath = join(dir, 'config.json');
  try {
    await runConfigSet(cfgPath, 'bridge.maxMessageChars', '1200');
    const saved = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.equal(saved.bridge.maxMessageChars, 1200);

    await assert.rejects(() => runConfigSet(cfgPath, 't3.origin', 'http://10.0.0.1:3773'), /must target loopback/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runInitWizard in nonInteractive mode creates config.json and credentials.json safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-initwiz-'));
  try {
    await runInitWizard({ dir, force: false, nonInteractive: true, cliEntry: 'dist/cli.mjs' });
    const cfg = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    const creds = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'));
    assert.equal(cfg.bridge.port, 18773);
    assert.equal(creds.bridgeSecret.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
