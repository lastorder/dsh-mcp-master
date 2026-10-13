/** Browser-side calls to the Host routes (same origin; the Harness cookie rides along). */

import {
  API_BASE, CSRF_HEADER, MAX_WAIT_MS,
  type ActionResponse, type ServerAction, type SessionAction, type StateResponse, type WorkspaceAction,
} from '../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parse<T>(resp: Response): Promise<T> {
  let body: unknown = null;
  try { body = await resp.json(); } catch {}
  if (!resp.ok) {
    const record = body && typeof body === 'object' ? body as { error?: unknown; code?: unknown } : {};
    throw new ApiError(resp.status, typeof record.error === 'string' ? record.error : `HTTP ${resp.status}`, typeof record.code === 'string' ? record.code : undefined);
  }
  return body as T;
}

export async function fetchState(cwd: string, session: string, rev: number | undefined, wait: boolean, signal: AbortSignal): Promise<StateResponse> {
  const params = new URLSearchParams({ cwd, session });
  if (rev !== undefined && wait) {
    params.set('rev', String(rev));
    params.set('wait', String(MAX_WAIT_MS));
  }
  const resp = await fetch(`${API_BASE}/state?${params}`, { credentials: 'same-origin', cache: 'no-store', signal });
  return parse<StateResponse>(resp);
}

async function post(path: string, body: Record<string, unknown>): Promise<ActionResponse> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify(body),
  });
  return parse<ActionResponse>(resp);
}

export function sessionAction(cwd: string, session: string, name: string, action: SessionAction, trust = false): Promise<ActionResponse> {
  return post('/session', { cwd, session, name, action, trust });
}

export function serverAction(cwd: string, session: string, name: string, action: ServerAction): Promise<ActionResponse> {
  return post('/server', { cwd, session, name, action });
}

export function workspaceAction(cwd: string, session: string, action: WorkspaceAction): Promise<ActionResponse> {
  return post('/workspace', { cwd, session, action });
}
