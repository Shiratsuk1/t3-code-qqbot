import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedPluginConfig } from './types.ts';

export type ResolvedT3Command = {
  executable: string;
  prefix: string[];
  env: Record<string, string>;
};

const STRIPPED_ENV_KEYS = new Set([
  'QQ_BRIDGE_SECRET',
  'QQ_APP_ID',
  'QQ_APP_SECRET',
  'QQ_CREDENTIALS_FILE',
]);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const target = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === target) return v;
  }
  return undefined;
}

export function sanitizeChildEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!STRIPPED_ENV_KEYS.has(key.toUpperCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Parses T3 Code's Windows `t3.cmd` desktop launcher so Node 24 can run the
 * underlying Electron binary via `execFile` without spawning `cmd.exe`.
 */
export function parseWindowsT3Cmd(
  scriptText: string,
  options: { env?: NodeJS.ProcessEnv; scriptPath?: string } = {},
): ResolvedT3Command | null {
  const callerEnv = options.env ?? {};
  const scriptDir = options.scriptPath ? dirname(options.scriptPath) : '';
  const env: Record<string, string> = {};
  const lines = scriptText.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^rem\b/i.test(trimmed) || trimmed.startsWith('::')) continue;

    const ifNotDefMatch = /^if\s+not\s+defined\s+([A-Za-z0-9_]+)\s+set\s+(?:"([^"=]+)=([^"]*)"|([A-Za-z0-9_]+)=(.*))$/i.exec(
      trimmed,
    );
    if (ifNotDefMatch) {
      const guardVar = ifNotDefMatch[1];
      const key = ifNotDefMatch[2] ?? ifNotDefMatch[4];
      const val = (ifNotDefMatch[3] ?? ifNotDefMatch[5] ?? '').trim();
      if (!getEnvCaseInsensitive(callerEnv, guardVar) && !val.includes('%ERRORLEVEL%')) {
        env[key] = scriptDir ? val.replace(/%~dp0/gi, scriptDir + '\\') : val;
      }
      continue;
    }

    const setMatch = /^set\s+(?:"([^"=]+)=([^"]*)"|([A-Za-z0-9_]+)=(.*))$/i.exec(trimmed);
    if (setMatch) {
      const key = setMatch[1] ?? setMatch[3];
      const val = (setMatch[2] ?? setMatch[4] ?? '').trim();
      if (val.includes('%ERRORLEVEL%') || /^t3_exit$/i.test(key)) continue;
      env[key] = scriptDir ? val.replace(/%~dp0/gi, scriptDir + '\\') : val;
    }
  }

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed.endsWith('%*')) continue;
    trimmed = trimmed.slice(0, -2).trim();
    // Strip leading `if exist "..." ` or `call `
    trimmed = trimmed.replace(/^if\s+exist\s+(?:"[^"]+"|\S+)\s+/i, '');
    trimmed = trimmed.replace(/^call\s+/i, '');
    if (scriptDir) {
      trimmed = trimmed.replace(/%~dp0/gi, scriptDir + '\\');
    }
    const tokens = [...trimmed.matchAll(/"([^"]+)"|(\S+)/g)].map(match => match[1] ?? match[2]);
    if (tokens.length >= 1) {
      return {
        executable: tokens[0],
        prefix: tokens.slice(1),
        env,
      };
    }
  }
  return null;
}

export async function resolveT3Command(
  t3Config: ResolvedPluginConfig['t3'],
  options: { platform?: NodeJS.Platform; homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedT3Command> {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const procEnv = options.env ?? process.env;
  const t3Home = t3Config.home ?? getEnvCaseInsensitive(procEnv, 'T3CODE_HOME') ?? join(home, '.t3');

  const mergeEnv = (detected: Record<string, string>): Record<string, string> => ({
    ...detected,
    ...(t3Config.home ? { T3CODE_HOME: t3Config.home } : {}),
    ...t3Config.env,
  });

  if (t3Config.executable && t3Config.executable !== 'auto') {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(t3Config.executable)) {
      const parsed = parseWindowsT3Cmd(await readFile(t3Config.executable, 'utf8'), {
        env: procEnv,
        scriptPath: t3Config.executable,
      });
      if (!parsed) {
        throw new Error(`Could not parse Windows T3 launcher script: ${t3Config.executable}`);
      }
      return {
        executable: parsed.executable,
        prefix: [...parsed.prefix, ...t3Config.prefix],
        env: mergeEnv(parsed.env),
      };
    }
    return {
      executable: t3Config.executable,
      prefix: [...t3Config.prefix],
      env: mergeEnv({}),
    };
  }

  if (platform === 'win32') {
    const candidates = [join(t3Home, 'bin', 't3.cmd'), join(t3Home, 'bin', 't3.exe')];
    for (const candidate of candidates) {
      if (!(await fileExists(candidate))) continue;
      if (candidate.endsWith('.cmd')) {
        const parsed = parseWindowsT3Cmd(await readFile(candidate, 'utf8'), {
          env: procEnv,
          scriptPath: candidate,
        });
        if (parsed) {
          return {
            executable: parsed.executable,
            prefix: [...parsed.prefix, ...t3Config.prefix],
            env: mergeEnv(parsed.env),
          };
        }
      } else {
        return {
          executable: candidate,
          prefix: [...t3Config.prefix],
          env: mergeEnv({}),
        };
      }
    }
    return {
      executable: 't3.exe',
      prefix: [...t3Config.prefix],
      env: mergeEnv({}),
    };
  }

  // Linux / macOS
  const unixCandidates = [join(t3Home, 'bin', 't3'), join(home, '.local', 'bin', 't3'), '/usr/local/bin/t3'];
  for (const candidate of unixCandidates) {
    if (await fileExists(candidate)) {
      return {
        executable: candidate,
        prefix: [...t3Config.prefix],
        env: mergeEnv({}),
      };
    }
  }
  return {
    executable: 't3',
    prefix: [...t3Config.prefix],
    env: mergeEnv({}),
  };
}

export class T3Cli {
  private resolvedPromise?: Promise<ResolvedT3Command>;
  private readonly t3Config: ResolvedPluginConfig['t3'];
  private readonly baseEnv: Record<string, string | undefined>;

  constructor(t3Config: ResolvedPluginConfig['t3'], baseEnv: NodeJS.ProcessEnv = process.env) {
    this.t3Config = t3Config;
    this.baseEnv = sanitizeChildEnv(baseEnv);
  }

  async resolve(): Promise<ResolvedT3Command> {
    this.resolvedPromise ??= resolveT3Command(this.t3Config, { env: this.baseEnv });
    return this.resolvedPromise;
  }

  async runJson<T>(args: string[], input?: string, timeoutMs = 30_000): Promise<T> {
    const cmd = await this.resolve();
    return new Promise<T>((done, fail) => {
      const child = execFile(
        cmd.executable,
        [...cmd.prefix, ...args, '--json'],
        {
          env: { ...this.baseEnv, ...cmd.env },
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 4_000_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr?.trim() ? `: ${stderr.trim().slice(0, 300)}` : '';
            return fail(
              new Error(`T3 CLI (${args.slice(0, 2).join(' ')}) failed (${error.code ?? error.signal})${detail}`),
            );
          }
          try {
            done(JSON.parse(stdout) as T);
          } catch (invalid) {
            fail(
              new Error(
                `T3 CLI returned invalid JSON: ${invalid instanceof Error ? invalid.message : String(invalid)}`,
              ),
            );
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(input, 'utf8');
    });
  }

  async issueSession(options: {
    scopes: string[];
    ttl: string;
    label: string;
    subject?: string;
  }): Promise<{ sessionId: string; token: string }> {
    const args = ['auth', 'session', 'issue'];
    for (const scope of options.scopes) {
      args.push('--scope', scope);
    }
    if (options.subject) {
      args.push('--subject', options.subject);
    }
    args.push('--ttl', options.ttl, '--label', options.label);
    return this.runJson<{ sessionId: string; token: string }>(args);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const cmd = await this.resolve();
    await new Promise<void>(resolveDone => {
      const child = execFile(
        cmd.executable,
        [...cmd.prefix, 'auth', 'session', 'revoke', sessionId],
        {
          env: { ...this.baseEnv, ...cmd.env },
          windowsHide: true,
          timeout: 10_000,
        },
        () => resolveDone(),
      );
      child.on('error', () => resolveDone());
    });
  }

  async withSession<T>(
    options: { scopes: string[]; ttl: string; label: string; subject?: string },
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    const session = await this.issueSession(options);
    try {
      return await fn(session.token);
    } finally {
      await this.revokeSession(session.sessionId).catch(() => {});
    }
  }
}
