import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.ts';
import type { Observer } from '../src/observe.ts';
import {
  createSlashCommandHandler,
  parseRewindTurnsArg,
  parseSlashCommand,
  parseThinkingEffort,
  readActiveThreadOverride,
  resolveModelFromInput,
  writeActiveThreadOverride,
} from '../src/slash-commands.ts';
import type { ProviderCapabilities } from '../src/slash-commands.ts';

const MOCK_PROVIDERS: ProviderCapabilities[] = [
  {
    providerInstanceId: 'antigravity_cloudstay',
    driverKind: 'antigravity',
    displayName: 'CLOUDSTAY',
    canRunChildTask: true,
    models: [
      {
        id: 'gemini-4-neon',
        label: 'Gemini 4 Neon',
        options: [{ id: 'thought_level', values: ['low', 'medium', 'high', 'xhigh'], default: 'high' }],
      },
      {
        id: 'gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen',
        options: [{ id: 'thought_level', values: ['low', 'medium', 'high', 'xhigh'], default: 'high' }],
      },
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        options: [{ id: 'thought_level', values: ['low', 'medium', 'high'], default: 'medium' }],
      },
    ],
  },
  {
    providerInstanceId: 'codex',
    driverKind: 'codex',
    displayName: 'Team',
    canRunChildTask: true,
    models: [
      {
        id: 'gpt-6.2-sol',
        label: 'GPT 6.2 Sol',
        options: [{ id: 'reasoningEffort', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' }],
      },
    ],
  },
];

test('parseSlashCommand recognizes all commands, aliases, and ignores attachments or unknown commands', () => {
  assert.deepEqual(parseSlashCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseSlashCommand('/?'), { name: 'help', args: '' });
  assert.deepEqual(parseSlashCommand('/m 4h xhigh'), { name: 'model', args: '4h xhigh' });
  assert.deepEqual(parseSlashCommand('/t xh'), { name: 'think', args: 'xh' });
  assert.deepEqual(parseSlashCommand('/p codex'), { name: 'provider', args: 'codex' });
  assert.deepEqual(parseSlashCommand('/reset 新话题'), { name: 'new', args: '新话题' });
  assert.deepEqual(parseSlashCommand('/撤回 2'), { name: 'rewind', args: '2' });
  assert.deepEqual(parseSlashCommand('/stop'), { name: 'cancel', args: '' });
  assert.deepEqual(parseSlashCommand('/upgrade'), { name: 'update', args: '' });
  assert.deepEqual(parseSlashCommand('/compact 保留重点'), { name: 'compact', args: '保留重点' });
  assert.equal(parseSlashCommand('/unknown foo'), null);
  assert.equal(parseSlashCommand('/new', true), null);
  assert.equal(parseSlashCommand('hello /new'), null);
});

test('resolveModelFromInput supports indices, shorthands, effort combos, and cross-provider syntax', () => {
  const byIdx = resolveModelFromInput('2', MOCK_PROVIDERS, 'antigravity_cloudstay');
  assert.equal(byIdx.match?.model.id, 'gemini-4-hydrogen');

  const byShort = resolveModelFromInput('4h xhigh', MOCK_PROVIDERS, 'antigravity_cloudstay');
  assert.equal(byShort.match?.model.id, 'gemini-4-hydrogen');
  assert.equal(byShort.match?.inferredEffort, 'xhigh');

  const byCompact = resolveModelFromInput('4nl', MOCK_PROVIDERS, 'antigravity_cloudstay');
  assert.equal(byCompact.match?.model.id, 'gemini-4-neon');
  assert.equal(byCompact.match?.inferredEffort, 'low');

  const byDash = resolveModelFromInput('3.8f-h', MOCK_PROVIDERS, 'antigravity_cloudstay');
  assert.equal(byDash.match?.model.id, 'gemini-3.8-flash');
  assert.equal(byDash.match?.inferredEffort, 'high');

  const byCross = resolveModelFromInput('codex/sol max', MOCK_PROVIDERS, 'antigravity_cloudstay');
  assert.equal(byCross.match?.provider.providerInstanceId, 'codex');
  assert.equal(byCross.match?.model.id, 'gpt-6.2-sol');
  assert.equal(byCross.match?.inferredEffort, 'max');

  assert.equal(parseThinkingEffort('xh'), 'xhigh');
  assert.equal(parseThinkingEffort('invalid'), null);
});

test('parseRewindTurnsArg validates range 1..10 and optional --files flag', () => {
  assert.deepEqual(parseRewindTurnsArg(''), { turns: 1, restoreFiles: false });
  assert.deepEqual(parseRewindTurnsArg('3'), { turns: 3, restoreFiles: false });
  assert.deepEqual(parseRewindTurnsArg('--files'), { turns: 1, restoreFiles: true });
  assert.deepEqual(parseRewindTurnsArg('2 --files'), { turns: 2, restoreFiles: true });
  assert.deepEqual(parseRewindTurnsArg('--files 2'), { turns: 2, restoreFiles: true });
  assert.ok(parseRewindTurnsArg('0').error);
  assert.ok(parseRewindTurnsArg('11').error);
  assert.ok(parseRewindTurnsArg('abc').error);
  assert.ok(parseRewindTurnsArg('1 2').error);
});

test('createSlashCommandHandler executes /model, /think, /new, /threads, /use, /rewind, /stop, and /compact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-qqbot-slash-'));
  try {
    const cfg = parseConfig(
      {
        stateDir: join(dir, 'state'),
        t3: { origin: 'http://127.0.0.1:3773' },
        bridge: { port: 18773 },
        bindings: [{ scope: 'c2c:U1', workspace: dir, threadId: 'thread-main' }],
      },
      join(dir, 'config.json'),
    );
    const binding = cfg.bindings[0];
    const replies: string[] = [];
    const calls: { name: string; args: any }[] = [];

    const mockObserver = {
      call: async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === 'orchestrator_capabilities') return { providers: MOCK_PROVIDERS };
        if (name === 't3_thread_configure') {
          if (args.modelSelection) return { ok: true };
          return {
            threadId: args.threadId,
            modelSelection: {
              instanceId: 'antigravity_cloudstay',
              model: 'gemini-4-neon',
              options: [{ id: 'thought_level', value: 'high' }],
            },
          };
        }
        if (name === 't3_project_list') return { projects: [{ id: 'proj-1', workspaceRoot: dir }] };
        if (name === 't3_thread_launch') return { threadId: 'thread-new-1' };
        if (name === 't3_thread_list') {
          return {
            threads: [
              { threadId: 'thread-new-1', title: 'New Chat', status: 'idle' },
              { threadId: 'thread-main', title: 'Main Chat', status: 'idle' },
            ],
          };
        }
        if (name === 't3_thread_transfer') return { threadId: 'thread-rewound-1' };
        if (name === 't3_thread_interrupt') return { ok: true };
        return {};
      },
      read: async (threadId: string) => ({
        items: [],
        recentRuns: [
          { runId: 'run-3', status: 'completed' },
          { runId: 'run-2', status: 'completed' },
          { runId: 'run-1', status: 'completed' },
        ],
        thread: { threadId, itemCount: 12, pendingRequestCount: 0, pendingBackgroundTasks: [] },
      }),
    } as unknown as Observer;

    const rollbackCalls: { threadId: string; turns: number; restoreFiles: boolean }[] = [];
    const handler = createSlashCommandHandler({
      config: cfg,
      observer: mockObserver,
      stateDir: cfg.stateDir,
      sendReply: async text => {
        replies.push(text);
      },
      resolveActiveThread: async b => (await readActiveThreadOverride(cfg.stateDir, b.scopeHash)) ?? b.threadId!,
      setActiveThreadOverride: (b, id) => writeActiveThreadOverride(cfg.stateDir, b.scopeHash, id),
      rollbackTurns: async (threadId, turns, restoreFiles) => {
        rollbackCalls.push({ threadId, turns, restoreFiles });
        return {
          threadId,
          rolledBackTurns: turns,
          remainingTurns: 2,
          targetOrdinal: 2,
          checkpointId: 'cp-2',
          restoreFiles,
        };
      },
    });

    assert.equal(await handler({ name: 'help', args: '' }, binding, 'c2c:U1'), 'handled');
    assert.match(replies.at(-1)!, /\/model/);

    assert.equal(await handler({ name: 'model', args: '4h xhigh' }, binding, 'c2c:U1'), 'handled');
    const cfgCall = calls.find(c => c.name === 't3_thread_configure' && c.args.modelSelection);
    assert.equal(cfgCall?.args.modelSelection.model, 'gemini-4-hydrogen');
    assert.deepEqual(cfgCall?.args.modelSelection.options, [{ id: 'thought_level', value: 'xhigh' }]);

    assert.equal(await handler({ name: 'think', args: 'l' }, binding, 'c2c:U1'), 'handled');
    assert.match(replies.at(-1)!, /low/);

    assert.equal(await handler({ name: 'new', args: '测试新对话' }, binding, 'c2c:U1'), 'handled');
    assert.equal(await readActiveThreadOverride(cfg.stateDir, binding.scopeHash), 'thread-new-1');

    assert.equal(await handler({ name: 'threads', args: '' }, binding, 'c2c:U1'), 'handled');
    assert.equal(await handler({ name: 'use', args: '2' }, binding, 'c2c:U1'), 'handled');
    assert.equal(await readActiveThreadOverride(cfg.stateDir, binding.scopeHash), 'thread-main');

    assert.equal(await handler({ name: 'rewind', args: '1' }, binding, 'c2c:U1'), 'handled');
    assert.deepEqual(rollbackCalls, [{ threadId: 'thread-main', turns: 1, restoreFiles: false }]);
    assert.equal(await readActiveThreadOverride(cfg.stateDir, binding.scopeHash), 'thread-main');
    assert.match(replies.at(-1)!, /原地撤回最近 1 轮/);

    assert.equal(await handler({ name: 'use', args: 'main' }, binding, 'c2c:U1'), 'handled');
    assert.equal(await readActiveThreadOverride(cfg.stateDir, binding.scopeHash), undefined);

    assert.equal(await handler({ name: 'cancel', args: '' }, binding, 'c2c:U1'), 'handled');
    assert.ok(calls.some(c => c.name === 't3_thread_interrupt'));

    assert.equal(await handler({ name: 'compact', args: '' }, binding, 'c2c:U1'), 'passthrough');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
