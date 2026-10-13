/**
 * MCP Master runtime.
 *
 *   McpMasterManager      one per plugin instance
 *   └─ WorkspaceRuntime   one per workspace root (created by a session or a viewer)
 *      └─ ServerRuntime   one per catalog entry (global + project): trust, connection, tools, logs
 *
 * Which servers a session uses is a per-session selection. A server runs
 * while at least one live or viewed session in the workspace selects it, and
 * its tools are registered into exactly those sessions' agents
 * (`agent.ctx.tools.register`). Changing a selection mid-session is a plain
 * tool registration change, which DSH records in the session log itself.
 */

import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AuthMode, LogEntryView, ServerStatus, ServerView, SessionView, StateResponse, Trust, WorkspaceView,
} from '../shared/types.ts';
import { OAUTH_CALLBACK_PATH } from '../shared/types.ts';
import {
  configStamp, displayPath, findConfigRoot, launchKey, loadCatalog,
  type ConfigFileInfo, type ServerSpec, type WorkspaceConfig,
} from './config.ts';
import type { Agent, Logger, ToolDefinition, ToolExecution, ToolRegistry } from './dsh.ts';
import { baseEnv } from './env.ts';
import { NO_AUTH, openLegacySse, openStreamableHttp, type HttpAuth } from './http.ts';
import {
  AuthRequiredError, McpError, SessionExpiredError, initialize, listAllTools,
  type LogEntry, type McpConnection, type McpTool, type Root,
} from './jsonrpc.ts';
import { OAuthManager, parseWwwAuthenticate } from './oauth.ts';
import type { StateStore } from './state.ts';
import { openStdio } from './stdio.ts';
import {
  disposeRegistrations, makeToolDefinition, publicToolName, syncRegistrations,
  type CallToolResult, type Registration, type ToolServices,
} from './tools.ts';

export interface ManagerOptions {
  configFiles: readonly string[];
  /** Absolute path of the global catalog; undefined disables the global scope. */
  globalConfigFile: string | undefined;
  /** Trust project servers without asking. */
  autoTrust: boolean;
  searchParents: boolean;
  startupWaitMs: number;
  connectTimeoutMs: number;
  toolCallTimeoutMs: number;
  idleShutdownMs: number;
  /** A server nobody selects any more keeps running this long (default 2 min). */
  stopGraceMs?: number;
  /** A viewed, not yet started session keeps its selection warm this long after its last poll (default 2 min). */
  viewerTtlMs?: number;
}

export interface ManagerDeps {
  logger: Logger;
  store: StateStore;
  services: ToolServices;
  options: ManagerOptions;
  /** The tool registry seen through one agent's scope. */
  toolsOf(agent: Agent): ToolRegistry | undefined;
}

interface OAuthContext {
  root: string;
  name: string;
}

const LOG_LIMIT = 40;
const MAX_RETRIES = 6;
const AUTHORIZING_TIMEOUT_MS = 10 * 60 * 1000;
const WATCH_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 30 * 1000;
const CALL_WAIT_FOR_CONNECT_MS = 20000;
const DEFAULT_VIEWER_TTL_MS = 2 * 60 * 1000;
const DEFAULT_STOP_GRACE_MS = 2 * 60 * 1000;

/** Strip credentials from anything that is logged or shown. */
export function redact(value: unknown): string {
  return String(value ?? '')
    .replace(/([?&#](?:code|state|client_secret|access_token|refresh_token|id_token|token)=)[^&\s"']*/gi, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 <redacted>')
    .replace(/\b(authorization|access_token|refresh_token|client_secret|id_token|api[_-]?key|token)\b(["']?\s*[:=]\s*["']?)[^&\s"',}]+/gi, '$1$2<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function errorText(error: unknown): string {
  return redact((error as Error)?.message ?? error).slice(0, 400);
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'authorization');
}

/** Thrown when activating a server the user has not trusted yet. */
export class TrustRequiredError extends Error {
  readonly server: string;
  constructor(server: string) {
    super(`"${server}" comes from the workspace config and must be trusted before it can run`);
    this.name = 'TrustRequiredError';
    this.server = server;
  }
}

class ServerRuntime {
  readonly ws: WorkspaceRuntime;
  spec: ServerSpec;
  private key: string;
  status: ServerStatus;
  error = '';
  conn: McpConnection | null = null;
  /** Live definitions (empty unless connected). */
  definitions = new Map<string, ToolDefinition>();
  /** Last tool list seen, kept while idle so the picker can show it. */
  knownTools: McpTool[] = [];
  registrationErrors: string[] = [];
  connectedAt = 0;
  attempts = 0;
  retryAt = 0;
  authHint: Record<string, string> = {};
  readonly logs: LogEntryView[] = [];
  private generation = 0;
  private connecting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private authorizingTimer: NodeJS.Timeout | null = null;
  private unwantedSince: number | undefined;

  constructor(ws: WorkspaceRuntime, spec: ServerSpec) {
    this.ws = ws;
    this.spec = spec;
    this.key = launchKey(spec);
    this.status = this.restingStatus();
  }

  private get manager(): McpMasterManager {
    return this.ws.manager;
  }

  get name(): string {
    return this.spec.name;
  }

  get trust(): Trust {
    if (this.spec.invalid) return 'invalid';
    if (this.spec.scope === 'global') return 'trusted';
    const decision = this.manager.store.trust(this.ws.root, this.name);
    if (decision) {
      if (decision.fingerprint === this.spec.fingerprint) return decision.trusted ? 'trusted' : 'untrusted';
      return decision.trusted ? 'changed' : 'untrusted';
    }
    return this.manager.options.autoTrust ? 'trusted' : 'untrusted';
  }

  private restingStatus(): ServerStatus {
    const trust = this.trust;
    return trust === 'trusted' ? 'idle' : trust;
  }

  /** Running, starting, or holding a state (sign-in, error) that only a running server has. */
  private get engaged(): boolean {
    return this.conn !== null || this.connecting !== null || ['needs-auth', 'authorizing', 'error'].includes(this.status);
  }

  get authMode(): AuthMode {
    if (this.spec.transport === 'stdio') return 'none';
    if (hasAuthorizationHeader(this.spec.headers)) return 'header';
    if (this.spec.url && this.manager.oauth.hasTokens(this.spec.url)) return 'oauth';
    if (this.status === 'needs-auth' || this.status === 'authorizing' || Object.keys(this.authHint).length > 0) return 'oauth';
    if (this.status === 'connected') return 'none';
    return 'unknown';
  }

  log(entry: LogEntry): void {
    this.logs.push({
      at: Date.now(),
      phase: entry.phase.slice(0, 32),
      status: Number.isFinite(entry.status) ? entry.status ?? 0 : 0,
      target: redact(entry.target ?? ''),
      detail: redact(entry.detail),
    });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
  }

  /** Apply a re-read catalog entry; restart only when launch fields changed. */
  update(spec: ServerSpec): void {
    const changed = launchKey(spec) !== this.key;
    this.spec = spec;
    this.key = launchKey(spec);
    if (changed) {
      this.knownTools = [];
      if (this.engaged) {
        this.log({ phase: 'config', detail: 'configuration changed; restarting' });
        void this.stop(this.restingStatus());
      }
    }
  }

  /** Converge toward running (wanted and trusted) or resting. */
  converge(wanted: boolean, now: number): void {
    if (this.trust !== 'trusted') {
      if (this.engaged) void this.stop(this.restingStatus());
      else if (this.status !== this.restingStatus()) { this.status = this.restingStatus(); this.error = ''; }
      this.unwantedSince = undefined;
      return;
    }
    if (wanted) {
      this.unwantedSince = undefined;
      if (!this.engaged) this.start();
      return;
    }
    if (!this.engaged) {
      if (this.status !== 'idle') { this.status = 'idle'; this.error = ''; }
      return;
    }
    this.unwantedSince ??= now;
    if (now - this.unwantedSince >= (this.manager.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)) {
      this.log({ phase: 'idle', detail: 'no session uses this server; stopped' });
      void this.stop('idle');
    }
  }

  start(): void {
    const generation = ++this.generation;
    this.cancelRetry();
    this.clearAuthorizing();
    this.unwantedSince = undefined;
    this.status = 'connecting';
    this.error = '';
    this.ws.bump();
    const task = this.connect(generation).finally(() => {
      if (this.connecting === task) this.connecting = null;
      this.ws.bump();
    });
    this.connecting = task;
  }

  /** Resolves when the current connection attempt settles (or after `ms`). */
  async settled(ms: number, signal?: AbortSignal): Promise<void> {
    const task = this.connecting;
    if (!task) return;
    await Promise.race([
      task,
      new Promise<void>((done) => {
        const timer = setTimeout(done, ms);
        timer.unref?.();
        signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      }),
    ]);
  }

  private httpAuth(): HttpAuth {
    const url = this.spec.url ?? '';
    if (!url || hasAuthorizationHeader(this.spec.headers)) return NO_AUTH;
    const oauth = this.manager.oauth;
    const manual = this.spec.oauth?.clientId ? this.spec.oauth : undefined;
    const log = (e: LogEntry): void => this.log(e);
    return {
      headers: async (): Promise<Record<string, string>> => {
        const token = await oauth.accessToken(url, manual, log);
        return token ? { authorization: `Bearer ${token}` } : {};
      },
      unauthorized: async ({ wwwAuthenticate }) => {
        this.authHint = parseWwwAuthenticate(wwwAuthenticate);
        return oauth.hasTokens(url) ? oauth.refresh(url, manual, log) : false;
      },
    };
  }

  private roots(): Root[] {
    return [{ uri: pathToFileURL(this.ws.root).href, name: basename(this.ws.root) }];
  }

  private async open(): Promise<McpConnection> {
    const timeoutMs = this.manager.options.connectTimeoutMs;
    const log = (e: LogEntry): void => this.log(e);
    if (this.spec.transport === 'stdio') {
      const env = { ...(await baseEnv()), ...(this.spec.env ?? {}) };
      const conn = openStdio({ command: this.spec.command ?? '', args: this.spec.args ?? [], cwd: this.spec.cwd ?? this.ws.root, display: this.spec.display }, { env, roots: this.roots(), log });
      try { await initialize(conn, { timeoutMs }); } catch (error) { await conn.close(); throw error; }
      return conn;
    }
    const http = { url: this.spec.url ?? '', headers: this.spec.headers ?? {} };
    const options = { auth: this.httpAuth(), roots: this.roots(), log, connectTimeoutMs: timeoutMs };
    if (this.spec.transport === 'sse') {
      const conn = await openLegacySse(http, options);
      try { await initialize(conn, { timeoutMs }); } catch (error) { await conn.close(); throw error; }
      return conn;
    }
    const conn = openStreamableHttp(http, options);
    try {
      await initialize(conn, { timeoutMs });
      return conn;
    } catch (error) {
      await conn.close();
      // Servers that only speak the 2024-11-05 HTTP+SSE transport reject a bare POST.
      const status = (error as McpError)?.status;
      if (error instanceof McpError && status !== undefined && [400, 404, 405].includes(status)) {
        this.log({ phase: 'initialize', status, detail: 'Streamable HTTP rejected; trying the legacy HTTP+SSE transport' });
        try {
          const sse = await openLegacySse(http, options);
          try { await initialize(sse, { timeoutMs }); } catch (inner) { await sse.close(); throw inner; }
          return sse;
        } catch (fallbackError) {
          if (fallbackError instanceof AuthRequiredError) throw fallbackError;
          this.log({ phase: 'initialize', detail: `legacy SSE fallback failed: ${errorText(fallbackError)}` });
        }
      }
      throw error;
    }
  }

  private async connect(generation: number): Promise<void> {
    let conn: McpConnection | null = null;
    try {
      conn = await this.open();
      const tools = await listAllTools(conn, { timeoutMs: this.manager.options.connectTimeoutMs });
      if (generation !== this.generation) { await conn.close(); return; }
      this.conn = conn;
      const live = conn;
      live.onClose = (error) => this.lost(live, error);
      live.onNotification = (message) => {
        if (message.method === 'notifications/tools/list_changed') void this.refreshTools(live);
      };
      if (live.capabilities.tools?.listChanged) live.startNotificationStream?.();
      this.status = 'connected';
      this.error = '';
      this.connectedAt = Date.now();
      this.attempts = 0;
      this.retryAt = 0;
      const info = live.serverInfo;
      this.log({ phase: 'ready', detail: `${info.name ?? 'server'} ${info.version ?? ''} · protocol ${live.protocolVersion} · ${tools.length} tools`.replace(/\s+/g, ' ') });
      this.setTools(tools);
    } catch (error) {
      try { await conn?.close(); } catch {}
      if (generation !== this.generation) return;
      this.setTools([]);
      if (error instanceof AuthRequiredError) {
        this.authHint = parseWwwAuthenticate(error.wwwAuthenticate);
        if (hasAuthorizationHeader(this.spec.headers)) {
          this.status = 'error';
          this.error = 'the server rejected the Authorization header configured for it';
        } else {
          this.status = 'needs-auth';
          this.error = '';
          this.log({ phase: 'auth', status: 401, detail: 'sign-in required' });
        }
        return;
      }
      this.status = 'error';
      this.error = errorText(error);
      this.log({ phase: 'error', detail: this.error });
      this.manager.logger.warn(`mcp-master: ${this.name} (${this.ws.root}) failed: ${this.error}`);
      this.scheduleRetry();
    }
  }

  private async refreshTools(conn: McpConnection): Promise<void> {
    try {
      const tools = await listAllTools(conn, { timeoutMs: this.manager.options.connectTimeoutMs });
      if (this.conn !== conn) return;
      this.log({ phase: 'tools', detail: `tool list changed: ${tools.length} tools` });
      this.setTools(tools);
      this.ws.bump();
    } catch (error) {
      this.log({ phase: 'tools', detail: `refreshing tools failed: ${errorText(error)}` });
    }
  }

  private lost(conn: McpConnection, error: Error): void {
    if (this.conn !== conn) return;
    this.conn = null;
    this.setTools([]);
    if (error instanceof SessionExpiredError) {
      this.log({ phase: 'session', detail: 'server session expired; reconnecting' });
      this.start();
      return;
    }
    this.status = 'error';
    this.error = `connection lost: ${errorText(error)}`;
    this.log({ phase: 'error', detail: this.error });
    this.scheduleRetry();
    this.ws.bump();
  }

  private setTools(tools: McpTool[]): void {
    if (tools.length > 0) this.knownTools = tools;
    const definitions = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      if (definitions.has(tool.name)) continue;
      definitions.set(tool.name, makeToolDefinition({
        serverName: this.name,
        tool,
        call: (raw, args, exec) => this.call(raw, args, exec),
        services: this.manager.services,
      }));
    }
    this.definitions = definitions;
    this.ws.syncServer(this);
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    this.attempts += 1;
    if (this.attempts > MAX_RETRIES) {
      this.retryAt = 0;
      this.log({ phase: 'retry', detail: `giving up after ${MAX_RETRIES} attempts; use Reconnect to try again` });
      return;
    }
    const delay = Math.min(60000, 2000 * 2 ** (this.attempts - 1));
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = 0;
      if (this.trust === 'trusted' && this.status === 'error' && this.ws.wanted().has(this.name)) this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = 0;
  }

  private clearAuthorizing(): void {
    if (this.authorizingTimer) clearTimeout(this.authorizingTimer);
    this.authorizingTimer = null;
  }

  async stop(next: ServerStatus): Promise<void> {
    this.generation += 1;
    this.cancelRetry();
    this.clearAuthorizing();
    this.unwantedSince = undefined;
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    this.setTools([]);
    this.status = next;
    this.error = '';
    this.ws.bump();
    if (conn) {
      conn.onClose = null;
      try { await conn.close(); } catch {}
    }
  }

  /** Tool dispatch for every agent that registered this server's tools. */
  async call(rawName: string, args: Record<string, unknown>, exec: ToolExecution): Promise<CallToolResult> {
    if (this.status === 'connecting') await this.settled(CALL_WAIT_FOR_CONNECT_MS, exec.signal);
    const conn = this.conn;
    if (!conn || this.status !== 'connected') {
      const hint = this.status === 'needs-auth' ? ' — sign in from the MCP picker next to the model selector' : this.error ? `: ${this.error}` : '';
      throw new Error(`MCP server "${this.name}" is ${this.status}${hint}`);
    }
    try {
      return await conn.request('tools/call', { name: rawName, arguments: args }, { signal: exec.signal, timeoutMs: this.manager.options.toolCallTimeoutMs }) as CallToolResult;
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        this.authHint = parseWwwAuthenticate(error.wwwAuthenticate);
        await this.stop('needs-auth');
        throw new Error(`MCP server "${this.name}" needs sign-in again — open the MCP picker next to the model selector and click Sign in`);
      }
      throw error;
    }
  }

  setTrusted(trusted: boolean): void {
    if (this.spec.scope === 'global') throw new Error('global servers are always trusted');
    if (this.spec.invalid) throw new Error(this.spec.invalid);
    this.manager.store.setTrust(this.ws.root, this.name, trusted, this.spec.fingerprint);
    this.log({ phase: 'trust', detail: trusted ? 'trusted by the user' : 'trust revoked by the user' });
    if (trusted) this.attempts = 0;
  }

  reconnect(): void {
    if (this.trust !== 'trusted') throw new TrustRequiredError(this.name);
    this.attempts = 0;
    this.log({ phase: 'reconnect', detail: 'reconnect requested by the user' });
    this.start();
  }

  async beginSignIn(origin: string): Promise<string> {
    if (this.spec.transport === 'stdio' || !this.spec.url) throw new Error('stdio servers handle their own authentication');
    if (hasAuthorizationHeader(this.spec.headers)) throw new Error('this server is authenticated by its configured Authorization header');
    if (this.trust !== 'trusted') throw new TrustRequiredError(this.name);
    const { url } = await this.manager.oauth.begin({
      serverUrl: this.spec.url,
      redirectUri: `${origin}${OAUTH_CALLBACK_PATH}`,
      manual: this.spec.oauth?.clientId ? this.spec.oauth : undefined,
      hint: this.authHint,
      context: { root: this.ws.root, name: this.name },
      log: (e) => this.log(e),
    });
    this.cancelRetry();
    this.status = 'authorizing';
    this.error = '';
    this.clearAuthorizing();
    this.authorizingTimer = setTimeout(() => {
      this.authorizingTimer = null;
      if (this.status === 'authorizing') { this.status = 'needs-auth'; this.ws.bump(); }
    }, AUTHORIZING_TIMEOUT_MS);
    this.authorizingTimer.unref?.();
    this.ws.bump();
    return url;
  }

  signInFailed(message: string): void {
    this.clearAuthorizing();
    this.status = 'needs-auth';
    this.error = redact(message);
    this.log({ phase: 'auth', detail: this.error });
    this.ws.bump();
  }

  async signOut(): Promise<void> {
    if (!this.spec.url) return;
    this.manager.oauth.signOut(this.spec.url);
    this.manager.oauth.cancel((c) => c.root === this.ws.root && c.name === this.name);
    this.log({ phase: 'auth', detail: 'signed out' });
    await this.stop(this.trust === 'trusted' ? 'needs-auth' : this.restingStatus());
  }

  async dispose(): Promise<void> {
    await this.stop(this.restingStatus());
  }

  view(isDefault: boolean): ServerView {
    const authMode = this.authMode;
    const signedIn = Boolean(this.spec.url && this.manager.oauth.hasTokens(this.spec.url));
    const info = this.conn?.serverInfo;
    const trust = this.trust;
    return {
      name: this.name,
      scope: this.spec.scope,
      source: this.spec.source,
      transport: this.spec.transport,
      target: this.spec.display,
      description: this.spec.description,
      trust,
      status: this.status,
      declaredEnabled: this.spec.declaredEnabled,
      isDefault,
      error: this.spec.invalid || this.error,
      warnings: [...this.spec.warnings, ...this.registrationErrors.map((e) => `tool registration failed: ${e}`)],
      auth: {
        mode: authMode,
        signedIn,
        canSignIn: this.spec.transport !== 'stdio' && authMode !== 'header' && trust === 'trusted'
          && (this.status === 'needs-auth' || this.status === 'authorizing' || signedIn || authMode === 'oauth'),
      },
      tools: this.knownTools.map((tool) => ({
        name: tool.name,
        publicName: publicToolName(this.name, tool.name),
        description: (tool.description ?? tool.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
      toolCount: this.knownTools.length,
      serverInfo: this.conn && info ? { name: info.title ?? info.name ?? '', version: info.version ?? '', protocolVersion: this.conn.protocolVersion } : null,
      connectedAt: this.status === 'connected' ? this.connectedAt : 0,
      retryAt: this.retryAt,
      attempts: this.attempts,
    };
  }
}

interface AgentBinding {
  sessionId: string;
  /** server name → raw tool name → registration */
  registrations: Map<string, Map<string, Registration>>;
}

class WorkspaceRuntime {
  readonly manager: McpMasterManager;
  readonly root: string;
  files: ConfigFileInfo[] = [];
  shadowed: WorkspaceConfig['shadowed'] = [];
  readonly servers = new Map<string, ServerRuntime>();
  readonly agents = new Map<Agent, AgentBinding>();
  /** Sessions shown in a picker (e.g. a new, not yet started session) → last poll. */
  private readonly viewers = new Map<string, number>();
  rev: number;
  lastSeen = Date.now();
  private stamp = '';
  private loading: Promise<void>;
  private readonly watchTimer: NodeJS.Timeout;
  private readonly waiters = new Set<() => void>();
  disposed = false;

  constructor(manager: McpMasterManager, root: string) {
    this.manager = manager;
    this.root = root;
    this.rev = manager.nextRev();
    this.loading = this.reload();
    this.watchTimer = setInterval(() => {
      if (this.disposed) return;
      if (configStamp(this.root, this.catalogOptions()) !== this.stamp) void this.scheduleReload();
    }, WATCH_INTERVAL_MS);
    this.watchTimer.unref?.();
  }

  private catalogOptions(): { configFiles: readonly string[]; globalFile: string | undefined } {
    return { configFiles: this.manager.options.configFiles, globalFile: this.manager.options.globalConfigFile };
  }

  ready(): Promise<void> {
    return this.loading;
  }

  touch(): void {
    this.lastSeen = Date.now();
  }

  scheduleReload(): Promise<void> {
    this.loading = this.loading.catch(() => {}).then(() => this.reload());
    return this.loading;
  }

  private async reload(): Promise<void> {
    if (this.disposed) return;
    const env = await baseEnv();
    this.stamp = configStamp(this.root, this.catalogOptions());
    const catalog = loadCatalog(this.root, { ...this.catalogOptions(), env });
    this.files = catalog.files;
    this.shadowed = catalog.shadowed;
    const desired = new Map(catalog.servers.map((spec) => [spec.name, spec]));
    for (const [name, server] of [...this.servers]) {
      if (desired.get(name)?.scope === server.spec.scope) continue;
      this.servers.delete(name);
      await server.dispose();
      this.dropServerRegistrations(name);
    }
    for (const spec of catalog.servers) {
      const existing = this.servers.get(spec.name);
      if (existing) existing.update(spec);
      else this.servers.set(spec.name, new ServerRuntime(this, spec));
    }
    this.reconcile();
  }

  bump(): void {
    this.rev = this.manager.nextRev();
    for (const wake of [...this.waiters]) wake();
  }

  /** Resolve when `rev` is stale, after `ms`, or on abort. */
  waitForChange(rev: number, ms: number, signal?: AbortSignal): Promise<void> {
    if (rev !== this.rev || this.disposed) return Promise.resolve();
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  // ---- selections ----

  /** The set new sessions start with: the saved defaults, else trusted servers the files mark enabled. */
  defaults(): string[] {
    const saved = this.manager.store.defaults(this.root);
    if (saved) return saved.filter((name) => this.servers.has(name));
    return [...this.servers.values()].filter((s) => s.trust === 'trusted' && s.spec.declaredEnabled).map((s) => s.name);
  }

  selection(sessionId: string): { active: string[]; explicit: boolean } {
    const stored = this.manager.store.session(sessionId);
    if (stored && stored.root === this.root) return { active: stored.active, explicit: true };
    return { active: this.defaults(), explicit: false };
  }

  /** Selected servers that exist and may run. */
  effective(sessionId: string): Set<string> {
    return new Set(this.selection(sessionId).active.filter((name) => this.servers.get(name)?.trust === 'trusted'));
  }

  /** Servers some live agent or recently viewed session selects. */
  wanted(): Set<string> {
    const now = Date.now();
    const wanted = new Set<string>();
    for (const [sessionId, seen] of [...this.viewers]) {
      if (now - seen > (this.manager.options.viewerTtlMs ?? DEFAULT_VIEWER_TTL_MS)) { this.viewers.delete(sessionId); continue; }
      for (const name of this.effective(sessionId)) wanted.add(name);
    }
    for (const binding of this.agents.values()) for (const name of this.effective(binding.sessionId)) wanted.add(name);
    return wanted;
  }

  /** Start/stop servers and (un)register tools to match every selection. */
  reconcile(): void {
    if (this.disposed) return;
    const wanted = this.wanted();
    const now = Date.now();
    for (const server of this.servers.values()) server.converge(wanted.has(server.name), now);
    for (const agent of this.agents.keys()) this.syncAgent(agent);
    this.bump();
  }

  /** A picker is showing `sessionId`; keep its selection warm. */
  view(sessionId: string): void {
    const fresh = !this.viewers.has(sessionId);
    this.viewers.set(sessionId, Date.now());
    this.touch();
    if (fresh) this.reconcile();
  }

  setActive(sessionId: string, name: string, active: boolean, trust: boolean): void {
    const server = this.server(name);
    if (active && server.trust !== 'trusted') {
      if (!trust) throw new TrustRequiredError(name);
      server.setTrusted(true);
    }
    const next = new Set(this.selection(sessionId).active);
    if (active) next.add(name);
    else next.delete(name);
    this.manager.store.setSession(sessionId, this.root, [...next]);
    if (!this.hasAgentFor(sessionId)) this.viewers.set(sessionId, Date.now());
    if (active && (server.status === 'error' || server.status === 'needs-auth')) server.attempts = 0;
    this.reconcile();
  }

  saveDefaults(sessionId: string): void {
    this.manager.store.setDefaults(this.root, [...this.effective(sessionId)]);
    this.bump();
  }

  resetDefaults(): void {
    this.manager.store.setDefaults(this.root, undefined);
    this.bump();
  }

  trustServer(name: string, trusted: boolean): void {
    this.server(name).setTrusted(trusted);
    this.reconcile();
  }

  // ---- agents ----

  attach(agent: Agent, sessionId: string, parentSessionId: string | undefined): void {
    if (this.agents.has(agent)) return;
    const store = this.manager.store;
    const own = store.session(sessionId);
    if (!own || own.root !== this.root) {
      // Forks and subagents start from their parent's selection; others from the defaults.
      const parent = parentSessionId ? store.session(parentSessionId) : undefined;
      store.setSession(sessionId, this.root, parent && parent.root === this.root ? parent.active : this.selection(sessionId).active);
    }
    this.agents.set(agent, { sessionId, registrations: new Map() });
    this.viewers.delete(sessionId);
    this.touch();
    this.reconcile();
  }

  detach(agent: Agent): void {
    const binding = this.agents.get(agent);
    if (!binding) return;
    for (const registrations of binding.registrations.values()) disposeRegistrations(registrations);
    this.agents.delete(agent);
    this.touch();
    this.reconcile();
  }

  hasAgentFor(sessionId: string): boolean {
    for (const binding of this.agents.values()) if (binding.sessionId === sessionId) return true;
    return false;
  }

  /** Wait (bounded) for servers that are still connecting. */
  async whenSettled(ms: number, signal?: AbortSignal): Promise<void> {
    await this.ready();
    await Promise.all([...this.servers.values()].map((server) => server.settled(ms, signal)));
  }

  syncServer(server: ServerRuntime): void {
    for (const agent of this.agents.keys()) this.syncAgentServer(agent, server);
  }

  private syncAgent(agent: Agent): void {
    for (const server of this.servers.values()) this.syncAgentServer(agent, server);
  }

  private syncAgentServer(agent: Agent, server: ServerRuntime): void {
    const binding = this.agents.get(agent);
    if (!binding) return;
    let registrations = binding.registrations.get(server.name);
    if (!registrations) binding.registrations.set(server.name, registrations = new Map());
    const registry = this.manager.toolsOf(agent);
    if (!registry) return;
    const active = server.status === 'connected' && this.effective(binding.sessionId).has(server.name);
    const definitions = active ? server.definitions : new Map<string, ToolDefinition>();
    const result = syncRegistrations((definition) => registry.register(definition), registrations, definitions);
    if (result.errors.length > 0) {
      server.registrationErrors = result.errors.slice(0, 5);
      this.manager.logger.warn(`mcp-master: registering ${server.name} tools failed: ${result.errors.join('; ')}`);
    } else if (definitions.size > 0) {
      server.registrationErrors = [];
    }
  }

  private dropServerRegistrations(name: string): void {
    for (const binding of this.agents.values()) {
      const registrations = binding.registrations.get(name);
      if (registrations) disposeRegistrations(registrations);
      binding.registrations.delete(name);
    }
  }

  server(name: string): ServerRuntime {
    const server = this.servers.get(name);
    if (!server) throw new Error(`no MCP server named "${name}" for ${this.root}`);
    return server;
  }

  hasViewersOrAgents(now: number): boolean {
    if (this.agents.size > 0) return true;
    for (const seen of this.viewers.values()) if (now - seen <= (this.manager.options.viewerTtlMs ?? DEFAULT_VIEWER_TTL_MS)) return true;
    return false;
  }

  workspaceView(): WorkspaceView {
    const defaults = this.defaults();
    const defaultSet = new Set(defaults);
    return {
      root: this.root,
      name: basename(this.root),
      files: this.files.map((f) => ({ scope: f.scope, rel: f.rel, error: f.error, count: f.count })),
      globalFile: this.manager.options.globalConfigFile ? displayPath(this.manager.options.globalConfigFile) : null,
      shadowed: this.shadowed,
      servers: [...this.servers.values()].map((s) => s.view(defaultSet.has(s.name))),
      defaults,
      customDefaults: this.manager.store.defaults(this.root) !== undefined,
      agents: this.agents.size,
      rev: this.rev,
    };
  }

  sessionView(sessionId: string): SessionView {
    const { active, explicit } = this.selection(sessionId);
    return { id: sessionId, active: active.filter((name) => this.servers.has(name)), explicit, live: this.hasAgentFor(sessionId) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.watchTimer);
    for (const binding of this.agents.values()) {
      for (const registrations of binding.registrations.values()) disposeRegistrations(registrations);
    }
    this.agents.clear();
    this.viewers.clear();
    await Promise.all([...this.servers.values()].map((server) => server.dispose()));
    this.servers.clear();
    for (const wake of [...this.waiters]) wake();
  }
}

export type { WorkspaceRuntime };

export class McpMasterManager {
  readonly logger: Logger;
  readonly store: StateStore;
  readonly services: ToolServices;
  readonly options: ManagerOptions;
  readonly toolsOf: (agent: Agent) => ToolRegistry | undefined;
  readonly oauth: OAuthManager<OAuthContext>;
  private readonly workspaces = new Map<string, WorkspaceRuntime>();
  private readonly agentRoots = new Map<Agent, string>();
  private readonly tickTimer: NodeJS.Timeout;
  private revCounter = 0;
  private disposed = false;

  constructor(deps: ManagerDeps) {
    this.logger = deps.logger;
    this.store = deps.store;
    this.services = deps.services;
    this.options = deps.options;
    this.toolsOf = deps.toolsOf;
    this.oauth = new OAuthManager<OAuthContext>(deps.store, 'DeepSeek Harness (MCP Master)');
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
  }

  nextRev(): number {
    this.revCounter += 1;
    return this.revCounter;
  }

  /** The workspace root for `cwd`: the nearest directory with a project config, else `cwd` itself. */
  rootFor(cwd: string): string | null {
    if (!isAbsolute(cwd)) return null;
    const path = canonical(cwd);
    const root = findConfigRoot(path, { configFiles: this.options.configFiles, searchParents: this.options.searchParents });
    return root ? canonical(root) : path;
  }

  workspaceFor(cwd: string): WorkspaceRuntime | null {
    if (this.disposed) return null;
    const root = this.rootFor(cwd);
    if (!root) return null;
    let ws = this.workspaces.get(root);
    if (!ws || ws.disposed) {
      ws = new WorkspaceRuntime(this, root);
      this.workspaces.set(root, ws);
    }
    return ws;
  }

  requireWorkspace(cwd: string): WorkspaceRuntime {
    const ws = this.workspaceFor(cwd);
    if (!ws) throw new Error(`no workspace for ${cwd}`);
    return ws;
  }

  async attachAgent(agent: Agent, signal?: AbortSignal): Promise<void> {
    if (this.disposed || this.agentRoots.has(agent)) return;
    const header = agent?.session?.header as { cwd?: string; parentSession?: string } | undefined;
    const cwd = header?.cwd;
    if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) return;
    const ws = this.workspaceFor(cwd);
    if (!ws) return;
    this.agentRoots.set(agent, ws.root);
    await ws.ready();
    ws.attach(agent, agent.session.id ?? agent.id, typeof header?.parentSession === 'string' ? header.parentSession : undefined);
    // Give selected servers that are mid-connect a bounded chance to land before the first turn.
    await ws.whenSettled(this.options.startupWaitMs, signal);
  }

  detachAgent(agent: Agent): void {
    const root = this.agentRoots.get(agent);
    if (root === undefined) return;
    this.agentRoots.delete(agent);
    this.workspaces.get(root)?.detach(agent);
  }

  /** View for a cwd and session; with `rev`, long-polls until it changes. */
  async state(cwd: string, sessionId: string | undefined, rev?: number, waitMs = 0, signal?: AbortSignal): Promise<StateResponse> {
    const ws = this.workspaceFor(cwd);
    if (!ws) return { workspace: null, session: null, rev: 0 };
    await ws.ready();
    if (sessionId) ws.view(sessionId);
    else ws.touch();
    if (rev !== undefined && waitMs > 0) await ws.waitForChange(rev, waitMs, signal);
    if (ws.disposed) return { workspace: null, session: null, rev: 0 };
    if (sessionId) ws.view(sessionId);
    return { workspace: ws.workspaceView(), session: sessionId ? ws.sessionView(sessionId) : null, rev: ws.rev };
  }

  /** Finish a browser sign-in; returns a human-readable outcome. */
  async completeSignIn(state: string, code: string | null, providerError: string | null): Promise<{ ok: boolean; message: string; server: string }> {
    const flow = this.oauth.flow(state);
    const ws = flow ? this.workspaces.get(flow.context.root) : undefined;
    const server = flow && ws ? ws.servers.get(flow.context.name) : undefined;
    const name = flow?.context.name ?? '';
    if (!flow) return { ok: false, message: 'This sign-in link expired or was already used. Start the sign-in again from DSH.', server: name };
    if (providerError || !code) {
      this.oauth.cancel((c) => c === flow.context);
      server?.signInFailed(`authorization server returned: ${providerError ?? 'no authorization code'}`);
      return { ok: false, message: `The authorization server returned: ${providerError ?? 'no authorization code'}`, server: name };
    }
    try {
      await this.oauth.complete(state, code, (e) => server?.log(e));
    } catch (error) {
      server?.signInFailed(errorText(error));
      return { ok: false, message: errorText(error), server: name };
    }
    if (server) {
      server.attempts = 0;
      server.start();
      await server.settled(this.options.connectTimeoutMs);
      const ok = server.status === 'connected';
      return { ok, server: name, message: ok ? `Connected — ${server.knownTools.length} tools are available to sessions that activate ${name}.` : `Signed in, but connecting failed: ${server.error || server.status}` };
    }
    return { ok: true, server: name, message: 'Signed in. Return to DSH to use the server.' };
  }

  /** Periodic housekeeping: grace stops, viewer expiry, idle workspaces. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const [root, ws] of [...this.workspaces]) {
      if (!ws.hasViewersOrAgents(now) && now - ws.lastSeen >= this.options.idleShutdownMs) {
        this.workspaces.delete(root);
        this.logger.info(`mcp-master: stopping idle workspace ${root}`);
        await ws.dispose();
        continue;
      }
      ws.reconcile();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.tickTimer);
    const all = [...this.workspaces.values()];
    this.workspaces.clear();
    this.agentRoots.clear();
    await Promise.all(all.map((ws) => ws.dispose()));
  }
}
