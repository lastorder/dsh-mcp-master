/**
 * Wire contract between the Host half (src/host) and the Client half
 * (src/client). Both sides import these types; only plain JSON crosses.
 */

export const ROUTE_PREFIX = '/mcp-master';
export const API_BASE = `${ROUTE_PREFIX}/api`;
export const OAUTH_CALLBACK_PATH = `${ROUTE_PREFIX}/oauth/callback`;
/** Sent on every mutating request; a cross-origin page cannot add it without a CORS preflight. */
export const CSRF_HEADER = 'x-dsh-mcp-master';
/** Longest long-poll the Host holds open for `GET /state`. */
export const MAX_WAIT_MS = 25000;

/** How a server is reached. */
export type Transport = 'stdio' | 'http' | 'sse';

/** Where a server is declared. */
export type Scope = 'project' | 'global';

/**
 * Whether a server may run at all (security, per workspace).
 * - `trusted`   — global servers, or project servers the user trusted
 * - `untrusted` — newly discovered project server, never trusted
 * - `changed`   — trusted before, but its command/URL changed since
 * - `invalid`   — the entry cannot be launched as written
 */
export type Trust = 'trusted' | 'untrusted' | 'changed' | 'invalid';

/** Live state of one server in a workspace. */
export type ServerStatus =
  | 'connected'
  | 'connecting'
  | 'needs-auth'
  | 'authorizing'
  | 'error'
  | 'idle'
  | 'untrusted'
  | 'changed'
  | 'invalid';

/** How an HTTP server is authenticated. */
export type AuthMode = 'none' | 'oauth' | 'header' | 'unknown';

export interface ToolView {
  name: string;
  publicName: string;
  description: string;
  readOnly: boolean;
}

export interface LogEntryView {
  at: number;
  phase: string;
  status: number;
  target: string;
  detail: string;
}

export interface ServerView {
  name: string;
  scope: Scope;
  /** File that declares the server (workspace-relative, or ~-relative for global). */
  source: string;
  transport: Transport;
  /** Command line or URL exactly as written (never variable-expanded). */
  target: string;
  description: string;
  trust: Trust;
  status: ServerStatus;
  /** What the config file itself says (`enabled:false` / `disabled:true` → false). */
  declaredEnabled: boolean;
  /** Part of the workspace's default set for new sessions. */
  isDefault: boolean;
  error: string;
  warnings: string[];
  auth: {
    mode: AuthMode;
    signedIn: boolean;
    /** Whether a browser sign-in can be started. */
    canSignIn: boolean;
  };
  /** Last known tool list (kept while the server is idle). */
  tools: ToolView[];
  toolCount: number;
  serverInfo: { name: string; version: string; protocolVersion: string } | null;
  connectedAt: number;
  /** Epoch ms of the next automatic reconnect, 0 when none is scheduled. */
  retryAt: number;
  attempts: number;
}

export interface ConfigFileView {
  scope: Scope;
  rel: string;
  error: string;
  count: number;
}

export interface ShadowedView {
  name: string;
  source: string;
  winner: string;
}

export interface WorkspaceView {
  root: string;
  name: string;
  files: ConfigFileView[];
  /** Where global servers are read from (~-relative), even if the file does not exist yet; null when disabled. */
  globalFile: string | null;
  shadowed: ShadowedView[];
  servers: ServerView[];
  /** Server names new sessions in this workspace start with. */
  defaults: string[];
  /** Whether `defaults` was saved by the user (false: derived from the files). */
  customDefaults: boolean;
  /** Live sessions in this workspace. */
  agents: number;
  rev: number;
}

/** One session's MCP selection. */
export interface SessionView {
  id: string;
  /** Servers active in this session (trusted ones get their tools registered). */
  active: string[];
  /** Whether the selection was set for this session (false: following the defaults). */
  explicit: boolean;
  /** Whether a live agent of this session currently receives the tools. */
  live: boolean;
}

export interface StateResponse {
  workspace: WorkspaceView | null;
  session: SessionView | null;
  rev: number;
}

export interface ActionResponse {
  ok: boolean;
  error?: string;
  workspace?: WorkspaceView | null;
  session?: SessionView | null;
  authorizeUrl?: string;
  logs?: LogEntryView[];
}

export type ServerAction = 'reconnect' | 'sign-in' | 'sign-out' | 'logs' | 'trust' | 'untrust';
export type SessionAction = 'activate' | 'deactivate';
export type WorkspaceAction = 'reload' | 'save-default' | 'reset-default';
