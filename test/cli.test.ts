import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli.ts';

test('parseArgs handles boolean flags without swallowing -h or positional arguments', () => {
  const res = parseArgs(['init', '--force', '-h']);
  assert.deepEqual(res.positional, ['init']);
  assert.equal(res.flags.get('force'), true);
  assert.equal(res.flags.get('help'), true);

  const bindRes = parseArgs(['bind', '--install-media-mcp', '--scope', 'c2c:abc', '--workspace', '/tmp/p']);
  assert.equal(bindRes.flags.get('install-media-mcp'), true);
  assert.equal(bindRes.flags.get('scope'), 'c2c:abc');
  assert.equal(bindRes.flags.get('workspace'), '/tmp/p');
});

test('cli.ts executes cleanly when invoked through a symlink/junction (Linux/macOS global bin simulation)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-sym-'));
  const targetDir = resolve(import.meta.dirname, '..', 'src');
  const linkDir = join(dir, 'src-link');
  try {
    await symlink(targetDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const out = await new Promise<string>((resolveOut, rejectOut) => {
      execFile(process.execPath, [join(linkDir, 'cli.ts'), '--help'], { timeout: 10_000 }, (err, stdout) => {
        if (err) rejectOut(err);
        else resolveOut(stdout);
      });
    });
    assert.match(out, /t3-code-qqbot v1\.2\.1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
