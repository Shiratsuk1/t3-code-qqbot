import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { APP_VERSION } from './config.ts';
import { DEFAULT_UPLOAD_TIMEOUT_MS, isT3NativeImageMime, T3_MAX_IMAGE_BYTES } from './protocol.ts';
import type { NativeAttachment } from './types.ts';

export type ThreadReadItem = {
  itemId: string;
  status: string;
  title: string | null;
  runId: string | null;
  type: string;
  position: number;
  text: string | null;
};

export type ThreadReadResult = {
  items: ThreadReadItem[];
  recentRuns: { runId: string; status: string }[];
  thread: {
    threadId?: string;
    projectId?: string;
    link?: string;
    itemCount?: number;
    providerInstanceId?: string;
    activeRunId?: string | null;
    pendingRequestCount: number;
    pendingBackgroundTasks?: { taskId: string; kind: string }[];
  };
};

export type ProjectListItem = {
  id: string;
  title?: string;
  workspaceRoot: string;
};

type McpSessionState = {
  token: string;
  sessionId: string;
  authSessionId?: string;
  renewAt: number;
};

class McpHttpError extends Error {
  readonly status: number;
  constructor(method: string, status: number) {
    super(`T3 MCP ${method} HTTP ${status}`);
    this.status = status;
  }
}

export class Observer {
  private state: McpSessionState | null = null;
  private connecting?: Promise<McpSessionState>;
  private id = 0;
  private readonly url: string;
  private readonly issue: () => Promise<{ token: string; sessionId?: string }>;
  private readonly revoke?: (sessionId: string) => Promise<void>;

  constructor(
    origin: string,
    issue: () => Promise<{ token: string; sessionId?: string }>,
    revoke?: (sessionId: string) => Promise<void>,
  ) {
    this.url = new URL('/mcp', origin).href;
    this.issue = issue;
    this.revoke = revoke;
  }

  private async rpcWith(
    token: string,
    sessionId: string | null,
    method: string,
    params?: object,
    notification = false,
  ): Promise<{ result?: any; newSessionId?: string | null }> {
    const response = await fetch(this.url, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(!notification ? { id: ++this.id } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new McpHttpError(method, response.status);
    }
    const newSessionId = method === 'initialize' ? response.headers.get('mcp-session-id') : undefined;
    if (notification) {
      await response.body?.cancel().catch(() => {});
      return { newSessionId };
    }
    const contentType = response.headers.get('content-type') ?? '';
    let body: { error?: { code: number; message?: string }; result?: any };
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      const dataLine = text
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean)
        .at(-1);
      if (!dataLine) throw new Error(`T3 MCP ${method} returned empty SSE stream`);
      body = JSON.parse(dataLine);
    } else {
      body = (await response.json()) as { error?: { code: number; message?: string }; result?: any };
    }
    if (body.error) {
      throw new Error(
        `T3 MCP ${method} error ${body.error.code}${body.error.message ? `: ${body.error.message}` : ''}`,
      );
    }
    return { result: body.result, newSessionId };
  }

  private async connect(force = false): Promise<McpSessionState> {
    if (!force && this.state && Date.now() < this.state.renewAt) {
      return this.state;
    }
    if (!this.connecting) {
      const previousAuthId = this.state?.authSessionId;
      this.connecting = (async () => {
        const issued = await this.issue();
        if (!issued.token) throw new Error('T3 MCP session returned no bearer token');
        const init = await this.rpcWith(issued.token, null, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't3-code-qqbot', version: APP_VERSION },
        });
        if (!init.newSessionId) throw new Error('T3 MCP did not return an mcp-session-id header');
        await this.rpcWith(issued.token, init.newSessionId, 'notifications/initialized', undefined, true);
        const next: McpSessionState = {
          token: issued.token,
          sessionId: init.newSessionId,
          authSessionId: issued.sessionId,
          renewAt: Date.now() + 50 * 60_000,
        };
        this.state = next;
        if (previousAuthId && previousAuthId !== issued.sessionId && this.revoke) {
          void this.revoke(previousAuthId).catch(() => {});
        }
        return next;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async close(): Promise<void> {
    const authId = this.state?.authSessionId;
    this.state = null;
    if (authId && this.revoke) {
      await this.revoke(authId).catch(() => {});
    }
  }

  private async callWithSession<T>(name: string, args: object): Promise<{ data: T; session: McpSessionState }> {
    let session = await this.connect(false);
    let result: any;
    try {
      ({ result } = await this.rpcWith(session.token, session.sessionId, 'tools/call', { name, arguments: args }));
    } catch (error) {
      if (error instanceof McpHttpError && (error.status === 401 || error.status === 404)) {
        if (this.state === session) this.state = null;
        session = await this.connect(true);
        ({ result } = await this.rpcWith(session.token, session.sessionId, 'tools/call', { name, arguments: args }));
      } else {
        throw error;
      }
    }
    if (result?.isError) {
      const detail = result?.content?.[0]?.text ? `: ${String(result.content[0].text)}` : '';
      throw new Error(`T3 MCP tool rejected (${name})${detail}`);
    }
    if (result?.structuredContent !== undefined) {
      return { data: result.structuredContent as T, session };
    }
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`T3 MCP tool (${name}) returned empty content`);
    }
    return { data: JSON.parse(text) as T, session };
  }

  async call<T>(name: string, args: object): Promise<T> {
    const { data } = await this.callWithSession<T>(name, args);
    return data;
  }

  async upload(
    filePath: string,
    name: string,
    mimeType: string,
    options: { forceType?: 'image' | 'file'; timeoutMs?: number } = {},
  ): Promise<NativeAttachment> {
    const info = await stat(filePath);
    const sizeBytes = info.size;
    const type: 'image' | 'file' =
      options.forceType ?? (isT3NativeImageMime(mimeType) && sizeBytes <= T3_MAX_IMAGE_BYTES ? 'image' : 'file');
    const attachment = {
      name,
      mimeType,
      sizeBytes,
      type,
    };
    const { data: staged, session } = await this.callWithSession<{
      attachmentId: string;
      relativeUrl: string;
      uploadUrl?: string;
    }>('t3_attachment_prepare_upload', { upload: attachment });
    const fileStream = createReadStream(filePath);
    try {
      const endpoint = new URL(staged.uploadUrl ?? staged.relativeUrl, this.url);
      if (endpoint.origin !== new URL(this.url).origin) {
        throw new Error('Unexpected T3 attachment upload origin');
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': mimeType,
          'Content-Length': String(sizeBytes),
        },
        body: Readable.toWeb(fileStream) as NonNullable<RequestInit['body']>,
        duplex: 'half',
      } as RequestInit);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `T3 native attachment upload HTTP ${response.status}${detail.trim() ? `: ${detail.trim().slice(0, 200)}` : ''}`,
        );
      }
      await response.body?.cancel().catch(() => {});
      return { ...attachment, id: staged.attachmentId };
    } catch (error) {
      fileStream.destroy();
      await this.call('t3_attachment_discard', { attachmentId: staged.attachmentId }).catch(() => {});
      throw error;
    }
  }

  async read(
    threadId: string,
    view: 'messages' | 'activity' = 'messages',
    itemId?: string,
  ): Promise<ThreadReadResult> {
    return this.call<ThreadReadResult>('t3_thread_read', {
      threadId,
      view,
      itemId,
      limit: 40,
      runLimit: 50,
      maxCharsPerItem: 20_000,
    });
  }
}
