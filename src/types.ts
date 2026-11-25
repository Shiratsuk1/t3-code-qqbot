export type Target = {
  kind: 'users' | 'groups';
  id: string;
};

export type ReplyAddress = {
  scope: 'c2c' | 'group';
  targetId: string;
  msgId: string;
};

export type Attachment = {
  url?: string;
  content_type?: string;
  filename?: string;
  stagedName?: string;
};

export type InboundEvent = {
  id: string;
  content?: string;
  group_openid?: string;
  author?: { user_openid?: string };
  attachments?: Attachment[];
};

export type NativeAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  type: 'image' | 'file';
};

export type ModelSelection = {
  provider: string;
  model: string;
};

export type BindingConfig = {
  /**
   * Either a literal scope (`c2c:<user_openid>` or `group:<group_openid>`)
   * or a hashed scope (`sha256:<hex>` of `c2c:<id>` / `group:<id>`).
   */
  scope: string;
  /** Local project workspace path registered in T3 Code. */
  workspace: string;
  /** Optional fixed T3 thread ID. If omitted, a thread is created automatically on first message. */
  threadId?: string;
  /** Optional model selection used only when creating a new thread automatically. */
  modelSelection?: ModelSelection;
};

export type T3Config = {
  origin: string;
  executable?: string;
  prefix?: string[];
  env?: Record<string, string>;
  home?: string;
  /** Optional thread ID exported as T3CODE_MUTE_MOBILE_COMPLETION_THREAD_ID (requires patched/supporting T3 server). */
  muteMobileCompletionThreadId?: string;
};

export type BridgeConfig = {
  host?: string;
  port: number;
  proactiveBackgroundReports?: boolean;
  maxMessageChars?: number;
  autoSettleThread?: boolean;
  enableSlashCommands?: boolean;
  testStaging?: string;
};

export type GatewayConfig = {
  bridgeUrl?: string;
  requireMentionInGroup?: boolean;
  stripPrefix?: string;
};

export type RawPluginConfig = {
  stateDir: string;
  credentialsFile?: string;
  t3: T3Config;
  bridge: BridgeConfig;
  gateway?: GatewayConfig;
  attachmentHosts?: string[];
  bindings: BindingConfig[];
};

export type ResolvedBinding = {
  rawScope: string;
  scopeHash: string;
  workspace: string;
  threadId?: string;
  modelSelection?: ModelSelection;
};

export type ResolvedPluginConfig = {
  configPath: string;
  configDir: string;
  stateDir: string;
  credentialsFile?: string;
  t3: {
    origin: string;
    executable: string;
    prefix: string[];
    env: Record<string, string>;
    home?: string;
    muteMobileCompletionThreadId?: string;
  };
  bridge: {
    host: string;
    port: number;
    proactiveBackgroundReports: boolean;
    maxMessageChars: number;
    autoSettleThread: boolean;
    enableSlashCommands: boolean;
    testStaging?: string;
  };
  gateway: {
    bridgeUrl: string;
    requireMentionInGroup: boolean;
    stripPrefix: string;
  };
  attachmentHosts: string[];
  bindings: ResolvedBinding[];
};

export type Credentials = {
  appId: string;
  appSecret: string;
  bridgeSecret: string;
};

export type PersistedRunRecord = {
  key: string;
  scope: string;
  scopeHash: string;
  reply: ReplyAddress;
  thread: string;
  runId: string;
  workspace: string;
  sequence: number;
};
