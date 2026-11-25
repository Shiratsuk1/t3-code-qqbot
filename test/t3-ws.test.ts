import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { Observer } from '../src/observe.ts';
import { dispatchMessage, readReply } from '../src/t3-ws.ts';

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
