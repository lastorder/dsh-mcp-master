/**
 * Minimal structural types for the DSH Host services this plugin touches.
 *
 * Profile plugins cannot import `@deepseek-ai/*` packages, so these mirror
 * only the members used here (verified against DSH 0.2.x through
 * `cordis_inspect_query` and the shipped package sources).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type Disposer = () => unknown;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface Fiber {
  dispose(): unknown;
}

export interface HostContext {
  readonly logger: Logger;
  on(event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean; global?: boolean }): Disposer;
  effect(execute: () => Disposer | void, label?: string): Disposer;
  inject(deps: string[], callback: (ctx: HostContext) => void): Fiber;
  get(name: string): unknown;
}

/** One MCP-style content block as the tool registry carries it. */
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; attachment: unknown };

export interface ToolExecution {
  readonly signal: AbortSignal;
  readonly agent?: Agent;
  readonly name?: string;
}

export interface ToolResultView {
  readonly isError?: boolean;
  readonly value?: unknown;
  readonly content?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  isConcurrencySafe?: (args: unknown) => boolean;
  execute(args: unknown, exec: ToolExecution): Promise<unknown>;
  projectContent?(exec: ToolExecution, result: ToolResultView): ContentBlock[] | undefined;
}

export interface ToolRegistry {
  register(definition: ToolDefinition): Disposer;
}

export interface Agent {
  readonly id: string;
  readonly ctx: HostContext & { readonly tools?: ToolRegistry };
  readonly session: {
    readonly id: string;
    readonly header: { readonly cwd?: string };
    requestHeader?(): { config?: { provider?: string; model?: string } } | undefined;
  };
  readonly options?: { provider?: string; model?: string };
}

export interface AgentRegistry {
  list(): Agent[];
  get(id: string): Agent | undefined;
}

export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
}

export interface WebServer {
  register(route: WebRoute): Disposer;
}

export interface Connection {
  /** HTTP status to answer with when the request is untrusted/unauthenticated. */
  requestRejection(request: IncomingMessage): number | undefined;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly path: string;
  readonly title?: string;
}

export interface WorkspaceRegistry {
  list(): WorkspaceRecord[];
}

export interface AttachmentStore {
  saveImages?(inputs: Array<{ data: Buffer; mediaType: string }>): Promise<unknown[]>;
  saveImage?(input: { data: Buffer; mediaType: string }): Promise<unknown>;
}

export interface ModelInfoRegistry {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: string[] }>;
}

/** Row `config` accepted by this plugin (all optional). */
export interface PluginConfig {
  /** Project files looked up in each workspace, relative to its root, in priority order. */
  configFiles?: string[];
  /** Global catalog file (default `~/.dsh/mcp-master/mcp.json`); `false` disables the global scope. */
  globalConfigFile?: string | false;
  /** Trust project servers without asking (they can run arbitrary commands). */
  autoTrust?: boolean;
  /** Also look for project config files in parent directories of the session cwd. */
  searchParents?: boolean;
  /** How long a new session waits for still-connecting servers before its first turn. */
  startupWaitMs?: number;
  connectTimeoutMs?: number;
  toolCallTimeoutMs?: number;
  /** Stop a workspace's servers after it has no sessions and no viewer for this long. */
  idleShutdownMinutes?: number;
  /** Override the state file (trust, defaults, selections, OAuth tokens). */
  stateFile?: string;
}
