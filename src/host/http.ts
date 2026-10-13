/**
 * HTTP transports: Streamable HTTP (current MCP) and the legacy HTTP+SSE
 * session transport, both with pluggable authorization.
 */

import {
  AuthRequiredError, McpError, PendingRequests, SessionExpiredError, kindOf, messagesFromEventData,
  pumpSse, replyToServerRequest, timeoutSignal,
  type JsonRpcMessage, type LogFn, type McpConnection, type RequestOptions, type Root,
} from './jsonrpc.ts';

/**
 * Authorization hook. `unauthorized` returns true when it refreshed the
 * credentials and the request should be retried once; otherwise the
 * transport throws AuthRequiredError.
 */
export interface HttpAuth {
  headers(): Promise<Record<string, string>>;
  unauthorized(info: { wwwAuthenticate: string; status: number }): Promise<boolean>;
}

export interface HttpSpec {
  url: string;
  headers: Record<string, string>;
}

export interface HttpOptions {
  auth?: HttpAuth;
  roots?: Root[];
  log?: LogFn;
  connectTimeoutMs?: number;
}

export const NO_AUTH: HttpAuth = { headers: async () => ({}), unauthorized: async () => false };

async function bodyText(resp: Response, limit = 600): Promise<string> {
  try {
    return (await resp.text()).replace(/\s+/g, ' ').trim().slice(0, limit);
  } catch {
    return '';
  }
}

export function describeHttpFailure(status: number, text: string): string {
  let reason = text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed['error'];
    reason = String(parsed['error_description'] ?? (error && typeof error === 'object' ? (error as { message?: string }).message : error) ?? parsed['message'] ?? text);
  } catch {}
  return `HTTP ${status}${reason ? `: ${reason.slice(0, 300)}` : ''}`;
}

async function authorizedFetch(url: string, init: RequestInit & { headers: Record<string, string> }, auth: HttpAuth, log: LogFn, phase: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = { ...init.headers, ...(await auth.headers()) };
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, headers });
    } catch (error) {
      const err = error as Error & { cause?: { code?: string; message?: string } };
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
      const cause = err?.cause?.code ?? err?.cause?.message ?? '';
      throw new McpError(`${phase}: ${err?.message ?? err}${cause ? ` (${cause})` : ''}`);
    }
    if (resp.status !== 401) return resp;
    const wwwAuthenticate = resp.headers.get('www-authenticate') ?? '';
    const text = await bodyText(resp, 300);
    log({ phase, status: 401, target: url, detail: wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate.slice(0, 300)}` : (text || 'unauthorized') });
    if (attempt === 0 && (await auth.unauthorized({ wwwAuthenticate, status: 401 }))) continue;
    throw new AuthRequiredError(`authentication required${text ? ` (${text.slice(0, 160)})` : ''}`, { wwwAuthenticate });
  }
  throw new AuthRequiredError('authentication required');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export interface StreamableHttpConnection extends McpConnection {
  readonly sessionId: string | null;
}

/**
 * Streamable HTTP connection. The first request must be `initialize`; its
 * response may assign an `Mcp-Session-Id` that every later request carries.
 */
export function openStreamableHttp(spec: HttpSpec, options: HttpOptions = {}): StreamableHttpConnection {
  const { auth = NO_AUTH, roots = [], log = () => {} } = options;
  const pending = new PendingRequests();
  let sessionId: string | null = null;
  let closed = false;
  let streamController: AbortController | null = null;
  const inflight = new Set<AbortController>();

  const baseHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { accept: 'application/json, text/event-stream', ...spec.headers };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (conn.protocolVersion) headers['mcp-protocol-version'] = conn.protocolVersion;
    return headers;
  };

  const dispatch = (message: JsonRpcMessage): void => {
    switch (kindOf(message)) {
      case 'response':
        pending.settle(message);
        break;
      case 'notification':
        try { conn.onNotification?.(message); } catch {}
        break;
      case 'request':
        void post(replyToServerRequest(message, roots), { timeoutMs: 15000 }).catch(() => {});
        break;
      default:
        break;
    }
  };

  const handleDeath = (error: Error): void => {
    if (closed) return;
    closed = true;
    streamController?.abort();
    pending.rejectAll(error);
    try { conn.onClose?.(error); } catch {}
  };

  async function post(payload: JsonRpcMessage, opts: RequestOptions & { expectId?: number } = {}): Promise<void> {
    const { signal, timeoutMs = 60000, expectId } = opts;
    if (closed) throw new McpError('connection closed');
    const controller = new AbortController();
    inflight.add(controller);
    const limit = timeoutSignal(signal, timeoutMs);
    const combined = limit ? AbortSignal.any([controller.signal, limit]) : controller.signal;
    const what = payload.method ?? 'response';
    try {
      const resp = await authorizedFetch(spec.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...baseHeaders() },
        body: JSON.stringify(payload),
        signal: combined,
      }, auth, log, what);
      const assigned = resp.headers.get('mcp-session-id');
      if (assigned && !sessionId) sessionId = assigned;
      if (resp.status === 404 && sessionId && payload.method !== 'initialize') {
        await bodyText(resp);
        throw new SessionExpiredError();
      }
      if (!resp.ok) throw new McpError(describeHttpFailure(resp.status, await bodyText(resp)), { status: resp.status });
      if (resp.status === 202 || resp.status === 204 || expectId === undefined) {
        try { await resp.body?.cancel(); } catch {}
        return;
      }
      const type = (resp.headers.get('content-type') ?? '').toLowerCase();
      if (type.includes('text/event-stream') && resp.body) {
        let done = false;
        await pumpSse(resp.body, ({ data }) => {
          for (const message of messagesFromEventData(data)) {
            if (kindOf(message) === 'response' && message.id === expectId) done = true;
            dispatch(message);
          }
        }, () => done);
        if (!done && pending.has(expectId)) throw new McpError(`${what}: the response stream ended without an answer`);
        return;
      }
      const text = await resp.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        throw new McpError(`${what}: the server answered with non-JSON content (${type || 'no content-type'}): ${text.replace(/\s+/g, ' ').slice(0, 160)}`, { status: resp.status });
      }
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) dispatch(message as JsonRpcMessage);
    } catch (error) {
      const err = error as Error;
      if (err?.name === 'TimeoutError') throw new McpError(`${what} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' });
      if (err?.name === 'AbortError' && controller.signal.aborted) throw new McpError('connection closed');
      throw error;
    } finally {
      inflight.delete(controller);
    }
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    try {
      await post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, { timeoutMs: 15000 });
    } catch (error) {
      if (error instanceof SessionExpiredError) handleDeath(error);
    }
  }

  const conn: StreamableHttpConnection = {
    transport: 'http',
    protocolVersion: '',
    capabilities: {},
    serverInfo: {},
    instructions: '',
    onNotification: null,
    onClose: null,
    get sessionId() { return sessionId; },
    request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
      if (closed) return Promise.reject(new McpError('connection closed'));
      const timeoutMs = opts.timeoutMs ?? 60000;
      const id = pending.allocate();
      const promise = pending.track(id, method, {
        timeoutMs: timeoutMs + 1000,
        signal: opts.signal,
        onAbort: (requestId, reason) => { void notify('notifications/cancelled', { requestId, reason }); },
      });
      post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, { signal: opts.signal, timeoutMs, expectId: id })
        .then(() => {
          if (pending.has(id)) pending.reject(id, new McpError(`${method}: no response received`));
        })
        .catch((error: Error) => {
          if (error instanceof SessionExpiredError) { handleDeath(error); return; }
          pending.reject(id, error);
        });
      return promise;
    },
    notify,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      streamController?.abort();
      for (const controller of inflight) controller.abort();
      pending.rejectAll(new McpError('connection closed'));
      if (sessionId) {
        try {
          const resp = await fetch(spec.url, { method: 'DELETE', headers: { ...baseHeaders(), ...(await auth.headers()) }, signal: AbortSignal.timeout(3000) });
          await resp.body?.cancel();
        } catch {}
      }
    },
    startNotificationStream(): void {
      if (streamController || closed) return;
      const controller = new AbortController();
      streamController = controller;
      void (async () => {
        let failures = 0;
        while (!controller.signal.aborted && !closed) {
          try {
            const resp = await authorizedFetch(spec.url, {
              method: 'GET',
              headers: { ...baseHeaders(), accept: 'text/event-stream' },
              signal: controller.signal,
            }, auth, () => {}, 'notifications');
            if (resp.status === 405 || resp.status === 404 || resp.status === 400) { await bodyText(resp); return; }
            if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
            failures = 0;
            await pumpSse(resp.body, ({ data }) => {
              for (const message of messagesFromEventData(data)) dispatch(message);
            }, () => controller.signal.aborted);
          } catch {
            if (controller.signal.aborted || closed) return;
            failures += 1;
            if (failures > 6) return;
          }
          await sleep(Math.min(30000, 1000 * 2 ** failures), controller.signal);
        }
      })();
    },
  };
  return conn;
}

/**
 * Legacy HTTP+SSE transport (MCP 2024-11-05): a GET stream advertises a POST
 * endpoint via `event: endpoint`; replies arrive asynchronously on the stream.
 */
export async function openLegacySse(spec: HttpSpec, options: HttpOptions = {}): Promise<McpConnection> {
  const { auth = NO_AUTH, roots = [], log = () => {}, connectTimeoutMs = 20000 } = options;
  const pending = new PendingRequests();
  const controller = new AbortController();
  let closed = false;
  let endpoint = '';

  const resp = await authorizedFetch(spec.url, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...spec.headers },
    signal: controller.signal,
  }, auth, log, 'sse-connect');
  if (!resp.ok || !resp.body) throw new McpError(`SSE connect ${describeHttpFailure(resp.status, await bodyText(resp))}`, { status: resp.status });
  if (!(resp.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
    const text = await bodyText(resp);
    throw new McpError(`SSE connect: the server did not answer with an event stream (${text.slice(0, 120)})`);
  }

  async function post(payload: JsonRpcMessage, timeoutMs = 30000): Promise<void> {
    if (closed) throw new McpError('connection closed');
    const r = await authorizedFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...spec.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    }, auth, log, payload.method ?? 'response');
    if (!r.ok) throw new McpError(describeHttpFailure(r.status, await bodyText(r)), { status: r.status });
    try { await r.body?.cancel(); } catch {}
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    try { await post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); } catch {}
  }

  const conn: McpConnection = {
    transport: 'sse',
    protocolVersion: '',
    capabilities: {},
    serverInfo: {},
    instructions: '',
    onNotification: null,
    onClose: null,
    request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
      if (closed) return Promise.reject(new McpError('connection closed'));
      const id = pending.allocate();
      const promise = pending.track(id, method, {
        ...opts,
        onAbort: (requestId, reason) => { void notify('notifications/cancelled', { requestId, reason }); },
      });
      post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch((error: Error) => pending.reject(id, error));
      return promise;
    },
    notify,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      controller.abort();
      pending.rejectAll(new McpError('connection closed'));
    },
  };

  const dispatch = (message: JsonRpcMessage): void => {
    switch (kindOf(message)) {
      case 'response':
        pending.settle(message);
        break;
      case 'notification':
        try { conn.onNotification?.(message); } catch {}
        break;
      case 'request':
        void post(replyToServerRequest(message, roots)).catch(() => {});
        break;
      default:
        break;
    }
  };

  let endpointResolve: (value: string) => void = () => {};
  const endpointReady = new Promise<string>((resolve) => { endpointResolve = resolve; });
  void pumpSse(resp.body, ({ event, data }) => {
    if (event === 'endpoint') {
      try { endpointResolve(new URL(data.trim(), spec.url).toString()); } catch {}
      return;
    }
    for (const message of messagesFromEventData(data)) dispatch(message);
  }, () => closed).catch(() => {}).finally(() => {
    endpointResolve('');
    if (!closed) {
      closed = true;
      const error = new McpError('SSE stream closed by the server');
      pending.rejectAll(error);
      try { conn.onClose?.(error); } catch {}
    }
  });

  const advertised = await Promise.race([
    endpointReady,
    new Promise<string>((resolve) => { const t = setTimeout(() => resolve(''), connectTimeoutMs); t.unref?.(); }),
  ]);
  if (!advertised) {
    closed = true;
    controller.abort();
    throw new McpError('SSE stream did not advertise a message endpoint');
  }
  endpoint = advertised;
  log({ phase: 'sse-connect', target: spec.url, detail: `session endpoint ${new URL(advertised).pathname}` });
  return conn;
}
