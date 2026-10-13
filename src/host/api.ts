/**
 * Same-origin JSON API between the composer MCP picker and the Host, plus
 * the OAuth redirect receiver. Mounted on the DSH GUI webserver.
 *
 *   GET  /mcp-master/api/ping                                     liveness + version (no data)
 *   GET  /mcp-master/api/state?cwd=…&session=…&rev=…&wait=…       catalog + this session's selection (long-poll)
 *   POST /mcp-master/api/session   { cwd, session, name, action, trust? }   activate | deactivate
 *   POST /mcp-master/api/server    { cwd, session?, name, action }          reconnect | sign-in | sign-out | logs | trust | untrust
 *   POST /mcp-master/api/workspace { cwd, session?, action }                reload | save-default | reset-default
 *   GET  /mcp-master/oauth/callback?code=…&state=…                          browser redirect target
 *
 * API requests pass the Harness connection fence (Host/Origin + browser
 * authentication). The OAuth callback cannot carry the Harness cookie (it
 * arrives in the system browser), so it is authorized by the unguessable,
 * single-use `state` of a flow this process started.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  API_BASE, CSRF_HEADER, MAX_WAIT_MS, OAUTH_CALLBACK_PATH, ROUTE_PREFIX,
  type ActionResponse, type ServerAction, type SessionAction, type WorkspaceAction,
} from '../shared/types.ts';
import type { Connection, Logger, WebRoute } from './dsh.ts';
import { TrustRequiredError, type McpMasterManager, type WorkspaceRuntime } from './runtime.ts';

const MAX_BODY = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/;

export interface ApiDeps {
  manager: McpMasterManager;
  logger: Logger;
  connection(): Connection | undefined;
  /** Whether a cwd belongs to a workspace/session this Harness knows. */
  isKnownPath(cwd: string): boolean;
  version: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, 'body must be a JSON object');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function callbackPage(ok: boolean, title: string, message: string): string {
  const color = ok ? '#1f9d55' : '#d93025';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}
main{max-width:460px;padding:32px;border-radius:16px;border:1px solid color-mix(in srgb,CanvasText 12%,transparent)}h1{font-size:18px;margin:0 0 8px;display:flex;gap:10px;align-items:center}
.dot{width:10px;height:10px;border-radius:50%;background:${color}}p{margin:0;opacity:.8}small{display:block;margin-top:16px;opacity:.55}</style></head>
<body><main><h1><span class="dot"></span>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><small>You can close this tab and return to DeepSeek Harness.</small></main>
${ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script>' : ''}</body></html>`;
}

function originOf(req: IncomingMessage): string {
  const host = String(req.headers.host ?? '').trim();
  if (!/^[A-Za-z0-9.[\]:-]+$/.test(host)) throw new HttpError(400, 'missing or invalid Host header');
  return `http://${host}`;
}

function isLoopbackHost(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createRoute(deps: ApiDeps): WebRoute {
  const { manager, logger } = deps;

  function authorize(req: IncomingMessage, mutating: boolean): void {
    const connection = deps.connection();
    if (connection) {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) throw new HttpError(rejection, 'request rejected by the Harness connection policy');
    } else if (!isLoopbackHost(req)) {
      throw new HttpError(403, 'only loopback requests are accepted');
    }
    // A custom header cannot be sent cross-origin without a CORS preflight, which this route never grants.
    if (mutating && req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, `missing ${CSRF_HEADER} header`);
  }

  function checkCwd(value: unknown): string {
    const cwd = str(value).trim();
    if (!cwd || !isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path');
    try {
      if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new HttpError(404, 'cwd does not exist');
    }
    if (!deps.isKnownPath(cwd)) throw new HttpError(403, 'cwd is not a known DSH workspace');
    return cwd;
  }

  function checkSession(value: unknown, required: boolean): string | undefined {
    const id = str(value);
    if (!id) {
      if (required) throw new HttpError(400, 'session is required');
      return undefined;
    }
    if (!SESSION_ID.test(id)) throw new HttpError(400, 'invalid session id');
    return id;
  }

  async function workspaceOf(body: Record<string, unknown>): Promise<WorkspaceRuntime> {
    const ws = manager.requireWorkspace(checkCwd(body['cwd']));
    await ws.ready();
    return ws;
  }

  function respond(ws: WorkspaceRuntime, sessionId: string | undefined, extra: Partial<ActionResponse> = {}): ActionResponse {
    return { ok: true, workspace: ws.workspaceView(), session: sessionId ? ws.sessionView(sessionId) : null, ...extra };
  }

  async function sessionAction(body: Record<string, unknown>): Promise<ActionResponse> {
    const ws = await workspaceOf(body);
    const sessionId = checkSession(body['session'], true) as string;
    const name = str(body['name']);
    const action = body['action'] as SessionAction;
    if (action !== 'activate' && action !== 'deactivate') throw new HttpError(400, `unknown action "${String(action)}"`);
    ws.setActive(sessionId, name, action === 'activate', body['trust'] === true);
    return respond(ws, sessionId);
  }

  async function serverAction(body: Record<string, unknown>, req: IncomingMessage): Promise<ActionResponse> {
    const ws = await workspaceOf(body);
    const sessionId = checkSession(body['session'], false);
    const server = ws.server(str(body['name']));
    const action = body['action'] as ServerAction;
    let authorizeUrl: string | undefined;
    switch (action) {
      case 'reconnect': server.reconnect(); break;
      case 'sign-in': authorizeUrl = await server.beginSignIn(originOf(req)); break;
      case 'sign-out': await server.signOut(); break;
      case 'trust': ws.trustServer(server.name, true); break;
      case 'untrust': ws.trustServer(server.name, false); break;
      case 'logs': return { ok: true, logs: server.logs.slice() };
      default: throw new HttpError(400, `unknown action "${String(action)}"`);
    }
    return respond(ws, sessionId, authorizeUrl ? { authorizeUrl } : {});
  }

  async function workspaceAction(body: Record<string, unknown>): Promise<ActionResponse> {
    const ws = await workspaceOf(body);
    const sessionId = checkSession(body['session'], false);
    const action = body['action'] as WorkspaceAction;
    switch (action) {
      case 'reload':
        await ws.scheduleReload();
        for (const server of ws.servers.values()) if (server.status === 'error') server.reconnect();
        break;
      case 'save-default':
        if (!sessionId) throw new HttpError(400, 'session is required');
        ws.saveDefaults(sessionId);
        break;
      case 'reset-default':
        ws.resetDefaults();
        break;
      default:
        throw new HttpError(400, `unknown action "${String(action)}"`);
    }
    return respond(ws, sessionId);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === OAUTH_CALLBACK_PATH) {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only');
      const state = url.searchParams.get('state') ?? '';
      const outcome = await manager.completeSignIn(state, url.searchParams.get('code'), url.searchParams.get('error_description') ?? url.searchParams.get('error'));
      res.statusCode = outcome.ok ? 200 : 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
      res.end(callbackPage(outcome.ok, outcome.ok ? `${outcome.server || 'MCP server'} connected` : 'Sign-in did not complete', outcome.message));
      return;
    }

    if (path === `${API_BASE}/ping`) {
      sendJson(res, 200, { ok: true, name: 'dsh-mcp-master', version: deps.version });
      return;
    }

    if (path === `${API_BASE}/state`) {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only');
      authorize(req, false);
      const cwd = checkCwd(url.searchParams.get('cwd'));
      const sessionId = checkSession(url.searchParams.get('session'), false);
      const revParam = url.searchParams.get('rev');
      const rev = revParam !== null && /^\d+$/.test(revParam) ? Number(revParam) : undefined;
      const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
      const aborted = new AbortController();
      res.on('close', () => aborted.abort());
      sendJson(res, 200, await manager.state(cwd, sessionId, rev, wait, aborted.signal));
      return;
    }

    const handlers: Record<string, (body: Record<string, unknown>) => Promise<ActionResponse>> = {
      [`${API_BASE}/session`]: sessionAction,
      [`${API_BASE}/server`]: (body) => serverAction(body, req),
      [`${API_BASE}/workspace`]: workspaceAction,
    };
    const handler = handlers[path];
    if (handler) {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      authorize(req, true);
      sendJson(res, 200, await handler(await readJson(req)));
      return;
    }

    throw new HttpError(404, 'not found');
  }

  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      try {
        await handle(req, res);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
          return;
        }
        if (error instanceof TrustRequiredError) {
          sendJson(res, 409, { ok: false, error: error.message, code: 'trust-required' });
          return;
        }
        const message = String((error as Error)?.message ?? error).slice(0, 400);
        logger.warn(`mcp-master api: ${message}`);
        sendJson(res, 400, { ok: false, error: message });
      }
    },
  };
}
