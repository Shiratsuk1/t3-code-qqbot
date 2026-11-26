import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildInboundMessageText, createBridgeRuntime, startTypingKeepalive } from '../src/bridge.ts';
import { parseConfig } from '../src/config.ts';

test('bridge HTTP server enforces auth, validates events, and accepts bound scopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-bridge-'));
  const config = parseConfig(
    {
      stateDir: join(dir, 'state'),
      t3: { origin: 'http://127.0.0.1:3773' },
      bridge: { host: '127.0.0.1', port: 18999 },
      bindings: [
        {
          scope: 'c2c:BOUND_USER',
          workspace: dir,
          threadId: 'thread-bound',
        },
      ],
    },
    join(dir, 'config.json'),
  );
  // Use ephemeral port 0 by overriding directly on resolved config
  config.bridge.port = 0;

  const acceptedEvents: string[] = [];
  const runtime = await createBridgeRuntime(
    config,
    { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
    {
      attachFileLogger: false,
      checkT3Health: async () => true,
      onAccepted: async (event, _target, _binding, scope) => {
        acceptedEvents.push(`${scope}:${event.id}:${event.content}`);
      },
    },
  );

  assert.ok(runtime.server);
  const addr = runtime.server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Verify listen:false (used by --recover) works even while bridge server is running
    const recoverRuntime = await createBridgeRuntime(
      { ...config, bridge: { ...config.bridge, port: addr.port } },
      { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
      { attachFileLogger: false, listen: false },
    );
    assert.equal(recoverRuntime.server, null);
    await recoverRuntime.close();
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);

    const noAuth = await fetch(`${baseUrl}/events`, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 401);

    const unbound = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'msg-1', content: 'hello', author: { user_openid: 'STRANGER' } },
      }),
    });
    assert.equal(unbound.status, 403);

    const bound = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'msg-2', content: '测试中文', author: { user_openid: 'BOUND_USER' } },
      }),
    });
    assert.equal(bound.status, 202);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(acceptedEvents, ['c2c:BOUND_USER:msg-2:测试中文']);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startTypingKeepalive fires immediately for C2C, refreshes on interval, skips group, and stops cleanly', async () => {
  const c2cCalls: number[] = [];
  const stopC2C = startTypingKeepalive(
    { scope: 'c2c', targetId: 'U1', msgId: 'M1' },
    async (_target, sec) => {
      c2cCalls.push(sec);
    },
    { durationSec: 60, intervalMs: 25 },
  );
  await new Promise(resolve => setTimeout(resolve, 65));
  stopC2C();
  const countAtStop = c2cCalls.length;
  assert.ok(countAtStop >= 2, `expected >=2 typing calls, got ${countAtStop}`);
  assert.equal(c2cCalls[0], 60);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(c2cCalls.length, countAtStop);

  let groupCalls = 0;
  const stopGroup = startTypingKeepalive(
    { scope: 'group', targetId: 'G1', msgId: 'M2' },
    async () => {
      groupCalls++;
    },
    { intervalMs: 20 },
  );
  await new Promise(resolve => setTimeout(resolve, 35));
  stopGroup();
  assert.equal(groupCalls, 0);
});

test('buildInboundMessageText preserves QQ voice ASR transcripts and falls back cleanly for audio-only turns', () => {
  assert.equal(
    buildInboundMessageText('', [{ url: 'https://qqbot.ugcimg.cn/a.wav', asr_refer_text: '你好呀' }], [
      { mimeType: 'audio/wav' },
    ]),
    '[语音转写参考] 你好呀',
  );
  assert.equal(
    buildInboundMessageText('附言', [{ url: 'https://qqbot.ugcimg.cn/a.wav', asr_refer_text: '第一段' }], [
      { mimeType: 'audio/wav' },
    ]),
    '附言\n\n[语音转写参考] 第一段',
  );
  assert.equal(
    buildInboundMessageText('', [{ url: 'https://qqbot.ugcimg.cn/a.wav' }], [{ mimeType: 'audio/wav' }]),
    '[语音消息]',
  );
  assert.equal(
    buildInboundMessageText('', [{ url: 'https://multimedia.nt.qq.com.cn/a.png' }], [{ mimeType: 'image/png' }]),
    '',
  );
});
