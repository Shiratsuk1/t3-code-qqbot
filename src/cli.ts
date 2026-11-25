#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  APP_VERSION,
  DEFAULT_ATTACHMENT_HOSTS,
  isMainModule,
  loadConfig,
  loadCredentials,
  samePath,
  scopeToHash,
} from './config.ts';
import { Observer } from './observe.ts';
import type { ProjectListItem } from './observe.ts';
import { digest } from './protocol.ts';
import { resolveT3Command, T3Cli } from './t3-cli.ts';
import type { RawPluginConfig } from './types.ts';

const BOOLEAN_FLAGS = new Set(['help', 'force', 'install-media-mcp']);

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h') {
      flags.set('help', true);
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const name = token.slice(2);
        if (BOOLEAN_FLAGS.has(name)) {
          flags.set(name, true);
        } else {
          const next = argv[i + 1];
          if (next && !next.startsWith('-')) {
            flags.set(name, next);
            i++;
          } else {
            flags.set(name, true);
          }
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function getSiblingEntry(name: 'bridge' | 'gateway' | 'publish'): string {
  const currentExt = extname(import.meta.filename) === '.mjs' ? '.mjs' : '.ts';
  return join(import.meta.dirname, `${name}${currentExt}`);
}

function printHelp(): void {
  console.log(`t3-code-qqbot v${APP_VERSION} — Cross-platform (Windows & Linux) QQ Bot plugin for T3 Code

Usage:
  t3-qqbot <command> [options]
  node dist/cli.mjs <command> [options]

Commands:
  init [--dir <dir>] [--force]       Create config.json & credentials.json with a random bridgeSecret
  start [--config <path>]            Run both bridge and QQ gateway together (recommended for single-host)
  bridge [--config <path>]           Run only the T3 bridge HTTP server
  gateway [--config <path>]          Run only the QQ official WebSocket gateway
  bind --scope <c2c:...|group:...> [--workspace <path>] [--thread <threadId>] [--install-media-mcp] [--config <path>]
                                     Validate and bind a QQ chat/group to a T3 workspace/thread
  doctor [--config <path>]           Run end-to-end health & connectivity checks
  recover <runId> [--config <path>]  Recover an interrupted QQ reply delivery for an existing T3 runId

Options:
  --config <path>   Path to config.json (default: ./config.json or $T3_QQBOT_CONFIG)
  --help, -h        Show this help
`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cmdInit(flags: Map<string, string | boolean>): Promise<void> {
  const dir = resolve(typeof flags.get('dir') === 'string' ? String(flags.get('dir')) : process.cwd());
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const credsPath = join(dir, 'credentials.json');
  const force = flags.get('force') === true;

  if (!force && (await fileExists(configPath))) {
    console.log(`Skipped existing ${configPath} (use --force to overwrite)`);
  } else {
    const defaultConfig: RawPluginConfig = {
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
      },
      gateway: {
        bridgeUrl: 'http://127.0.0.1:18773/events',
        requireMentionInGroup: true,
        stripPrefix: '',
      },
      attachmentHosts: [...DEFAULT_ATTACHMENT_HOSTS],
      bindings: [],
    };
    await writeFile(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');
    console.log(`Created ${configPath}`);
  }

  if (!force && (await fileExists(credsPath))) {
    console.log(`Skipped existing ${credsPath} (use --force to overwrite)`);
  } else {
    const creds = {
      appId: 'REPLACE_WITH_QQ_BOT_APP_ID',
      appSecret: 'REPLACE_WITH_QQ_BOT_APP_SECRET',
      bridgeSecret: randomBytes(32).toString('hex'),
    };
    await writeFile(credsPath, JSON.stringify(creds, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    console.log(`Created ${credsPath} (generated random 32-byte bridgeSecret)`);
  }

  const detected = await resolveT3Command({ origin: 'http://127.0.0.1:3773', executable: 'auto', prefix: [], env: {} });
  console.log(`Detected T3 CLI: ${detected.executable}${detected.prefix.length ? ' ' + detected.prefix.join(' ') : ''}`);
  console.log('\nNext steps:');
  console.log(`  1. Fill appId and appSecret in "${credsPath}"`);
  console.log(`  2. Run: node "${import.meta.filename}" start --config "${configPath}"`);
  console.log('  3. Send a message to your QQ Bot; copy the printed "c2c:<openid>" from logs');
  console.log(
    `  4. Run: node "${import.meta.filename}" bind --scope c2c:<openid> --workspace "<path>" [--thread <id>] --config "${configPath}"`,
  );
}

async function waitForBridgeOrExit(
  url: string,
  childExitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs = 10_000,
): Promise<{ ready: boolean; exitedEarly?: { code: number | null; signal: NodeJS.Signals | null } }> {
  let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  void childExitPromise.then(info => {
    exitedEarly = info;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitedEarly) return { ready: false, exitedEarly };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      await res.body?.cancel().catch(() => {});
      if (exitedEarly) return { ready: false, exitedEarly };
      if (res.status === 200 || res.status === 503) return { ready: true };
    } catch {
      // Wait for server listen
    }
    await sleep(200);
  }
  return { ready: false, exitedEarly };
}

async function cmdStart(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  await loadCredentials(config);

  const bridgeEntry = getSiblingEntry('bridge');
  const gatewayEntry = getSiblingEntry('gateway');

  console.info(`Starting T3 QQBot bridge (${bridgeEntry})...`);
  const bridgeChild = spawn(process.execPath, [bridgeEntry, config.configPath], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });

  const bridgeExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    bridgeChild.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  const healthUrl = `http://${config.bridge.host === '::1' ? '[::1]' : config.bridge.host}:${config.bridge.port}/health`;
  const startup = await waitForBridgeOrExit(healthUrl, bridgeExitPromise, 10_000);
  if (!startup.ready) {
    if (bridgeChild.exitCode === null && !bridgeChild.killed) {
      bridgeChild.kill('SIGTERM');
    }
    if (startup.exitedEarly) {
      throw new Error(
        `Bridge exited during startup (code=${startup.exitedEarly.code}, signal=${startup.exitedEarly.signal})`,
      );
    }
    throw new Error(`Bridge failed to start listening on ${healthUrl}`);
  }

  console.info(`Starting T3 QQBot gateway (${gatewayEntry})...`);
  const gatewayChild = spawn(process.execPath, [gatewayEntry, config.configPath], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });

  const gatewayExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    gatewayChild.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  let shuttingDown = false;
  const terminateChildren = (fromSigint: boolean) => {
    // On Windows Ctrl+C (SIGINT), the OS delivers CTRL_C_EVENT to the shared console group;
    // give children a brief moment to handle SIGINT cleanly before forcing termination.
    if (process.platform === 'win32' && fromSigint) {
      setTimeout(() => {
        if (bridgeChild.exitCode === null) bridgeChild.kill();
        if (gatewayChild.exitCode === null) gatewayChild.kill();
      }, 1_000).unref();
    } else {
      if (bridgeChild.exitCode === null) bridgeChild.kill('SIGTERM');
      if (gatewayChild.exitCode === null) gatewayChild.kill('SIGTERM');
    }
  };

  await new Promise<void>((resolveRun, rejectRun) => {
    const finish = (error?: Error) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (error) rejectRun(error);
      else resolveRun();
    };

    const shutdownClean = (fromSigint: boolean) => {
      if (shuttingDown) return;
      shuttingDown = true;
      terminateChildren(fromSigint);
      void Promise.race([Promise.all([bridgeExitPromise, gatewayExitPromise]), sleep(2_500)]).then(() => finish());
    };

    const onSigint = () => shutdownClean(true);
    const onSigterm = () => shutdownClean(false);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    void bridgeExitPromise.then(({ code, signal }) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const err = new Error(`Bridge exited unexpectedly (code=${code}, signal=${signal})`);
      console.error(err.message);
      terminateChildren(false);
      void Promise.race([gatewayExitPromise, sleep(2_000)]).then(() => finish(err));
    });

    void gatewayExitPromise.then(({ code, signal }) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const err = new Error(`Gateway exited unexpectedly (code=${code}, signal=${signal})`);
      console.error(err.message);
      terminateChildren(false);
      void Promise.race([bridgeExitPromise, sleep(2_000)]).then(() => finish(err));
    });
  });
}

async function installAntigravityMcp(
  mcpFile: string,
  mcpServerEntry: { command: string; args: string[] },
): Promise<void> {
  const existingRaw = await readFile(mcpFile, 'utf8').catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  });
  const mcpConfig = existingRaw.trim() ? JSON.parse(existingRaw.replace(/^\uFEFF/, '')) : {};
  mcpConfig.mcpServers ??= {};
  await mkdir(dirname(mcpFile), { recursive: true });
  if (existingRaw.trim()) {
    await writeFile(`${mcpFile}.pre-t3-qqbot`, existingRaw, { flag: 'wx' }).catch(err => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    });
  }
  mcpConfig.mcpServers['qqbot-media'] = mcpServerEntry;
  await writeFile(`${mcpFile}.next`, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
  await rename(`${mcpFile}.next`, mcpFile);
}

async function cmdBind(configPath: string, flags: Map<string, string | boolean>): Promise<void> {
  const scope = typeof flags.get('scope') === 'string' ? String(flags.get('scope')).trim() : '';
  const workspaceFlag = typeof flags.get('workspace') === 'string' ? String(flags.get('workspace')).trim() : '';
  const threadId = typeof flags.get('thread') === 'string' ? String(flags.get('thread')).trim() : '';
  const installMediaMcp = flags.get('install-media-mcp') === true;

  if (!scope) {
    throw new Error('Missing --scope (example: --scope c2c:<user_openid> or --scope group:<group_openid>)');
  }
  if (!threadId && !workspaceFlag) {
    throw new Error('Provide either --thread <threadId> or --workspace <path>');
  }
  const scopeHash = scopeToHash(scope);

  const config = await loadConfig(configPath);
  const t3Cli = new T3Cli(config.t3);
  const observer = new Observer(
    config.t3.origin,
    () =>
      t3Cli.issueSession({
        scopes: ['orchestration:read'],
        subject: 'mcp-client',
        ttl: '5m',
        label: 'T3 QQBot bind check',
      }),
    sessionId => t3Cli.revokeSession(sessionId),
  );

  let resolvedWorkspace = workspaceFlag ? resolve(workspaceFlag) : '';
  let providerInstanceId: string | undefined;

  try {
    const { projects } = await observer.call<{ projects: ProjectListItem[] }>('t3_project_list', { limit: 100 });

    if (threadId) {
      const snap = await observer.read(threadId);
      const project = projects.find(row => row.id === snap.thread.projectId);
      if (!project) {
        throw new Error(`Thread "${threadId}" does not match any registered T3 project`);
      }
      if (resolvedWorkspace && !samePath(project.workspaceRoot, resolvedWorkspace)) {
        throw new Error(`Thread "${threadId}" belongs to "${project.workspaceRoot}", not "${resolvedWorkspace}"`);
      }
      resolvedWorkspace = project.workspaceRoot;
      providerInstanceId = snap.thread.providerInstanceId;
    } else {
      const project = projects.find(row => samePath(row.workspaceRoot, resolvedWorkspace));
      if (!project) {
        throw new Error(
          `Workspace "${resolvedWorkspace}" is not registered in T3 Code. Open/register it in T3 Code first.`,
        );
      }
      resolvedWorkspace = project.workspaceRoot;
    }
  } finally {
    await observer.close().catch(() => {});
  }

  const rawText = await readFile(config.configPath, 'utf8');
  const rawJson = JSON.parse(rawText.replace(/^\uFEFF/, '')) as RawPluginConfig;
  rawJson.bindings = Array.isArray(rawJson.bindings) ? rawJson.bindings : [];
  const nextEntry = {
    scope,
    workspace: resolvedWorkspace,
    ...(threadId ? { threadId } : {}),
  };
  const existingIdx = rawJson.bindings.findIndex(item => {
    try {
      return scopeToHash(item.scope) === scopeHash;
    } catch {
      return false;
    }
  });
  if (existingIdx >= 0) {
    rawJson.bindings[existingIdx] = nextEntry;
  } else {
    rawJson.bindings.push(nextEntry);
  }

  const tmpConfig = `${config.configPath}.next`;
  await writeFile(tmpConfig, JSON.stringify(rawJson, null, 2) + '\n', 'utf8');
  await rename(tmpConfig, config.configPath);
  console.log(`Updated binding in ${config.configPath}:`);
  console.log(`  scope:     ${scope}`);
  console.log(`  workspace: ${resolvedWorkspace}`);
  console.log(`  threadId:  ${threadId || '(auto-create on first message)'}`);

  const publishEntry = getSiblingEntry('publish');
  const mcpServerEntry = { command: process.execPath, args: [publishEntry, config.configPath] };
  const t3Home = config.t3.home || process.env.T3CODE_HOME || join(homedir(), '.t3');

  if (installMediaMcp) {
    if (providerInstanceId?.startsWith('antigravity')) {
      const mcpFile = join(
        t3Home,
        'userdata',
        'providers',
        'antigravity',
        digest(providerInstanceId),
        'config',
        'mcp_config.json',
      );
      await installAntigravityMcp(mcpFile, mcpServerEntry);
      console.log(`Registered "qqbot-media" MCP server in ${mcpFile}`);
    } else {
      // Check if Antigravity provider dirs exist when --thread was not specified
      const agyRoot = join(t3Home, 'userdata', 'providers', 'antigravity');
      const agyDirs = await readdir(agyRoot, { withFileTypes: true })
        .then(entries => entries.filter(e => e.isDirectory()).map(e => e.name))
        .catch(() => [] as string[]);
      if (!threadId && agyDirs.length === 1) {
        const mcpFile = join(agyRoot, agyDirs[0], 'config', 'mcp_config.json');
        await installAntigravityMcp(mcpFile, mcpServerEntry);
        console.log(`Registered "qqbot-media" MCP server in ${mcpFile}`);
      } else {
        if (!threadId && agyDirs.length > 1) {
          console.log(
            `\nDetected ${agyDirs.length} Antigravity provider instances under ${agyRoot}. Pass --thread <threadId> with --install-media-mcp to register automatically for that thread's provider, or configure manually:`,
          );
        } else {
          console.log('\nRegister the "qqbot-media" MCP server for your provider:');
        }
        console.log('\nClaude Code / JSON-based MCP clients:');
        console.log(JSON.stringify({ mcpServers: { 'qqbot-media': mcpServerEntry } }, null, 2));
        console.log('\nCodex CLI (~/.codex/config.toml):');
        console.log(`[mcp_servers.qqbot-media]`);
        console.log(`command = ${JSON.stringify(mcpServerEntry.command)}`);
        console.log(`args = ${JSON.stringify(mcpServerEntry.args)}`);
      }
    }
  } else {
    console.log('\nOptional: re-run with --install-media-mcp or add this MCP server so your T3 agent can send files to QQ:');
    console.log(JSON.stringify({ mcpServers: { 'qqbot-media': mcpServerEntry } }, null, 2));
  }
  console.log('\nRestart the bridge to activate the updated binding.');
}

async function cmdDoctor(configPath: string): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(
    `[1/6] Node.js: v${process.versions.node} (${process.platform}/${process.arch}) ${major >= 24 ? 'OK' : 'NEEDS >= 24'}`,
  );
  if (major < 24) throw new Error('Node.js 24+ is required');

  const config = await loadConfig(configPath);
  console.log(`[2/6] Config loaded: ${config.configPath} (${config.bindings.length} binding(s))`);

  await loadCredentials(config);
  console.log('[3/6] Credentials loaded: OK (local check only; QQ OpenAPI & IP whitelist verified on gateway connect)');

  const t3Cli = new T3Cli(config.t3);
  const resolvedCli = await t3Cli.resolve();
  console.log(
    `[4/6] T3 CLI resolved: ${resolvedCli.executable}${resolvedCli.prefix.length ? ' ' + resolvedCli.prefix.join(' ') : ''}`,
  );

  const probe = await fetch(config.t3.origin, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
  if (!probe?.ok) {
    throw new Error(`T3 Code server is unreachable at ${config.t3.origin}. Start T3 Code first.`);
  }
  await probe.body?.cancel();
  console.log(`[5/6] T3 Code server reachable: ${config.t3.origin}`);

  const observer = new Observer(
    config.t3.origin,
    () =>
      t3Cli.issueSession({
        scopes: ['orchestration:read', 'orchestration:operate'],
        subject: 'mcp-client',
        ttl: '5m',
        label: 'T3 QQBot doctor',
      }),
    sessionId => t3Cli.revokeSession(sessionId),
  );

  try {
    if (config.bindings.length === 0) {
      console.log('      Warning: 0 bindings configured. Run `bind` after capturing your scope from logs.');
    }
    for (const binding of config.bindings) {
      if (binding.threadId) {
        const snap = await observer.read(binding.threadId);
        console.log(
          `      Binding ${binding.rawScope} -> thread ${binding.threadId} (project=${snap.thread.projectId}, items=${snap.thread.itemCount}) OK`,
        );
      } else {
        console.log(
          `      Binding ${binding.rawScope} -> workspace ${binding.workspace} (auto-create thread on first message) OK`,
        );
      }
    }

    const probePng = join(tmpdir(), `t3-qqbot-doctor-${process.pid}.png`);
    await writeFile(
      probePng,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X+Xo8AAAAASUVORK5CYII=', 'base64'),
    );
    try {
      const attachment = await observer.upload(probePng, 'doctor-check.png', 'image/png');
      await observer.call('t3_attachment_discard', { attachmentId: attachment.id });
      console.log('[6/6] T3 native attachment upload & discard round-trip: OK');
    } finally {
      await unlink(probePng).catch(() => {});
    }
  } finally {
    await observer.close().catch(() => {});
  }

  console.log('\nAll checks passed.');
}

async function runSibling(entry: 'bridge' | 'gateway', args: string[]): Promise<void> {
  const script = getSiblingEntry(entry);
  let shuttingDown = false;
  await new Promise<void>((resolveDone, rejectDone) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    const forwardSignal = (signal: NodeJS.Signals) => {
      shuttingDown = true;
      if (process.platform !== 'win32' || signal !== 'SIGINT') {
        child.kill(signal);
      }
    };
    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);
    child.once('error', rejectDone);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      if (code === 0 || (shuttingDown && signal)) resolveDone();
      else rejectDone(new Error(`${entry} exited abnormally (code=${code}, signal=${signal})`));
    });
  });
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === 'help' || flags.get('help') === true) {
    printHelp();
    return;
  }

  const configPath = resolve(
    typeof flags.get('config') === 'string'
      ? String(flags.get('config'))
      : process.env.T3_QQBOT_CONFIG || 'config.json',
  );

  if (command === 'init') {
    await cmdInit(flags);
    return;
  }
  if (command === 'start') {
    await cmdStart(configPath);
    return;
  }
  if (command === 'bridge') {
    await runSibling('bridge', [configPath]);
    return;
  }
  if (command === 'gateway') {
    await runSibling('gateway', [configPath]);
    return;
  }
  if (command === 'recover') {
    const runId = positional[1];
    if (!runId) throw new Error('Usage: recover <runId> [--config <path>]');
    await runSibling('bridge', [configPath, '--recover', runId]);
    return;
  }
  if (command === 'bind') {
    await cmdBind(configPath, flags);
    return;
  }
  if (command === 'doctor') {
    await cmdDoctor(configPath);
    return;
  }

  throw new Error(`Unknown command "${command}". Run with --help to see available commands.`);
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
