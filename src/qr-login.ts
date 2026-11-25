import { qrConnect } from '@tencent-connect/qqbot-connector';
import type { QrConnectCredentials } from '@tencent-connect/qqbot-connector';

export type QrBindResult = {
  appId: string;
  appSecret: string;
  userOpenid?: string;
};

/**
 * Displays an official QQ Bot binding QR code in the terminal via
 * `@tencent-connect/qqbot-connector` and waits for the user to scan it.
 */
export async function runQrBotLogin(options: { timeoutMs?: number } = {}): Promise<QrBindResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const timer = setTimeout(() => controller.abort(new Error('扫码超时（5分钟），请重试。')), timeoutMs);

  const onSigint = () => controller.abort(new Error('用户已取消扫码。'));
  process.once('SIGINT', onSigint);

  console.log('\n请使用手机 QQ 扫描下方二维码一键绑定你的 QQ 机器人（按 Ctrl+C 可取消）：\n');
  try {
    const list: QrConnectCredentials[] = await qrConnect({
      signal: controller.signal,
      source: 't3-code-qqbot',
    });
    const picked = list[0];
    if (!picked?.appId || !picked?.appSecret) {
      throw new Error('扫码完成但未返回有效的 AppID / AppSecret。');
    }
    return {
      appId: picked.appId,
      appSecret: picked.appSecret,
      ...(picked.userOpenid ? { userOpenid: picked.userOpenid } : {}),
    };
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onSigint);
  }
}
