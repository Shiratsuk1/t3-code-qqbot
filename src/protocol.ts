import { createHash } from 'node:crypto';
import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Attachment } from './types.ts';

export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const digestBuffer = (value: string | Uint8Array): Buffer =>
  createHash('sha256').update(value).digest();

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.silk': 'audio/silk',
  '.amr': 'audio/amr',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

export function mimeFromExtension(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isInsideBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export async function safeArtifact(root: string, file: string): Promise<{
  localPath: string;
  fileType: 1 | 3 | 4;
  fileName: string;
}> {
  if (!file || typeof file !== 'string' || file.includes('\0')) {
    throw new Error('Invalid artifact path');
  }
  // Block Windows UNC / device namespace paths before any filesystem call (prevents SMB/NTLM leaks)
  if (/^(\\\\|\/\/)/.test(file)) {
    throw new Error('Artifact is outside this workspace directory');
  }
  const base = await realpath(root);
  const lexicalCandidate = resolve(base, file);
  if (/^(\\\\|\/\/)/.test(lexicalCandidate) || !isInsideBase(base, lexicalCandidate)) {
    throw new Error('Artifact is outside this workspace directory');
  }

  const localPath = await realpath(lexicalCandidate);
  if (!isInsideBase(base, localPath)) {
    throw new Error('Artifact is outside this workspace directory');
  }
  const info = await stat(localPath);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Invalid artifact size or type');
  }
  const extension = extname(localPath).toLowerCase();
  const fileType: 1 | 3 | 4 = ['.png', '.jpg', '.jpeg'].includes(extension)
    ? 1
    : extension === '.silk'
      ? 3
      : 4;
  return { localPath, fileType, fileName: basename(localPath) };
}

export function detectExtension(bytes: Buffer, fallbackName: string): string {
  const header = bytes.subarray(0, 16);
  if (header.length >= 8 && header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'png';
  }
  if (header.length >= 3 && header.subarray(0, 3).toString('hex') === 'ffd8ff') {
    return 'jpg';
  }
  if (
    header.length >= 12 &&
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'wav';
  }
  if (
    header.length >= 9 &&
    header.subarray(header[0] === 2 ? 1 : 0).toString('ascii').startsWith('#!SILK_V3')
  ) {
    return 'silk';
  }
  if (header.length >= 6 && header.toString('ascii', 0, 6) === '#!AMR\n') {
    return 'amr';
  }
  if (header.length >= 3 && header.toString('ascii', 0, 3) === 'ID3') {
    return 'mp3';
  }
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'OggS') {
    return 'ogg';
  }
  const suffix = extname(fallbackName).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(suffix) ? suffix.slice(1) : 'bin';
}

const MAX_ATTACHMENT_REDIRECTS = 2;

function parseAllowedAttachmentUrl(rawUrl: string, hosts: Set<string>): URL {
  const trimmed = rawUrl.trim();
  const normalized = trimmed.startsWith('//')
    ? `https:${trimmed}`
    : !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)
      ? `https://${trimmed}`
      : trimmed;
  const url = new URL(normalized);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !hosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error(`Unrecognized QQ attachment origin: ${url.hostname}`);
  }
  return url;
}

export async function saveAttachment(
  item: Attachment,
  directory: string,
  index: number,
  hosts: Set<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string; format: string }> {
  if (!item.url) throw new Error('Missing QQ attachment URL');
  let currentUrl = parseAllowedAttachmentUrl(item.url, hosts);
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_ATTACHMENT_REDIRECTS; hop++) {
    response = await fetchImpl(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_ATTACHMENT_REDIRECTS) {
        throw new Error(`QQ attachment redirect rejected (HTTP ${response.status})`);
      }
      currentUrl = parseAllowedAttachmentUrl(new URL(location, currentUrl).href, hosts);
      continue;
    }
    break;
  }
  if (!response || !response.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    throw new Error(`QQ attachment HTTP ${response?.status ?? 0}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('QQ attachment exceeds 12 MiB limit');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const extension = detectExtension(bytes, item.filename ?? currentUrl.pathname);
  const path = join(directory, `${index}-${digest(bytes).slice(0, 12)}.${extension}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, bytes);
  return { path, format: extension };
}

export async function copyStagedAttachment(
  root: string,
  file: string,
  directory: string,
  index: number,
): Promise<{ path: string }> {
  const source = await safeArtifact(root, file);
  const path = join(directory, `${index}-${basename(source.localPath)}`);
  await mkdir(directory, { recursive: true });
  await copyFile(source.localPath, path);
  return { path };
}
