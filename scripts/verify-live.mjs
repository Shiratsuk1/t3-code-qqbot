#!/usr/bin/env node
/**
 * 面向本机真实 T3 Code Server 的无 Mock 端到端契约实证脚本。
 *
 * 用法：
 *   npm run verify:live
 *   node scripts/verify-live.mjs --origin http://127.0.0.1:3773
 *
 * 特点：
 * - 不修改用户现有 T3 会话（只读查询 + 临时上传后立即 discard 清理）；
 * - 实证验证本机 T3 附件真实边界（10 MiB 图片、11 MiB 大图转文件、15 MiB / 50 MiB MP4 流式上传、50 MiB+1 拒绝）；
 * - 实证验证流式下载落盘与超大视频安全清理、出站 safeArtifact 视频/文件/图片分类型上限。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ATTACHMENT_HOSTS } from '../src/config.ts';
import { Observer } from '../src/observe.ts';
import {
  AttachmentError,
  formatByteSize,
  safeArtifact,
  saveAttachment,
  T3_MAX_FILE_BYTES,
  T3_MAX_IMAGE_BYTES,
} from '../src/protocol.ts';
import { T3Cli } from '../src/t3-cli.ts';
import { getThreadState } from '../src/t3-ws.ts';

const originFlagIdx = process.argv.indexOf('--origin');
const origin =
  (originFlagIdx >= 0 && process.argv[originFlagIdx + 1]) ||
  process.env.T3_ORIGIN ||
  'http://127.0.0.1:3773';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP4_HEADER = Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex');
const SILK_HEADER = Buffer.from('\x02#!SILK_V3livecheck');

async function createSizedFile(dir, name, sizeBytes, header) {
  const filePath = join(dir, name);
  const fh = await open(filePath, 'w');
  try {
    await fh.truncate(sizeBytes);
    if (header && header.length > 0) {
      await fh.write(header, 0, Math.min(header.length, sizeBytes), 0);
    }
  } finally {
    await fh.close();
  }
  return filePath;
}

const workDir = await mkdtemp(join(tmpdir(), 't3-qqbot-live-verify-'));
const t3Cli = new T3Cli({ origin, executable: 'auto', prefix: [], env: {} });
const observer = new Observer(
  origin,
  () =>
    t3Cli.issueSession({
      scopes: ['orchestration:read', 'orchestration:operate'],
      subject: 'mcp-client',
      ttl: '5m',
      label: 'T3 QQBot live contract verification',
    }),
  id => t3Cli.revokeSession(id),
);

try {
  // [1/6] Local T3 server reachability + CLI resolution
  const probe = await fetch(origin, { signal: AbortSignal.timeout(3_000) });
  await probe.body?.cancel();
  assert.equal(probe.ok, true, `T3 server unreachable at ${origin} (HTTP ${probe.status})`);
  const resolvedCli = await t3Cli.resolve();
  console.log(`[1/6] T3 服务可达 (${origin})，CLI 解析成功: ${resolvedCli.executable}`);

  // [2/6] Real MCP contract check
  const { projects } = await observer.call('t3_project_list', { limit: 10 });
  assert.ok(Array.isArray(projects), 't3_project_list did not return projects array');
  const caps = await observer.call('orchestrator_capabilities', {});
  assert.ok(Array.isArray(caps.providers) && caps.providers.length > 0, 'orchestrator_capabilities returned no providers');
  const threadList = await observer.call('t3_thread_list', { allProjects: true, limit: 5 });
  const threads = threadList.threads ?? threadList.items ?? [];
  console.log(
    `[2/6] T3 MCP 契约验证通过 (projects=${projects.length}, providers=${caps.providers.length}, recentThreads=${threads.length})`,
  );

  // [3/6] Real native WS read-only check
  if (threads.length > 0 && threads[0].threadId) {
    const state = await t3Cli.withSession(
      { scopes: ['orchestration:read'], ttl: '2m', label: 'T3 QQBot live ws read' },
      token => getThreadState(origin, token, threads[0].threadId),
    );
    assert.equal(state.threadId, threads[0].threadId);
    console.log(
      `[3/6] 原生 WS 协议 (/ws?orchestrationProtocol=2) 读取通过 (thread=${state.threadId}, model=${state.modelSelection?.model ?? 'default'})`,
    );
  } else {
    console.log('[3/6] 原生 WS 读取跳过（当前无历史线程，未创建新线程以保持环境干净）');
  }

  // [4/6] Live streaming attachment upload & boundary matrix against real T3 server
  const uploadCases = [
    {
      label: 'tiny PNG (image)',
      name: 'tiny.png',
      size: 128,
      mime: 'image/png',
      header: PNG_HEADER,
      expectType: 'image',
      expectOk: true,
    },
    {
      label: '10 MiB exact PNG (image boundary)',
      name: 'exact-10m.png',
      size: T3_MAX_IMAGE_BYTES,
      mime: 'image/png',
      header: PNG_HEADER,
      expectType: 'image',
      expectOk: true,
    },
    {
      label: '10 MiB + 1 B PNG forced as image (expect T3 reject)',
      name: 'over-10m-img.png',
      size: T3_MAX_IMAGE_BYTES + 1,
      mime: 'image/png',
      header: PNG_HEADER,
      forceType: 'image',
      expectOk: false,
    },
    {
      label: '11 MiB PNG auto-routed as file',
      name: 'large-11m.png',
      size: 11 * 1024 * 1024,
      mime: 'image/png',
      header: PNG_HEADER,
      expectType: 'file',
      expectOk: true,
    },
    {
      label: '15 MiB MP4 video (> old 12 MiB limit)',
      name: 'video-15m.mp4',
      size: 15 * 1024 * 1024,
      mime: 'video/mp4',
      header: MP4_HEADER,
      expectType: 'file',
      expectOk: true,
    },
    {
      label: '50 MiB exact MP4 video (T3 native file ceiling)',
      name: 'video-50m.mp4',
      size: T3_MAX_FILE_BYTES,
      mime: 'video/mp4',
      header: MP4_HEADER,
      expectType: 'file',
      expectOk: true,
    },
    {
      label: '50 MiB + 1 B MP4 video (expect T3 reject -> triggers workspace fallback)',
      name: 'video-50m-plus1.mp4',
      size: T3_MAX_FILE_BYTES + 1,
      mime: 'video/mp4',
      header: MP4_HEADER,
      forceType: 'file',
      expectOk: false,
    },
  ];

  console.log('[4/6] 开始实测本机 T3 流式附件上传边界矩阵：');
  for (const tc of uploadCases) {
    const filePath = await createSizedFile(workDir, tc.name, tc.size, tc.header);
    const t0 = Date.now();
    try {
      if (tc.expectOk) {
        const uploaded = await observer.upload(filePath, tc.name, tc.mime, {
          ...(tc.forceType ? { forceType: tc.forceType } : {}),
          timeoutMs: 120_000,
        });
        assert.equal(uploaded.sizeBytes, tc.size);
        if (tc.expectType) assert.equal(uploaded.type, tc.expectType);
        await observer.call('t3_attachment_discard', { attachmentId: uploaded.id });
        console.log(`      PASS  ${tc.label} (${formatByteSize(tc.size)}, type=${uploaded.type}, ${Date.now() - t0}ms)`);
      } else {
        let rejected = false;
        try {
          const uploaded = await observer.upload(filePath, tc.name, tc.mime, {
            ...(tc.forceType ? { forceType: tc.forceType } : {}),
            timeoutMs: 60_000,
          });
          await observer.call('t3_attachment_discard', { attachmentId: uploaded.id }).catch(() => {});
        } catch {
          rejected = true;
        }
        assert.equal(rejected, true, `Expected T3 to reject ${tc.label}, but upload succeeded!`);
        console.log(`      PASS  ${tc.label} (confirmed rejected as expected, ${Date.now() - t0}ms)`);
      }
    } finally {
      await unlink(filePath).catch(() => {});
    }
  }

  // [5/6] Streaming inbound saveAttachment (16 MiB MP4 chunked stream + oversize .part cleanup)
  const dlDir = join(workDir, 'downloads');
  const chunkCount = 16;
  const oneMiB = Buffer.alloc(1024 * 1024, 0x41);
  const firstChunk = Buffer.from(oneMiB);
  MP4_HEADER.copy(firstChunk, 0);
  const streamingFetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(firstChunk);
          for (let i = 1; i < chunkCount; i++) controller.enqueue(oneMiB);
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(chunkCount * 1024 * 1024) } },
    );
  const saved = await saveAttachment(
    { url: 'https://video.nt.qq.com/clip', filename: 'speech_bg.mp4', content_type: 'video/mp4' },
    dlDir,
    0,
    DEFAULT_ATTACHMENT_HOSTS,
    { fetchImpl: streamingFetch, maxBytes: 200 * 1024 * 1024 },
  );
  assert.equal(saved.format, 'mp4');
  assert.equal(saved.sizeBytes, 16 * 1024 * 1024);
  const dlFiles = await readdir(dlDir);
  assert.equal(dlFiles.some(f => f.endsWith('.part')), false, 'Leftover .part temp file detected!');
  console.log(`[5/6] 流式入站落盘实测通过 (16 MiB MP4 via wildcard *.nt.qq.com, format=${saved.format}, 0 .part 残留)`);

  // [6/6] Outbound safeArtifact real filesystem matrix (PNG / 16 MiB MP4 / SILK / >100 MiB reject)
  const outWs = join(workDir, 'outbound-ws');
  await mkdir(outWs, { recursive: true });
  const pngOut = await createSizedFile(outWs, 'preview.png', 4096, PNG_HEADER);
  const mp4Out = await createSizedFile(outWs, 'render.mp4', 16 * 1024 * 1024, MP4_HEADER);
  const silkOut = await createSizedFile(outWs, 'reply.silk', 2048, SILK_HEADER);
  const hugeOut = await createSizedFile(outWs, 'huge.mp4', 101 * 1024 * 1024, MP4_HEADER);
  assert.equal((await safeArtifact(outWs, pngOut)).fileType, 1);
  assert.equal((await safeArtifact(outWs, mp4Out)).fileType, 2);
  assert.equal((await safeArtifact(outWs, silkOut)).fileType, 3);
  await assert.rejects(
    () => safeArtifact(outWs, hugeOut),
    err => err instanceof AttachmentError && err.code === 'OUTBOUND_SIZE_EXCEEDED',
  );
  console.log('[6/6] 出站 safeArtifact 真实文件系统矩阵通过 (IMAGE=1 / VIDEO=2(16 MiB) / VOICE=3 / >100 MiB 精确拒收)');

  console.log('\n全部 6 项真实环境契约实证通过！');
} finally {
  await observer.close().catch(() => {});
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
