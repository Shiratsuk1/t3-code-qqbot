import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { QQBot, contentSanitizer, mentionGate, messageFilter } from '@tencent-connect/qqbot-nodejs';
import { isMainModule, loadCredentials, loadGatewayConfig } from './config.ts';
import type { ResolvedGatewayOnlyConfig } from './config.ts';
import type { Attachment, Credentials, InboundQuote } from './types.ts';

/** QQ Open Platform message_type code for quote-reply messages (matches SDK `MSG_TYPE_QUOTE`). */
export const MSG_TYPE_QUOTE = 103;

function stripCommandPrefix(text: string, prefix: string): string {
  if (!prefix) return text.trim();
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${escaped}(?:\\s+|$)`), '').trim();
}

function normalizeAttachmentUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export type RawGatewayAttachmentLike = {
  url?: string;
  voice_wav_url?: string;
  content_type?: string;
  filename?: string;
  size?: number;
  asr_refer_text?: string;
};

export type RawGatewayMessageLike = {
  content?: string;
  msgType?: number;
  attachments?: RawGatewayAttachmentLike[];
  msgElements?: {
    content?: string;
    attachments?: RawGatewayAttachmentLike[];
  }[];
};

function summarizeQuotedAttachments(items: readonly RawGatewayAttachmentLike[] | undefined): string | undefined {
  if (!items || items.length === 0) return undefined;
  const tags: string[] = [];
  for (const att of items) {
    const ct = (att.content_type ?? '').toLowerCase();
    const asr = att.asr_refer_text?.trim();
    const name = att.filename?.trim();
    if (ct.startsWith('audio/') || ct === 'voice' || ct.includes('silk') || ct.includes('amr')) {
      tags.push(asr ? `[语音: ${asr}]` : '[语音]');
    } else if (ct.startsWith('image/')) {
      tags.push(name ? `[图片: ${name}]` : '[图片]');
    } else if (ct.startsWith('video/')) {
      tags.push(name ? `[视频: ${name}]` : '[视频]');
    } else {
      tags.push(name ? `[文件: ${name}]` : '[文件]');
    }
  }
  return tags.length > 0 ? tags.join(' ') : undefined;
}

export function extractInboundPayload(
  message: RawGatewayMessageLike,
  stripPrefix = '',
): { content: string; attachments: Attachment[]; quote?: InboundQuote } {
  const isQuoteMessage = message.msgType === MSG_TYPE_QUOTE;
  // For quote-reply messages (msgType === 103), `msgElements[0]` carries the *referenced* message.
  // Do NOT merge quoted attachments into the current message's download queue (old URLs may be expired or huge).
  const rawAttachments: RawGatewayAttachmentLike[] = isQuoteMessage
    ? [...(message.attachments ?? [])]
    : [
        ...(message.attachments ?? []),
        ...(message.msgElements ?? []).flatMap(item => item.attachments ?? []),
      ];

  const deduped = new Map<string, Attachment>();
  for (const item of rawAttachments) {
    const voiceWavUrl = item.voice_wav_url?.trim();
    const baseUrl = item.url?.trim();
    const rawUrl = voiceWavUrl || baseUrl;
    if (!rawUrl) continue;
    const normalizedUrl = normalizeAttachmentUrl(rawUrl);
    const normalizedFallback =
      voiceWavUrl && baseUrl && voiceWavUrl !== baseUrl ? normalizeAttachmentUrl(baseUrl) : undefined;
    const asrReferText = item.asr_refer_text?.trim() || undefined;
    const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.size > 0 ? item.size : undefined;
    if (!deduped.has(normalizedUrl)) {
      deduped.set(normalizedUrl, {
        url: normalizedUrl,
        ...(normalizedFallback && normalizedFallback !== normalizedUrl ? { fallback_url: normalizedFallback } : {}),
        content_type: item.content_type,
        filename: item.filename,
        ...(size !== undefined ? { size } : {}),
        ...(asrReferText ? { asr_refer_text: asrReferText } : {}),
      });
    }
  }

  let quote: InboundQuote | undefined;
  if (isQuoteMessage && message.msgElements?.[0]) {
    const el = message.msgElements[0];
    const qText = el.content?.trim() ? el.content.trim().slice(0, 500) : undefined;
    const qAtt = summarizeQuotedAttachments(el.attachments);
    if (qText || qAtt) {
      quote = {
        ...(qText ? { text: qText } : {}),
        ...(qAtt ? { attachmentSummary: qAtt } : {}),
      };
    }
  }

  return {
    content: stripCommandPrefix(message.content ?? '', stripPrefix),
    attachments: [...deduped.values()],
    ...(quote ? { quote } : {}),
  };
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
    const { content, attachments, quote } = extractInboundPayload(message, config.gateway.stripPrefix);
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
            ...(quote ? { quote } : {}),
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
