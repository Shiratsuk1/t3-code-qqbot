import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { Observer } from '../src/observe.ts';
import {
  dispatchMessage,
  planCheckpointRollback,
  readReply,
  rollbackThreadTurns,
} from '../src/t3-ws.ts';
import type { ThreadRollbackProjection } from '../src/t3-ws.ts';

test('dispatchMessage and readReply stream text and exclude foreground completed subagents from backgroundTaskIds', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let lastAuth = '';
  let dispatchCount = 0;

  wss.on('connection', (socket, req) => {
    lastAuth = String(req.headers.authorization ?? '');
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg._tag === 'Request' && msg.tag === 'orchestration.dispatchCommand') {
        dispatchCount++;
        assert.equal(msg.payload.type, 'message.dispatch');
        assert.equal(msg.payload.dispatchMode.type, 'queue_after_active');
        socket.send(
          JSON.stringify({
            _tag: 'Exit',
            requestId: msg.id,
            exit: { _tag: 'Success', value: { sequence: 10 } },
          }),
        );
      } else if (msg._tag === 'Request' && msg.tag === 'orchestration.getThreadProjection') {
        socket.send(
          JSON.stringify({
            _tag: 'Exit',
            requestId: msg.id,
            exit: {
              _tag: 'Success',
              value: {
                runs: [{ id: 'run-1', userMessageId: 'qq-message:key-1' }],
                turnItems: [],
              },
            },
          }),
        );
      } else if (msg._tag === 'Request' && msg.tag === 'orchestration.subscribeThread') {
        socket.send(
          JSON.stringify({
            _tag: 'Chunk',
            requestId: msg.id,
            values: [
              // Foreground subagent starts and finishes before run completes
              {
                kind: 'event',
                sequence: 11,
                event: {
                  type: 'turn-item.updated',
                  payload: {
                    id: 'sub-fg',
                    runId: 'run-1',
                    ordinal: 1,
                    type: 'subagent',
                    status: 'running',
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
              {
                kind: 'event',
                sequence: 12,
                event: {
                  type: 'turn-item.updated',
                  payload: {
                    id: 'sub-fg',
                    runId: 'run-1',
                    ordinal: 1,
                    type: 'subagent',
                    status: 'completed',
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
              // Background subagent stays running after parent run ends
              {
                kind: 'event',
                sequence: 13,
                event: {
                  type: 'turn-item.updated',
                  payload: {
                    id: 'sub-bg',
                    runId: 'run-1',
                    ordinal: 2,
                    type: 'subagent',
                    status: 'running',
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
              {
                kind: 'event',
                sequence: 14,
                event: {
                  type: 'turn-item.updated',
                  payload: {
                    id: 'item-1',
                    runId: 'run-1',
                    ordinal: 3,
                    type: 'assistant_message',
                    status: 'running',
                    text: '你好，',
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
              {
                kind: 'event',
                sequence: 15,
                event: {
                  type: 'turn-item.updated',
                  payload: {
                    id: 'item-1',
                    runId: 'run-1',
                    ordinal: 3,
                    type: 'assistant_message',
                    status: 'completed',
                    text: '你好，世界！',
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
              {
                kind: 'event',
                sequence: 16,
                event: {
                  type: 'run.updated',
                  payload: {
                    id: 'run-1',
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                  },
                },
              },
            ],
          }),
        );
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const dispatched = await dispatchMessage(origin, 'tok-123', {
      threadId: 'thread-1',
      key: 'key-1',
      text: 'hi',
      attachments: [],
    });
    assert.equal(lastAuth, 'Bearer tok-123');
    assert.equal(dispatchCount, 1);
    assert.deepEqual(dispatched, { runId: 'run-1', sequence: 10 });

    const updates: string[] = [];
    const completed: string[] = [];
    let terminalStatus = '';
    const reply = await readReply(origin, 'tok-123', 'thread-1', 'run-1', {
      afterSequence: 10,
      onUpdate: item => updates.push(item.text),
      onMessage: async item => {
        completed.push(item.text);
      },
      onTerminal: run => {
        terminalStatus = run.status;
      },
    });
    assert.deepEqual(updates, ['你好，']);
    assert.deepEqual(completed, ['你好，世界！']);
    assert.equal(terminalStatus, 'completed');
    assert.equal(reply.body, '你好，世界！');
    assert.equal(reply.status, 'completed');
    assert.deepEqual(reply.backgroundTaskIds, ['sub-bg']);
  } finally {
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Observer reconnects and retries once on HTTP 401 session expiration', async () => {
  let issueCount = 0;
  let toolCalls = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': `sess-${issueCount}` });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.writeHead(204).end();
      return;
    }
    if (body.method === 'tools/call') {
      toolCalls++;
      if (toolCalls === 1) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const observer = new Observer(`http://127.0.0.1:${addr.port}`, async () => {
    issueCount++;
    return { token: `tok-${issueCount}`, sessionId: `auth-${issueCount}` };
  });

  try {
    const res = await observer.call<{ ok: boolean }>('t3_project_list', { limit: 1 });
    assert.deepEqual(res, { ok: true });
    assert.equal(issueCount, 2);
    assert.equal(toolCalls, 2);
  } finally {
    await observer.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('planCheckpointRollback handles baseline, multi-turn, consecutive rollback, active run guard, and --files check', () => {
  const baseProjection: ThreadRollbackProjection = {
    thread: { activeProviderThreadId: 'pt-1' },
    runs: [
      { id: 'run-4', ordinal: 4, status: 'completed' },
      { id: 'run-5', ordinal: 5, status: 'completed' },
      { id: 'run-6', ordinal: 6, status: 'completed' },
    ],
    checkpointScopes: [{ id: 'scope-root', providerThreadId: 'pt-1', kind: 'root_run' }],
    checkpoints: [
      { id: 'cp-0', scopeId: 'scope-root', runId: null, ordinalWithinScope: 0, appRunOrdinal: null, status: 'missing' },
      { id: 'cp-4', scopeId: 'scope-root', runId: 'run-4', ordinalWithinScope: 4, appRunOrdinal: 4, status: 'missing' },
      { id: 'cp-5', scopeId: 'scope-root', runId: 'run-5', ordinalWithinScope: 5, appRunOrdinal: 5, status: 'missing' },
      { id: 'cp-6', scopeId: 'scope-root', runId: 'run-6', ordinalWithinScope: 6, appRunOrdinal: 6, status: 'missing' },
    ],
  };

  // Rewind 1 turn in conversation-only mode works even when checkpoints are 'missing'
  const r1 = planCheckpointRollback(baseProjection, 1, false);
  assert.deepEqual(r1.plan, {
    scopeId: 'scope-root',
    checkpointId: 'cp-5',
    targetOrdinal: 5,
    rolledBackTurns: 1,
    remainingTurns: 2,
    latestRolledBackRunId: 'run-6',
  });

  // Rewind all 3 turns goes to baseline (appRunOrdinal: null)
  const r3 = planCheckpointRollback(baseProjection, 3, false);
  assert.equal(r3.plan?.checkpointId, 'cp-0');
  assert.equal(r3.plan?.targetOrdinal, 0);
  assert.equal(r3.plan?.remainingTurns, 0);

  // Consecutive rewind after run-6 was rolled_back and cp-6 became stale
  const afterOne: ThreadRollbackProjection = {
    ...baseProjection,
    runs: [
      { id: 'run-4', ordinal: 4, status: 'completed' },
      { id: 'run-5', ordinal: 5, status: 'completed' },
      { id: 'run-6', ordinal: 6, status: 'rolled_back' },
    ],
    checkpoints: [
      { id: 'cp-0', scopeId: 'scope-root', runId: null, ordinalWithinScope: 0, appRunOrdinal: null, status: 'missing' },
      { id: 'cp-4', scopeId: 'scope-root', runId: 'run-4', ordinalWithinScope: 4, appRunOrdinal: 4, status: 'missing' },
      { id: 'cp-5', scopeId: 'scope-root', runId: 'run-5', ordinalWithinScope: 5, appRunOrdinal: 5, status: 'missing' },
      { id: 'cp-6', scopeId: 'scope-root', runId: 'run-6', ordinalWithinScope: 6, appRunOrdinal: 6, status: 'stale' },
    ],
  };
  const rNext = planCheckpointRollback(afterOne, 1, false);
  assert.equal(rNext.plan?.checkpointId, 'cp-4');
  assert.equal(rNext.plan?.latestRolledBackRunId, 'run-5');
  assert.equal(rNext.plan?.remainingTurns, 1);

  // Single-turn thread can also rewind to baseline
  const singleTurn: ThreadRollbackProjection = {
    thread: { activeProviderThreadId: 'pt-1' },
    runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }],
    checkpointScopes: [{ id: 'scope-root', providerThreadId: 'pt-1', kind: 'root_run' }],
    checkpoints: [
      { id: 'cp-0', scopeId: 'scope-root', runId: null, ordinalWithinScope: 0, appRunOrdinal: null, status: 'ready' },
      { id: 'cp-1', scopeId: 'scope-root', runId: 'run-1', ordinalWithinScope: 1, appRunOrdinal: 1, status: 'ready' },
    ],
  };
  const rSingle = planCheckpointRollback(singleTurn, 1, false);
  assert.equal(rSingle.plan?.checkpointId, 'cp-0');
  assert.equal(rSingle.plan?.remainingTurns, 0);

  // --files rejected when checkpoints are 'missing'
  const rFilesMissing = planCheckpointRollback(baseProjection, 1, true);
  assert.match(rFilesMissing.error ?? '', /文件快照/);

  // Active running turn blocked with /stop hint
  const runningProj: ThreadRollbackProjection = {
    ...baseProjection,
    runs: [...baseProjection.runs, { id: 'run-7', ordinal: 7, status: 'running' }],
  };
  assert.match(planCheckpointRollback(runningProj, 1, false).error ?? '', /\/stop/);
});

test('rollbackThreadTurns dispatches native checkpoint.rollback and waits for rolled_back confirmation', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let rolledBack = false;
  let dispatchedCommand: any = null;
  let pollCount = 0;

  wss.on('connection', socket => {
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg._tag === 'Request' && msg.tag === 'orchestration.getThreadProjection') {
        pollCount++;
        if (dispatchedCommand && pollCount >= 3) rolledBack = true;
        socket.send(
          JSON.stringify({
            _tag: 'Exit',
            requestId: msg.id,
            exit: {
              _tag: 'Success',
              value: {
                thread: { activeProviderThreadId: 'pt-1', rollbackFailure: null },
                runs: [
                  { id: 'run-1', ordinal: 1, status: 'completed' },
                  { id: 'run-2', ordinal: 2, status: rolledBack ? 'rolled_back' : 'completed' },
                ],
                checkpointScopes: [{ id: 'scope-root', providerThreadId: 'pt-1', kind: 'root_run' }],
                checkpoints: [
                  { id: 'cp-0', scopeId: 'scope-root', runId: null, ordinalWithinScope: 0, appRunOrdinal: null, status: 'missing' },
                  { id: 'cp-1', scopeId: 'scope-root', runId: 'run-1', ordinalWithinScope: 1, appRunOrdinal: 1, status: 'missing' },
                  { id: 'cp-2', scopeId: 'scope-root', runId: 'run-2', ordinalWithinScope: 2, appRunOrdinal: 2, status: rolledBack ? 'stale' : 'missing' },
                ],
              },
            },
          }),
        );
      } else if (msg._tag === 'Request' && msg.tag === 'orchestration.dispatchCommand') {
        dispatchedCommand = msg.payload;
        socket.send(
          JSON.stringify({
            _tag: 'Exit',
            requestId: msg.id,
            exit: { _tag: 'Success', value: { sequence: 99 } },
          }),
        );
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const origin = `http://127.0.0.1:${addr.port}`;

  try {
    const res = await rollbackThreadTurns(origin, 'tok-rb', 'thread-1', {
      turns: 1,
      restoreFiles: false,
      pollIntervalMs: 20,
      timeoutMs: 5_000,
    });
    assert.equal(dispatchedCommand?.type, 'checkpoint.rollback');
    assert.equal(dispatchedCommand?.scopeId, 'scope-root');
    assert.equal(dispatchedCommand?.checkpointId, 'cp-1');
    assert.equal(dispatchedCommand?.restoreFiles, false);
    assert.equal(res.rolledBackTurns, 1);
    assert.equal(res.remainingTurns, 1);
    assert.equal(res.targetOrdinal, 1);
  } finally {
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
