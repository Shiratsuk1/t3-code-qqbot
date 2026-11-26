import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { APP_VERSION, isMainModule, isSameOrInsidePath, loadConfig, loadCredentials } from './config.ts';
import { Observer } from './observe.ts';
import { digest, safeArtifact } from './protocol.ts';
import { T3Cli } from './t3-cli.ts';
import type { PersistedRunRecord, ResolvedBinding, ResolvedPluginConfig } from './types.ts';

export const MEDIA_TOOL_DEFINITION = {
  name: 'qqbot_send_media',
  description: 'Send a local file from the bound QQ workspace back to the active QQ conversation.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description: 'Local output file path inside the current bound T3 workspace.',
      },
      caption: {
        type: 'string',
        description: 'Optional caption accompanying the file.',
      },
    },
  },
};

export type McpRequest = {
  id?: string | number | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: { path?: string; caption?: string };
  };
};

async function resolveBindingThreadId(config: ResolvedPluginConfig, binding: ResolvedBinding): Promise<string | undefined> {
  // Prefer runtime thread override (created by /new, /use, or /rewind) over static config binding.threadId
  const persisted = await readFile(join(config.stateDir, 'bindings', `${binding.scopeHash}.thread`), 'utf8').catch(
    error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    },
  );
  if (persisted.trim()) return persisted.trim();
  return binding.threadId;
}

export function createMediaPublisher(config: ResolvedPluginConfig) {
  const t3Cli = new T3Cli(config.t3);
  const readOnly = new Observer(
    config.t3.origin,
    () =>
      t3Cli.issueSession({
        scopes: ['orchestration:read'],
        subject: 'mcp-client',
        ttl: '1h',
        label: 'T3 QQBot media tool',
      }),
    sessionId => t3Cli.revokeSession(sessionId),
  );

  let cachedBotKey = '';
  let cachedBot: QQBot | null = null;

  return async function publishMedia(args: { path?: string; caption?: string } | undefined) {
    if (!args?.path || typeof args.path !== 'string') {
      throw new Error('Missing required "path" argument');
    }
    const cwd = await realpath(process.cwd());
    const matchingBindings: { binding: ResolvedBinding; workspace: string }[] = [];
    for (const binding of config.bindings) {
      const workspace = await realpath(binding.workspace).catch(() => null);
      if (workspace && isSameOrInsidePath(cwd, workspace)) {
        matchingBindings.push({ binding, workspace });
      }
    }
    if (matchingBindings.length === 0) {
      throw new Error('The QQ media tool can only be used inside a bound QQ workspace');
    }
    // Prefer deepest (most specific) workspace first
    matchingBindings.sort((a, b) => b.workspace.length - a.workspace.length);

    const activeMatches: { route: PersistedRunRecord; workspace: string }[] = [];

    for (const { binding, workspace } of matchingBindings) {
      const threadId = await resolveBindingThreadId(config, binding);
      if (!threadId) continue;
      let runId: string | null | undefined;
      try {
        const current = (await readOnly.read(threadId)).thread;
        runId = current.activeRunId;
      } catch {
        // Ignore deleted/unreadable sibling thread and keep scanning
        continue;
      }
      if (!runId) continue;
      const routePath = join(config.stateDir, digest(runId) + '.run.json');
      const rawRoute = await readFile(routePath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      if (!rawRoute) continue;
      const route = JSON.parse(rawRoute) as PersistedRunRecord;
      if (route.thread === threadId && route.runId === runId && route.scopeHash === binding.scopeHash) {
        activeMatches.push({ route, workspace });
      }
    }

    if (activeMatches.length === 0) {
      throw new Error('No active QQ turn found for this workspace');
    }
    if (activeMatches.length > 1) {
      throw new Error(
        'Multiple QQ conversations in this workspace are active simultaneously; bind separate workspaces per QQ chat to avoid ambiguity.',
      );
    }

    const { route: matchedRoute, workspace: matchedWorkspace } = activeMatches[0];
    // Resolve relative paths from cwd, then strictly jail inside matchedWorkspace
    const targetPath = resolve(cwd, args.path);
    const file = await safeArtifact(matchedWorkspace, targetPath, {
      maxBytes: config.attachments.maxOutboundBytes,
    });

    const credentials = await loadCredentials(config, process.env, { requireBridgeSecret: false });
    const botKey = `${credentials.appId}\0${credentials.appSecret}`;
    if (!cachedBot || cachedBotKey !== botKey) {
      cachedBot = new QQBot({ appId: credentials.appId, appSecret: credentials.appSecret });
      cachedBotKey = botKey;
    }
    const outcome = await cachedBot.sendMedia({
      ...file,
      target: matchedRoute.reply,
      ...(typeof args.caption === 'string' ? { content: args.caption } : {}),
    });
    if (!outcome.message?.id) {
      throw new Error('QQ did not confirm media delivery');
    }
    return { content: [{ type: 'text', text: `File "${file.fileName}" delivered to QQ.` }] };
  };
}

export async function handleMcpRequest(
  request: unknown,
  publishFn: (args: { path?: string; caption?: string } | undefined) => Promise<unknown>,
): Promise<object | null> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }
  const req = request as McpRequest;
  if (req.id === undefined) return null;
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion === '2024-11-05' ? '2024-11-05' : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 't3-code-qqbot-media', version: APP_VERSION },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [MEDIA_TOOL_DEFINITION] } };
  }
  if (method === 'tools/call') {
    if (params?.name !== MEDIA_TOOL_DEFINITION.name) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${String(params?.name ?? '')}` },
      };
    }
    try {
      const result = await publishFn(params?.arguments);
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'QQ media delivery failed' }],
        },
      };
    }
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' },
  };
}

export async function runPublishServer(configPath: string): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let cachedPublisher: ReturnType<typeof createMediaPublisher> | null = null;

  const getPublisher = async () => {
    if (!cachedPublisher) {
      const config = await loadConfig(configPath);
      cachedPublisher = createMediaPublisher(config);
    }
    return cachedPublisher;
  };

  for await (const rawLine of input) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n',
      );
      continue;
    }
    const response = await handleMcpRequest(parsed, async args => {
      const publisher = await getPublisher();
      return publisher(args);
    });
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  }
}

if (isMainModule(import.meta.url)) {
  const configPath = process.argv[2] || process.env.T3_QQBOT_CONFIG || resolve('config.json');
  runPublishServer(configPath).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
