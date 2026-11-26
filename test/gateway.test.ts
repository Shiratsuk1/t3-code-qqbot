import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInboundPayload, MSG_TYPE_QUOTE } from '../src/gateway.ts';

test('extractInboundPayload normalizes URLs, preserves voice fallback + ASR, and strips command prefix', () => {
  const res = extractInboundPayload(
    {
      content: '  /ai 帮我看下这段语音',
      attachments: [
        {
          url: 'multimedia.nt.qq.com/raw.silk',
          voice_wav_url: '//qqbot.ugcimg.cn/transcoded.wav',
          content_type: 'voice',
          filename: 'voice.silk',
          asr_refer_text: '请检查日志',
        },
      ],
    },
    '/ai',
  );
  assert.equal(res.content, '帮我看下这段语音');
  assert.equal(res.attachments.length, 1);
  assert.equal(res.attachments[0].url, 'https://qqbot.ugcimg.cn/transcoded.wav');
  assert.equal(res.attachments[0].fallback_url, 'https://multimedia.nt.qq.com/raw.silk');
  assert.equal(res.attachments[0].asr_refer_text, '请检查日志');
  assert.equal(res.quote, undefined);
});

test('extractInboundPayload does NOT re-download quoted attachments on quote-reply messages (msgType=103)', () => {
  const res = extractInboundPayload({
    content: '把刚才那个视频前 5 秒剪掉',
    msgType: MSG_TYPE_QUOTE,
    attachments: [],
    msgElements: [
      {
        content: '原视频发这里了',
        attachments: [
          {
            url: 'https://video.nt.qq.com/expired-old-video.mp4',
            content_type: 'video/mp4',
            filename: 'speech.mp4',
          },
        ],
      },
    ],
  });
  assert.equal(res.content, '把刚才那个视频前 5 秒剪掉');
  assert.equal(res.attachments.length, 0);
  assert.deepEqual(res.quote, {
    text: '原视频发这里了',
    attachmentSummary: '[视频: speech.mp4]',
  });
});

test('extractInboundPayload merges msgElements attachments for non-quote messages and deduplicates by URL', () => {
  const res = extractInboundPayload({
    content: '',
    msgType: 0,
    attachments: [{ url: 'https://video.nt.qq.com/a.mp4', content_type: 'video/mp4', filename: 'a.mp4' }],
    msgElements: [
      {
        attachments: [
          { url: 'https://video.nt.qq.com/a.mp4', content_type: 'video/mp4', filename: 'a.mp4' },
          { url: 'https://video.nt.qq.com/b.mp4', content_type: 'video/mp4', filename: 'b.mp4', size: 25_000_000 },
        ],
      },
    ],
  });
  assert.equal(res.attachments.length, 2);
  assert.equal(res.attachments[1].size, 25_000_000);
});
