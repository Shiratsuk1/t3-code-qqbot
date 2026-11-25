import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const distDir = join(root, 'dist');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [
    join(root, 'src', 'cli.ts'),
    join(root, 'src', 'bridge.ts'),
    join(root, 'src', 'gateway.ts'),
    join(root, 'src', 'publish.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  outdir: distDir,
  outExtension: { '.js': '.mjs' },
  sourcemap: false,
  logLevel: 'info',
});

if (process.platform !== 'win32') {
  await chmod(join(distDir, 'cli.mjs'), 0o755);
}

for (const entry of ['cli.mjs', 'bridge.mjs', 'gateway.mjs', 'publish.mjs']) {
  execFileSync(process.execPath, ['--check', join(distDir, entry)], { stdio: 'inherit' });
}
console.log('Built and syntax-checked dist/*.mjs');

async function collectEntries(dir, baseDir, out = []) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(baseDir, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push({ abs, rel, isDir: true });
      await collectEntries(abs, baseDir, out);
    } else if (entry.isFile()) {
      out.push({ abs, rel, isDir: false });
    }
  }
  return out;
}

function makeTarHeader(name, size, mode, mtimeSec, isDir) {
  const header = Buffer.alloc(512, 0);
  const fullName = isDir && !name.endsWith('/') ? `${name}/` : name;
  let prefix = '';
  let baseName = fullName;
  if (Buffer.byteLength(fullName) > 100) {
    const idx = fullName.lastIndexOf('/');
    prefix = fullName.slice(0, idx);
    baseName = fullName.slice(idx + 1);
  }
  header.write(baseName, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write((isDir ? 0 : size).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(mtimeSec).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(isDir ? '5' : '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

async function writeNormalizedTarGz(stageDir, bundleName, tarPath) {
  const chunks = [];
  const nowSec = Math.floor(Date.now() / 1000);
  chunks.push(makeTarHeader(bundleName, 0, 0o755, nowSec, true));

  const entries = await collectEntries(stageDir, stageDir);
  for (const entry of entries) {
    const archivePath = `${bundleName}/${entry.rel}`;
    const info = await stat(entry.abs);
    const mtimeSec = Math.floor(info.mtimeMs / 1000);
    if (entry.isDir) {
      chunks.push(makeTarHeader(archivePath, 0, 0o755, mtimeSec, true));
    } else {
      const data = await readFile(entry.abs);
      const mode = entry.rel === 'dist/cli.mjs' ? 0o755 : 0o644;
      chunks.push(makeTarHeader(archivePath, data.length, mode, mtimeSec, false));
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
  await writeFile(tarPath, gz);
}

function writeNormalizedZip(stageDir, bundleName, zipPath) {
  if (process.platform === 'win32') {
    const ps = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stage = '${stageDir.replace(/'/g, "''")}'
$zipPath = '${zipPath.replace(/'/g, "''")}'
$prefix = '${bundleName.replace(/'/g, "''")}'
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($stage.Length).TrimStart('\\','/').Replace('\\','/')
    $entryName = "$prefix/$rel"
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}
`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  } else {
    try {
      execFileSync('zip', ['-rq', zipPath, bundleName], { cwd: resolve(stageDir, '..'), stdio: 'inherit' });
    } catch {
      console.warn('zip command not found on this Linux host; created .tar.gz archive only.');
    }
  }
}

if (process.argv.includes('--package')) {
  const releaseDir = join(root, 'release');
  const bundleName = `${pkg.name}-v${pkg.version}`;
  const stageDir = join(releaseDir, bundleName);

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  const releasePackageJson = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    author: pkg.author,
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    type: pkg.type,
    engines: pkg.engines,
    bin: pkg.bin,
    scripts: {
      start: 'node dist/cli.mjs start',
      login: 'node dist/cli.mjs login',
      config: 'node dist/cli.mjs config',
      service: 'node dist/cli.mjs service',
      bridge: 'node dist/cli.mjs bridge',
      gateway: 'node dist/cli.mjs gateway',
      recover: 'node dist/cli.mjs recover',
      init: 'node dist/cli.mjs init',
      bind: 'node dist/cli.mjs bind',
      doctor: 'node dist/cli.mjs doctor',
    },
    dependencies: pkg.dependencies,
  };

  await writeFile(join(stageDir, 'package.json'), JSON.stringify(releasePackageJson, null, 2) + '\n', 'utf8');

  if (process.platform === 'win32') {
    execFileSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd install --package-lock-only --omit=dev --no-audit --no-fund --install-links=false'],
      { cwd: stageDir, stdio: 'inherit' },
    );
  } else {
    execFileSync('npm', ['install', '--package-lock-only', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: stageDir,
      stdio: 'inherit',
    });
  }

  const filesToCopy = ['LICENSE', 'README.md', 'config.example.json', 'credentials.example.json'];
  for (const rel of filesToCopy) {
    await cp(join(root, rel), join(stageDir, rel));
  }
  await cp(distDir, join(stageDir, 'dist'), { recursive: true });
  await cp(join(root, 'docs'), join(stageDir, 'docs'), { recursive: true });
  await mkdir(join(stageDir, 'scripts'), { recursive: true });
  for (const scriptFile of ['start-windows.ps1', 'install-windows-task.ps1', 't3-code-qqbot.service']) {
    await cp(join(root, 'scripts', scriptFile), join(stageDir, 'scripts', scriptFile));
  }

  const zipPath = join(releaseDir, `${bundleName}.zip`);
  const tarPath = join(releaseDir, `${bundleName}.tar.gz`);
  await rm(zipPath, { force: true });
  await rm(tarPath, { force: true });

  writeNormalizedZip(stageDir, bundleName, zipPath);
  await writeNormalizedTarGz(stageDir, bundleName, tarPath);

  console.log(`Packaged release artifacts in ${releaseDir}:`);
  console.log(`  - ${zipPath}`);
  console.log(`  - ${tarPath}`);
}
