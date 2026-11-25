import { timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { QQBot, StreamInputState, StreamSession } from '@tencent-connect/qqbot-nodejs';
import { ApiClient, MessageApi } from '@tencent-connect/qqbot-nodejs/protocol';
import { findBindingForScope, isMainModule, loadConfig, loadCredentials, samePath } from './config.ts';
import { Observer } from './observe.ts';
import type { ProjectListItem } from './observe.ts';
import {
  copyStagedAttachment,
  digest,
  digestBuffer,
  MAX_ATTACHMENTS_PER_MESSAGE,
  mimeFromExtension,
  saveAttachment,
} from './protocol.ts';
import { T3Cli } from './t3-cli.ts';
import { dispatchMessage, readReply, TERMINAL_RUN_STATUSES } from './t3-ws.ts';
import type {
  Credentials,
  InboundEvent,
  NativeAttachment,
  PersistedRunRecord,
  ReplyAddress,
  ResolvedBinding,
  ResolvedPluginConfig,
  Target,
} from './types.ts';

class ReplyStreamApi extends MessageApi {
  readonly key: string;
  readonly runId: string;
  readonly itemId: string;
  readonly logTiming: (stage: string, key: string, runId: string, ...details: (string | number)[]) => void;
  hasLiveBubble = false;

  constructor(
    client: ApiClient,
    tokens: any,
    key: string,
    runId: string,
    itemId: string,
    logTiming: (stage: string, key: string, runId: string, ...details: (string | number)[]) => void,
  ) {
    super(client, tokens, { markdownSupport: false });
    this.key = key;
    this.runId = runId;
    this.itemId = itemId;
    this.logTiming = logTiming;
  }

  override async sendC2CStreamMessage(...args: Parameters<MessageApi['sendC2CStreamMessage']>) {
    const started = Date.now();
    const frame = args[2];
    if (frame.index === 0) this.logTiming('first_frame_send', this.key, this.runId, this.itemId);
    const response = await super.sendC2CStreamMessage(...args);
    if (response?.id) {
      this.hasLiveBubble = true;
      if (frame.index === 0) {
        this.logTiming('first_frame_ack', this.key, this.runId, this.itemId, Array.from(frame.content_raw).length);
      }
      if (frame.input_state === StreamInputState.DONE) {
        this.logTiming('final_frame_ack', this.key, this.runId, this.itemId, Array.from(frame.content_raw).length);
      }
    }
    if (frame.input_state === StreamInputState.DONE || frame.index === 0) {
      console.info(
        'QQ stream frame confirmed',
        frame.input_state === StreamInputState.DONE ? 'done' : 'first',
        'chars',
        Array.from(frame.content_raw).length,
        'ms',
        Date.now() - started,
      );
    }
    return response;
  }
}

export type BridgeRuntime = {
  server: Server | null;
  close: () => Promise<void>;
  observeRun: (
    key: string,
    reply: ReplyAddress,
    threadId: string,
    runId: string,
    sequence?: number,
    live?: boolean,
  ) => Promise<void>;
};

export async function createBridgeRuntime(
  config: ResolvedPluginConfig,
  credentials: Credentials,
  options: {
    listen?: boolean;
    attachFileLogger?: boolean;
    onAccepted?: (event: InboundEvent, target: Target, binding: ResolvedBinding, scope: string) => Promise<void>;
    checkT3Health?: () => Promise<boolean>;
  } = {},
): Promise<BridgeRuntime> {
  const root = resolve(config.stateDir);
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'bindings'), { recursive: true });

  const originalConsole: Partial<Record<'info' | 'warn' | 'error', (...args: unknown[]) => void>> = {};
  if (options.attachFileLogger !== false) {
    const logPath = join(root, 'bridge.log');
    for (const level of ['info', 'warn', 'error'] as const) {
      const original = console[level].bind(console);
      originalConsole[level] = console[level];
      console[level] = (...parts: unknown[]) => {
        try {
          appendFileSync(
            logPath,
            `${new Date().toISOString()} [${level.toUpperCase()}] ${parts.map(String).join(' ')}\n`,
            { mode: 0o600 },
          );
        } catch {
          // Ignore transient file logging errors
        }
        original(...parts);
      };
    }
  }

  const shutdownController = new AbortController();
  const qq = new QQBot({ appId: credentials.appId, appSecret: credentials.appSecret });
  const streamClient = new ApiClient({ defaultTimeoutMs: 10_000 });
  const sharedTokenManager = (qq as unknown as { tokenManager: unknown }).tokenManager;
  const t3Cli = new T3Cli(config.t3);
  const observer = new Observer(
    config.t3.origin,
    () =>
      t3Cli.issueSession({
        scopes: ['orchestration:read', 'orchestration:operate'],
        subject: 'mcp-client',
        ttl: '1h',
        label: 'T3 QQBot observer',
      }),
    sessionId => t3Cli.revokeSession(sessionId),
  );

  const expectedAuthDigest = digestBuffer(`Bearer ${credentials.bridgeSecret}`);
  const threadLocks = new Map<string, Promise<string>>();
  const timing = (stage: string, key: string, runId: string, ...details: (string | number)[]) =>
    console.info('QQ_T3_TIMING', stage, key, runId, Date.now(), ...details);

  async function resolveThreadForBinding(binding: ResolvedBinding, scope: string): Promise<string> {
    if (binding.threadId) return binding.threadId;
    const existingLock = threadLocks.get(binding.scopeHash);
    if (existingLock) return existingLock;

    const promise = (async () => {
      const bindingFile = join(root, 'bindings', `${binding.scopeHash}.thread`);
      const persisted = await readFile(bindingFile, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      if (persisted.trim()) return persisted.trim();

      const { projects } = await observer.call<{ projects: ProjectListItem[] }>('t3_project_list', { limit: 100 });
      const project = projects.find(row => samePath(row.workspaceRoot, binding.workspace));
      if (!project) {
        throw new Error(
          `Workspace "${binding.workspace}" is not registered in T3 Code. Open or add it as a T3 project first.`,
        );
      }
      const created = await observer.call<{ threadId: string }>('t3_thread_launch', {
        projectId: project.id,
        title: `QQ ${scope.startsWith('group:') ? 'Group' : 'Chat'} ${binding.scopeHash.slice(0, 8)}`,
        ...(binding.modelSelection ? { modelSelection: binding.modelSelection } : {}),
      });
      if (!created?.threadId) throw new Error('T3 did not return threadId when auto-creating a thread');
      await writeFile(bindingFile, created.threadId + '\n', { mode: 0o600 });
      console.info('Auto-created T3 thread for scope', `sha256:${binding.scopeHash.slice(0, 12)}`, created.threadId);
      return created.threadId;
    })();

    threadLocks.set(binding.scopeHash, promise);
    void promise.catch(() => threadLocks.delete(binding.scopeHash));
    return promise;
  }

  async function relayBackground(
    threadId: string,
    runId: string,
    taskIds: string[],
    reply: ReplyAddress,
  ): Promise<void> {
    const settled = await Promise.allSettled(
      taskIds.map(async itemId => {
        const receipt = join(root, digest(`bg\0${runId}\0${itemId}`) + '.delivered');
        const alreadySent = await readFile(receipt).then(
          () => true,
          error => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? false : Promise.reject(error)),
        );
        if (alreadySent) return '';

        for (let attempt = 0; attempt < 720; attempt++) {
          if (shutdownController.signal.aborted) return '';
          try {
            const item = (await observer.read(threadId, 'activity', itemId)).items.find(v => v.itemId === itemId);
            if (!item || item.type !== 'subagent' || item.runId !== runId) return '';
            if (TERMINAL_RUN_STATUSES.has(item.status)) {
              const summary = `${item.title ?? '后台任务'} · ${item.status}\n${item.text?.trim() ?? ''}`.trim();
              const target = config.bridge.proactiveBackgroundReports
                ? { scope: reply.scope, targetId: reply.targetId }
                : reply;
              const chars = Array.from(summary);
              const maxChars = config.bridge.maxMessageChars;
              for (let offset = 0; offset < chars.length; offset += maxChars) {
                await qq.sendText(target, chars.slice(offset, offset + maxChars).join(''));
              }
              await writeFile(receipt, '1', { mode: 0o600 });
              console.info('QQ background report delivered', runId, itemId);
              return summary;
            }
          } catch (error) {
            console.warn(
              'QQ background poll retry',
              runId,
              itemId,
              error instanceof Error ? error.message : String(error),
            );
          }
          await sleep(5000, undefined, { signal: shutdownController.signal }).catch(() => {});
        }
        throw new Error(`T3 background report observation expired (${itemId})`);
      }),
    );

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        console.error('QQ background task relay error', runId, outcome.reason?.message ?? String(outcome.reason));
      }
    }
  }

  async function observeRun(
    key: string,
    reply: ReplyAddress,
    threadId: string,
    runId: string,
    sequence?: number,
    live = true,
  ): Promise<void> {
    const maxChars = config.bridge.maxMessageChars;
    const streams = new Map<
      string,
      {
        session: StreamSession;
        api: ReplyStreamApi;
        failedBeforeLive: boolean;
        finishing: boolean;
        lastQueued: string;
      }
    >();
    const observedItems = new Set<string>();

    const markFirstText = (item: { id: string; text: string; updatedAt: string }) => {
      if (!live || observedItems.has(item.id)) return;
      observedItems.add(item.id);
      timing('first_text', key, runId, item.id, Date.parse(item.updatedAt), Array.from(item.text).length);
    };

    const updateStream = (item: { id: string; text: string; updatedAt: string }) => {
      markFirstText(item);
      if (reply.scope !== 'c2c' || !live) return;
      let stream = streams.get(item.id);
      if (!stream) {
        const api = new ReplyStreamApi(streamClient, sharedTokenManager, key, runId, item.id, timing);
        const session = new StreamSession(api, {
          openid: reply.targetId,
          msgId: reply.msgId,
          creds: { appId: credentials.appId, clientSecret: credentials.appSecret },
          logger: {
            info: () => {},
            error: () => {
              const current = streams.get(item.id);
              if (current && !current.finishing && !current.api.hasLiveBubble) {
                current.failedBeforeLive = true;
                current.session.cancel();
                console.info('QQ streaming unavailable before first frame, falling back to normal text', key, runId);
              }
            },
          },
        });
        stream = { session, api, failedBeforeLive: false, finishing: false, lastQueued: '' };
        streams.set(item.id, stream);
      }
      if (!stream.failedBeforeLive) {
        const clipped = Array.from(item.text).slice(0, maxChars).join('');
        if (clipped !== stream.lastQueued) {
          stream.lastQueued = clipped;
          void stream.session.update(clipped).catch(() => {});
        }
      }
    };

    const sendMessage = async (item: { id: string; text: string; updatedAt: string }) => {
      markFirstText(item);
      if (live) timing('text_completed', key, runId, item.id, Date.parse(item.updatedAt));
      const chars = Array.from(item.text);
      const sendStarted = Date.now();
      let sentCount = 0;
      const stream = streams.get(item.id);

      for (let offset = 0; offset < chars.length; offset += maxChars) {
        const receipt = join(root, digest(`${runId}\0${item.id}\0${offset}`) + '.delivered');
        const alreadySent = await readFile(receipt).then(
          () => true,
          error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          },
        );
        if (alreadySent) continue;

        const content = chars.slice(offset, offset + maxChars).join('');
        let sent: { id?: string } | undefined;
        if (offset === 0 && stream && !stream.failedBeforeLive) {
          stream.finishing = true;
          try {
            if (stream.lastQueued !== content) {
              stream.lastQueued = content;
              // Set pendingText without triggering an unnecessary duplicate GENERATING frame when possible
              (stream.session as unknown as { pendingText: string }).pendingText = content;
            }
            sent = await stream.session.complete();
          } catch {
            console.info('QQ stream completion failed, falling back to normal text', key, runId);
          }
        }
        sent = sent?.id ? sent : await qq.sendText(reply, content);
        if (!sent?.id) throw new Error('QQ did not confirm the text reply');
        await writeFile(receipt, sent.id, { mode: 0o600 });
        sentCount++;
      }

      if (sentCount) {
        console.info(
          'QQ text delivered',
          key,
          runId,
          'chars',
          chars.length,
          'QQ request ms',
          Date.now() - sendStarted,
          'last T3 body to QQ ms',
          Date.now() - Date.parse(item.updatedAt),
        );
      }
    };

    const result = await t3Cli
      .withSession({ scopes: ['orchestration:read'], ttl: '45m', label: 'T3 QQBot reply' }, token =>
        readReply(config.t3.origin, token, threadId, runId, {
          afterSequence: sequence,
          signal: shutdownController.signal,
          onMessage: async item => {
            try {
              await sendMessage(item);
            } catch (error) {
              console.error(
                'QQ reply delivery failed',
                key,
                runId,
                error instanceof Error ? error.message : 'unknown error',
              );
              throw error;
            }
          },
          onUpdate: updateStream,
          onTerminal: run => {
            if (live) timing('run_terminal', key, runId, run.status, run.completedAt ?? '-');
          },
        }),
      )
      .finally(() => {
        for (const stream of streams.values()) stream.session.cancel();
      });

    if (!result.body) {
      console.info('T3 finished without a text reply', key, runId, result.status);
      if (result.status !== 'completed') {
        await qq.sendText(reply, `T3 Code 本轮任务未完成（状态：${result.status}），请在 T3 Code 中查看详情。`).catch(
          () => {},
        );
      }
    }
    if (result.status === 'completed' && result.backgroundTaskIds.length) {
      void relayBackground(threadId, runId, result.backgroundTaskIds, reply).catch(error =>
        console.error('QQ background report failed', runId, error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async function relay(event: InboundEvent, target: Target, binding: ResolvedBinding, scope: string): Promise<void> {
    const key = digest(`${scope}\0${event.id}`);
    const reply: ReplyAddress = {
      scope: target.kind === 'users' ? 'c2c' : 'group',
      targetId: target.id,
      msgId: event.id,
    };
    const receipt = join(root, key + '.received');
    try {
      await writeFile(receipt, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }

    if (!event.content?.trim() && !event.attachments?.length) {
      await qq.sendText(reply, '请输入消息正文，或附上要发送的文件。');
      return;
    }

    const rawAttachments = event.attachments ?? [];
    if (rawAttachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      await unlink(receipt).catch(() => {});
      await qq.sendText(reply, `单条消息最多支持 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，请分批发送。`).catch(() => {});
      return;
    }

    const uploadedAttachments: NativeAttachment[] = [];
    let threadId: string;
    let accepted: { runId: string; sequence: number };
    try {
      const attachmentDir = join(binding.workspace, 'attachments', key);
      const allowedHosts = new Set(config.attachmentHosts);
      const files: { path: string }[] = [];
      for (let index = 0; index < rawAttachments.length; index++) {
        const item = rawAttachments[index];
        const saved =
          item.stagedName && config.bridge.testStaging
            ? await copyStagedAttachment(config.bridge.testStaging, item.stagedName, attachmentDir, index)
            : await saveAttachment(item, attachmentDir, index, allowedHosts);
        files.push(saved);
      }

      threadId = await resolveThreadForBinding(binding, scope);
      for (const file of files) {
        const mime = mimeFromExtension(file.path);
        uploadedAttachments.push(await observer.upload(file.path, basename(file.path), mime));
      }
      accepted = await t3Cli.withSession(
        { scopes: ['orchestration:read', 'orchestration:operate'], ttl: '2m', label: 'T3 QQBot delivery' },
        token =>
          dispatchMessage(config.t3.origin, token, {
            threadId,
            key,
            text: event.content ?? '',
            attachments: uploadedAttachments,
          }),
      );
    } catch (error) {
      await unlink(receipt).catch(() => {});
      for (const att of uploadedAttachments) {
        await observer.call('t3_attachment_discard', { attachmentId: att.id }).catch(() => {});
      }
      await qq.sendText(reply, 'T3 Code 暂时无法处理这条消息，请检查本地 T3 服务与日志。').catch(() => {});
      throw error;
    }

    const record: PersistedRunRecord = {
      key,
      scope,
      scopeHash: binding.scopeHash,
      reply,
      thread: threadId,
      runId: accepted.runId,
      workspace: binding.workspace,
      sequence: accepted.sequence,
    };
    await writeFile(join(root, digest(accepted.runId) + '.run.json'), JSON.stringify(record), { mode: 0o600 });
    timing('dispatch_ack', key, accepted.runId);
    console.info('T3 accepted', key, threadId, accepted.runId);
    await observeRun(key, reply, threadId, accepted.runId, accepted.sequence);
  }

  const checkHealth =
    options.checkT3Health ??
    (async () => {
      try {
        const probe = await fetch(config.t3.origin, { signal: AbortSignal.timeout(2_000) });
        await probe.body?.cancel();
        return probe.ok;
      } catch {
        return false;
      }
    });

  let server: Server | null = null;
  if (options.listen !== false) {
    const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/ready')) {
        const t3Running = await checkHealth();
        const ready = t3Running && (req.url !== '/ready' || config.bindings.length > 0);
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: ready,
            t3Origin: config.t3.origin,
            bindings: config.bindings.length,
          }),
        );
        return;
      }

      if (req.method !== 'POST' || req.url !== '/events') {
        res.writeHead(404).end();
        return;
      }
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      if (!timingSafeEqual(digestBuffer(authHeader), expectedAuthDigest)) {
        res.writeHead(401).end();
        return;
      }

      try {
        let size = 0;
        const parts: Buffer[] = [];
        for await (const part of req) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          if ((size += chunk.length) > 256_000) {
            res.writeHead(413).end();
            return;
          }
          parts.push(chunk);
        }
        const { t, d } = JSON.parse(Buffer.concat(parts).toString('utf8')) as { t: string; d: InboundEvent };
        if (t !== 'GROUP_AT_MESSAGE_CREATE' && t !== 'C2C_MESSAGE_CREATE') {
          res.writeHead(204).end();
          return;
        }
        const group = t === 'GROUP_AT_MESSAGE_CREATE';
        const id = group ? d?.group_openid : d?.author?.user_openid;
        if (
          !id ||
          typeof id !== 'string' ||
          !d?.id ||
          typeof d.id !== 'string' ||
          (d.content !== undefined && typeof d.content !== 'string') ||
          (d.attachments !== undefined && !Array.isArray(d.attachments))
        ) {
          res.writeHead(400).end();
          return;
        }

        const scope = `${group ? 'group' : 'c2c'}:${id}`;
        const binding = findBindingForScope(config, scope);
        if (!binding) {
          console.warn(
            `[unbound] Ignored message from "${scope}" (sha256:${digest(scope)}). Add this scope to "bindings" in ${config.configPath} to enable it.`,
          );
          res.writeHead(403).end();
          return;
        }

        res.writeHead(202).end();
        const key = digest(`${scope}\0${d.id}`);
        timing('bridge_ingress', key, '-');
        const runner = options.onAccepted ?? relay;
        void runner(d, { kind: group ? 'groups' : 'users', id }, binding, scope).catch(error =>
          console.error(key, error instanceof Error ? error.message : String(error)),
        );
      } catch {
        res.writeHead(400).end();
      }
    };

    server = createServer((req, res) => {
      void handleRequest(req, res);
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen);
      server!.listen(config.bridge.port, config.bridge.host, () => {
        server!.off('error', rejectListen);
        resolveListen();
      });
    });
  }

  return {
    server,
    observeRun,
    close: async () => {
      shutdownController.abort();
      await observer.close().catch(() => {});
      if (server) {
        await new Promise<void>((resolveClose, rejectClose) => {
          server!.close(error => (error ? rejectClose(error) : resolveClose()));
        });
      }
      for (const level of ['info', 'warn', 'error'] as const) {
        if (originalConsole[level]) {
          console[level] = originalConsole[level]!;
        }
      }
    },
  };
}

export async function runBridgeCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const configPath = argv[0] || process.env.T3_QQBOT_CONFIG || resolve('config.json');
  const config = await loadConfig(configPath);
  const credentials = await loadCredentials(config);

  if (argv[1] === '--recover') {
    const runId = argv[2];
    if (!runId) throw new Error('Recovery requires an existing T3 run ID: --recover <runId>');
    const runtime = await createBridgeRuntime(config, credentials, { listen: false });
    try {
      const recordPath = join(config.stateDir, digest(runId) + '.run.json');
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as PersistedRunRecord;
      if (record.runId !== runId) throw new Error('Recovery runId mismatch');
      await runtime.observeRun(record.key, record.reply, record.thread, record.runId, record.sequence, false);
      console.info('Recovery completed for run', runId);
    } finally {
      await runtime.close();
    }
    return;
  }

  const runtime = await createBridgeRuntime(config, credentials, { listen: true });
  const address = runtime.server?.address();
  const port = typeof address === 'object' && address ? address.port : config.bridge.port;
  console.info(
    `T3 QQBot bridge listening on http://${config.bridge.host}:${port} (${config.bindings.length} binding(s))`,
  );

  const shutdown = () => {
    console.info('Shutting down T3 QQBot bridge...');
    void runtime.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isMainModule(import.meta.url)) {
  runBridgeCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
