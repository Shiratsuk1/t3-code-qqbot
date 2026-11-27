import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError, StreamInputState } from '@tencent-connect/qqbot-nodejs';
import type { StreamMessageRequest } from '@tencent-connect/qqbot-nodejs/protocol';
import {
  buildInboundMessageText,
  createBridgeRuntime,
  formatUserFacingBridgeError,
  startTypingKeepalive,
} from '../src/bridge.ts';
import { parseConfig } from '../src/config.ts';
import { AttachmentError } from '../src/protocol.ts';

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
  const withFallback = buildInboundMessageText(
    '请剪辑前 10 秒',
    [{ url: 'https://video.nt.qq.com/big.mp4' }],
    [],
    [
      {
        path: 'C:\\ws\\attachments\\k\\0-abc.mp4',
        fileName: 'speech.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 75 * 1024 * 1024,
        reason: 'exceeds 50 MiB',
      },
    ],
    { text: '旧消息文本', attachmentSummary: '[视频: old.mp4]' },
  );
  assert.match(withFallback, /\[引用消息\] 旧消息文本 \[视频: old\.mp4\]/);
  assert.match(withFallback, /请剪辑前 10 秒/);
  assert.match(withFallback, /speech\.mp4 \(75 MiB, video\/mp4\): C:\\ws\\attachments\\k\\0-abc\.mp4/);
});

test('formatUserFacingBridgeError surfaces actionable Chinese reasons for every attachment & T3 failure mode', () => {
  const sizeErr = new AttachmentError('SIZE_EXCEEDED', 'too big', {
    fileName: 'speech.mp4',
    sizeBytes: 250 * 1024 * 1024,
    maxBytes: 200 * 1024 * 1024,
  });
  assert.match(formatUserFacingBridgeError(sizeErr), /speech\.mp4.*250 MiB.*200 MiB/);

  const hostErr = new AttachmentError('HOST_NOT_ALLOWED', 'bad host', { host: 'cdn.example.net' });
  assert.match(formatUserFacingBridgeError(hostErr), /cdn\.example\.net.*attachmentHosts/);

  const timeoutErr = new AttachmentError('DOWNLOAD_TIMEOUT', 'stalled', { fileName: 'clip.mp4', timeoutMs: 30_000 });
  assert.match(formatUserFacingBridgeError(timeoutErr), /clip\.mp4.*30 秒/);

  const httpErr = new AttachmentError('DOWNLOAD_HTTP', '403', { status: 403 });
  assert.match(formatUserFacingBridgeError(httpErr), /HTTP 403/);

  const connErr = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3773');
  assert.match(formatUserFacingBridgeError(connErr), /无法连接本地 T3 Code/);
});

test('observeRun sanitizes T3 internal links in C2C stream and completes in 1 bubble with 0 fallback sendText calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-stream-ok-'));
  const config = parseConfig(
    {
      stateDir: join(dir, 'state'),
      t3: { origin: 'http://127.0.0.1:3773' },
      bridge: { host: '127.0.0.1', port: 18999 },
      bindings: [],
    },
    join(dir, 'config.json'),
  );

  const streamFrames: StreamMessageRequest[] = [];
  const fallbackTexts: string[] = [];

  const runtime = await createBridgeRuntime(
    config,
    { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
    {
      listen: false,
      attachFileLogger: false,
      withReadSession: fn => fn('test-token'),
      sendC2CStreamMessage: async (_creds, _openid, req) => {
        streamFrames.push({ ...req });
        return { id: req.stream_msg_id ?? 'stream-bubble-1', timestamp: Date.now() };
      },
      sendText: async (_reply, text) => {
        fallbackTexts.push(text);
        return { id: 'plain-1' };
      },
      readReplyImpl: async (_origin, _token, _threadId, _runId, opts = {}) => {
        const now = new Date().toISOString();
        opts.onUpdate?.({
          id: 'item-1',
          text: '请看 [hi](t3-thread://v2/demo-thread-001',
          updatedAt: now,
        });
        await new Promise(resolve => setTimeout(resolve, 15));
        const finalText = '请看 [hi](t3-thread://v2/demo-thread-001/mcp:123)，已完成。';
        await opts.onMessage?.({
          id: 'item-1',
          text: finalText,
          updatedAt: now,
        });
        return {
          body: finalText,
          status: 'completed',
          completedAt: now,
          lastBodyAt: Date.now(),
          backgroundTaskIds: [],
        };
      },
    },
  );

  try {
    await runtime.observeRun(
      'key-stream-ok',
      { scope: 'c2c', targetId: 'USER_1', msgId: 'MSG_1' },
      'thread-1',
      'run-1',
      0,
      true,
    );

    assert.equal(fallbackTexts.length, 0);
    assert.ok(streamFrames.length >= 2, `expected >= 2 stream frames, got ${streamFrames.length}`);
    for (const frame of streamFrames) {
      assert.doesNotMatch(frame.content_raw, /t3-thread:\/\//);
      assert.match(frame.content_raw, /「hi」/);
    }
    const first = streamFrames[0];
    const last = streamFrames[streamFrames.length - 1];
    assert.equal(first.input_state, StreamInputState.GENERATING);
    assert.equal(first.index, 0);
    assert.equal(last.input_state, StreamInputState.DONE);
    assert.equal(last.stream_msg_id, 'stream-bubble-1');
    assert.equal(last.msg_seq, first.msg_seq);
    assert.equal(last.content_raw, '请看 「hi」，已完成。');
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('observeRun logs structured ApiError details on complete() failure and supports orphan-bubble DONE recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-stream-err-'));
  const config = parseConfig(
    {
      stateDir: join(dir, 'state'),
      t3: { origin: 'http://127.0.0.1:3773' },
      bridge: { host: '127.0.0.1', port: 18999 },
      bindings: [],
    },
    join(dir, 'config.json'),
  );

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  // Case 1: complete() fails with ApiError and no Markdown links to strip -> logs httpStatus/bizCode/bizMessage and falls back to sendText
  const fallbackTexts1: string[] = [];
  const runtime1 = await createBridgeRuntime(
    config,
    { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
    {
      listen: false,
      attachFileLogger: false,
      withReadSession: fn => fn('test-token'),
      sendC2CStreamMessage: async (_creds, _openid, req) => {
        if (req.input_state === StreamInputState.DONE) {
          throw new ApiError(
            'stream done rejected',
            400,
            '/v2/users/USER_1/stream_messages',
            304003,
            'content rejected by platform',
          );
        }
        return { id: 'stream-bubble-err-1', timestamp: Date.now() };
      },
      sendText: async (_reply, text) => {
        fallbackTexts1.push(text);
        return { id: 'plain-fallback-1' };
      },
      readReplyImpl: async (_origin, _token, _threadId, _runId, opts = {}) => {
        const now = new Date().toISOString();
        opts.onUpdate?.({ id: 'item-err-1', text: '开头内容', updatedAt: now });
        await new Promise(resolve => setTimeout(resolve, 15));
        await opts.onMessage?.({ id: 'item-err-1', text: '完整纯文本回复', updatedAt: now });
        return {
          body: '完整纯文本回复',
          status: 'completed',
          completedAt: now,
          lastBodyAt: Date.now(),
          backgroundTaskIds: [],
        };
      },
    },
  );

  // Case 2: complete() fails on unwhitelisted https link while live bubble exists -> recovery DONE strips link and avoids fallback sendText
  const recoveryFrames: StreamMessageRequest[] = [];
  const fallbackTexts2: string[] = [];
  const runtime2 = await createBridgeRuntime(
    config,
    { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
    {
      listen: false,
      attachFileLogger: false,
      withReadSession: fn => fn('test-token'),
      sendC2CStreamMessage: async (_creds, _openid, req) => {
        recoveryFrames.push({ ...req });
        if (req.input_state === StreamInputState.DONE && req.content_raw.includes('https://')) {
          throw new ApiError(
            'url not in whitelist',
            400,
            '/v2/users/USER_2/stream_messages',
            304003,
            'unwhitelisted url',
          );
        }
        return { id: req.stream_msg_id ?? 'stream-bubble-rec-2', timestamp: Date.now() };
      },
      sendText: async (_reply, text) => {
        fallbackTexts2.push(text);
        return { id: 'plain-fallback-2' };
      },
      readReplyImpl: async (_origin, _token, _threadId, _runId, opts = {}) => {
        const now = new Date().toISOString();
        opts.onUpdate?.({ id: 'item-rec-2', text: '正在检索...', updatedAt: now });
        await new Promise(resolve => setTimeout(resolve, 15));
        const finalText = '详情见 [参考文档](https://unwhitelisted.example.com/guide)。';
        await opts.onMessage?.({ id: 'item-rec-2', text: finalText, updatedAt: now });
        return {
          body: finalText,
          status: 'completed',
          completedAt: now,
          lastBodyAt: Date.now(),
          backgroundTaskIds: [],
        };
      },
    },
  );

  try {
    await runtime1.observeRun(
      'key-err-1',
      { scope: 'c2c', targetId: 'USER_1', msgId: 'MSG_ERR_1' },
      'thread-1',
      'run-err-1',
      0,
      true,
    );
    assert.deepEqual(fallbackTexts1, ['完整纯文本回复']);
    const completionWarn = warnings.find(
      line => line.includes('key-err-1') && line.includes('run-err-1') && line.includes('httpStatus=400'),
    );
    assert.ok(completionWarn, `expected structured ApiError warning, got:\n${warnings.join('\n')}`);
    assert.match(completionWarn, /bizCode=304003/);
    assert.match(completionWarn, /bizMessage="content rejected by platform"/);

    await runtime2.observeRun(
      'key-rec-2',
      { scope: 'c2c', targetId: 'USER_2', msgId: 'MSG_REC_2' },
      'thread-2',
      'run-rec-2',
      0,
      true,
    );
    assert.equal(fallbackTexts2.length, 0);
    assert.equal(recoveryFrames.length, 3);
    const [firstFrame, failedDone, recoveredDone] = recoveryFrames;
    assert.equal(failedDone.input_state, StreamInputState.DONE);
    assert.equal(recoveredDone.input_state, StreamInputState.DONE);
    assert.equal(recoveredDone.stream_msg_id, 'stream-bubble-rec-2');
    assert.equal(recoveredDone.msg_seq, firstFrame.msg_seq);
    assert.equal(recoveredDone.index, failedDone.index + 1);
    assert.equal(recoveredDone.content_raw, '详情见 「参考文档」。');
  } finally {
    console.warn = origWarn;
    await runtime1.close();
    await runtime2.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('observeRun skips streaming when bridge.enableStreaming is false and delivers sanitized text via sendText', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-stream-off-'));
  const config = parseConfig(
    {
      stateDir: join(dir, 'state'),
      t3: { origin: 'http://127.0.0.1:3773' },
      bridge: { host: '127.0.0.1', port: 18999, enableStreaming: false },
      bindings: [],
    },
    join(dir, 'config.json'),
  );

  let streamCalls = 0;
  const sentTexts: string[] = [];

  const runtime = await createBridgeRuntime(
    config,
    { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
    {
      listen: false,
      attachFileLogger: false,
      withReadSession: fn => fn('test-token'),
      sendC2CStreamMessage: async () => {
        streamCalls++;
        return { id: 'should-not-happen', timestamp: Date.now() };
      },
      sendText: async (_reply, text) => {
        sentTexts.push(text);
        return { id: 'plain-direct-1' };
      },
      readReplyImpl: async (_origin, _token, _threadId, _runId, opts = {}) => {
        const now = new Date().toISOString();
        opts.onUpdate?.({ id: 'item-off-1', text: '草稿 [hi](t3-thread://v2/a', updatedAt: now });
        const finalText = '结果：[hi](t3-thread://v2/a/mcp:9) 完成。';
        await opts.onMessage?.({ id: 'item-off-1', text: finalText, updatedAt: now });
        return {
          body: finalText,
          status: 'completed',
          completedAt: now,
          lastBodyAt: Date.now(),
          backgroundTaskIds: [],
        };
      },
    },
  );

  try {
    await runtime.observeRun(
      'key-off-1',
      { scope: 'c2c', targetId: 'USER_OFF', msgId: 'MSG_OFF_1' },
      'thread-off',
      'run-off-1',
      0,
      true,
    );
    assert.equal(streamCalls, 0);
    assert.deepEqual(sentTexts, ['结果：「hi」 完成。']);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('observeRun deduplicates repeated alternating live-bubble stream logger errors without flooding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-stream-dedup-'));
  const config = parseConfig(
    {
      stateDir: join(dir, 'state'),
      t3: { origin: 'http://127.0.0.1:3773' },
      bridge: { host: '127.0.0.1', port: 18999 },
      bindings: [],
    },
    join(dir, 'config.json'),
  );

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  let generatingFailures = 0;
  const runtime = await createBridgeRuntime(
    config,
    { appId: 'app-1', appSecret: 'sec-1', bridgeSecret: 'secret-token' },
    {
      listen: false,
      attachFileLogger: false,
      withReadSession: fn => fn('test-token'),
      sendC2CStreamMessage: async (_creds, _openid, req) => {
        if (req.index === 0) {
          return { id: 'stream-dedup-1', timestamp: Date.now() };
        }
        if (req.input_state === StreamInputState.GENERATING) {
          generatingFailures++;
          throw new ApiError(
            'transient stream failure',
            400,
            '/v2/users/USER_DEDUP/stream_messages',
            304003,
            'transient reject',
          );
        }
        return { id: req.stream_msg_id ?? 'stream-dedup-1', timestamp: Date.now() };
      },
      sendText: async () => ({ id: 'plain-unused' }),
      readReplyImpl: async (_origin, _token, _threadId, _runId, opts = {}) => {
        const now = new Date().toISOString();
        // Frame 0 succeeds immediately -> establishes live bubble
        opts.onUpdate?.({ id: 'item-dedup-1', text: '第一段', updatedAt: now });
        await new Promise(resolve => setTimeout(resolve, 20));
        // Triggers 1st throttled flush failure (~500ms) -> emits alternating flush failed + throttle flush error
        opts.onUpdate?.({ id: 'item-dedup-1', text: '第一段 第二段', updatedAt: now });
        await new Promise(resolve => setTimeout(resolve, 560));
        // Triggers 2nd throttled flush failure (~500ms) -> same two alternating error strings must be deduplicated
        opts.onUpdate?.({ id: 'item-dedup-1', text: '第一段 第二段 第三段', updatedAt: now });
        await new Promise(resolve => setTimeout(resolve, 560));
        // Triggers 3rd failure on immediate flush -> still deduplicated
        opts.onUpdate?.({ id: 'item-dedup-1', text: '第一段 第二段 第三段 第四段', updatedAt: now });
        await new Promise(resolve => setTimeout(resolve, 30));
        await opts.onMessage?.({ id: 'item-dedup-1', text: '最终完成内容', updatedAt: now });
        return {
          body: '最终完成内容',
          status: 'completed',
          completedAt: now,
          lastBodyAt: Date.now(),
          backgroundTaskIds: [],
        };
      },
    },
  );

  try {
    await runtime.observeRun(
      'key-dedup-1',
      { scope: 'c2c', targetId: 'USER_DEDUP', msgId: 'MSG_DEDUP_1' },
      'thread-dedup',
      'run-dedup-1',
      0,
      true,
    );
    assert.ok(generatingFailures >= 3, `expected >= 3 failed generating flushes, got ${generatingFailures}`);
    const streamErrLogs = warnings.filter(line => line.startsWith('QQ stream error key-dedup-1 run-dedup-1'));
    assert.equal(
      streamErrLogs.length,
      2,
      `expected exactly 2 deduplicated stream error logs (flush failed + throttle flush error), got ${streamErrLogs.length}:\n${streamErrLogs.join('\n')}`,
    );
  } finally {
    console.warn = origWarn;
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
