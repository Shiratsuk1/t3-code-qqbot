#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assetDir = fileURLToPath(new URL('../assets/', import.meta.url));
const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const [option, directory, ...extra] = process.argv.slice(2);
if (option && (option !== '--preview-dir' || !directory || extra.length)) {
  throw new Error('用法：node scripts/render-assets.mjs [--preview-dir <目录>]');
}
const previewDir = directory ? resolve(directory) : undefined;

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const candidates = process.platform === 'win32'
    ? [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter(Boolean)
        .flatMap(dir => [
          join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ])
    : [
        '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
        '/usr/bin/microsoft-edge', '/snap/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('未找到 Chromium、Chrome 或 Edge，请通过 CHROMIUM_PATH 指定可执行文件。');
  return executable;
}

function encodeIco(images) {
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;

  for (const [index, { size, png }] of images.entries()) {
    const entry = 6 + 16 * index;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = directory[entry];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }

  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

const chromium = findChromium();
const workDir = await mkdtemp(join(tmpdir(), 't3-qqbot-assets-'));
try {
  const jobs = [
    { svg: 'logo', name: 'logo-512', width: 512, height: 512 },
    { svg: 'social-preview', name: 'social-preview-1280x640', width: 1280, height: 640 },
    ...iconSizes.map(size => ({ svg: 'logo', name: `favicon-${size}`, width: size, height: size })),
  ];
  if (previewDir) {
    jobs.push(
      { svg: 'banner-light', name: 'banner-light', width: 1200, height: 320 },
      { svg: 'banner-dark', name: 'banner-dark', width: 1200, height: 320 },
      { svg: 'architecture-overview', name: 'architecture-overview', width: 1280, height: 662 },
    );
  }

  const sources = Object.fromEntries(await Promise.all(
    [...new Set(jobs.map(job => job.svg))].map(async name => [
      name,
      (await readFile(join(assetDir, `${name}.svg`))).toString('base64'),
    ]),
  ));

  // 先解码 SVG，再按目标尺寸绘制到透明 Canvas，保留徽标和卡片的透明边缘。
  const page = join(workDir, 'render.html');
  await writeFile(page, `<!doctype html><meta charset="utf-8"><pre id="result"></pre>
<script type="module">
  const sources = ${JSON.stringify(sources)};
  const jobs = ${JSON.stringify(jobs)};
  const result = document.getElementById('result');
  try {
    const images = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, source]) => {
      const image = new Image();
      image.src = 'data:image/svg+xml;base64,' + source;
      await image.decode();
      return [name, image];
    })));
    const output = Object.fromEntries(jobs.map(({ svg, name, width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(images[svg], 0, 0, width, height);
      return [name, canvas.toDataURL('image/png').split(',')[1]];
    }));
    result.textContent = JSON.stringify(output);
  } catch (error) {
    result.textContent = JSON.stringify({ error: String(error) });
  }
</script>`);

  const dom = execFileSync(chromium, [
    '--headless', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-first-run',
    `--user-data-dir=${join(workDir, 'profile')}`, '--virtual-time-budget=5000',
    '--dump-dom', pathToFileURL(page).href,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true });
  const serialized = dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
  if (!serialized) throw new Error('Chromium 未返回渲染结果。');
  const output = JSON.parse(serialized);
  if (output.error) throw new Error(output.error);
  const pngs = new Map(jobs.map(({ name, width, height }) => {
    const png = Buffer.from(output[name] ?? '', 'base64');
    if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR'
        || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
      throw new Error(`${name} 栅格化失败或尺寸不符。`);
    }
    return [name, png];
  }));

  const images = [
    ['logo-512.png', pngs.get('logo-512')],
    ['social-preview-1280x640.png', pngs.get('social-preview-1280x640')],
    ['favicon.ico', encodeIco(iconSizes.map(size => ({ size, png: pngs.get(`favicon-${size}`) })))],
  ];
  await Promise.all(images.map(([name, contents]) => writeFile(join(assetDir, name), contents)));
  console.log('已生成 logo-512.png、social-preview-1280x640.png 和 favicon.ico。');
  if (previewDir) {
    await mkdir(previewDir, { recursive: true });
    await Promise.all([...pngs].map(([name, png]) => writeFile(join(previewDir, `${name}.png`), png)));
    console.log(`审阅用 PNG 已写入 ${previewDir}`);
  }
} finally {
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
