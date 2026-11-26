import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Attachment } from './types.ts';

/** Empirically verified against local T3 Code server (`PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`). */
export const T3_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Empirically verified against local T3 Code server (`PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES`). */
export const T3_MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
/** Empirically verified against local T3 Code server (`PROVIDER_SEND_TURN_MAX_FILE_BYTES`). */
export const T3_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Default inbound QQ attachment download ceiling (streamed to disk; > 50 MiB uses workspace-disk delivery). */
export const DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS = 300_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

/** Backwards-compatible aliases. */
export const MAX_ATTACHMENT_BYTES = DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES;
export const MAX_ATTACHMENTS_PER_MESSAGE = DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE;

/**
 * Outbound per-type ceilings matching `@tencent-connect/qqbot-nodejs` `MEDIA_FILE_TYPE_INFO`
 * (chunked upload activates automatically in SDK above 5 MiB).
 */
export const QQ_MAX_UPLOAD_BYTES_BY_TYPE: Record<1 | 2 | 3 | 4, number> = {
  1: 30 * 1024 * 1024, // IMAGE
  2: 100 * 1024 * 1024, // VIDEO
  3: 20 * 1024 * 1024, // VOICE
  4: 100 * 1024 * 1024, // FILE
};

export type AttachmentErrorCode =
  | 'MISSING_URL'
  | 'INVALID_URL'
  | 'HOST_NOT_ALLOWED'
  | 'REDIRECT_REJECTED'
  | 'DOWNLOAD_HTTP'
  | 'DOWNLOAD_TIMEOUT'
  | 'SIZE_EXCEEDED'
  | 'OUTBOUND_INVALID_PATH'
  | 'OUTBOUND_OUTSIDE_WORKSPACE'
  | 'OUTBOUND_INVALID_FILE'
  | 'OUTBOUND_SIZE_EXCEEDED';

export type AttachmentErrorDetails = {
  host?: string;
  status?: number;
  sizeBytes?: number;
  maxBytes?: number;
  fileName?: string;
  timeoutMs?: number;
};

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  readonly details: AttachmentErrorDetails;

  constructor(code: AttachmentErrorCode, message: string, details: AttachmentErrorDetails = {}) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    this.details = details;
  }
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) {
    const mib = bytes / (1024 * 1024);
    return Number.isInteger(mib) ? `${mib} MiB` : `${mib.toFixed(1)} MiB`;
  }
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const digestBuffer = (value: string | Uint8Array): Buffer =>
  createHash('sha256').update(value).digest();

const MIME_MAP: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  // Videos
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.ts': 'video/mp2t',
  // Audio
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.silk': 'audio/silk',
  '.amr': 'audio/amr',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  // Documents & structured text
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
  '.log': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
};

const EXTENSION_FROM_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/silk': 'silk',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-7z-compressed': '7z',
  'application/vnd.rar': 'rar',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const ZIP_CONTAINER_EXTENSIONS = new Set([
  '.zip',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.jar',
  '.apk',
]);

const OUTBOUND_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'ac.uk',
  'org.uk',
  'co.jp',
  'com.hk',
  'com.tw',
  'com.au',
]);

export function isT3NativeImageMime(mimeType: string): boolean {
  return /^image\/(png|jpeg|webp|gif)$/i.test(mimeType.split(';')[0].trim());
}

export function mimeFromExtension(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function sanitizeDisplayFileName(rawName: string | undefined, fallback: string): string {
  const base = rawName ? basename(rawName.trim()) : '';
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chosen = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
  return chosen.length > 200 ? chosen.slice(-200) : chosen;
}

function isIpOrLoopbackHost(host: string): boolean {
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa')
  ) {
    return true;
  }
  if (host.includes(':') || host.startsWith('[')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (!host.includes('.')) return true;
  return false;
}

/**
 * Returns true if an IPv4 or IPv6 address belongs to a loopback, private, link-local,
 * metadata, or CGNAT range that must be blocked for SSRF protection.
 * Deliberately allows `198.18.0.0/15` (RFC 2544 benchmark / Clash & Mihomo TUN Fake-IP).
 */
export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses like `::ffff:127.0.0.1` or `::ffff:7f00:1`
  if (ip.startsWith('::ffff:')) {
    const rest = ip.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
      return isBlockedIpAddress(rest);
    }
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1], 16);
      const lo = Number.parseInt(hexMatch[2], 16);
      return isBlockedIpAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT / Tailscale)
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 checks
  const cleaned = ip.split('%')[0];
  if (cleaned === '::' || cleaned === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(cleaned)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(cleaned)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(cleaned)) return true; // ff00::/8 multicast
  return false;
}

export function isValidAttachmentHostPattern(rawPattern: string): boolean {
  const pattern = rawPattern.trim().toLowerCase();
  if (!pattern || pattern.length > 253) return false;
  const isWildcard = pattern.startsWith('*.');
  const domain = isWildcard ? pattern.slice(2) : pattern;
  if (!domain || isIpOrLoopbackHost(domain)) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return false;
  }
  const labels = domain.split('.');
  if (isWildcard) {
    const lastTwo = labels.slice(-2).join('.');
    const minLabels = TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) ? 3 : 2;
    if (labels.length < minLabels) return false;
  }
  return true;
}

export function isHostAllowed(hostname: string, allowlist: Iterable<string>): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host || isIpOrLoopbackHost(host)) return false;
  for (const rawEntry of allowlist) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('*.')) {
      if (!isValidAttachmentHostPattern(entry)) continue;
      const suffix = entry.slice(2);
      if (host.endsWith(`.${suffix}`) && host.length > suffix.length + 1) {
        return true;
      }
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

function isInsideBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export async function safeArtifact(
  root: string,
  file: string,
  options: { maxBytes?: number } = {},
): Promise<{
  localPath: string;
  fileType: 1 | 2 | 3 | 4;
  fileName: string;
  sizeBytes: number;
}> {
  if (!file || typeof file !== 'string' || file.includes('\0')) {
    throw new AttachmentError('OUTBOUND_INVALID_PATH', 'Invalid artifact path');
  }
  // Block Windows UNC / device namespace paths before any filesystem call (prevents SMB/NTLM leaks)
  if (/^(\\\\|\/\/)/.test(file)) {
    throw new AttachmentError('OUTBOUND_OUTSIDE_WORKSPACE', 'Artifact is outside this workspace directory');
  }
  const base = await realpath(root);
  const lexicalCandidate = resolve(base, file);
  if (/^(\\\\|\/\/)/.test(lexicalCandidate) || !isInsideBase(base, lexicalCandidate)) {
    throw new AttachmentError('OUTBOUND_OUTSIDE_WORKSPACE', 'Artifact is outside this workspace directory');
  }

  const localPath = await realpath(lexicalCandidate);
  if (!isInsideBase(base, localPath)) {
    throw new AttachmentError('OUTBOUND_OUTSIDE_WORKSPACE', 'Artifact is outside this workspace directory');
  }
  const info = await stat(localPath);
  const fileName = basename(localPath);
  if (!info.isFile() || info.size <= 0) {
    throw new AttachmentError('OUTBOUND_INVALID_FILE', 'Invalid artifact size or type', {
      fileName,
      sizeBytes: info.size,
    });
  }
  const extension = extname(localPath).toLowerCase();
  const fileType: 1 | 2 | 3 | 4 = OUTBOUND_IMAGE_EXTENSIONS.has(extension)
    ? 1
    : extension === '.mp4'
      ? 2
      : extension === '.silk'
        ? 3
        : 4;
  const effectiveMaxBytes = options.maxBytes ?? QQ_MAX_UPLOAD_BYTES_BY_TYPE[fileType];
  if (info.size > effectiveMaxBytes) {
    throw new AttachmentError(
      'OUTBOUND_SIZE_EXCEEDED',
      `Invalid artifact size: "${fileName}" (${formatByteSize(info.size)}) exceeds ${formatByteSize(effectiveMaxBytes)} limit`,
      { fileName, sizeBytes: info.size, maxBytes: effectiveMaxBytes },
    );
  }
  return { localPath, fileType, fileName, sizeBytes: info.size };
}

export function detectExtension(bytes: Buffer, fallbackName: string, contentType?: string): string {
  const header = bytes.subarray(0, 32);
  const fallbackSuffix = extname(fallbackName).toLowerCase();
  const normalizedMime = contentType ? contentType.split(';')[0].trim().toLowerCase() : '';

  if (header.length >= 8 && header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'png';
  }
  if (header.length >= 3 && header.subarray(0, 3).toString('hex') === 'ffd8ff') {
    return 'jpg';
  }
  if (
    header.length >= 6 &&
    (header.toString('ascii', 0, 6) === 'GIF87a' || header.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'gif';
  }
  if (header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF') {
    const fourcc = header.toString('ascii', 8, 12);
    if (fourcc === 'WAVE') return 'wav';
    if (fourcc === 'WEBP') return 'webp';
    if (fourcc === 'AVI ') return 'avi';
  }
  if (
    header.length >= 14 &&
    header[0] === 0x42 &&
    header[1] === 0x4d &&
    header.readUInt32LE(6) === 0
  ) {
    return 'bmp';
  }
  if (
    header.length >= 9 &&
    header.subarray(header[0] === 2 ? 1 : 0).toString('ascii').startsWith('#!SILK_V3')
  ) {
    return 'silk';
  }
  if (
    header.length >= 6 &&
    (header.toString('ascii', 0, 6) === '#!AMR\n' ||
      (header.length >= 9 && header.toString('ascii', 0, 9) === '#!AMR-WB\n'))
  ) {
    return 'amr';
  }
  if (header.length >= 3 && header.toString('ascii', 0, 3) === 'ID3') {
    return 'mp3';
  }
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'OggS') {
    return 'ogg';
  }
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'fLaC') {
    return 'flac';
  }
  if (header.length >= 12 && header.toString('ascii', 4, 8) === 'ftyp') {
    const brand = header.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'mov';
    if (brand === 'M4A ') return 'm4a';
    if (brand === 'M4V ') return 'm4v';
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return '3gp';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    return 'mp4';
  }
  if (header.length >= 4 && header.subarray(0, 4).toString('hex') === '1a45dfa3') {
    if (fallbackSuffix === '.webm' || normalizedMime.includes('webm')) return 'webm';
    return 'mkv';
  }
  if (header.length >= 5 && header.toString('ascii', 0, 5) === '%PDF-') {
    return 'pdf';
  }
  if (header.length >= 4 && header.subarray(0, 4).toString('hex') === '504b0304') {
    if (ZIP_CONTAINER_EXTENSIONS.has(fallbackSuffix)) {
      return fallbackSuffix.slice(1);
    }
    return 'zip';
  }
  if (header.length >= 3 && header.subarray(0, 3).toString('hex') === '1f8b08') {
    return 'gz';
  }
  if (header.length >= 6 && header.subarray(0, 6).toString('hex') === '377abcaf271c') {
    return '7z';
  }
  if (header.length >= 6 && header.subarray(0, 6).toString('hex') === '526172211a07') {
    return 'rar';
  }

  if (/^\.[a-z0-9]{1,12}$/.test(fallbackSuffix)) {
    return fallbackSuffix.slice(1);
  }
  if (normalizedMime && EXTENSION_FROM_MIME[normalizedMime]) {
    return EXTENSION_FROM_MIME[normalizedMime];
  }
  return 'bin';
}

const MAX_ATTACHMENT_REDIRECTS = 2;

export type DnsLookupFn = (hostname: string) => Promise<{ address: string }[]>;

function parseAllowedAttachmentUrl(rawUrl: string, hosts: readonly string[]): URL {
  const trimmed = rawUrl.trim();
  const normalized = trimmed.startsWith('//')
    ? `https:${trimmed}`
    : !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)
      ? `https://${trimmed}`
      : trimmed;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new AttachmentError('INVALID_URL', `Invalid QQ attachment URL: ${rawUrl}`);
  }
  const hasExplicitAllowlist = hosts.length > 0;
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    isIpOrLoopbackHost(url.hostname.toLowerCase()) ||
    (hasExplicitAllowlist && !isHostAllowed(url.hostname, hosts))
  ) {
    throw new AttachmentError('HOST_NOT_ALLOWED', `Unrecognized QQ attachment origin: ${url.hostname}`, {
      host: url.hostname,
    });
  }
  return url;
}

async function verifyPublicDnsResolution(hostname: string, lookupImpl: DnsLookupFn): Promise<void> {
  let records: { address: string }[];
  try {
    records = await lookupImpl(hostname);
  } catch {
    // Let fetch surface the real network/DNS error cleanly
    return;
  }
  for (const record of records) {
    if (isBlockedIpAddress(record.address)) {
      throw new AttachmentError(
        'HOST_NOT_ALLOWED',
        `Blocked QQ attachment origin resolving to private/loopback IP: ${hostname} (${record.address})`,
        { host: hostname },
      );
    }
  }
}

export type SaveAttachmentOptions = {
  fetchImpl?: typeof fetch;
  lookupImpl?: DnsLookupFn;
  maxBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
};

export type SavedAttachment = {
  path: string;
  format: string;
  sizeBytes: number;
  fileName: string;
};

async function destroyAndCleanupTempFile(ws: ReturnType<typeof createWriteStream>, partPath: string): Promise<void> {
  if (!ws.closed) {
    const closePromise = once(ws, 'close').catch(() => {});
    ws.destroy();
    await closePromise;
  }
  await unlink(partPath).catch(() => {});
}

export async function saveAttachment(
  item: Attachment,
  directory: string,
  index: number,
  hosts: Iterable<string>,
  fetchOrOptions: typeof fetch | SaveAttachmentOptions = fetch,
): Promise<SavedAttachment> {
  if (!item.url) {
    throw new AttachmentError('MISSING_URL', 'Missing QQ attachment URL');
  }
  const opts: SaveAttachmentOptions =
    typeof fetchOrOptions === 'function' ? { fetchImpl: fetchOrOptions } : fetchOrOptions;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hostList = [...hosts];
  const lookupImpl: DnsLookupFn | undefined =
    opts.lookupImpl ?? (fetchImpl === fetch ? host => dnsLookup(host, { all: true }) : undefined);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS;
  const displayHint = item.filename?.trim() || undefined;

  let currentUrl = parseAllowedAttachmentUrl(item.url, hostList);
  if (lookupImpl) {
    await verifyPublicDnsResolution(currentUrl.hostname, lookupImpl);
  }
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => {
    overallController.abort(
      new AttachmentError(
        'DOWNLOAD_TIMEOUT',
        `QQ attachment download exceeded total timeout (${Math.round(totalTimeoutMs / 1000)}s)`,
        { fileName: displayHint, timeoutMs: totalTimeoutMs },
      ),
    );
  }, totalTimeoutMs);
  overallTimer.unref?.();

  const onExternalAbort = () => overallController.abort(opts.signal?.reason ?? new Error('Download aborted'));
  if (opts.signal?.aborted) {
    clearTimeout(overallTimer);
    throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Download aborted');
  }
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let response: Response | undefined;
  try {
    for (let hop = 0; hop <= MAX_ATTACHMENT_REDIRECTS; hop++) {
      const connectController = new AbortController();
      const connectTimer = setTimeout(() => {
        connectController.abort(
          new AttachmentError(
            'DOWNLOAD_TIMEOUT',
            `QQ attachment connect timed out (${Math.round(idleTimeoutMs / 1000)}s)`,
            { fileName: displayHint, timeoutMs: idleTimeoutMs },
          ),
        );
      }, idleTimeoutMs);
      connectTimer.unref?.();
      const onOverall = () => connectController.abort(overallController.signal.reason);
      overallController.signal.addEventListener('abort', onOverall, { once: true });

      try {
        response = await fetchImpl(currentUrl, { redirect: 'manual', signal: connectController.signal });
      } catch (err) {
        if (connectController.signal.aborted && connectController.signal.reason instanceof AttachmentError) {
          throw connectController.signal.reason;
        }
        if (overallController.signal.aborted && overallController.signal.reason instanceof AttachmentError) {
          throw overallController.signal.reason;
        }
        throw err;
      } finally {
        clearTimeout(connectTimer);
        overallController.signal.removeEventListener('abort', onOverall);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || hop === MAX_ATTACHMENT_REDIRECTS) {
          throw new AttachmentError(
            'REDIRECT_REJECTED',
            `QQ attachment redirect rejected (HTTP ${response.status})`,
            { status: response.status, fileName: displayHint },
          );
        }
        currentUrl = parseAllowedAttachmentUrl(new URL(location, currentUrl).href, hostList);
        if (lookupImpl) {
          await verifyPublicDnsResolution(currentUrl.hostname, lookupImpl);
        }
        continue;
      }
      break;
    }

    if (!response || !response.ok || !response.body) {
      await response?.body?.cancel().catch(() => {});
      throw new AttachmentError('DOWNLOAD_HTTP', `QQ attachment HTTP ${response?.status ?? 0}`, {
        status: response?.status ?? 0,
        fileName: displayHint,
      });
    }

    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw && /^\d+$/.test(contentLengthRaw.trim())) {
      const declaredSize = Number(contentLengthRaw.trim());
      if (Number.isSafeInteger(declaredSize) && declaredSize > maxBytes) {
        await response.body.cancel().catch(() => {});
        throw new AttachmentError(
          'SIZE_EXCEEDED',
          `QQ attachment exceeds ${formatByteSize(maxBytes)} limit (${formatByteSize(declaredSize)})`,
          { fileName: displayHint, sizeBytes: declaredSize, maxBytes },
        );
      }
    }

    await mkdir(directory, { recursive: true });
    const partPath = join(directory, `.tmp-${index}-${randomUUID()}.part`);
    const ws = createWriteStream(partPath, { flags: 'wx' });
    let writeStreamError: Error | null = null;
    ws.on('error', err => {
      writeStreamError = err;
    });

    const hasher = createHash('sha256');
    const headerChunks: Buffer[] = [];
    let headerLen = 0;
    let size = 0;
    const reader = response.body.getReader();

    try {
      while (true) {
        if (overallController.signal.aborted) {
          throw overallController.signal.reason instanceof Error
            ? overallController.signal.reason
            : new Error('Download aborted');
        }
        let idleTimer: NodeJS.Timeout | undefined;
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, rejectTimeout) => {
              idleTimer = setTimeout(() => {
                rejectTimeout(
                  new AttachmentError(
                    'DOWNLOAD_TIMEOUT',
                    `QQ attachment download stalled for ${Math.round(idleTimeoutMs / 1000)}s`,
                    { fileName: displayHint, timeoutMs: idleTimeoutMs },
                  ),
                );
              }, idleTimeoutMs);
              idleTimer.unref?.();
            }),
          ]);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }

        if (readResult.done) break;
        const chunk = readResult.value;
        if (!chunk || chunk.byteLength === 0) continue;

        size += chunk.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AttachmentError(
            'SIZE_EXCEEDED',
            `QQ attachment exceeds ${formatByteSize(maxBytes)} limit`,
            { fileName: displayHint, sizeBytes: size, maxBytes },
          );
        }

        hasher.update(chunk);
        if (headerLen < 64) {
          const slice = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, 64 - headerLen));
          headerChunks.push(slice);
          headerLen += slice.length;
        }

        if (writeStreamError) throw writeStreamError;
        if (!ws.write(chunk)) {
          await once(ws, 'drain');
          if (writeStreamError) throw writeStreamError;
        }
      }

      ws.end();
      await finished(ws);
      if (writeStreamError) throw writeStreamError;

      const headerBuf = headerChunks.length ? Buffer.concat(headerChunks) : Buffer.alloc(0);
      const responseMime = response.headers.get('content-type') ?? undefined;
      const extension = detectExtension(
        headerBuf,
        item.filename ?? currentUrl.pathname,
        item.content_type || responseMime,
      );
      const finalName = `${index}-${hasher.digest('hex').slice(0, 12)}.${extension}`;
      const finalPath = join(directory, finalName);
      await rename(partPath, finalPath);
      return {
        path: finalPath,
        format: extension,
        sizeBytes: size,
        fileName: sanitizeDisplayFileName(item.filename, finalName),
      };
    } catch (error) {
      await reader.cancel().catch(() => {});
      await destroyAndCleanupTempFile(ws, partPath);
      throw error;
    }
  } finally {
    clearTimeout(overallTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function copyStagedAttachment(
  root: string,
  file: string,
  directory: string,
  index: number,
  options: { maxBytes?: number } = {},
): Promise<SavedAttachment> {
  const source = await safeArtifact(root, file, {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES,
  });
  const path = join(directory, `${index}-${basename(source.localPath)}`);
  await mkdir(directory, { recursive: true });
  await copyFile(source.localPath, path);
  const ext = extname(source.localPath).toLowerCase();
  return {
    path,
    format: /^\.[a-z0-9]{1,12}$/.test(ext) ? ext.slice(1) : 'bin',
    sizeBytes: source.sizeBytes,
    fileName: source.fileName,
  };
}
