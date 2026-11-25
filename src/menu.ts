import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_ATTACHMENT_HOSTS,
  loadConfig,
  parseConfig,
  scopeToHash,
} from './config.ts';
import { Observer } from './observe.ts';
import type { ProjectListItem } from './observe.ts';
import { runQrBotLogin } from './qr-login.ts';
import { runServiceCommand } from './service.ts';
import { resolveT3Command, T3Cli } from './t3-cli.ts';
import type { BindingConfig, Credentials, RawPluginConfig } from './types.ts';

export function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.startsWith('REPLACE_WITH_')) return '(placeholder)';
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function createDefaultRawConfig(): RawPluginConfig {
  return {
    stateDir: './state',
    credentialsFile: './credentials.json',
    t3: {
      origin: 'http://127.0.0.1:3773',
      executable: 'auto',
      prefix: [],
      env: {},
    },
    bridge: {
      host: '127.0.0.1',
      port: 18773,
      proactiveBackgroundReports: false,
      maxMessageChars: 1600,
      autoSettleThread: false,
      enableSlashCommands: true,
    },
    gateway: {
      bridgeUrl: 'http://127.0.0.1:18773/events',
      requireMentionInGroup: true,
      stripPrefix: '',
    },
    attachmentHosts: [...DEFAULT_ATTACHMENT_HOSTS],
    bindings: [],
  };
}

export function applyConfigSet(raw: RawPluginConfig, key: string, value: string): RawPluginConfig {
  const next: RawPluginConfig = JSON.parse(JSON.stringify(raw));
  next.t3 ??= { origin: 'http://127.0.0.1:3773' };
  next.bridge ??= { port: 18773 };
  next.gateway ??= {};

  const parseBool = (v: string) => {
    const low = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(low)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(low)) return false;
    throw new Error(`Invalid boolean "${v}". Use true or false.`);
  };

  const parseIntStrict = (v: string, label: string) => {
    const num = Number(v.trim());
    if (!Number.isInteger(num)) throw new Error(`Invalid integer for ${label}: "${v}"`);
    return num;
  };

  switch (key) {
    case 'stateDir':
      next.stateDir = value.trim();
      break;
    case 'credentialsFile':
      next.credentialsFile = value.trim() || undefined;
      break;
    case 't3.origin':
      next.t3.origin = value.trim();
      break;
    case 't3.executable':
      next.t3.executable = value.trim() || 'auto';
      break;
    case 't3.home':
      next.t3.home = value.trim() || undefined;
      break;
    case 't3.muteMobileCompletionThreadId':
      next.t3.muteMobileCompletionThreadId = value.trim() || undefined;
      break;
    case 'bridge.host':
      next.bridge.host = value.trim();
      break;
    case 'bridge.port': {
      const oldPort = next.bridge.port ?? 18773;
      const newPort = parseIntStrict(value, 'bridge.port');
      next.bridge.port = newPort;
      // Keep default gateway.bridgeUrl in sync if it pointed to the old default port
      const oldDefault = `http://${next.bridge.host ?? '127.0.0.1'}:${oldPort}/events`;
      if (!next.gateway.bridgeUrl || next.gateway.bridgeUrl === oldDefault) {
        next.gateway.bridgeUrl = `http://${next.bridge.host ?? '127.0.0.1'}:${newPort}/events`;
      }
      break;
    }
    case 'bridge.maxMessageChars':
      next.bridge.maxMessageChars = parseIntStrict(value, 'bridge.maxMessageChars');
      break;
    case 'bridge.proactiveBackgroundReports':
      next.bridge.proactiveBackgroundReports = parseBool(value);
      break;
    case 'bridge.autoSettleThread':
      next.bridge.autoSettleThread = parseBool(value);
      break;
    case 'bridge.enableSlashCommands':
      next.bridge.enableSlashCommands = parseBool(value);
      break;
    case 'gateway.bridgeUrl':
      next.gateway.bridgeUrl = value.trim();
      break;
    case 'gateway.requireMentionInGroup':
      next.gateway.requireMentionInGroup = parseBool(value);
      break;
    case 'gateway.stripPrefix':
      next.gateway.stripPrefix = value.trim();
      break;
    default:
      throw new Error(
        `Unknown config key "${key}". Supported keys: stateDir, credentialsFile, t3.origin, t3.executable, t3.home, t3.muteMobileCompletionThreadId, bridge.host, bridge.port, bridge.maxMessageChars, bridge.proactiveBackgroundReports, bridge.autoSettleThread, bridge.enableSlashCommands, gateway.bridgeUrl, gateway.requireMentionInGroup, gateway.stripPrefix`,
      );
  }
  return next;
}

async function atomicWriteJson(filePath: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.next`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', mode ? { encoding: 'utf8', mode } : 'utf8');
  await rename(tmpPath, filePath);
}

async function readOrCreateRawConfig(configPath: string): Promise<RawPluginConfig> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as RawPluginConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const created = createDefaultRawConfig();
      await atomicWriteJson(configPath, created);
      console.log(`Created new config file: ${configPath}`);
      return created;
    }
    throw error;
  }
}

function resolveCredsPath(configPath: string, raw: RawPluginConfig): string {
  const rel = raw.credentialsFile || './credentials.json';
  return isAbsolute(rel) ? resolve(rel) : resolve(dirname(resolve(configPath)), rel);
}

async function readCredsSafe(credsPath: string): Promise<Partial<Credentials>> {
  try {
    const raw = await readFile(credsPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<Credentials>;
  } catch {
    return {};
  }
}

async function saveValidatedConfig(configPath: string, raw: RawPluginConfig): Promise<void> {
  parseConfig(raw, configPath);
  await atomicWriteJson(configPath, raw);
}

async function fetchT3ProjectsBestEffort(configPath: string): Promise<ProjectListItem[]> {
  try {
    const cfg = await loadConfig(configPath);
    const t3Cli = new T3Cli(cfg.t3);
    const observer = new Observer(
      cfg.t3.origin,
      () =>
        t3Cli.issueSession({
          scopes: ['orchestration:read'],
          subject: 'mcp-client',
          ttl: '2m',
          label: 'T3 QQBot config menu',
        }),
      id => t3Cli.revokeSession(id),
    );
    try {
      const { projects } = await observer.call<{ projects: ProjectListItem[] }>('t3_project_list', { limit: 100 });
      return projects ?? [];
    } finally {
      await observer.close().catch(() => {});
    }
  } catch {
    return [];
  }
}

export async function runInitWizard(options: {
  dir: string;
  force: boolean;
  nonInteractive: boolean;
  cliEntry: string;
  bindAndInstallMcp?: (args: {
    configPath: string;
    scope: string;
    workspace: string;
    threadId?: string;
    installMediaMcp: boolean;
  }) => Promise<void>;
}): Promise<void> {
  const dir = resolve(options.dir);
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const credsPath = join(dir, 'credentials.json');

  const configExists = await access(configPath).then(() => true, () => false);
  const credsExists = await access(credsPath).then(() => true, () => false);

  const detected = await resolveT3Command({
    origin: 'http://127.0.0.1:3773',
    executable: 'auto',
    prefix: [],
    env: {},
  });

  if (options.nonInteractive || !process.stdin.isTTY) {
    if (!options.force && configExists) {
      console.log(`Skipped existing ${configPath} (use --force to overwrite)`);
    } else {
      await atomicWriteJson(configPath, createDefaultRawConfig());
      console.log(`Created ${configPath}`);
    }
    if (!options.force && credsExists) {
      console.log(`Skipped existing ${credsPath} (use --force to overwrite)`);
    } else {
      await atomicWriteJson(
        credsPath,
        {
          appId: 'REPLACE_WITH_QQ_BOT_APP_ID',
          appSecret: 'REPLACE_WITH_QQ_BOT_APP_SECRET',
          bridgeSecret: randomBytes(32).toString('hex'),
        },
        0o600,
      );
      console.log(`Created ${credsPath} (generated random 32-byte bridgeSecret)`);
    }
    console.log(
      `Detected T3 CLI: ${detected.executable}${detected.prefix.length ? ' ' + detected.prefix.join(' ') : ''}`,
    );
    console.log('\nNext steps:');
    console.log(`  1. Run "t3-qqbot config --config "${configPath}"" or fill appId/appSecret in "${credsPath}"`);
    console.log(`  2. Run "t3-qqbot start --config "${configPath}"" and message your QQ Bot to get your "c2c:<openid>"`);
    console.log(
      `  3. Run "t3-qqbot bind --scope c2c:<openid> --workspace "<path>" --install-media-mcp --config "${configPath}""`,
    );
    console.log(`  4. Run "t3-qqbot service install --config "${configPath}"" to enable background auto-start`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, fallback = ''): Promise<string> => {
    const suffix = fallback ? ` [${fallback}]` : '';
    return (await rl.question(`${prompt}${suffix}: `)).trim();
  };
  const askYesNo = async (prompt: string, defaultYes: boolean): Promise<boolean> => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const ans = (await rl.question(`${prompt} (${hint}): `)).trim().toLowerCase();
    if (!ans) return defaultYes;
    return ['y', 'yes', '1', 'true'].includes(ans);
  };

  try {
    console.log('\n==================================================');
    console.log('  T3 Code QQBot 安装初始化向导');
    console.log('==================================================');
    console.log(`  配置目录: ${dir}`);
    console.log(`  运行平台: ${process.platform}/${process.arch} (Node v${process.versions.node})`);
    console.log(
      `  探测 T3 CLI: ${detected.executable}${detected.prefix.length ? ' ' + detected.prefix.join(' ') : ''}`,
    );

    if (configExists && !options.force) {
      const overwrite = await askYesNo(`\n检测到已存在 ${configPath}，是否重新配置并覆盖?`, false);
      if (!overwrite) {
        console.log('已保留现有配置。随时可运行 "t3-qqbot config" 修改各项设置。');
        return;
      }
    }

    const existingCreds = credsExists ? await readCredsSafe(credsPath) : {};
    let raw = configExists ? await readOrCreateRawConfig(configPath) : createDefaultRawConfig();

    console.log('\n[1/5] QQ Bot 凭据');
    console.log('  [1] 手机 QQ 扫码一键绑定（自动获取 AppID、AppSecret 与你的 user_openid，推荐）');
    console.log('  [2] 手动输入 AppID / AppSecret（或留空稍后补填）');
    const authMode = await ask('  选择凭据配置方式 [1/2]', '1');

    let appIdVal = existingCreds.appId || 'REPLACE_WITH_QQ_BOT_APP_ID';
    let appSecretVal = existingCreds.appSecret || 'REPLACE_WITH_QQ_BOT_APP_SECRET';
    let qrUserOpenid: string | undefined;

    if (authMode === '1') {
      try {
        const qr = await runQrBotLogin();
        appIdVal = qr.appId;
        appSecretVal = qr.appSecret;
        qrUserOpenid = qr.userOpenid;
        console.log(`  扫码绑定成功！AppID: ${maskSecret(appIdVal)}${qrUserOpenid ? ` · 自动获取 openid: c2c:${qrUserOpenid}` : ''}`);
      } catch (error) {
        console.warn(`  扫码未完成 (${error instanceof Error ? error.message : String(error)})，回退到手动输入：`);
        const appIdIn = await ask('  QQ Bot AppID', maskSecret(existingCreds.appId));
        const appSecretIn = await ask('  QQ Bot AppSecret', maskSecret(existingCreds.appSecret));
        if (appIdIn) appIdVal = appIdIn;
        if (appSecretIn) appSecretVal = appSecretIn;
      }
    } else {
      const appIdIn = await ask('  QQ Bot AppID', maskSecret(existingCreds.appId));
      const appSecretIn = await ask('  QQ Bot AppSecret', maskSecret(existingCreds.appSecret));
      if (appIdIn) appIdVal = appIdIn;
      if (appSecretIn) appSecretVal = appSecretIn;
    }

    const finalCreds: Credentials = {
      appId: appIdVal,
      appSecret: appSecretVal,
      bridgeSecret:
        existingCreds.bridgeSecret && !existingCreds.bridgeSecret.startsWith('REPLACE_WITH_')
          ? existingCreds.bridgeSecret
          : randomBytes(32).toString('hex'),
    };
    const credsReady =
      !finalCreds.appId.startsWith('REPLACE_WITH_') && !finalCreds.appSecret.startsWith('REPLACE_WITH_');

    console.log('\n[2/5] T3 Code 连接与本地桥接端口');
    const originIn = await ask('  T3 Code 服务地址', raw.t3?.origin ?? 'http://127.0.0.1:3773');
    if (originIn) raw = applyConfigSet(raw, 't3.origin', originIn);
    const portIn = await ask('  本地桥接监听端口', String(raw.bridge?.port ?? 18773));
    if (portIn) raw = applyConfigSet(raw, 'bridge.port', portIn);

    console.log('\n[3/5] 行为与体验可选项');
    const enableSlash = await askYesNo(
      '  启用 QQ 聊天内斜杠指令面板 (/help, /model, /think, /new, /rewind, /stop 等)?',
      raw.bridge?.enableSlashCommands ?? true,
    );
    raw = applyConfigSet(raw, 'bridge.enableSlashCommands', String(enableSlash));

    const requireMention = await askYesNo('  群聊中是否必须 @机器人 才响应?', raw.gateway?.requireMentionInGroup ?? true);
    raw = applyConfigSet(raw, 'gateway.requireMentionInGroup', String(requireMention));

    const autoSettle = await askYesNo(
      '  每轮回复后是否自动收起 T3 侧边栏中的 QQ 会话 (autoSettleThread)?',
      raw.bridge?.autoSettleThread ?? false,
    );
    raw = applyConfigSet(raw, 'bridge.autoSettleThread', String(autoSettle));

    const proactiveBg = await askYesNo(
      '  异步后台子任务是否启用主动消息汇报 (需 QQ 机器人具备主动消息权限)?',
      raw.bridge?.proactiveBackgroundReports ?? false,
    );
    raw = applyConfigSet(raw, 'bridge.proactiveBackgroundReports', String(proactiveBg));

    const muteThreadIn = await ask(
      '  [可选高级项] 补丁版 T3 静音手机完成推送的主会话 threadId (官方版直接回车跳过)',
      raw.t3?.muteMobileCompletionThreadId || '',
    );
    if (muteThreadIn) raw = applyConfigSet(raw, 't3.muteMobileCompletionThreadId', muteThreadIn);

    await saveValidatedConfig(configPath, raw);
    await atomicWriteJson(credsPath, finalCreds, 0o600);
    console.log(`\n已保存配置: ${configPath}`);
    console.log(`已保存凭据: ${credsPath}`);

    console.log('\n[4/5] QQ 会话绑定（可选）');
    const defaultScope = qrUserOpenid ? `c2c:${qrUserOpenid}` : '';
    const scopeInput = await ask(
      defaultScope
        ? '  已通过扫码获取你的私聊 scope（直接回车使用，填 - 跳过）'
        : '  如已知你的 QQ scope (如 c2c:OPENID)，直接输入；尚未获取请回车跳过',
      defaultScope,
    );
    const knownScope = scopeInput === '-' ? '' : scopeInput || defaultScope;
    if (knownScope) {
      const projects = await fetchT3ProjectsBestEffort(configPath);
      let workspace = '';
      if (projects.length > 0) {
        console.log('  检测到 T3 Code 已注册项目:');
        projects.forEach((p, idx) => console.log(`    [${idx + 1}] ${p.title || '(未命名)'} — ${p.workspaceRoot}`));
        const pick = await ask('  输入项目编号或工作区路径');
        const num = Number(pick);
        workspace = Number.isInteger(num) && num >= 1 && num <= projects.length ? projects[num - 1].workspaceRoot : pick;
      } else {
        workspace = await ask('  输入 T3 已注册的项目工作区绝对路径');
      }
      if (workspace) {
        const threadId = await ask('  指定已有 T3 threadId (留空则首次聊天自动新建)');
        const installMcp = await askYesNo('  是否同时配置 qqbot_send_media 媒体回传 MCP 工具?', true);
        if (options.bindAndInstallMcp) {
          try {
            await options.bindAndInstallMcp({
              configPath,
              scope: knownScope,
              workspace,
              threadId: threadId || undefined,
              installMediaMcp: installMcp,
            });
          } catch (error) {
            console.warn(
              `  绑定校验未通过 (${error instanceof Error ? error.message : String(error)})，稍后可运行 "t3-qqbot bind" 完成绑定。`,
            );
          }
        }
      }
    }

    console.log('\n[5/5] 开机自启动与后台自守护');
    const daemonDesc =
      process.platform === 'win32'
        ? 'Windows 隐藏计划任务 + 崩溃自拉起'
        : process.platform === 'linux'
          ? 'Linux systemd --user 常驻服务'
          : '后台自守护服务';
    const wantService = await askYesNo(`  是否立即注册开机自启动与后台自守护 (${daemonDesc})?`, credsReady);
    if (wantService) {
      if (!credsReady) {
        console.log('  检测到 AppID / AppSecret 尚未填写，暂缓注册自启动。填完凭据后运行 "t3-qqbot service install" 即可一键启用。');
      } else {
        try {
          await runServiceCommand('install', { cliEntry: options.cliEntry, configPath });
        } catch (error) {
          console.error(
            `  自守护注册失败: ${error instanceof Error ? error.message : String(error)}。稍后可重试 "t3-qqbot service install"。`,
          );
        }
      }
    }

    if (raw.t3?.muteMobileCompletionThreadId) {
      const tid = raw.t3.muteMobileCompletionThreadId;
      console.log('\n提示：你设置了静音主会话 ID，请在补丁版 T3 Code 启动环境中注入：');
      console.log(`  T3CODE_MUTE_MOBILE_COMPLETION_THREAD_ID=${tid}`);
    }

    console.log('\n初始化完成！常用后续命令：');
    console.log(`  - 修改任意配置:   t3-qqbot config --config "${configPath}"`);
    console.log(`  - 全链路体检:     t3-qqbot doctor --config "${configPath}"`);
    console.log(`  - 前台启动调试:   t3-qqbot start --config "${configPath}"`);
    console.log(`  - 后台守护管理:   t3-qqbot service status|restart|stop --config "${configPath}"`);
  } finally {
    rl.close();
  }
}

export async function runQrLoginCommand(configPath: string): Promise<void> {
  const absPath = resolve(configPath);
  const raw = await readOrCreateRawConfig(absPath);
  const credsPath = resolveCredsPath(absPath, raw);
  const existing = await readCredsSafe(credsPath);
  const qr = await runQrBotLogin();
  const nextCreds: Credentials = {
    appId: qr.appId,
    appSecret: qr.appSecret,
    bridgeSecret:
      existing.bridgeSecret && !existing.bridgeSecret.startsWith('REPLACE_WITH_')
        ? existing.bridgeSecret
        : randomBytes(32).toString('hex'),
  };
  await atomicWriteJson(credsPath, nextCreds, 0o600);
  if (!raw.credentialsFile) {
    raw.credentialsFile = './credentials.json';
    await saveValidatedConfig(absPath, raw);
  }
  console.log(`\n扫码登录成功！凭据已保存至 ${credsPath}`);
  console.log(`  AppID: ${maskSecret(qr.appId)}`);
  if (qr.userOpenid) {
    console.log(`  你的 QQ 私聊 scope: c2c:${qr.userOpenid}`);
    console.log(`  可直接绑定: t3-qqbot bind --scope c2c:${qr.userOpenid} --workspace "<T3项目路径>" --install-media-mcp --config "${absPath}"`);
  }
}

export async function runConfigShow(configPath: string): Promise<void> {
  const absPath = resolve(configPath);
  const exists = await access(absPath).then(() => true, () => false);
  if (!exists) {
    throw new Error(`Config file not found: ${absPath}. Run "t3-qqbot init" or "t3-qqbot config" first.`);
  }
  const raw = await readOrCreateRawConfig(absPath);
  const credsPath = resolveCredsPath(absPath, raw);
  const creds = await readCredsSafe(credsPath);

  console.log(`Config file:      ${absPath}`);
  console.log(`Credentials file: ${credsPath}`);
  console.log(`  appId:          ${maskSecret(creds.appId)}`);
  console.log(`  appSecret:      ${maskSecret(creds.appSecret)}`);
  console.log(`  bridgeSecret:   ${maskSecret(creds.bridgeSecret)}`);
  console.log('\nCurrent config.json:');
  console.log(JSON.stringify(raw, null, 2));
}

export async function runConfigSet(configPath: string, key: string, value: string): Promise<void> {
  const absPath = resolve(configPath);
  const raw = await readOrCreateRawConfig(absPath);
  const updated = applyConfigSet(raw, key, value);
  await saveValidatedConfig(absPath, updated);
  console.log(`Updated "${key}" in ${absPath}`);
}

export async function runConfigMenu(options: {
  configPath: string;
  cliEntry: string;
  runDoctor: (configPath: string) => Promise<void>;
}): Promise<void> {
  const absPath = resolve(options.configPath);
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive menu requires a TTY terminal. Use "t3-qqbot config show" or "t3-qqbot config set <key> <value>" in non-interactive shells.',
    );
  }

  let raw = await readOrCreateRawConfig(absPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (prompt: string, current?: string): Promise<string> => {
    const suffix = current !== undefined ? ` [${current}]` : '';
    const answer = await rl.question(`${prompt}${suffix}: `);
    return answer.trim();
  };

  try {
    while (true) {
      const credsPath = resolveCredsPath(absPath, raw);
      const creds = await readCredsSafe(credsPath);
      const credsReady =
        Boolean(creds.appId && !creds.appId.startsWith('REPLACE_WITH_')) &&
        Boolean(creds.appSecret && !creds.appSecret.startsWith('REPLACE_WITH_')) &&
        Boolean(creds.bridgeSecret && !creds.bridgeSecret.startsWith('REPLACE_WITH_'));

      console.log('\n==================================================');
      console.log('  T3 Code QQBot 配置菜单');
      console.log('==================================================');
      console.log(`  配置文件:   ${absPath}`);
      console.log(`  QQ 凭据:    ${credsReady ? '已配置' : '待填写'} (AppID: ${maskSecret(creds.appId)})`);
      console.log(`  T3 服务:    ${raw.t3?.origin ?? 'http://127.0.0.1:3773'} (CLI: ${raw.t3?.executable || 'auto'})`);
      console.log(`  桥接端口:   ${raw.bridge?.host ?? '127.0.0.1'}:${raw.bridge?.port ?? 18773} (单段上限: ${raw.bridge?.maxMessageChars ?? 1600} 字)`);
      console.log(`  会话绑定:   ${(raw.bindings ?? []).length} 条`);
      console.log(`  侧边栏收纳: ${raw.bridge?.autoSettleThread ? '开启 (autoSettleThread)' : '关闭'} | 静音线程ID: ${raw.t3?.muteMobileCompletionThreadId || '(未设置)'}`);
      console.log('--------------------------------------------------');
      console.log('  [1] 配置 QQ Bot 凭据 (AppID / AppSecret / BridgeSecret)');
      console.log('  [2] 配置 T3 Code 连接 (origin / executable / home)');
      console.log('  [3] 配置桥接与网关参数 (端口 / 分段长度 / 群聊@ / 前缀)');
      console.log('  [4] 管理 QQ 会话绑定 (新增 / 修改 / 删除)');
      console.log('  [5] 管理附件域名白名单 (attachmentHosts)');
      console.log('  [6] 后台自守护服务 (安装 / 状态 / 重启 / 停止 / 卸载)');
      console.log('  [7] 主会话静音与侧边栏收纳 (可选)');
      console.log('  [8] 运行全链路体检 (doctor)');
      console.log('  [9] 查看完整配置摘要');
      console.log('  [0] 退出');
      console.log('--------------------------------------------------');

      const choice = (await rl.question('请选择操作编号 [0-9]: ')).trim();

      if (choice === '0' || choice.toLowerCase() === 'q') {
        console.log('已退出配置菜单。修改已自动保存；若后台服务正在运行，请执行 "t3-qqbot service restart" 使新配置生效。');
        break;
      }

      try {
        if (choice === '1') {
          console.log(`\n--- QQ Bot 凭据 (${credsPath}) ---`);
          const mode = await ask('方式: [1] 手机QQ扫码一键绑定 / [2] 手动填写', '2');
          let nextAppId = creds.appId || 'REPLACE_WITH_QQ_BOT_APP_ID';
          let nextAppSecret = creds.appSecret || 'REPLACE_WITH_QQ_BOT_APP_SECRET';
          if (mode === '1') {
            const qr = await runQrBotLogin();
            nextAppId = qr.appId;
            nextAppSecret = qr.appSecret;
            if (qr.userOpenid) {
              console.log(`扫码获取到你的私聊 scope: c2c:${qr.userOpenid}`);
            }
          } else {
            console.log('直接回车保持原值不变。');
            const inputAppId = await ask('AppID', maskSecret(creds.appId));
            const inputAppSecret = await ask('AppSecret', maskSecret(creds.appSecret));
            if (inputAppId) nextAppId = inputAppId;
            if (inputAppSecret) nextAppSecret = inputAppSecret;
          }
          const regen = await ask('是否重新生成随机 bridgeSecret? (y/N)', 'N');
          const nextCreds: Credentials = {
            appId: nextAppId,
            appSecret: nextAppSecret,
            bridgeSecret:
              regen.toLowerCase() === 'y' || !creds.bridgeSecret || creds.bridgeSecret.startsWith('REPLACE_WITH_')
                ? randomBytes(32).toString('hex')
                : creds.bridgeSecret,
          };
          await atomicWriteJson(credsPath, nextCreds, 0o600);
          if (!raw.credentialsFile) {
            raw.credentialsFile = './credentials.json';
            await saveValidatedConfig(absPath, raw);
          }
          console.log(`已保存凭据到 ${credsPath}`);
        } else if (choice === '2') {
          console.log('\n--- T3 Code 连接配置 ---');
          const origin = await ask('T3 服务地址 (t3.origin)', raw.t3?.origin ?? 'http://127.0.0.1:3773');
          const executable = await ask('T3 CLI 路径 (填 auto 自动探测)', raw.t3?.executable || 'auto');
          const home = await ask('自定义 T3CODE_HOME (留空默认 ~/.t3, 填 - 清除)', raw.t3?.home || '');
          let next = raw;
          if (origin) next = applyConfigSet(next, 't3.origin', origin);
          if (executable) next = applyConfigSet(next, 't3.executable', executable);
          if (home === '-') next = applyConfigSet(next, 't3.home', '');
          else if (home) next = applyConfigSet(next, 't3.home', home);
          await saveValidatedConfig(absPath, next);
          raw = next;
          console.log('已保存 T3 Code 连接配置。');
        } else if (choice === '3') {
          console.log('\n--- 桥接与网关参数 ---');
          const port = await ask('本地桥接端口 (bridge.port)', String(raw.bridge?.port ?? 18773));
          const maxChars = await ask('单条回复最大字数 (100-4000)', String(raw.bridge?.maxMessageChars ?? 1600));
          const slashEnabled = await ask(
            '启用 QQ 聊天内斜杠指令面板 (true/false)',
            String(raw.bridge?.enableSlashCommands ?? true),
          );
          const proactive = await ask(
            '后台子任务允许主动推送 (true/false)',
            String(raw.bridge?.proactiveBackgroundReports ?? false),
          );
          const mention = await ask(
            '群聊是否必须 @机器人 (true/false)',
            String(raw.gateway?.requireMentionInGroup ?? true),
          );
          const stripPrefix = await ask(
            '可选剥离指令前缀 (如 /ai，填 - 清除)',
            raw.gateway?.stripPrefix || '(无)',
          );
          const bridgeUrl = await ask(
            '网关转发目标地址 (gateway.bridgeUrl)',
            raw.gateway?.bridgeUrl || `http://${raw.bridge?.host ?? '127.0.0.1'}:${port || raw.bridge?.port || 18773}/events`,
          );
          let next = raw;
          if (port) next = applyConfigSet(next, 'bridge.port', port);
          if (maxChars) next = applyConfigSet(next, 'bridge.maxMessageChars', maxChars);
          if (slashEnabled) next = applyConfigSet(next, 'bridge.enableSlashCommands', slashEnabled);
          if (proactive) next = applyConfigSet(next, 'bridge.proactiveBackgroundReports', proactive);
          if (mention) next = applyConfigSet(next, 'gateway.requireMentionInGroup', mention);
          if (stripPrefix === '-') next = applyConfigSet(next, 'gateway.stripPrefix', '');
          else if (stripPrefix && stripPrefix !== '(无)') next = applyConfigSet(next, 'gateway.stripPrefix', stripPrefix);
          if (bridgeUrl) next = applyConfigSet(next, 'gateway.bridgeUrl', bridgeUrl);
          await saveValidatedConfig(absPath, next);
          raw = next;
          console.log('已保存桥接与网关参数。');
        } else if (choice === '4') {
          await manageBindingsSubmenu(rl, absPath, raw, updated => {
            raw = updated;
          });
        } else if (choice === '5') {
          const hosts = Array.isArray(raw.attachmentHosts) && raw.attachmentHosts.length > 0
            ? [...raw.attachmentHosts]
            : [...DEFAULT_ATTACHMENT_HOSTS];
          console.log('\n--- 附件下载域名白名单 ---');
          hosts.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
          const action = await ask('操作: [a]添加域名 / [d]删除编号 / [r]恢复默认 / 回车返回');
          if (action.toLowerCase() === 'a') {
            const domain = await ask('输入要添加的 HTTPS 域名 (如 multimedia.nt.qq.com)');
            if (domain) {
              hosts.push(domain.toLowerCase());
              raw.attachmentHosts = [...new Set(hosts)];
              await saveValidatedConfig(absPath, raw);
              console.log('已添加并保存。');
            }
          } else if (action.toLowerCase() === 'd') {
            const idx = Number(await ask('输入要删除的编号')) - 1;
            if (Number.isInteger(idx) && idx >= 0 && idx < hosts.length) {
              hosts.splice(idx, 1);
              raw.attachmentHosts = hosts;
              await saveValidatedConfig(absPath, raw);
              console.log('已删除并保存。');
            }
          } else if (action.toLowerCase() === 'r') {
            raw.attachmentHosts = [...DEFAULT_ATTACHMENT_HOSTS];
            await saveValidatedConfig(absPath, raw);
            console.log('已恢复默认白名单。');
          }
        } else if (choice === '6') {
          console.log('\n--- 后台自守护服务管理 ---');
          console.log('  [1] 安装并立即启动 (service install)');
          console.log('  [2] 查看运行状态 (service status)');
          console.log('  [3] 重启服务 (service restart)');
          console.log('  [4] 停止服务 (service stop)');
          console.log('  [5] 卸载开机自启 (service uninstall)');
          console.log('  [0] 返回上级');
          const svcChoice = (await rl.question('请选择 [0-5]: ')).trim();
          const map: Record<string, string> = {
            '1': 'install',
            '2': 'status',
            '3': 'restart',
            '4': 'stop',
            '5': 'uninstall',
          };
          if (map[svcChoice]) {
            await runServiceCommand(map[svcChoice], {
              cliEntry: options.cliEntry,
              configPath: absPath,
            });
          }
        } else if (choice === '7') {
          console.log('\n--- 主会话静音与侧边栏收纳（可选）---');
          console.log('说明：');
          console.log('  1. autoSettleThread：官方 T3 Code 直接支持，每轮回复后自动将 QQ 会话从侧边栏活跃列表收起（不影响手机完成推送）。');
          console.log('  2. muteMobileCompletionThreadId：仅对支持 T3CODE_MUTE_MOBILE_COMPLETION_THREAD_ID 环境变量的自编译/补丁版 T3 服务端生效，官方原版 T3 Code 目前无法由外部插件屏蔽手机完成推送。');
          const settleAns = await ask(
            '回复完成后自动收起 T3 侧边栏会话 (true/false)',
            String(raw.bridge?.autoSettleThread ?? false),
          );
          const muteAns = await ask(
            '需要静音手机完成推送的主会话 threadId (留空保持，填 - 清除)',
            raw.t3?.muteMobileCompletionThreadId || '',
          );
          let next = raw;
          if (settleAns) next = applyConfigSet(next, 'bridge.autoSettleThread', settleAns);
          if (muteAns === '-') next = applyConfigSet(next, 't3.muteMobileCompletionThreadId', '');
          else if (muteAns) next = applyConfigSet(next, 't3.muteMobileCompletionThreadId', muteAns);
          await saveValidatedConfig(absPath, next);
          raw = next;
          console.log('已保存静音与收纳选项。');
          if (raw.t3?.muteMobileCompletionThreadId) {
            const tid = raw.t3.muteMobileCompletionThreadId;
            console.log('\n请将以下环境变量配置到你的自编译/补丁版 T3 Code 服务端启动环境中并重启 T3 Code：');
            console.log(`  Linux / systemd:    Environment=T3CODE_MUTE_MOBILE_COMPLETION_THREAD_ID=${tid}`);
            console.log(`  Windows PowerShell: $env:T3CODE_MUTE_MOBILE_COMPLETION_THREAD_ID = "${tid}"`);
          }
        } else if (choice === '8') {
          console.log('\n--- 运行全链路体检 ---');
          await options.runDoctor(absPath);
        } else if (choice === '9') {
          console.log('');
          await runConfigShow(absPath);
        } else {
          console.log('无效选项，请输入 0-9。');
        }
      } catch (error) {
        console.error(`\n操作失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function manageBindingsSubmenu(
  rl: ReturnType<typeof createInterface>,
  absPath: string,
  raw: RawPluginConfig,
  onSave: (next: RawPluginConfig) => void,
): Promise<void> {
  const bindings: BindingConfig[] = Array.isArray(raw.bindings) ? [...raw.bindings] : [];
  console.log('\n--- QQ 会话绑定列表 ---');
  if (bindings.length === 0) {
    console.log('  (当前暂无绑定)');
  } else {
    bindings.forEach((b, i) => {
      console.log(`  [${i + 1}] ${b.scope}  ->  ${b.workspace}  (thread: ${b.threadId || '自动创建'})`);
    });
  }
  const op = (await rl.question('操作: [a]新增/更新绑定 / [d]删除绑定 / 回车返回: ')).trim().toLowerCase();
  if (op === 'd') {
    const idx = Number((await rl.question('输入要删除的绑定编号: ')).trim()) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < bindings.length) {
      const removed = bindings.splice(idx, 1)[0];
      const next: RawPluginConfig = { ...raw, bindings };
      await saveValidatedConfig(absPath, next);
      onSave(next);
      console.log(`已删除绑定: ${removed.scope}`);
    }
    return;
  }
  if (op !== 'a') return;

  const scope = (await rl.question('输入 scope (例如 c2c:USER_OPENID 或 group:GROUP_OPENID): ')).trim();
  if (!scope) return;
  const scopeHash = scopeToHash(scope);

  const projects = await fetchT3ProjectsBestEffort(absPath);
  let workspace = '';
  if (projects.length > 0) {
    console.log('\n检测到以下 T3 Code 已注册项目:');
    projects.forEach((p, idx) => console.log(`  [${idx + 1}] ${p.title || '(未命名)'} — ${p.workspaceRoot}`));
    const pick = (await rl.question('输入项目编号，或直接输入完整目录路径: ')).trim();
    const num = Number(pick);
    if (Number.isInteger(num) && num >= 1 && num <= projects.length) {
      workspace = projects[num - 1].workspaceRoot;
    } else {
      workspace = pick;
    }
  } else {
    workspace = (await rl.question('输入 T3 已注册的项目工作区绝对路径: ')).trim();
  }
  if (!workspace) {
    console.log('工作区路径不能为空，已取消。');
    return;
  }

  const threadId = (await rl.question('指定已有 T3 threadId (直接回车则首次聊天自动创建): ')).trim();
  const entry: BindingConfig = {
    scope,
    workspace,
    ...(threadId ? { threadId } : {}),
  };

  const existingIdx = bindings.findIndex(b => {
    try {
      return scopeToHash(b.scope) === scopeHash;
    } catch {
      return false;
    }
  });
  if (existingIdx >= 0) bindings[existingIdx] = entry;
  else bindings.push(entry);

  const next: RawPluginConfig = { ...raw, bindings };
  await saveValidatedConfig(absPath, next);
  onSave(next);
  console.log(`已保存绑定: ${scope} -> ${workspace}`);
}
