import { realpathSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path, { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS,
  DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
  DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  digest,
  isValidAttachmentHostPattern,
} from './protocol.ts';
import type {
  Credentials,
  RawPluginConfig,
  ResolvedBinding,
  ResolvedPluginConfig,
} from './types.ts';

export const APP_VERSION = '1.2.5';
export const SELF_UPDATE_EXIT_CODE = 75;

export const LEGACY_DEFAULT_ATTACHMENT_HOSTS = [
  'multimedia.nt.qq.com.cn',
  'multimedia.nt.qq.com',
  'gchat.qpic.cn',
  'c2cpicdw.qpic.cn',
];

export const DEFAULT_ATTACHMENT_HOSTS = [
  ...LEGACY_DEFAULT_ATTACHMENT_HOSTS,
  'qqbot.ugcimg.cn',
  '*.nt.qq.com.cn',
  '*.nt.qq.com',
  '*.qpic.cn',
  '*.ugcimg.cn',
  '*.gtimg.cn',
];

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  const resolved = resolve(argv1);
  if (metaUrl === pathToFileURL(resolved).href) return true;
  try {
    return metaUrl === pathToFileURL(realpathSync(resolved)).href;
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function normalizePathForCompare(targetPath: string, platform: NodeJS.Platform = process.platform): string {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const normalized = pathImpl.resolve(targetPath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizePathForCompare(a, platform) === normalizePathForCompare(b, platform);
}

export function isSameOrInsidePath(
  candidate: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const normCandidate = normalizePathForCompare(candidate, platform);
  const normParent = normalizePathForCompare(parent, platform);
  if (normCandidate === normParent) return true;
  const rel = pathImpl.relative(normParent, normCandidate);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + pathImpl.sep) && !pathImpl.isAbsolute(rel);
}

export function scopeToHash(scope: string): string {
  const trimmed = scope.trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.slice('sha256:'.length).toLowerCase();
  }
  if (!/^(c2c|group):.+$/i.test(trimmed)) {
    throw new Error(
      `Invalid binding scope "${scope}". Expected "c2c:<user_openid>", "group:<group_openid>", or "sha256:<64-hex>".`,
    );
  }
  return digest(trimmed);
}

function resolveRelative(baseDir: string, maybeRelative: string): string {
  return isAbsolute(maybeRelative) ? resolve(maybeRelative) : resolve(baseDir, maybeRelative);
}

export function parseConfig(raw: RawPluginConfig, configPath: string): ResolvedPluginConfig {
  const absConfigPath = resolve(configPath);
  const configDir = dirname(absConfigPath);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be a JSON object');
  }
  if (!raw.stateDir || typeof raw.stateDir !== 'string') {
    throw new Error('Config requires "stateDir"');
  }
  if (!raw.t3?.origin || typeof raw.t3.origin !== 'string') {
    throw new Error('Config requires "t3.origin"');
  }
  if (!isLoopbackOrigin(raw.t3.origin)) {
    throw new Error(`Config "t3.origin" must target loopback (127.0.0.1 / localhost / ::1), got: ${raw.t3.origin}`);
  }
  const port = raw.bridge?.port ?? 18773;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid bridge port: ${port}`);
  }
  const host = raw.bridge?.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Bridge host must be loopback for security, got: ${host}`);
  }
  const maxMessageChars = raw.bridge?.maxMessageChars ?? 1600;
  if (!Number.isInteger(maxMessageChars) || maxMessageChars < 100 || maxMessageChars > 4000) {
    throw new Error(`Invalid bridge.maxMessageChars (${maxMessageChars}); expected integer between 100 and 4000`);
  }
  const rawBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
  const bindings: ResolvedBinding[] = rawBindings.map((binding, index) => {
    if (!binding || typeof binding.scope !== 'string' || !binding.scope.trim()) {
      throw new Error(`Binding #${index} is missing "scope"`);
    }
    if (typeof binding.workspace !== 'string' || !binding.workspace.trim()) {
      throw new Error(`Binding #${index} (${binding.scope}) is missing "workspace"`);
    }
    const threadId =
      typeof binding.threadId === 'string' &&
      binding.threadId.trim() &&
      !binding.threadId.startsWith('REPLACE_WITH_')
        ? binding.threadId.trim()
        : undefined;
    return {
      rawScope: binding.scope.trim(),
      scopeHash: scopeToHash(binding.scope),
      workspace: resolveRelative(configDir, binding.workspace.trim()),
      threadId,
      modelSelection: binding.modelSelection,
    };
  });

  const bridgeUrl = raw.gateway?.bridgeUrl?.trim() || `http://${host === '::1' ? '[::1]' : host}:${port}/events`;

  const configuredHosts =
    Array.isArray(raw.attachmentHosts) && raw.attachmentHosts.length > 0
      ? [...new Set(raw.attachmentHosts.map(h => String(h).trim().toLowerCase()).filter(Boolean))]
      : [];
  for (const hostPattern of configuredHosts) {
    if (!isValidAttachmentHostPattern(hostPattern)) {
      throw new Error(
        `Invalid attachmentHosts entry "${hostPattern}". Use an exact HTTPS hostname or safe subdomain wildcard like "*.nt.qq.com".`,
      );
    }
  }
  const configuredHostSet = new Set(configuredHosts);
  const attachmentHosts =
    configuredHosts.length === 0
      ? [...DEFAULT_ATTACHMENT_HOSTS]
      : LEGACY_DEFAULT_ATTACHMENT_HOSTS.every(host => configuredHostSet.has(host))
        ? [...new Set([...configuredHosts, ...DEFAULT_ATTACHMENT_HOSTS])]
        : configuredHosts;

  const parseBoundedInt = (
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
    label: string,
  ): number => {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
      throw new Error(`Invalid ${label} (${resolved}); expected integer between ${min} and ${max}`);
    }
    return resolved;
  };

  const maxInboundBytes = parseBoundedInt(
    raw.attachments?.maxInboundBytes,
    DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES,
    1024 * 1024,
    2 * 1024 * 1024 * 1024,
    'attachments.maxInboundBytes',
  );
  const maxOutboundBytes =
    raw.attachments?.maxOutboundBytes !== undefined
      ? parseBoundedInt(
          raw.attachments.maxOutboundBytes,
          100 * 1024 * 1024,
          1024 * 1024,
          500 * 1024 * 1024,
          'attachments.maxOutboundBytes',
        )
      : undefined;
  const maxPerMessage = parseBoundedInt(
    raw.attachments?.maxPerMessage,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
    1,
    100,
    'attachments.maxPerMessage',
  );
  const downloadIdleTimeoutMs = parseBoundedInt(
    raw.attachments?.downloadIdleTimeoutMs,
    DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
    5_000,
    300_000,
    'attachments.downloadIdleTimeoutMs',
  );
  const downloadTotalTimeoutMs = parseBoundedInt(
    raw.attachments?.downloadTotalTimeoutMs,
    DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS,
    10_000,
    1_800_000,
    'attachments.downloadTotalTimeoutMs',
  );
  const uploadTimeoutMs = parseBoundedInt(
    raw.attachments?.uploadTimeoutMs,
    DEFAULT_UPLOAD_TIMEOUT_MS,
    5_000,
    600_000,
    'attachments.uploadTimeoutMs',
  );

  return {
    configPath: absConfigPath,
    configDir,
    stateDir: resolveRelative(configDir, raw.stateDir),
    credentialsFile: raw.credentialsFile ? resolveRelative(configDir, raw.credentialsFile) : undefined,
    t3: {
      origin: raw.t3.origin.trim(),
      executable: raw.t3.executable?.trim() || 'auto',
      prefix: Array.isArray(raw.t3.prefix) ? raw.t3.prefix.map(String) : [],
      env: raw.t3.env && typeof raw.t3.env === 'object' ? { ...raw.t3.env } : {},
      home: raw.t3.home ? resolveRelative(configDir, raw.t3.home) : undefined,
      muteMobileCompletionThreadId: raw.t3.muteMobileCompletionThreadId?.trim() || undefined,
    },
    bridge: {
      host,
      port,
      proactiveBackgroundReports: Boolean(raw.bridge?.proactiveBackgroundReports),
      maxMessageChars,
      autoSettleThread: Boolean(raw.bridge?.autoSettleThread),
      enableSlashCommands: raw.bridge?.enableSlashCommands ?? true,
      testStaging: raw.bridge?.testStaging ? resolveRelative(configDir, raw.bridge.testStaging) : undefined,
    },
    gateway: {
      bridgeUrl,
      requireMentionInGroup: raw.gateway?.requireMentionInGroup ?? true,
      stripPrefix: raw.gateway?.stripPrefix ?? '',
    },
    attachmentHosts,
    attachments: {
      maxInboundBytes,
      ...(maxOutboundBytes !== undefined ? { maxOutboundBytes } : {}),
      maxPerMessage,
      downloadIdleTimeoutMs,
      downloadTotalTimeoutMs,
      uploadTimeoutMs,
    },
    bindings,
  };
}

export async function loadConfig(configPath: string): Promise<ResolvedPluginConfig> {
  const rawText = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(rawText.replace(/^\uFEFF/, '')) as RawPluginConfig;
  return parseConfig(parsed, configPath);
}

export type ResolvedGatewayOnlyConfig = {
  configPath: string;
  configDir: string;
  stateDir?: string;
  credentialsFile?: string;
  gateway: {
    bridgeUrl: string;
    requireMentionInGroup: boolean;
    stripPrefix: string;
  };
};

/**
 * Lightweight config loader for standalone split-host `gateway` deployments.
 * Does not require `stateDir`, `t3.origin`, or `bindings`.
 */
export async function loadGatewayConfig(configPath?: string): Promise<ResolvedGatewayOnlyConfig> {
  if (!configPath) {
    return {
      configPath: '',
      configDir: process.cwd(),
      gateway: {
        bridgeUrl: process.env.QQ_BRIDGE_URL?.trim() || 'http://127.0.0.1:18773/events',
        requireMentionInGroup: true,
        stripPrefix: '',
      },
    };
  }
  const absPath = resolve(configPath);
  const configDir = dirname(absPath);
  const rawText = await readFile(absPath, 'utf8');
  const raw = JSON.parse(rawText.replace(/^\uFEFF/, '')) as Partial<RawPluginConfig>;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be a JSON object');
  }
  const host = raw.bridge?.host ?? '127.0.0.1';
  const port = raw.bridge?.port ?? 18773;
  const defaultBridgeUrl = `http://${host === '::1' ? '[::1]' : host}:${port}/events`;

  let credentialsFile = raw.credentialsFile ? resolveRelative(configDir, raw.credentialsFile) : undefined;
  if (!credentialsFile) {
    const siblingCreds = join(configDir, 'credentials.json');
    const exists = await access(siblingCreds).then(() => true, () => false);
    if (exists) credentialsFile = siblingCreds;
  }

  return {
    configPath: absPath,
    configDir,
    stateDir: raw.stateDir ? resolveRelative(configDir, raw.stateDir) : undefined,
    credentialsFile,
    gateway: {
      bridgeUrl: raw.gateway?.bridgeUrl?.trim() || defaultBridgeUrl,
      requireMentionInGroup: raw.gateway?.requireMentionInGroup ?? true,
      stripPrefix: raw.gateway?.stripPrefix ?? '',
    },
  };
}

export async function loadCredentials(
  config: Pick<ResolvedPluginConfig, 'credentialsFile'>,
  env: NodeJS.ProcessEnv = process.env,
  options: { requireBridgeSecret?: boolean } = {},
): Promise<Credentials> {
  const requireBridgeSecret = options.requireBridgeSecret ?? true;
  const envAppId = env.QQ_APP_ID?.trim() || '';
  const envAppSecret = env.QQ_APP_SECRET?.trim() || '';
  const envBridgeSecret = env.QQ_BRIDGE_SECRET?.trim() || '';
  const explicitCredsFile = env.QQ_CREDENTIALS_FILE?.trim();

  const envHasAll = Boolean(envAppId && envAppSecret && (!requireBridgeSecret || envBridgeSecret));
  let fileCreds: Partial<Credentials> = {};

  const credentialsPath = explicitCredsFile || (envHasAll ? undefined : config.credentialsFile);
  if (credentialsPath) {
    try {
      const raw = await readFile(credentialsPath, 'utf8');
      fileCreds = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<Credentials>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !explicitCredsFile && envHasAll) {
        fileCreds = {};
      } else {
        throw error;
      }
    }
  }

  const appId = envAppId || fileCreds.appId?.trim() || '';
  const appSecret = envAppSecret || fileCreds.appSecret?.trim() || '';
  const bridgeSecret = envBridgeSecret || fileCreds.bridgeSecret?.trim() || '';

  if (!appId || !appSecret || (requireBridgeSecret && !bridgeSecret)) {
    const missing = requireBridgeSecret ? 'appId, appSecret, bridgeSecret' : 'appId, appSecret';
    throw new Error(
      `Missing QQ Bot credentials (${missing}). Set them in credentials.json or environment variables.`,
    );
  }
  if (
    appId.startsWith('REPLACE_WITH_') ||
    appSecret.startsWith('REPLACE_WITH_') ||
    (requireBridgeSecret && bridgeSecret.startsWith('REPLACE_WITH_'))
  ) {
    throw new Error('Credentials still contain REPLACE_WITH_* placeholder values. Edit credentials.json first.');
  }
  return { appId, appSecret, bridgeSecret };
}

export function findBindingForScope(
  config: ResolvedPluginConfig,
  scope: string,
): ResolvedBinding | undefined {
  const hash = digest(scope);
  return config.bindings.find(binding => binding.scopeHash === hash);
}
