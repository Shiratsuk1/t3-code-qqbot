import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { APP_VERSION, samePath } from './config.ts';
import type { Observer, ProjectListItem } from './observe.ts';
import type { RollbackResult } from './t3-ws.ts';
import type { ResolvedBinding, ResolvedPluginConfig } from './types.ts';

const execFileAsync = promisify(execFile);

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultrathink';

export type ProviderOptionSpec = {
  id: string;
  values: (string | boolean)[];
  default?: string | boolean;
};

export type ProviderModelSpec = {
  id: string;
  label?: string;
  options?: ProviderOptionSpec[];
};

export type ProviderCapabilities = {
  providerInstanceId: string;
  driverKind: string;
  displayName?: string;
  models: ProviderModelSpec[];
  canRunChildTask?: boolean;
};

export type OrchestratorCapabilities = {
  providers: ProviderCapabilities[];
};

export type ThreadConfigureResult = {
  threadId: string;
  modelSelection?: {
    provider?: string;
    instanceId?: string;
    model?: string;
    options?: { id: string; value: string | boolean }[] | Record<string, string | boolean>;
  };
  runtimeMode?: string;
  interactionMode?: string;
};

export type ParsedSlashCommand = {
  name:
    | 'help'
    | 'status'
    | 'new'
    | 'threads'
    | 'use'
    | 'compact'
    | 'rewind'
    | 'model'
    | 'think'
    | 'provider'
    | 'tasks'
    | 'cancel'
    | 'update';
  args: string;
};

const SLASH_COMMAND_MAP: Record<string, ParsedSlashCommand['name']> = {
  '/help': 'help',
  '/cmd': 'help',
  '/commands': 'help',
  '/menu': 'help',
  '/?': 'help',
  '/status': 'status',
  '/info': 'status',
  '/new': 'new',
  '/reset': 'new',
  '/clear': 'new',
  '/threads': 'threads',
  '/list': 'threads',
  '/use': 'use',
  '/switch': 'use',
  '/compact': 'compact',
  '/rewind': 'rewind',
  '/undo': 'rewind',
  '/撤回': 'rewind',
  '/回溯': 'rewind',
  '/model': 'model',
  '/models': 'model',
  '/m': 'model',
  '/think': 'think',
  '/effort': 'think',
  '/t': 'think',
  '/provider': 'provider',
  '/providers': 'provider',
  '/p': 'provider',
  '/tasks': 'tasks',
  '/cancel': 'cancel',
  '/stop': 'cancel',
  '/update': 'update',
  '/upgrade': 'update',
};

const EFFORT_ALIASES: Record<string, ThinkingEffort> = {
  l: 'low',
  lo: 'low',
  low: 'low',
  min: 'low',
  minimal: 'low',
  m: 'medium',
  med: 'medium',
  mid: 'medium',
  medium: 'medium',
  h: 'high',
  hi: 'high',
  high: 'high',
  xh: 'xhigh',
  xhigh: 'xhigh',
  'extra-high': 'xhigh',
  extra_high: 'xhigh',
  max: 'max',
  ultra: 'ultrathink',
  ultrathink: 'ultrathink',
};

const MODEL_SHORTHANDS: Record<string, string[]> = {
  '4n': ['gemini-4-neon'],
  n4: ['gemini-4-neon'],
  neon: ['gemini-4-neon'],
  '4c': ['gemini-4-carbon', 'gemini-4-neon'],
  c4: ['gemini-4-carbon', 'gemini-4-neon'],
  carbon: ['gemini-4-carbon'],
  '4a': ['gemini-4-argon'],
  a4: ['gemini-4-argon'],
  argon: ['gemini-4-argon'],
  '4h': ['gemini-4-hydrogen'],
  h4: ['gemini-4-hydrogen'],
  hydrogen: ['gemini-4-hydrogen'],
  '3.8f': ['gemini-3.8-flash'],
  '38f': ['gemini-3.8-flash'],
  '3f': ['gemini-3.8-flash'],
  flash: ['gemini-3.8-flash'],
  orch: ['gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator'],
  orchestrator: ['gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator'],
  'orch-n': ['gemini-pro-orchestrator-neon'],
  'orch-c': ['gemini-pro-orchestrator'],
  'orch-a': ['gemini-pro-orchestrator-argon'],
  sonnet: ['claude-sonnet-5-5', 'claude-sonnet-4-6'],
  cs: ['claude-sonnet-5-5', 'claude-sonnet-4-6'],
  opus: ['claude-opus-5-5', 'claude-opus-4-6-thinking'],
  co: ['claude-opus-5-5', 'claude-opus-4-6-thinking'],
  sol: ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol'],
  astra: ['gpt-6.2-astra', 'gpt-6-astra'],
  terra: ['gpt-6.1-terra'],
  gpt: ['gpt-6.2-sol', 'gpt-oss-120b-medium'],
  oss: ['gpt-oss-120b-medium'],
  '120b': ['gpt-oss-120b-medium'],
};

const EFFORT_OPTION_KEYS = ['thought_level', 'reasoningEffort', 'effort'];

export const MAX_REWIND_TURNS = 10;

export function parseSlashCommand(rawText: string, hasAttachments = false): ParsedSlashCommand | null {
  if (hasAttachments) return null;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.search(/\s/);
  const head = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const args = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
  const mapped = SLASH_COMMAND_MAP[head];
  if (!mapped) return null;
  return { name: mapped, args };
}

export function parseThinkingEffort(raw: string | undefined): ThinkingEffort | null {
  if (!raw) return null;
  return EFFORT_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function parseRewindTurnsArg(
  rawArg: string | undefined,
  maxTurns = MAX_REWIND_TURNS,
): { turns?: number; restoreFiles?: boolean; error?: string } {
  const cleaned = rawArg?.trim() ?? '';
  if (!cleaned) return { turns: 1, restoreFiles: false };
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  let restoreFiles = false;
  const positional: string[] = [];
  for (const token of tokens) {
    const low = token.toLowerCase();
    if (low === '--files' || low === '-f' || low === 'files' || low === '文件') {
      restoreFiles = true;
    } else {
      positional.push(token);
    }
  }
  if (positional.length === 0) return { turns: 1, restoreFiles };
  if (positional.length > 1 || !/^\d+$/.test(positional[0])) {
    return {
      error: `无效的撤回参数 "${cleaned}"。请使用正整数（1-${maxTurns}），例如 /rewind、/撤回 2 或 /rewind 1 --files。`,
    };
  }
  const turns = Number.parseInt(positional[0], 10);
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > maxTurns) {
    return {
      error: `单次撤回轮数范围为 1-${maxTurns}，收到 ${positional[0]}。发送 /rewind 默认撤回上一轮。`,
    };
  }
  return { turns, restoreFiles };
}

export function formatSlashHelpText(): string {
  return [
    `T3 Code QQBot 快捷指令面板 (v${APP_VERSION})`,
    '',
    '• /model [代号|编号|provider/model] — 查看或切换主模型（别名 /m）',
    '  简写：4n · 4c · 4a · 4h · 3.8f · sonnet · opus · sol · astra · orch',
    '  支持附带思考强度：如 /model 4h xhigh、/model 4n-low、/model 1',
    '• /think [low|medium|high|xhigh|max] — 切换思考/推理强度（别名 /t，支持 l/m/h/xh）',
    '• /provider [编号|实例ID] — 查看或切换 T3 Provider 账号实例（别名 /p）',
    '• /new [标题] — 在当前项目开新 T3 会话（自动保留模型与强度，别名 /reset）',
    '• /threads — 列出当前项目最近 10 条 T3 会话（别名 /list）',
    '• /use <编号|threadId|main> — 切换到指定历史会话或切回主会话（别名 /switch）',
    '• /rewind [轮数] [--files] — 调用 T3 原生检查点原地撤回最近 1-10 轮（别名 /undo、/撤回；默认仅撤回对话，加 --files 同时还原文件）',
    '• /compact [保留重点] — 透传给当前 T3 会话执行原生上下文压缩',
    '• /status — 查看当前会话 ID、Provider、模型档位、运行状态与后台任务（别名 /info）',
    '• /tasks & /cancel [taskId|all] — 查看后台任务，或中断当前轮次/取消子任务（别名 /stop）',
    '• /update — 检查 GitHub 最新版本并在源码仓库模式下自动拉取重建重启（别名 /upgrade）',
  ].join('\n');
}

export function findEffortOption(model: ProviderModelSpec | undefined): ProviderOptionSpec | undefined {
  if (!model?.options?.length) return undefined;
  return model.options.find(opt => EFFORT_OPTION_KEYS.includes(opt.id));
}

export function normalizeEffortValueForOption(
  effort: ThinkingEffort,
  option: ProviderOptionSpec,
): string | null {
  const stringValues = option.values.filter((v): v is string => typeof v === 'string');
  if (stringValues.includes(effort)) return effort;
  const fallbacks: Record<ThinkingEffort, string[]> = {
    low: ['low', 'medium'],
    medium: ['medium', 'low', 'high'],
    high: ['high', 'medium'],
    xhigh: ['xhigh', 'high', 'max'],
    max: ['max', 'xhigh', 'high'],
    ultrathink: ['ultrathink', 'max', 'xhigh', 'high'],
  };
  for (const candidate of fallbacks[effort]) {
    if (stringValues.includes(candidate)) return candidate;
  }
  return stringValues[0] ?? null;
}

export function extractCurrentEffort(
  options: NonNullable<ThreadConfigureResult['modelSelection']>['options'],
): string | undefined {
  if (!options) return undefined;
  if (Array.isArray(options)) {
    const found = options.find(o => EFFORT_OPTION_KEYS.includes(o.id));
    return found ? String(found.value) : undefined;
  }
  for (const key of EFFORT_OPTION_KEYS) {
    if (key in options) return String(options[key]);
  }
  return undefined;
}

export function resolveModelFromInput(
  rawInput: string,
  providers: ProviderCapabilities[],
  currentInstanceId?: string,
): {
  match?: { provider: ProviderCapabilities; model: ProviderModelSpec; inferredEffort?: ThinkingEffort };
  candidates?: { provider: ProviderCapabilities; model: ProviderModelSpec }[];
} {
  const cleaned = rawInput.trim();
  if (!cleaned) return {};

  const enabledProviders = providers.filter(p => p.models.length > 0 && p.canRunChildTask !== false);
  const activeProvider =
    enabledProviders.find(p => p.providerInstanceId === currentInstanceId) ??
    providers.find(p => p.providerInstanceId === currentInstanceId) ??
    enabledProviders[0] ??
    providers[0];

  // 1. Pure 1-based index in current provider's model list
  if (/^\d+$/.test(cleaned) && activeProvider) {
    const idx = Number.parseInt(cleaned, 10) - 1;
    if (idx >= 0 && idx < activeProvider.models.length) {
      return { match: { provider: activeProvider, model: activeProvider.models[idx] } };
    }
  }

  // 2. Explicit `<provider>/<model> [effort]`
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  let inferredEffort: ThinkingEffort | undefined;
  let modelToken = tokens[0];
  if (tokens.length >= 2) {
    const maybeEffort = parseThinkingEffort(tokens[tokens.length - 1]);
    if (maybeEffort) {
      inferredEffort = maybeEffort;
      modelToken = tokens.slice(0, -1).join(' ');
    }
  }

  let scopedProviders = activeProvider
    ? [activeProvider, ...enabledProviders.filter(p => p.providerInstanceId !== activeProvider.providerInstanceId)]
    : enabledProviders;

  if (modelToken.includes('/')) {
    const [provQuery, restModel] = modelToken.split('/', 2);
    const provLower = provQuery.toLowerCase();
    const matchedProvs = enabledProviders.filter(
      p =>
        p.providerInstanceId.toLowerCase() === provLower ||
        p.driverKind.toLowerCase() === provLower ||
        (p.displayName && p.displayName.toLowerCase() === provLower),
    );
    if (matchedProvs.length > 0 && restModel) {
      scopedProviders = matchedProvs;
      modelToken = restModel;
    }
  }

  // Handle dash/compact effort suffix like `4n-low`, `4h-xh`, `4hl`, `4nl`
  const lowerToken = modelToken.toLowerCase();
  if (!inferredEffort) {
    const lastDash = lowerToken.lastIndexOf('-');
    if (lastDash > 0) {
      const left = lowerToken.slice(0, lastDash);
      const right = lowerToken.slice(lastDash + 1);
      const eff = parseThinkingEffort(right);
      if (eff && MODEL_SHORTHANDS[left]) {
        inferredEffort = eff;
        modelToken = left;
      }
    }
  }
  if (!inferredEffort) {
    const compact = /^(4n|4c|4a|4h|3\.8f|38f|3f)(xh|xhigh|low|med|medium|high|max|l|m|h)$/.exec(lowerToken);
    if (compact) {
      inferredEffort = parseThinkingEffort(compact[2]) ?? undefined;
      modelToken = compact[1];
    }
  }

  const normalizedKey = modelToken.toLowerCase();

  // 3. Exact model id match (current provider prioritized)
  for (const prov of scopedProviders) {
    const exact = prov.models.find(m => m.id.toLowerCase() === normalizedKey);
    if (exact) return { match: { provider: prov, model: exact, inferredEffort } };
  }

  // 4. Shorthand aliases (`4n`, `4c`, `4h`, `3.8f`, `sonnet`, `opus`, `sol`, etc.)
  const aliasTargets = MODEL_SHORTHANDS[normalizedKey];
  if (aliasTargets) {
    for (const targetId of aliasTargets) {
      for (const prov of scopedProviders) {
        const hit = prov.models.find(m => m.id.toLowerCase() === targetId.toLowerCase());
        if (hit) return { match: { provider: prov, model: hit, inferredEffort } };
      }
    }
  }

  // 5. Substring match within active provider first, then across enabled providers
  const findFuzzy = (provs: ProviderCapabilities[]) => {
    const hits: { provider: ProviderCapabilities; model: ProviderModelSpec }[] = [];
    for (const prov of provs) {
      for (const m of prov.models) {
        if (
          m.id.toLowerCase().includes(normalizedKey) ||
          (m.label && m.label.toLowerCase().includes(normalizedKey))
        ) {
          hits.push({ provider: prov, model: m });
        }
      }
    }
    return hits;
  };

  if (activeProvider) {
    const localHits = findFuzzy([activeProvider]);
    if (localHits.length === 1) {
      return { match: { ...localHits[0], inferredEffort } };
    }
    if (localHits.length > 1) return { candidates: localHits };
  }

  const allHits = findFuzzy(scopedProviders);
  if (allHits.length === 1) {
    return { match: { ...allHits[0], inferredEffort } };
  }
  if (allHits.length > 1) return { candidates: allHits.slice(0, 10) };

  return {};
}

export type SlashHandlerDeps = {
  config: ResolvedPluginConfig;
  observer: Observer;
  stateDir: string;
  sendReply: (text: string) => Promise<void>;
  resolveActiveThread: (binding: ResolvedBinding, scope: string) => Promise<string>;
  setActiveThreadOverride: (binding: ResolvedBinding, threadId: string | null) => Promise<void>;
  rollbackTurns: (threadId: string, turns: number, restoreFiles: boolean) => Promise<RollbackResult>;
  triggerGracefulRestart?: () => void;
};

type ThreadListRow = {
  threadId: string;
  title?: string | null;
  status?: string;
  updatedAt?: string;
};

export function createSlashCommandHandler(deps: SlashHandlerDeps) {
  const recentThreadsCache = new Map<string, ThreadListRow[]>();

  const findProject = async (workspace: string): Promise<ProjectListItem> => {
    const { projects } = await deps.observer.call<{ projects: ProjectListItem[] }>('t3_project_list', { limit: 100 });
    const project = projects.find(p => samePath(p.workspaceRoot, workspace));
    if (!project) {
      throw new Error(`工作区 "${workspace}" 未在 T3 Code 中注册。`);
    }
    return project;
  };

  const getCapabilities = () => deps.observer.call<OrchestratorCapabilities>('orchestrator_capabilities', {});

  const getThreadConfig = (threadId: string) =>
    deps.observer.call<ThreadConfigureResult>('t3_thread_configure', { threadId });

  return async function handleSlashCommand(
    cmd: ParsedSlashCommand,
    binding: ResolvedBinding,
    scope: string,
  ): Promise<'handled' | 'passthrough'> {
    if (cmd.name === 'help') {
      await deps.sendReply(formatSlashHelpText());
      return 'handled';
    }

    if (cmd.name === 'compact') {
      await deps.sendReply('正在压缩当前 T3 会话上下文，请稍候…');
      return 'passthrough';
    }

    if (cmd.name === 'update') {
      await handleSelfUpdate(deps);
      return 'handled';
    }

    const threadId = await deps.resolveActiveThread(binding, scope);

    if (cmd.name === 'status') {
      const [cfgRes, snap] = await Promise.all([
        getThreadConfig(threadId).catch(() => null),
        deps.observer.read(threadId).catch(() => null),
      ]);
      const sel = cfgRes?.modelSelection;
      const effort = extractCurrentEffort(sel?.options);
      const pendingTasks = snap?.thread.pendingBackgroundTasks?.length ?? 0;
      const isCustom = Boolean(binding.threadId && binding.threadId !== threadId);
      const lines = [
        'T3 Code QQBot 当前会话状态',
        `• 会话 ID：${threadId}${isCustom ? '（已切换，发 /use main 可回主会话）' : ''}`,
        `• 工作区：${binding.workspace}`,
        `• Provider：${sel?.instanceId ?? sel?.provider ?? snap?.thread.providerInstanceId ?? '(默认)'}`,
        `• 当前模型：${sel?.model ?? '(默认)'}${effort ? ` (思考强度: ${effort})` : ''}`,
        `• 运行状态：${snap?.thread.activeRunId ? `运行中 (${snap.thread.activeRunId})` : '空闲'}`,
        `• 后台任务：${pendingTasks} 个`,
        `• 侧边栏自动收纳：${deps.config.bridge.autoSettleThread ? '开启' : '关闭'}`,
      ];
      await deps.sendReply(lines.join('\n'));
      return 'handled';
    }

    if (cmd.name === 'provider') {
      const caps = await getCapabilities();
      const enabled = caps.providers.filter(p => p.models.length > 0 && p.canRunChildTask !== false);
      const cfgRes = await getThreadConfig(threadId).catch(() => null);
      const currentInstance = cfgRes?.modelSelection?.instanceId ?? cfgRes?.modelSelection?.provider;

      if (!cmd.args) {
        const lines = [
          '可用 T3 Provider 实例',
          `当前实例：${currentInstance ?? '(默认)'}`,
          '',
          ...enabled.map((p, idx) => {
            const mark = p.providerInstanceId === currentInstance ? '👉 ' : '   ';
            return `${mark}[${idx + 1}] ${p.displayName ?? p.providerInstanceId} (${p.providerInstanceId} · ${p.models.length} 个模型)`;
          }),
          '',
          '发送 /provider <编号或实例ID> 切换（例如 /provider 1）。',
        ];
        await deps.sendReply(lines.join('\n'));
        return 'handled';
      }

      const q = cmd.args.trim();
      let picked: ProviderCapabilities | undefined;
      if (/^\d+$/.test(q)) {
        const idx = Number.parseInt(q, 10) - 1;
        picked = enabled[idx];
      } else {
        const low = q.toLowerCase();
        picked =
          enabled.find(p => p.providerInstanceId.toLowerCase() === low) ??
          enabled.find(p => (p.displayName ?? '').toLowerCase() === low) ??
          enabled.find(
            p =>
              p.providerInstanceId.toLowerCase().includes(low) ||
              (p.displayName ?? '').toLowerCase().includes(low),
          );
      }
      if (!picked) {
        await deps.sendReply(`未找到匹配的 Provider "${q}"，发 /provider 查看可用编号。`);
        return 'handled';
      }
      const nextModel = picked.models[0]?.id;
      if (!nextModel) {
        await deps.sendReply(`Provider "${picked.providerInstanceId}" 当前没有可用模型。`);
        return 'handled';
      }
      await deps.observer.call('t3_thread_configure', {
        threadId,
        modelSelection: { instanceId: picked.providerInstanceId, model: nextModel },
      });
      await deps.sendReply(
        `已切换 Provider 为：${picked.displayName ?? picked.providerInstanceId} (${picked.providerInstanceId})\n默认模型：${nextModel}`,
      );
      return 'handled';
    }

    if (cmd.name === 'model') {
      const [caps, cfgRes] = await Promise.all([getCapabilities(), getThreadConfig(threadId).catch(() => null)]);
      const currentInstance = cfgRes?.modelSelection?.instanceId ?? cfgRes?.modelSelection?.provider;
      const currentModel = cfgRes?.modelSelection?.model;
      const currentEffort = extractCurrentEffort(cfgRes?.modelSelection?.options);
      const enabled = caps.providers.filter(p => p.models.length > 0 && p.canRunChildTask !== false);
      const activeProvider =
        enabled.find(p => p.providerInstanceId === currentInstance) ?? enabled[0];

      if (!cmd.args) {
        const lines = [
          '可用模型列表',
          `当前 Provider：${activeProvider?.displayName ?? currentInstance ?? '(默认)'}`,
          `当前模型：${currentModel ?? '(默认)'}${currentEffort ? ` · 思考强度 ${currentEffort}` : ''}`,
          '',
          ...(activeProvider?.models ?? []).map((m, idx) => {
            const mark = m.id === currentModel ? '👉 ' : '   ';
            return `${mark}[${idx + 1}] ${m.label ?? m.id} (${m.id})`;
          }),
          '',
          '快捷切换：/model 1 · /model 4n · /model 4h xhigh · /model 3.8f · /model sol · /model provider/model',
        ];
        await deps.sendReply(lines.join('\n'));
        return 'handled';
      }

      const resolved = resolveModelFromInput(cmd.args, caps.providers, currentInstance);
      if (resolved.candidates?.length) {
        const lines = [
          `找到多个匹配模型，请输入更精确的编号或名称：`,
          ...resolved.candidates.map(c => `• ${c.provider.providerInstanceId}/${c.model.id} (${c.model.label ?? c.model.id})`),
        ];
        await deps.sendReply(lines.join('\n'));
        return 'handled';
      }
      if (!resolved.match) {
        await deps.sendReply(`未匹配到模型 "${cmd.args}"。发送 /model 查看当前可用模型列表。`);
        return 'handled';
      }

      const { provider, model, inferredEffort } = resolved.match;
      const effortOpt = findEffortOption(model);
      const desiredEffort = inferredEffort ?? (parseThinkingEffort(currentEffort) ?? undefined);
      let nextOptions: { id: string; value: string }[] | undefined;
      let appliedEffort: string | undefined;
      if (effortOpt && desiredEffort) {
        const norm = normalizeEffortValueForOption(desiredEffort, effortOpt);
        if (norm) {
          nextOptions = [{ id: effortOpt.id, value: norm }];
          appliedEffort = norm;
        }
      }

      await deps.observer.call('t3_thread_configure', {
        threadId,
        modelSelection: {
          instanceId: provider.providerInstanceId,
          model: model.id,
          ...(nextOptions ? { options: nextOptions } : {}),
        },
      });
      await deps.sendReply(
        `已切换模型：${model.label ?? model.id} (${model.id})\nProvider：${provider.displayName ?? provider.providerInstanceId}${appliedEffort ? `\n思考强度：${appliedEffort}` : ''}`,
      );
      return 'handled';
    }

    if (cmd.name === 'think') {
      const [caps, cfgRes] = await Promise.all([getCapabilities(), getThreadConfig(threadId).catch(() => null)]);
      const currentInstance = cfgRes?.modelSelection?.instanceId ?? cfgRes?.modelSelection?.provider;
      const currentModelId = cfgRes?.modelSelection?.model;
      const currentEffort = extractCurrentEffort(cfgRes?.modelSelection?.options);
      const prov = caps.providers.find(p => p.providerInstanceId === currentInstance);
      const modelSpec = prov?.models.find(m => m.id === currentModelId);
      const effortOpt = findEffortOption(modelSpec);

      if (!cmd.args) {
        const allowed = effortOpt ? effortOpt.values.join(' / ') : 'low / medium / high / xhigh';
        await deps.sendReply(
          `当前思考强度：${currentEffort ?? '默认'}\n当前模型支持档位：${allowed}\n示例：/think low（或 /t l）· /think high · /think xh`,
        );
        return 'handled';
      }

      const parsed = parseThinkingEffort(cmd.args);
      if (!parsed) {
        await deps.sendReply(`无法识别思考强度 "${cmd.args}"。支持：low(l) / medium(m) / high(h) / xhigh(xh) / max。`);
        return 'handled';
      }
      if (!currentModelId) {
        await deps.sendReply('当前会话尚未绑定具体模型，请先发 /model 选定一个模型。');
        return 'handled';
      }
      const optionId = effortOpt?.id ?? 'thought_level';
      const applied = effortOpt ? normalizeEffortValueForOption(parsed, effortOpt) ?? parsed : parsed;

      await deps.observer.call('t3_thread_configure', {
        threadId,
        modelSelection: {
          ...(currentInstance ? { instanceId: currentInstance } : {}),
          model: currentModelId,
          options: [{ id: optionId, value: applied }],
        },
      });
      await deps.sendReply(`已切换思考强度：${applied}（模型：${currentModelId}）`);
      return 'handled';
    }

    if (cmd.name === 'new') {
      const [project, cfgRes] = await Promise.all([
        findProject(binding.workspace),
        getThreadConfig(threadId).catch(() => null),
      ]);
      const title = cmd.args || `QQ ${scope.startsWith('group:') ? '群聊' : '私聊'} ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;
      const created = await deps.observer.call<{ threadId: string }>('t3_thread_launch', {
        projectId: project.id,
        title,
        ...(cfgRes?.modelSelection?.model ? { modelSelection: cfgRes.modelSelection } : {}),
      });
      if (!created?.threadId) throw new Error('T3 Code 未返回新会话 threadId');
      await deps.setActiveThreadOverride(binding, created.threadId);
      await deps.sendReply(
        `已开启全新 T3 会话并自动切换：\n• 新会话 ID：${created.threadId}\n• 标题：${title}\n（旧会话完整保留在 T3 中，发 /threads 或 /use main 可随时切回）`,
      );
      return 'handled';
    }

    if (cmd.name === 'threads') {
      const project = await findProject(binding.workspace);
      const list = await deps.observer.call<{ threads?: ThreadListRow[]; items?: ThreadListRow[] }>('t3_thread_list', {
        projectId: project.id,
        limit: 10,
      });
      const rows = (list.threads ?? list.items ?? []).slice(0, 10);
      recentThreadsCache.set(binding.scopeHash, rows);
      if (rows.length === 0) {
        await deps.sendReply('当前项目下暂无 T3 会话。发送 /new 创建新会话。');
        return 'handled';
      }
      const lines = [
        `当前项目最近 ${rows.length} 条 T3 会话：`,
        '',
        ...rows.map((row, idx) => {
          const mark = row.threadId === threadId ? '👉 ' : '   ';
          return `${mark}[${idx + 1}] ${row.title || '(无标题)'} (${row.status ?? 'idle'})\n      ${row.threadId}`;
        }),
        '',
        '发送 /use <编号或threadId> 切换，或发 /use main 切回配置默认主会话。',
      ];
      await deps.sendReply(lines.join('\n'));
      return 'handled';
    }

    if (cmd.name === 'use') {
      const targetArg = cmd.args.trim();
      if (!targetArg) {
        await deps.sendReply('用法：/use <编号|threadId|main>。先发 /threads 可查看编号列表。');
        return 'handled';
      }
      if (targetArg.toLowerCase() === 'main' || targetArg === '主会话') {
        if (!binding.threadId) {
          await deps.sendReply('config.json 中未配置固定主会话 threadId；请用 /threads 查看后以 /use <编号> 切换。');
          return 'handled';
        }
        await deps.setActiveThreadOverride(binding, null);
        await deps.sendReply(`已切回配置主会话：${binding.threadId}`);
        return 'handled';
      }
      let nextThreadId = targetArg;
      if (/^\d+$/.test(targetArg)) {
        const cached = recentThreadsCache.get(binding.scopeHash);
        const idx = Number.parseInt(targetArg, 10) - 1;
        if (!cached || !cached[idx]) {
          await deps.sendReply('未找到该编号，请先发送 /threads 刷新列表后再执行 /use <编号>。');
          return 'handled';
        }
        nextThreadId = cached[idx].threadId;
      }
      // Verify readable
      const snap = await deps.observer.read(nextThreadId);
      await deps.setActiveThreadOverride(binding, nextThreadId);
      await deps.sendReply(
        `已切换至 T3 会话：${nextThreadId}\n历史条目数：${snap.thread.itemCount ?? snap.items.length}`,
      );
      return 'handled';
    }

    if (cmd.name === 'rewind') {
      const parsed = parseRewindTurnsArg(cmd.args);
      if (parsed.error) {
        await deps.sendReply(parsed.error);
        return 'handled';
      }
      const turns = parsed.turns ?? 1;
      const restoreFiles = parsed.restoreFiles ?? false;
      const res = await deps.rollbackTurns(threadId, turns, restoreFiles);
      const modeLabel = res.restoreFiles ? '对话 + 工作区文件' : '仅对话上下文（不改动工作区文件）';
      const targetDesc = res.targetOrdinal === 0 ? '会话起点' : `第 ${res.targetOrdinal} 轮结束位置`;
      await deps.sendReply(
        `已在当前 T3 会话原地撤回最近 ${res.rolledBackTurns} 轮：\n• 回溯位置：${targetDesc}\n• 撤回模式：${modeLabel}\n• 剩余有效轮次：${res.remainingTurns} 轮`,
      );
      return 'handled';
    }

    if (cmd.name === 'tasks') {
      const snap = await deps.observer.read(threadId, 'activity');
      const pendingTasks = snap.thread.pendingBackgroundTasks ?? [];
      const activeSubagents = snap.items.filter(
        item => item.type === 'subagent' && ['pending', 'running', 'waiting'].includes(item.status),
      );
      if (pendingTasks.length === 0 && activeSubagents.length === 0) {
        await deps.sendReply('当前会话没有正在运行的后台任务。');
        return 'handled';
      }
      const lines = ['当前运行中的后台/委派任务：', ''];
      for (const t of pendingTasks) {
        lines.push(`• ${t.taskId} (${t.kind})`);
      }
      for (const s of activeSubagents) {
        lines.push(`• ${s.itemId} — ${s.title ?? '子任务'} [${s.status}]`);
      }
      lines.push('', '发 /cancel <taskId> 或 /cancel all 可取消，发 /stop 可中断主会话当前轮次。');
      await deps.sendReply(lines.join('\n'));
      return 'handled';
    }

    if (cmd.name === 'cancel') {
      const arg = cmd.args.trim();
      if (!arg) {
        await deps.observer.call('t3_thread_interrupt', {
          threadId,
          reason: 'Stopped by user via QQ /stop command',
        });
        await deps.sendReply('已发送中断指令，停止当前 T3 会话正在执行的轮次。');
        return 'handled';
      }
      if (arg.toLowerCase() === 'all') {
        const snap = await deps.observer.read(threadId);
        const pending = snap.thread.pendingBackgroundTasks ?? [];
        await deps.observer.call('t3_thread_interrupt', { threadId, reason: 'Stopped via QQ /cancel all' }).catch(() => {});
        let cancelled = 0;
        for (const t of pending) {
          await deps.observer.call('task_cancel', { taskId: t.taskId, reason: 'Cancelled via QQ /cancel all' }).catch(() => {});
          cancelled++;
        }
        await deps.sendReply(`已中断主会话并取消 ${cancelled} 个后台委派任务。`);
        return 'handled';
      }
      await deps.observer.call('task_cancel', {
        taskId: arg,
        reason: 'Cancelled by user via QQ /cancel command',
      });
      await deps.sendReply(`已取消后台任务：${arg}`);
      return 'handled';
    }

    return 'passthrough';
  };
}

async function handleSelfUpdate(deps: SlashHandlerDeps): Promise<void> {
  const pkgRoot = resolve(import.meta.dirname, '..');
  const isGitRepo = existsSync(join(pkgRoot, '.git'));

  if (isGitRepo) {
    await deps.sendReply('正在从 GitHub 拉取最新代码并检查更新…');
    const before = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: pkgRoot, windowsHide: true }))
      .stdout.trim();
    await execFileAsync('git', ['pull', '--ff-only'], { cwd: pkgRoot, windowsHide: true, timeout: 60_000 });
    const after = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: pkgRoot, windowsHide: true }))
      .stdout.trim();
    if (before === after) {
      await deps.sendReply(`当前已是最新版本（v${APP_VERSION} · ${after}），无需更新。`);
      return;
    }
    const npmBin = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const npmBuildArgs =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm.cmd install --no-audit --no-fund && npm.cmd run build']
        : ['run', 'build'];
    if (process.platform !== 'win32') {
      await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: pkgRoot,
        windowsHide: true,
        timeout: 120_000,
      });
    }
    await execFileAsync(npmBin, npmBuildArgs, { cwd: pkgRoot, windowsHide: true, timeout: 120_000 });
    await deps.sendReply(`更新完成（${before} -> ${after}），正在热重启桥接服务以加载新版…`);
    if (deps.triggerGracefulRestart) {
      setTimeout(() => deps.triggerGracefulRestart!(), 800);
    }
    return;
  }

  // Non-git installation (npm global or Release ZIP/TAR.GZ): check latest GitHub Release tag
  const res = await fetch('https://api.github.com/repos/Shiratsuk1/t3-code-qqbot/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `t3-code-qqbot/${APP_VERSION}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await deps.sendReply(`当前版本：v${APP_VERSION}。检查 GitHub 最新版本失败 (HTTP ${res.status})。`);
    return;
  }
  const latest = (await res.json()) as { tag_name?: string; html_url?: string };
  const latestTag = latest.tag_name ?? `v${APP_VERSION}`;
  if (latestTag === `v${APP_VERSION}`) {
    await deps.sendReply(`当前已是最新版本：${latestTag}。`);
  } else {
    await deps.sendReply(
      `发现新版本 ${latestTag}（当前 v${APP_VERSION}）！\n• npm 用户升级：npm i -g t3-code-qqbot@latest && t3-qqbot service restart\n• 发布页：${latest.html_url ?? 'https://github.com/Shiratsuk1/t3-code-qqbot/releases'}`,
    );
  }
}

export async function readActiveThreadOverride(stateDir: string, scopeHash: string): Promise<string | undefined> {
  const file = join(stateDir, 'bindings', `${scopeHash}.thread`);
  const text = await readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  return text.trim() || undefined;
}

export async function writeActiveThreadOverride(
  stateDir: string,
  scopeHash: string,
  threadId: string | null,
): Promise<void> {
  const dir = join(stateDir, 'bindings');
  const file = join(dir, `${scopeHash}.thread`);
  if (!threadId) {
    await unlink(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    return;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(file, threadId + '\n', { mode: 0o600 });
}
