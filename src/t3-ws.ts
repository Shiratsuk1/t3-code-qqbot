import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { LOOPBACK_HOSTS } from './config.ts';
import type { NativeAttachment } from './types.ts';

export const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'rolled_back',
]);

const PENDING_ITEM_STATUSES = new Set(['pending', 'running', 'waiting']);
const DEFAULT_OBSERVE_LIFETIME_MS = 40 * 60_000;
const MAX_CONSECUTIVE_WS_FAILURES = 10;

type Projection = {
  runs: { id: string; userMessageId?: string }[];
  turnItems: { messageId?: string; runId?: string | null }[];
};

export type TurnItem = {
  id: string;
  runId: string | null;
  ordinal: number;
  type: string;
  status: string;
  text?: string;
  updatedAt: string;
};

export type RunState = {
  id: string;
  status: string;
  completedAt: string | null;
};

export type ReplyMessage = {
  id: string;
  text: string;
  updatedAt: string;
};

type StreamItem =
  | {
      kind: 'snapshot';
      snapshotSequence: number;
      projection: {
        turnItems: TurnItem[];
        runs: RunState[];
      };
    }
  | {
      kind: 'event';
      sequence: number;
      event:
        | { type: 'turn-item.updated'; payload: TurnItem }
        | { type: 'run.updated'; payload: RunState };
    }
  | { kind: 'synchronized' };

export function openT3Socket(origin: string, token: string): WebSocket {
  const url = new URL('/ws?orchestrationProtocol=2', origin);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`T3 native WebSocket requires a loopback origin (127.0.0.1 / localhost / ::1), got: ${origin}`);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 5_000,
  });
}

function sendRpc<T>(socket: WebSocket, tag: string, payload: object, id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', receive);
      socket.off('close', closed);
      socket.off('error', errored);
      if (error) reject(error);
      else resolve(value as T);
    };
    const closed = () => finish(new Error('T3 closed the delivery connection'));
    const errored = (err: Error) => finish(err);
    const receive = (frame: WebSocket.RawData) => {
      try {
        const message = JSON.parse(frame.toString()) as {
          _tag?: string;
          requestId?: string | number;
          exit?: {
            _tag: string;
            value?: T;
            cause?: unknown;
          };
        };
        if (message._tag === 'Defect') return finish(new Error('T3 RPC protocol error'));
        if (message._tag !== 'Exit' || String(message.requestId) !== id) return;
        if (message.exit?._tag === 'Success') return finish(undefined, message.exit.value);
        const causes = Array.isArray(message.exit?.cause) ? message.exit.cause : [];
        const failure = causes.find(
          (cause: any) => cause && typeof cause === 'object' && cause._tag === 'Fail',
        ) as { error?: { message?: string; reason?: string } } | undefined;
        const detail = failure?.error?.message ?? failure?.error?.reason ?? 'dispatch rejected';
        finish(new Error(`T3 ${tag}: ${detail}`));
      } catch {
        finish(new Error('T3 returned an invalid RPC response'));
      }
    };
    const timer = setTimeout(() => finish(new Error(`T3 ${tag} timed out`)), 15_000);
    socket.on('message', receive);
    socket.once('close', closed);
    socket.once('error', errored);
    socket.send(JSON.stringify({ _tag: 'Request', id, tag, headers: [], payload }), error => {
      if (error) finish(error);
    });
  });
}

export async function dispatchMessage(
  origin: string,
  token: string,
  message: { threadId: string; key: string; text: string; attachments: NativeAttachment[] },
): Promise<{ runId: string; sequence: number }> {
  const socket = openT3Socket(origin, token);
  // Keep a baseline no-op error handler so ws never triggers uncaught EventEmitter 'error' during teardown
  const ignoreLateError = () => {};
  socket.on('error', ignoreLateError);

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off('open', onOpen);
        reject(err);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    const messageId = `qq-message:${message.key}`;
    const { sequence } = await sendRpc<{ sequence: number }>(
      socket,
      'orchestration.dispatchCommand',
      {
        type: 'message.dispatch',
        commandId: `qq:${message.key}`,
        threadId: message.threadId,
        messageId,
        text: message.text,
        attachments: message.attachments,
        createdBy: 'user',
        creationSource: 'server',
        dispatchMode: { type: 'queue_after_active' },
      },
      '1',
    );
    const projection = await sendRpc<Projection>(
      socket,
      'orchestration.getThreadProjection',
      { threadId: message.threadId },
      '2',
    );
    const runId =
      projection.runs.find(run => run.userMessageId === messageId)?.id ??
      projection.turnItems.find(item => item.messageId === messageId)?.runId;
    if (!runId) {
      throw new Error('T3 committed the QQ message but returned no matching run');
    }
    return { runId, sequence };
  } finally {
    socket.close();
  }
}

export async function readReply(
  origin: string,
  token: string,
  threadId: string,
  runId: string,
  options: {
    afterSequence?: number;
    lifetimeMs?: number;
    signal?: AbortSignal;
    onMessage?: (item: ReplyMessage) => Promise<void>;
    onUpdate?: (item: ReplyMessage) => void;
    onTerminal?: (run: RunState) => void;
  } = {},
): Promise<{
  status: string;
  completedAt: string | null;
  body: string;
  lastBodyAt: number;
  backgroundTaskIds: string[];
}> {
  const deadline = Date.now() + (options.lifetimeMs ?? DEFAULT_OBSERVE_LIFETIME_MS);
  const textByItem = new Map<string, TurnItem>();
  const pendingSubagents = new Set<string>();
  let cursor = options.afterSequence;
  let final: RunState | undefined;
  const scheduled = new Set<string>();
  let delivery = Promise.resolve();
  let deliveryError: unknown;

  const queueMessage = (item: TurnItem) => {
    if (!options.onMessage || !item.text?.trim() || scheduled.has(item.id)) return;
    scheduled.add(item.id);
    const message: ReplyMessage = { id: item.id, text: item.text, updatedAt: item.updatedAt };
    delivery = delivery
      .then(() => options.onMessage!(message))
      .catch(error => {
        deliveryError ??= error;
      });
  };

  const keepItem = (item: TurnItem) => {
    if (item.runId !== runId) return;
    if (item.type === 'assistant_message') {
      textByItem.set(item.id, item);
      if (item.status === 'completed') queueMessage(item);
      if (!TERMINAL_RUN_STATUSES.has(item.status) && item.text?.trim() && !scheduled.has(item.id)) {
        options.onUpdate?.({ id: item.id, text: item.text, updatedAt: item.updatedAt });
      }
    }
    if (item.type === 'subagent') {
      if (PENDING_ITEM_STATUSES.has(item.status)) {
        pendingSubagents.add(item.id);
      } else if (TERMINAL_RUN_STATUSES.has(item.status)) {
        // Foreground subagents that finish before the parent turn ends are NOT background tasks
        pendingSubagents.delete(item.id);
      }
    }
  };

  const keepRun = (run: RunState) => {
    if (final || run.id !== runId || !TERMINAL_RUN_STATUSES.has(run.status)) return;
    final = run;
    options.onTerminal?.(run);
  };

  const apply = (item: StreamItem) => {
    if (item.kind === 'snapshot') {
      const sortedItems = [...item.projection.turnItems].sort((a, b) => a.ordinal - b.ordinal);
      sortedItems.forEach(keepItem);
      item.projection.runs.forEach(keepRun);
      cursor = item.snapshotSequence;
    } else if (item.kind === 'event') {
      const event = item.event;
      if (event.type === 'turn-item.updated') keepItem(event.payload);
      if (event.type === 'run.updated') keepRun(event.payload);
      cursor = item.sequence;
    }
  };

  const subscribe = () =>
    new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('T3 reply observation aborted'));
        return;
      }
      const socket = openT3Socket(origin, token);
      const ignoreLateError = () => {};
      socket.on('error', ignoreLateError);

      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        socket.close();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error('T3 reply observation aborted'));
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const remaining = Math.max(1000, deadline - Date.now());
      const timer = setTimeout(() => finish(new Error('T3 reply observation expired')), remaining);
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            _tag: 'Request',
            id: '1',
            tag: 'orchestration.subscribeThread',
            headers: [],
            payload: {
              threadId,
              afterSequence: cursor,
              acceptBoundedSnapshot: true,
              requestCompletionMarker: true,
            },
          }),
        );
      });
      socket.on('message', frame => {
        try {
          const message = JSON.parse(frame.toString()) as {
            _tag?: string;
            requestId?: string | number;
            values?: StreamItem[];
          };
          if (message._tag === 'Chunk' && String(message.requestId) === '1' && Array.isArray(message.values)) {
            for (const item of message.values) apply(item);
            socket.send(JSON.stringify({ _tag: 'Ack', requestId: '1' }));
            if (final) finish();
          } else if (message._tag === 'Exit' || message._tag === 'Defect') {
            finish(new Error('T3 ended the reply subscription'));
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Invalid T3 reply event'));
        }
      });
      socket.on('error', finish);
      socket.on('close', () => finish(new Error('T3 reply connection closed')));
    });

  let failures = 0;
  try {
    while (!final) {
      const previousCursor = cursor;
      try {
        await subscribe();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failures = previousCursor === cursor ? failures + 1 : 1;
        if (Date.now() >= deadline || failures >= MAX_CONSECUTIVE_WS_FAILURES) throw error;
        const backoffMs = Math.min(8_000, 250 * Math.pow(2, failures - 1));
        await sleep(backoffMs, undefined, { signal: options.signal }).catch(() => {});
      }
    }
  } finally {
    if (final) {
      const messages = [...textByItem.values()].sort((a, b) => a.ordinal - b.ordinal);
      messages.forEach(queueMessage);
    }
    await delivery;
  }

  if (deliveryError) throw deliveryError;
  if (!final) throw new Error('T3 reply observation ended without terminal run state');

  const messages = [...textByItem.values()].sort((a, b) => a.ordinal - b.ordinal);
  return {
    status: final.status,
    completedAt: final.completedAt,
    body: messages
      .map(item => item.text ?? '')
      .filter(text => text.trim())
      .join('\n\n'),
    lastBodyAt: messages.reduce((latest, item) => Math.max(latest, Date.parse(item.updatedAt)), 0),
    backgroundTaskIds: [...pendingSubagents],
  };
}
