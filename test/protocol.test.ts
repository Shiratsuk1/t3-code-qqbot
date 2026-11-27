import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import {
  AttachmentError,
  detectExtension,
  digest,
  formatByteSize,
  formatQQApiError,
  isBlockedIpAddress,
  isHostAllowed,
  isT3NativeImageMime,
  isValidAttachmentHostPattern,
  mimeFromExtension,
  safeArtifact,
  sanitizeOutboundQQText,
  saveAttachment,
} from '../src/protocol.ts';

test('detectExtension sniffs image, audio, video, document, archive magic bytes and content-type hints', () => {
  assert.equal(detectExtension(Buffer.from('89504e470d0a1a0a0000', 'hex'), 'unknown'), 'png');
  assert.equal(detectExtension(Buffer.from('ffd8ffe000104a46', 'hex'), 'unknown'), 'jpg');
  assert.equal(detectExtension(Buffer.from('GIF89a\x01\x00'), 'unknown'), 'gif');
  assert.equal(detectExtension(Buffer.from('RIFF1234WEBP'), 'unknown'), 'webp');
  assert.equal(detectExtension(Buffer.from('RIFF1234WAVEfmt '), 'voice'), 'wav');
  assert.equal(detectExtension(Buffer.from('RIFF1234AVI LIST'), 'clip'), 'avi');
  assert.equal(detectExtension(Buffer.from('\x02#!SILK_V3abc'), 'voice'), 'silk');
  assert.equal(detectExtension(Buffer.from('#!AMR\nabc'), 'voice'), 'amr');
  assert.equal(detectExtension(Buffer.from('#!AMR-WB\nabc'), 'voice'), 'amr');
  assert.equal(detectExtension(Buffer.from('ID3\x03\x00\x00'), 'voice'), 'mp3');
  assert.equal(detectExtension(Buffer.from('OggS\x00\x02'), 'voice'), 'ogg');
  assert.equal(detectExtension(Buffer.from('fLaC\x00\x00'), 'voice'), 'flac');
  assert.equal(detectExtension(Buffer.from('000000186674797069736f6d', 'hex'), 'video'), 'mp4');
  assert.equal(detectExtension(Buffer.from('000000146674797071742020', 'hex'), 'video'), 'mov');
  assert.equal(detectExtension(Buffer.from('00000018667479704d344120', 'hex'), 'audio'), 'm4a');
  assert.equal(detectExtension(Buffer.from('1a45dfa301000000', 'hex'), 'movie'), 'mkv');
  assert.equal(detectExtension(Buffer.from('1a45dfa301000000', 'hex'), 'movie.webm'), 'webm');
  assert.equal(detectExtension(Buffer.from('%PDF-1.7\n'), 'unknown'), 'pdf');
  assert.equal(detectExtension(Buffer.from('504b030414000000', 'hex'), 'slides.pptx'), 'pptx');
  assert.equal(detectExtension(Buffer.from('504b030414000000', 'hex'), 'archive'), 'zip');
  assert.equal(detectExtension(Buffer.from('hello world'), 'report.pdf'), 'pdf');
  assert.equal(detectExtension(Buffer.from('hello world'), 'noext', 'video/mp4; codecs=avc1'), 'mp4');
  assert.equal(detectExtension(Buffer.from('hello world'), 'weird.ext!@#'), 'bin');
});

test('digest, formatByteSize, isT3NativeImageMime, and mimeFromExtension cover full media matrix', () => {
  assert.equal(digest(Buffer.from('hello', 'utf8')), digest('hello'));
  assert.equal(formatByteSize(512), '512 B');
  assert.equal(formatByteSize(15 * 1024 * 1024), '15 MiB');
  assert.equal(formatByteSize(15.5 * 1024 * 1024), '15.5 MiB');
  assert.equal(isT3NativeImageMime('image/png'), true);
  assert.equal(isT3NativeImageMime('image/bmp'), false);
  assert.equal(mimeFromExtension('photo.PNG'), 'image/png');
  assert.equal(mimeFromExtension('clip.mp4'), 'video/mp4');
  assert.equal(mimeFromExtension('clip.mov'), 'video/quicktime');
  assert.equal(mimeFromExtension('voice.wav'), 'audio/wav');
  assert.equal(mimeFromExtension('doc.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeFromExtension('doc.pdf'), 'application/pdf');
  assert.equal(mimeFromExtension('archive.unknown'), 'application/octet-stream');
});

test('attachment host pattern validation and wildcard matching block overly broad or loopback patterns', () => {
  assert.equal(isValidAttachmentHostPattern('multimedia.nt.qq.com'), true);
  assert.equal(isValidAttachmentHostPattern('*.nt.qq.com'), true);
  assert.equal(isValidAttachmentHostPattern('*.nt.qq.com.cn'), true);
  assert.equal(isValidAttachmentHostPattern('*.qpic.cn'), true);
  assert.equal(isValidAttachmentHostPattern('*'), false);
  assert.equal(isValidAttachmentHostPattern('*.com'), false);
  assert.equal(isValidAttachmentHostPattern('*.cn'), false);
  assert.equal(isValidAttachmentHostPattern('*.com.cn'), false);
  assert.equal(isValidAttachmentHostPattern('localhost'), false);
  assert.equal(isValidAttachmentHostPattern('127.0.0.1'), false);

  const allow = ['multimedia.nt.qq.com', '*.qpic.cn', '*.nt.qq.com.cn'];
  assert.equal(isHostAllowed('multimedia.nt.qq.com', allow), true);
  assert.equal(isHostAllowed('video.nt.qq.com.cn', allow), true);
  assert.equal(isHostAllowed('a.b.qpic.cn', allow), true);
  assert.equal(isHostAllowed('qpic.cn', allow), false);
  assert.equal(isHostAllowed('evil-qpic.cn', allow), false);
  assert.equal(isHostAllowed('127.0.0.1', allow), false);
});

test('safeArtifact maps image/video/voice/file types, enforces per-type limits, and blocks traversal and UNC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-art-'));
  const inside = join(dir, 'workspace');
  const outside = join(dir, 'outside.txt');
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, 'chart.png'), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(inside, 'clip.mp4'), Buffer.from([0, 0, 0, 0x18]));
  await writeFile(join(inside, 'voice.silk'), Buffer.from('#!SILK_V3x'));
  await writeFile(join(inside, 'report.pdf'), Buffer.from('%PDF-1.7'));
  await writeFile(join(inside, 'empty.png'), Buffer.alloc(0));
  const over20mVoice = join(inside, 'huge.silk');
  const fh = await open(over20mVoice, 'w');
  await fh.truncate(21 * 1024 * 1024);
  await fh.close();
  await writeFile(outside, 'secret');
  try {
    assert.equal((await safeArtifact(inside, 'chart.png')).fileType, 1);
    assert.equal((await safeArtifact(inside, 'clip.mp4')).fileType, 2);
    assert.equal((await safeArtifact(inside, 'voice.silk')).fileType, 3);
    assert.equal((await safeArtifact(inside, 'report.pdf')).fileType, 4);

    await assert.rejects(() => safeArtifact(inside, '../outside.txt'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, '../nonexistent-probe.txt'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, '\\\\evil.example.com\\share\\leak.png'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, '//evil.example.com/share/leak.png'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, 'empty.png'), /Invalid artifact size/);
    await assert.rejects(
      () => safeArtifact(inside, 'huge.silk'),
      err => err instanceof AttachmentError && err.code === 'OUTBOUND_SIZE_EXCEEDED',
    );
    await assert.rejects(
      () => safeArtifact(inside, 'report.pdf', { maxBytes: 4 }),
      err => err instanceof AttachmentError && err.code === 'OUTBOUND_SIZE_EXCEEDED',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveAttachment validates allowlist, streams >12 MiB files, fast-rejects Content-Length, and cleans up .part files', async () => {
  const hosts = new Set(['multimedia.nt.qq.com', 'qqbot.ugcimg.cn', '*.nt.qq.com']);
  await assert.rejects(
    () => saveAttachment({ url: 'http://multimedia.nt.qq.com/a.png' }, tmpdir(), 0, hosts),
    err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED' && /Unrecognized QQ attachment origin/.test(err.message),
  );
  await assert.rejects(
    () => saveAttachment({ url: 'https://evil.example.com/a.png' }, tmpdir(), 0, hosts),
    err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED',
  );

  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-dl-'));
  try {
    // 1. Redirect within allowlist + magic sniff
    const wavBytes = Buffer.from('RIFF1234WAVEfmt 0000');
    const allowlistedRedirectFetch: typeof fetch = async input => {
      const target = String(input);
      if (target === 'https://qqbot.ugcimg.cn/voice/initial') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://video.nt.qq.com/voice/final' },
        });
      }
      return new Response(wavBytes, { status: 200 });
    };
    const saved = await saveAttachment(
      { url: 'qqbot.ugcimg.cn/voice/initial', filename: 'voice' },
      dir,
      0,
      hosts,
      allowlistedRedirectFetch,
    );
    assert.equal(saved.format, 'wav');
    assert.equal(saved.sizeBytes, wavBytes.length);

    // 2. Evil redirect rejected
    const evilRedirectFetch: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal.wav' } });
    await assert.rejects(
      () => saveAttachment({ url: 'https://qqbot.ugcimg.cn/voice/bad' }, dir, 1, hosts, evilRedirectFetch),
      err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED',
    );

    // 3. Fast Content-Length oversize rejection
    const declaredHugeFetch: typeof fetch = async () =>
      new Response('tiny', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } });
    await assert.rejects(
      () =>
        saveAttachment({ url: 'https://video.nt.qq.com/huge.mp4', filename: 'huge.mp4' }, dir, 2, hosts, {
          fetchImpl: declaredHugeFetch,
          maxBytes: 10 * 1024 * 1024,
        }),
      err => err instanceof AttachmentError && err.code === 'SIZE_EXCEEDED' && err.details.sizeBytes === 500 * 1024 * 1024,
    );

    // 4. Mid-stream oversize rejection cleans up temp .part file
    const midStreamOversizeFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.alloc(4096, 1));
            controller.enqueue(Buffer.alloc(4096, 2));
            controller.close();
          },
        }),
        { status: 200 },
      );
    await assert.rejects(
      () =>
        saveAttachment({ url: 'https://video.nt.qq.com/over.mp4', filename: 'over.mp4' }, dir, 3, hosts, {
          fetchImpl: midStreamOversizeFetch,
          maxBytes: 5000,
        }),
      err => err instanceof AttachmentError && err.code === 'SIZE_EXCEEDED',
    );

    // 5. Idle timeout during stalled body cleans up temp .part file
    const stalledFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('000000186674797069736f6d', 'hex'));
            // Never close or enqueue another chunk
          },
        }),
        { status: 200 },
      );
    await assert.rejects(
      () =>
        saveAttachment({ url: 'https://video.nt.qq.com/stall.mp4', filename: 'stall.mp4' }, dir, 4, hosts, {
          fetchImpl: stalledFetch,
          idleTimeoutMs: 60,
          totalTimeoutMs: 500,
        }),
      err => err instanceof AttachmentError && err.code === 'DOWNLOAD_TIMEOUT',
    );

  const remaining = await readdir(dir);
    assert.equal(
      remaining.some(f => f.endsWith('.part')),
      false,
      `Expected zero leftover .part files, found: ${remaining.join(', ')}`,
    );

    // 6. Default open public HTTPS mode (empty allowlist) allows any public Tencent CDN like grouptalk.c2c.qq.com
    //    while still blocking HTTP, localhost, IP literals, non-default ports, and private-IP DNS SSRF (yet permitting Clash 198.18.x.x Fake-IP)
    assert.equal(isBlockedIpAddress('127.0.0.1'), true);
    assert.equal(isBlockedIpAddress('10.0.0.5'), true);
    assert.equal(isBlockedIpAddress('172.16.0.1'), true);
    assert.equal(isBlockedIpAddress('192.168.31.1'), true);
    assert.equal(isBlockedIpAddress('169.254.169.254'), true);
    assert.equal(isBlockedIpAddress('100.64.0.1'), true);
    assert.equal(isBlockedIpAddress('::1'), true);
    assert.equal(isBlockedIpAddress('::ffff:127.0.0.1'), true);
    assert.equal(isBlockedIpAddress('fc00::1'), true);
    assert.equal(isBlockedIpAddress('fe80::1'), true);
    assert.equal(isBlockedIpAddress('198.18.0.5'), false); // Clash/Mihomo TUN Fake-IP
    assert.equal(isBlockedIpAddress('183.3.226.35'), false); // Public IP

    const docxBytes = Buffer.concat([Buffer.from('504b030414000000', 'hex'), Buffer.from('docx-content')]);
    const okDocx = await saveAttachment(
      { url: 'https://grouptalk.c2c.qq.com/download?file=1', filename: '演讲稿.docx' },
      dir,
      5,
      [],
      {
        fetchImpl: async () => new Response(docxBytes, { status: 200 }),
        lookupImpl: async () => [{ address: '183.3.226.35' }],
      },
    );
    assert.equal(okDocx.format, 'docx');
    assert.equal(okDocx.fileName, '演讲稿.docx');

    await assert.rejects(
      () =>
        saveAttachment({ url: 'https://rebind.example.com/secret' }, dir, 6, [], {
          fetchImpl: async () => new Response('nope', { status: 200 }),
          lookupImpl: async () => [{ address: '169.254.169.254' }],
        }),
      err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED' && /private\/loopback/.test(err.message),
    );
    await assert.rejects(
      () => saveAttachment({ url: 'https://127.0.0.1/secret' }, dir, 7, []),
      err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED',
    );
    await assert.rejects(
      () => saveAttachment({ url: 'https://localhost/secret' }, dir, 8, []),
      err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED',
    );
    await assert.rejects(
      () => saveAttachment({ url: 'http://grouptalk.c2c.qq.com/plain' }, dir, 9, []),
      err => err instanceof AttachmentError && err.code === 'HOST_NOT_ALLOWED',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sanitizeOutboundQQText rewrites non-public Markdown links, avoids double brackets, preserves http(s) and code', () => {
  assert.equal(
    sanitizeOutboundQQText('已定位到 [示例会话](t3-thread://v2/demo-thread-001/mcp:98765)，请查收。'),
    '已定位到 「示例会话」，请查收。',
  );
  // Avoid double wrapping when label already has 「...」
  assert.equal(
    sanitizeOutboundQQText('查看 [「示例会话」](t3-thread://v2/demo-thread-001/mcp:1) 与 [ 「备忘」 ](file:///C:/a.md)'),
    '查看 「示例会话」 与 「备忘」',
  );
  // Empty/whitespace labels dropped cleanly
  assert.equal(
    sanitizeOutboundQQText('前[](t3-thread://v2/abc)中[   ](file:///a.txt)后'),
    '前中后',
  );
  // All common non-public schemes
  assert.equal(
    sanitizeOutboundQQText(
      [
        '[notes.md](file:///C:/Users/demo/notes.md#L10-L20)',
        '[历史对话](conversation://00000000-0000-4000-8000-000000000001)',
        '[打开编辑器](vscode://file/C:/repo/a.ts:10)',
        '[发邮件](mailto:test@example.com)',
        '[拨号](tel:+86-10086)',
        '[脚本](javascript:void(0))',
        '[内联](data:text/plain;base64,SGVsbG8=)',
        '[下载](blob:https://example.com/uuid)',
      ].join(' / '),
    ),
    '「notes.md」 / 「历史对话」 / 「打开编辑器」 / 「发邮件」 / 「拨号」 / 「脚本」 / 「内联」 / 「下载」',
  );
  // Balanced parentheses in label and URL, angle brackets, optional titles, and spaces in file://
  assert.equal(
    sanitizeOutboundQQText(
      '[第1讲 (修订版)](t3-thread://v2/abc(1)/mcp:2) [说明](file:///C:/Program%20Files_(x86)/a.md) [空格路径](file:///C:/My Folder/a (1).md) [尖括号](<t3-thread://v2/abc>) [带提示](t3-thread://v2/abc "tip")',
    ),
    '「第1讲 (修订版)」 「说明」 「空格路径」 「尖括号」 「带提示」',
  );
  // Preserve valid http(s) links by default (including balanced parens), strip when stripAllMarkdownLinks=true
  const httpSample = '参考 [Wiki](https://en.wikipedia.org/wiki/C_(programming_language)) 和 [站点](http://example.com/docs)';
  assert.equal(sanitizeOutboundQQText(httpSample), httpSample);
  assert.equal(
    sanitizeOutboundQQText(httpSample, { stripAllMarkdownLinks: true }),
    '参考 「Wiki」 和 「站点」',
  );
  // Preserve prose / non-URI parenthesized expressions
  const prose = '[引用消息] 时间 12:30，[备注](note: see below)，数组 a[0] = (1 + 2)';
  assert.equal(sanitizeOutboundQQText(prose), prose);
  // Preserve fenced code blocks (``` and ~~~) and inline code spans untouched
  const withCode = [
    '正文 [hi](t3-thread://v2/1/mcp:2) 与 `[keep](t3-thread://v2/inline)` 及 `` `t3-thread://v2/double` ``。',
    '```markdown',
    '[inside-fence](t3-thread://v2/fence/mcp:3)',
    't3-thread://v2/bare-in-fence',
    '```',
    '~~~text',
    '[tilde-fence](file:///C:/secret.txt)',
    '~~~',
    '尾部 [done](conversation://xyz)。',
  ].join('\n');
  assert.equal(
    sanitizeOutboundQQText(withCode),
    [
      '正文 「hi」 与 `[keep](t3-thread://v2/inline)` 及 `` `t3-thread://v2/double` ``。',
      '```markdown',
      '[inside-fence](t3-thread://v2/fence/mcp:3)',
      't3-thread://v2/bare-in-fence',
      '```',
      '~~~text',
      '[tilde-fence](file:///C:/secret.txt)',
      '~~~',
      '尾部 「done」。',
    ].join('\n'),
  );
  // Trailing backslash before newline must not swallow opening code fence on next line
  const trailingBackslashBeforeFence = [
    '目录路径 C:\\demo\\',
    '```markdown',
    '[keep-in-fence](t3-thread://v2/demo-fence/mcp:1)',
    '```',
    '后续 [外部链接](t3-thread://v2/demo-after/mcp:2)',
  ].join('\n');
  assert.equal(
    sanitizeOutboundQQText(trailingBackslashBeforeFence),
    [
      '目录路径 C:\\demo\\',
      '```markdown',
      '[keep-in-fence](t3-thread://v2/demo-fence/mcp:1)',
      '```',
      '后续 「外部链接」',
    ].join('\n'),
  );
  // Unclosed stray backtick in paragraph 1 must not span across \n\n to suppress sanitizing paragraph 2
  const strayBacktickAcrossParagraphs = [
    '第一段包含一个未闭合反引号 ` 示例',
    '',
    '第二段包含 [示例会话](t3-thread://v2/demo-thread-002/mcp:7)',
    '',
    '第三段包含 `正常代码` 片段',
  ].join('\n');
  assert.equal(
    sanitizeOutboundQQText(strayBacktickAcrossParagraphs),
    [
      '第一段包含一个未闭合反引号 ` 示例',
      '',
      '第二段包含 「示例会话」',
      '',
      '第三段包含 `正常代码` 片段',
    ].join('\n'),
  );
  // stripAllMarkdownLinks still preserves code blocks and inline code
  assert.equal(
    sanitizeOutboundQQText('看 [文档](https://a.example) 和 `[文档](https://a.example)`', {
      stripAllMarkdownLinks: true,
    }),
    '看 「文档」 和 `[文档](https://a.example)`',
  );
});

test('sanitizeOutboundQQText handles streaming incomplete links and bare internal URIs with trailing punctuation', () => {
  // Streaming incomplete non-public links at end of buffer
  assert.equal(
    sanitizeOutboundQQText('正在整理 [示例会话](t3-thread://v2/demo-thread', { streaming: true }),
    '正在整理 「示例会话」',
  );
  assert.equal(
    sanitizeOutboundQQText('正在整理 [示例会话](t3-thread:', { streaming: true }),
    '正在整理 「示例会话」',
  );
  assert.equal(
    sanitizeOutboundQQText('正在整理 [「示例会话」](file:///C:/Users/demo', { streaming: true }),
    '正在整理 「示例会话」',
  );
  assert.equal(
    sanitizeOutboundQQText('正在整理 [](t3-thread://v2/demo-thread', { streaming: true }),
    '正在整理 ',
  );
  // Streaming incomplete https:// link is preserved when stripAllMarkdownLinks is false
  assert.equal(
    sanitizeOutboundQQText('正在整理 [官网](https://example.com/ab', { streaming: true }),
    '正在整理 [官网](https://example.com/ab',
  );
  // Bare internal URIs neutralized while keeping Chinese & ASCII trailing punctuation intact
  assert.equal(
    sanitizeOutboundQQText('请查看 t3-thread://v2/demo-thread-001/mcp:123。'),
    '请查看 「内部链接」。',
  );
  assert.equal(
    sanitizeOutboundQQText('（详见 conversation://abc-123），或参考 [file:///C:/a/b.ts] 与 (t3-thread://v2/xyz)。下一句'),
    '（详见 「内部链接」），或参考 [「内部链接」] 与 (「内部链接」)。下一句',
  );
  assert.equal(
    sanitizeOutboundQQText('请看(t3-thread://v2/abc)然后继续，以及 file:///C:/Program_Files_(x86)/app.exe。'),
    '请看(「内部链接」)然后继续，以及 「内部链接」。',
  );
  assert.equal(
    sanitizeOutboundQQText('尖括号 <t3-thread://v2/abc> 和正常链接 https://example.com/path。'),
    '尖括号 「内部链接」 和正常链接 https://example.com/path。',
  );
});

test('formatQQApiError extracts structured ApiError and generic error fields cleanly', () => {
  const apiErr = new ApiError(
    'API request failed',
    400,
    '/v2/users/U1/stream_messages',
    304003,
    'invalid markdown url',
  );
  const formatted = formatQQApiError(apiErr);
  assert.match(formatted, /httpStatus=400/);
  assert.match(formatted, /bizCode=304003/);
  assert.match(formatted, /bizMessage="invalid markdown url"/);
  assert.match(formatted, /path=\/v2\/users\/U1\/stream_messages/);
  assert.match(formatted, /message=API request failed/);

  const nodeErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const nodeFormatted = formatQQApiError(nodeErr);
  assert.match(nodeFormatted, /code=ECONNRESET/);
  assert.match(nodeFormatted, /message=socket hang up/);

  assert.equal(formatQQApiError(null), 'unknown error');
  assert.equal(formatQQApiError('plain failure'), 'plain failure');
});
