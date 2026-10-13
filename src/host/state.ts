/**
 * Plugin-owned persistent state (`~/.dsh/mcp-master/state.json`):
 *
 * - per workspace: trust decisions for project servers and the default set of
 *   servers new sessions start with;
 * - per session: the servers active in that session;
 * - per server URL: OAuth client registrations and tokens.
 *
 * Nothing is written to the workspace's `.mcp.json`, so choices never dirty a
 * file that is usually committed. The file holds OAuth tokens, so it is
 * written 0600 and atomically.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from './dsh.ts';

/** Trust given to one project server, tied to the entry as written. */
export interface TrustDecision {
  trusted: boolean;
  fingerprint: string;
  at: number;
}

export interface SessionSelection {
  /** Workspace root the selection was made in. */
  root: string;
  active: string[];
  at: number;
}

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  /** RFC 8707 resource indicator, set when the server published RFC 9728 metadata. */
  resource: string;
  resourceMetadataUrl: string;
  resourceScopes: string[];
  source: 'protected-resource' | 'authorization-server' | 'fallback';
}

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  issuer: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  /** Epoch ms; 0 when the server did not say. */
  expires_at: number;
  obtained_at: number;
}

export interface OAuthRecord {
  metadata?: OAuthMetadata;
  client?: OAuthClient;
  tokens?: OAuthTokens;
}

interface WorkspaceRecord {
  trust: Record<string, TrustDecision>;
  defaults?: string[];
}

interface StateFile {
  version: 2;
  workspaces: Record<string, WorkspaceRecord>;
  sessions: Record<string, SessionSelection>;
  oauth: Record<string, OAuthRecord>;
}

/** Session selections untouched for this long are forgotten. */
const SESSION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['DSH_HOME']?.trim() ? env['DSH_HOME'] : join(homedir(), '.dsh');
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'mcp-master', 'state.json');
}

export function defaultGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'mcp-master', 'mcp.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0))] : [];
}

export class StateStore {
  readonly path: string;
  private readonly logger: Logger | undefined;
  private data: StateFile = { version: 2, workspaces: {}, sessions: {}, oauth: {} };

  constructor(path: string, logger?: Logger) {
    this.path = path;
    this.logger = logger;
    this.load();
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger?.warn(`mcp-master: ignoring unreadable state file ${this.path}: ${(error as Error)?.message ?? error}`);
      }
      return;
    }
    if (!isRecord(parsed)) return;
    const workspaces: StateFile['workspaces'] = {};
    for (const [root, raw] of Object.entries(isRecord(parsed['workspaces']) ? parsed['workspaces'] : {})) {
      if (!isRecord(raw)) continue;
      const trust: Record<string, TrustDecision> = {};
      for (const [name, d] of Object.entries(isRecord(raw['trust']) ? raw['trust'] : {})) {
        if (isRecord(d) && typeof d['trusted'] === 'boolean' && typeof d['fingerprint'] === 'string') {
          trust[name] = { trusted: d['trusted'], fingerprint: d['fingerprint'], at: Number(d['at']) || 0 };
        }
      }
      workspaces[root] = { trust, ...(Array.isArray(raw['defaults']) ? { defaults: names(raw['defaults']) } : {}) };
    }
    const sessions: StateFile['sessions'] = {};
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    for (const [id, raw] of Object.entries(isRecord(parsed['sessions']) ? parsed['sessions'] : {})) {
      if (!isRecord(raw) || typeof raw['root'] !== 'string') continue;
      const at = Number(raw['at']) || 0;
      if (at < cutoff) continue;
      sessions[id] = { root: raw['root'], active: names(raw['active']), at };
    }
    this.data = {
      version: 2,
      workspaces,
      sessions,
      oauth: isRecord(parsed['oauth']) ? parsed['oauth'] as StateFile['oauth'] : {},
    };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
      try { chmodSync(this.path, 0o600); } catch {}
    } catch (error) {
      this.logger?.error(`mcp-master: could not write state file ${this.path}: ${(error as Error)?.message ?? error}`);
    }
  }

  private workspace(root: string): WorkspaceRecord {
    return this.data.workspaces[root] ??= { trust: {} };
  }

  trust(root: string, name: string): TrustDecision | undefined {
    return this.data.workspaces[root]?.trust[name];
  }

  setTrust(root: string, name: string, trusted: boolean, fingerprint: string): void {
    this.workspace(root).trust[name] = { trusted, fingerprint, at: Date.now() };
    this.save();
  }

  /** The saved default set, or undefined when the user never saved one. */
  defaults(root: string): string[] | undefined {
    const defaults = this.data.workspaces[root]?.defaults;
    return defaults ? [...defaults] : undefined;
  }

  setDefaults(root: string, active: string[] | undefined): void {
    const ws = this.workspace(root);
    if (active === undefined) delete ws.defaults;
    else ws.defaults = names(active);
    this.save();
  }

  session(id: string): SessionSelection | undefined {
    const entry = this.data.sessions[id];
    return entry ? { ...entry, active: [...entry.active] } : undefined;
  }

  setSession(id: string, root: string, active: string[]): void {
    this.data.sessions[id] = { root, active: names(active), at: Date.now() };
    this.save();
  }

  /** OAuth record keyed by the canonical server URL (shared across workspaces). */
  oauth(key: string): OAuthRecord | undefined {
    const entry = this.data.oauth[key];
    return isRecord(entry) ? entry : undefined;
  }

  /** Replace the record with `mutate(copy)`; returning null deletes it. */
  updateOauth(key: string, mutate: (record: OAuthRecord) => OAuthRecord | null): OAuthRecord | undefined {
    const next = mutate({ ...(this.oauth(key) ?? {}) });
    if (next === null || Object.keys(next).length === 0) delete this.data.oauth[key];
    else this.data.oauth[key] = next;
    this.save();
    return next ?? undefined;
  }
}
