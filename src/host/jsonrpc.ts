/**
 * Transport-independent MCP JSON-RPC plumbing: the connection contract,
 * request bookkeeping, SSE framing, replies to server-initiated requests, and
 * the initialize handshake.
 */

declare const __PLUGIN_VERSION__: string;

export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_INFO = Object.freeze({
  name: 'dsh-mcp-master',
  title: 'DeepSeek Harness · MCP Master',
  version: typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0',
});

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  [key: string]: unknown;
}

/** What every transport returns; `initialize()` fills the negotiated fields. */
export interface McpConnection {
  readonly transport: 'stdio' | 'http' | 'sse';
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name?: string; version?: string; title?: string };
  instructions: string;
  /** Server notifications (e.g. `notifications/tools/list_changed`). */
  onNotification: ((message: JsonRpcMessage) => void) | null;
  /** Called once when the transport dies without `close()`. */
  onClose: ((error: Error) => void) | null;
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  /** Open the server→client stream when the server supports list_changed. */
  startNotificationStream?(): void;
}

export interface LogEntry {
  phase: string;
  status?: number;
  target?: string;
  detail: string;
}

export type LogFn = (entry: LogEntry) => void;

export interface Root {
  uri: string;
  name: string;
}

export class McpError extends Error {
  code?: number | string;
  data?: unknown;
  status?: number;

  constructor(message: string, extra: { code?: number | string; data?: unknown; status?: number } = {}) {
    super(message);
    this.name = 'McpError';
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.data !== undefined) this.data = extra.data;
    if (extra.status !== undefined) this.status = extra.status;
  }
}

/** The server demands credentials (HTTP 401) and no refresh helped. */
export class AuthRequiredError extends Error {
  readonly wwwAuthenticate: string;
  readonly status: number;

  constructor(message: string, extra: { wwwAuthenticate?: string; status?: number } = {}) {
    super(message);
    this.name = 'AuthRequiredError';
    this.wwwAuthenticate = extra.wwwAuthenticate ?? '';
    this.status = extra.status ?? 401;
  }
}

/** Streamable HTTP session vanished (HTTP 404 with a session id). */
export class SessionExpiredError extends Error {
  constructor(message = 'MCP session expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

function errorFromRpc(error: JsonRpcMessage['error']): McpError {
  const message = typeof error?.message === 'string' && error.message ? error.message : JSON.stringify(error ?? {});
  return new McpError(message, { ...(error?.code !== undefined ? { code: error.code } : {}), data: error?.data });
}

interface PendingEntry {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Pending request table shared by every transport. */
export class PendingRequests {
  private nextId = 1;
  private readonly map = new Map<number | string, PendingEntry>();

  allocate(): number {
    return this.nextId++;
  }

  /**
   * Track one request. Resolves with its `result`; rejects on an RPC error,
   * timeout, or abort. `onAbort(id, reason)` lets the transport send
   * `notifications/cancelled`.
   */
  track(id: number, method: string, options: RequestOptions & { onAbort?: (id: number, reason: string) => void } = {}): Promise<unknown> {
    const { timeoutMs = 60000, signal, onAbort } = options;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let cleanup: (() => void) | undefined;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        cleanup?.();
        this.map.delete(id);
      };
      const entry: PendingEntry = {
        method,
        resolve: (value) => { finish(); resolve(value); },
        reject: (error) => { finish(); reject(error); },
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          onAbort?.(id, 'timeout');
          entry.reject(new McpError(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' }));
        }, timeoutMs);
        timer.unref?.();
      }
      if (signal) {
        const reason = (): Error => (signal.reason instanceof Error ? signal.reason : new McpError(`MCP ${method} was cancelled`, { code: 'aborted' }));
        if (signal.aborted) {
          queueMicrotask(() => entry.reject(reason()));
        } else {
          const abort = (): void => {
            onAbort?.(id, 'cancelled by the caller');
            entry.reject(reason());
          };
          signal.addEventListener('abort', abort, { once: true });
          cleanup = () => signal.removeEventListener('abort', abort);
        }
      }
      this.map.set(id, entry);
    });
  }

  has(id: unknown): boolean {
    return (typeof id === 'number' || typeof id === 'string') && this.map.has(id);
  }

  /** Settle one response message. Returns true when it matched a request. */
  settle(message: JsonRpcMessage): boolean {
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return false;
    const entry = this.map.get(message.id);
    if (!entry) return false;
    if (message.error) entry.reject(errorFromRpc(message.error));
    else entry.resolve(message.result ?? {});
    return true;
  }

  reject(id: number, error: Error): void {
    this.map.get(id)?.reject(error);
  }

  rejectAll(error: Error): void {
    for (const entry of [...this.map.values()]) entry.reject(error);
    this.map.clear();
  }
}

export type MessageKind = 'request' | 'notification' | 'response' | 'invalid';

/** Classify one decoded JSON-RPC message. */
export function kindOf(message: unknown): MessageKind {
  if (!message || typeof message !== 'object') return 'invalid';
  const m = message as JsonRpcMessage;
  const hasId = m.id !== undefined && m.id !== null;
  if (typeof m.method === 'string') return hasId ? 'request' : 'notification';
  if (hasId && ('result' in m || 'error' in m)) return 'response';
  return 'invalid';
}

/**
 * Answer a request the server sent to us. Only `roots` is advertised, so
 * `ping` and `roots/list` succeed and everything else is "method not found".
 */
export function replyToServerRequest(message: JsonRpcMessage, roots: Root[] = []): JsonRpcMessage {
  switch (message.method) {
    case 'ping':
      return { jsonrpc: '2.0', id: message.id ?? null, result: {} };
    case 'roots/list':
      return { jsonrpc: '2.0', id: message.id ?? null, result: { roots } };
    default:
      return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `Method not supported by this client: ${message.method}` } };
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Decode complete SSE events in `text`. */
export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let data: string[] = [];
  let event = 'message';
  const flush = (): void => {
    if (data.length > 0) events.push({ event, data: data.join('\n') });
    data = [];
    event = 'message';
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line === '') { flush(); continue; }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value || 'message';
  }
  flush();
  return events;
}

/** JSON messages carried by one SSE event (single or batch). */
export function messagesFromEventData(data: string): JsonRpcMessage[] {
  try {
    const parsed: unknown = JSON.parse(data);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((m): m is JsonRpcMessage => m !== null && typeof m === 'object');
  } catch {
    return [];
  }
}

/**
 * Pump an SSE response body, invoking `onEvent` per event. Resolves when the
 * stream ends or `shouldStop()` turns true (the body is then cancelled).
 */
export async function pumpSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void, shouldStop: () => boolean = () => false): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split + 2);
        buffer = buffer.slice(split + 2);
        for (const event of parseSseEvents(block)) onEvent(event);
        if (shouldStop()) return;
      }
    }
    buffer += decoder.decode();
    for (const event of parseSseEvents(`${buffer}\n\n`)) onEvent(event);
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

/** Combine an optional caller signal with a timeout. */
export function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Run the MCP `initialize` handshake and record the negotiated facts on `conn`. */
export async function initialize(conn: McpConnection, options: RequestOptions = {}): Promise<void> {
  const result = await conn.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { roots: { listChanged: false } },
    clientInfo: CLIENT_INFO,
  }, options);
  const r = isRecord(result) ? result : {};
  conn.protocolVersion = typeof r['protocolVersion'] === 'string' ? r['protocolVersion'] : PROTOCOL_VERSION;
  conn.capabilities = isRecord(r['capabilities']) ? r['capabilities'] as ServerCapabilities : {};
  conn.serverInfo = isRecord(r['serverInfo']) ? r['serverInfo'] as McpConnection['serverInfo'] : {};
  conn.instructions = typeof r['instructions'] === 'string' ? r['instructions'] : '';
  await conn.notify('notifications/initialized');
}

/** One entry of `tools/list`. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Page through `tools/list`. Servers that omit the `tools` capability are probed once. */
export async function listAllTools(conn: McpConnection, options: RequestOptions = {}): Promise<McpTool[]> {
  if (!conn.capabilities.tools) {
    try {
      return await listPages(conn, options);
    } catch {
      return [];
    }
  }
  return listPages(conn, options);
}

async function listPages(conn: McpConnection, options: RequestOptions): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await conn.request('tools/list', cursor === undefined ? {} : { cursor }, options);
    const r = isRecord(result) ? result : {};
    const list = r['tools'];
    if (!Array.isArray(list)) throw new McpError('tools/list returned no tools array');
    for (const tool of list) if (isRecord(tool) && typeof tool['name'] === 'string' && tool['name']) tools.push(tool as unknown as McpTool);
    const next = typeof r['nextCursor'] === 'string' && r['nextCursor'] ? r['nextCursor'] : undefined;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return tools;
}
