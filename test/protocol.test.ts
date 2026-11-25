import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectExtension, digest, mimeFromExtension, safeArtifact, saveAttachment } from '../src/protocol.ts';

test('detectExtension sniffs png, jpg, wav, silk, and falls back cleanly', () => {
  assert.equal(detectExtension(Buffer.from('89504e470d0a1a0a0000', 'hex'), 'unknown'), 'png');
  assert.equal(detectExtension(Buffer.from('ffd8ffe000104a46', 'hex'), 'unknown'), 'jpg');
  assert.equal(detectExtension(Buffer.from('RIFF1234WAVEfmt '), 'voice'), 'wav');
  assert.equal(detectExtension(Buffer.from('\x02#!SILK_V3abc'), 'voice'), 'silk');
  assert.equal(detectExtension(Buffer.from('hello world'), 'report.pdf'), 'pdf');
  assert.equal(detectExtension(Buffer.from('hello world'), 'weird.ext!@#'), 'bin');
});

test('digest supports Buffer directly and matches string hash', () => {
  assert.equal(digest(Buffer.from('hello', 'utf8')), digest('hello'));
});

test('mimeFromExtension maps common media and document extensions', () => {
  assert.equal(mimeFromExtension('photo.PNG'), 'image/png');
  assert.equal(mimeFromExtension('voice.wav'), 'audio/wav');
  assert.equal(mimeFromExtension('doc.pdf'), 'application/pdf');
  assert.equal(mimeFromExtension('archive.unknown'), 'application/octet-stream');
});

test('safeArtifact allows files inside workspace and blocks traversal and UNC paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-art-'));
  const inside = join(dir, 'workspace');
  const outside = join(dir, 'outside.txt');
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, 'chart.png'), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(inside, 'empty.png'), Buffer.alloc(0));
  await writeFile(outside, 'secret');
  try {
    const ok = await safeArtifact(inside, 'chart.png');
    assert.equal(ok.fileType, 1);
    assert.equal(ok.fileName, 'chart.png');

    await assert.rejects(() => safeArtifact(inside, '../outside.txt'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, '../nonexistent-probe.txt'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, '\\\\evil.example.com\\share\\leak.png'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, '//evil.example.com/share/leak.png'), /outside this workspace/);
    await assert.rejects(() => safeArtifact(inside, 'empty.png'), /Invalid artifact size/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveAttachment rejects non-https and non-allowlisted hosts', async () => {
  const hosts = new Set(['multimedia.nt.qq.com']);
  await assert.rejects(
    () => saveAttachment({ url: 'http://multimedia.nt.qq.com/a.png' }, tmpdir(), 0, hosts),
    /Unrecognized QQ attachment origin/,
  );
  await assert.rejects(
    () => saveAttachment({ url: 'https://evil.example.com/a.png' }, tmpdir(), 0, hosts),
    /Unrecognized QQ attachment origin/,
  );
});
