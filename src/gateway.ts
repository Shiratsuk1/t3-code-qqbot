import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { QQBot, contentSanitizer, mentionGate, messageFilter } from '@tencent-connect/qqbot-nodejs';
import { isMainModule, loadCredentials, loadGatewayConfig } from './config.ts';
import type { ResolvedGatewayOnlyConfig } from './config.ts';
import type { Credentials } from './types.ts';

function stripCommandPrefix(text: string, prefix: string): string {
  if (!prefix) return text.trim();
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${escaped}(?:\\s+|$)`), '').trim();
}

function normalizeAttachmentUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  return trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
}

export async function startGateway(
  config: ResolvedGatewayOnlyConfig,
  credentials: Credentials,
  options: { attachFileLogger?: boolean } = {},
): Promise<void> {
  const originalConsole: Partial<Record<'info' | 'warn' | 'error', (...args: unknown[]) => void>> = {};
  if (options.attachFileLogger !== false && config.stateDir) {
    await mkdir(config.stateDir, { recursive: true });
    const logPath = join(config.stateDir, 'gateway.log');
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
          // Ignore file write errors
        }
        original(...parts);
      };
    }
  }

  const endpoint = process.env.QQ_BRIDGE_URL?.trim() || config.gateway.bridgeUrl;
  const bot = new QQBot({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    transport: 'websocket',
  });

  bot.use(
    messageFilter({ skipSelfEcho: true }),
    mentionGate({ requireMentionInGroup: config.gateway.requireMentionInGroup }),
    contentSanitizer({ parseFaceTags: true }),
  );

  bot.on('ready', () => console.info('T3 QQBot gateway READY ->', endpoint));
  bot.on('resumed', () => console.info('T3 QQBot gateway RESUMED'));
  bot.on('disconnected', event => console.warn('T3 QQBot gateway disconnected', event.code));
  bot.on('error', error => console.warn('T3 QQBot gateway error', error.name, error.message));

  bot.on('message', async (_context, message) => {
    const target = message.replyTarget;
    if (!target || !['c2c', 'group'].includes(target.scope) || !target.targetId || !target.msgId) {
      return;
    }
    const group = target.scope === 'group';
    const rawAttachments = [
      ...(message.attachments ?? []),
      ...(message.msgElements ?? []).flatMap(item => item.attachments ?? []),
    ];
    const deduped = new Map<string, { url: string; content_type?: string; filename?: string }>();
    for (const item of rawAttachments) {
      const rawUrl = item.voice_wav_url?.trim() || item.url?.trim();
      if (!rawUrl) continue;
      const normalizedUrl = normalizeAttachmentUrl(rawUrl);
      if (!deduped.has(normalizedUrl)) {
        deduped.set(normalizedUrl, {
          url: normalizedUrl,
          content_type: item.content_type,
          filename: item.filename,
        });
      }
    }
    const attachments = [...deduped.values()];

    const content = stripCommandPrefix(message.content ?? '', config.gateway.stripPrefix);
    if (!content && !attachments.length) return;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: {
          Authorization: `Bearer ${credentials.bridgeSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
          d: {
            id: target.msgId,
            content,
            attachments,
            ...(group ? { group_openid: target.targetId } : { author: { user_openid: target.targetId } }),
          },
        }),
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 403) {
        console.warn(
          `[unbound] Bridge rejected unbound scope ${target.scope}:${target.targetId}. Check bridge logs and add it to config.json.`,
        );
        return;
      }
      if (response.status !== 202) {
        throw new Error(`Bridge HTTP ${response.status}`);
      }
      console.info('T3 ingress accepted', target.scope, 'attachments', attachments.length);
    } catch (error) {
      console.error('T3 ingress failed', error instanceof Error ? error.message : 'unknown error');
      await bot.sendText(target, 'T3 Code 暂时未接收这条消息，请稍后再试。').catch(() => {});
    }
  });

  const stop = () => {
    console.info('Stopping T3 QQBot gateway...');
    bot.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    await bot.start();
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    for (const level of ['info', 'warn', 'error'] as const) {
      if (originalConsole[level]) {
        console[level] = originalConsole[level]!;
      }
    }
  }
}

export async function runGatewayCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const configPath = argv[0] || process.env.T3_QQBOT_CONFIG || resolve('config.json');
  const config = await loadGatewayConfig(configPath);
  const credentials = await loadCredentials(config);
  await startGateway(config, credentials);
}

if (isMainModule(import.meta.url)) {
  runGatewayCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
