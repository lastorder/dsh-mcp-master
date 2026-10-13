/**
 * OAuth 2.1 for remote MCP servers, as the MCP authorization spec describes:
 * RFC 9728 protected-resource metadata → RFC 8414 / OIDC authorization-server
 * metadata → RFC 7591 dynamic client registration → authorization code with
 * PKCE (S256) → refresh_token rotation.
 *
 * Credentials are keyed by the canonical server URL, so signing in to a
 * server once covers every workspace that declares the same URL.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { LogFn } from './jsonrpc.ts';
import type { OAuthClient, OAuthMetadata, StateStore } from './state.ts';

const FLOW_TTL_MS = 15 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Canonical credential key for one server URL: origin + path (no query, fragment, or trailing slash). */
export function credentialKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Parse the auth-params of a `WWW-Authenticate: Bearer ...` header (lower-cased names). */
export function parseWwwAuthenticate(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) out[(m[1] ?? '').toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

interface JsonResponse {
  status: number;
  ok: boolean;
  json: Record<string, unknown> | null;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<JsonResponse> {
  const resp = await fetch(url, { headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try { json = asRecord(JSON.parse(text)); } catch {}
  return { status: resp.status, ok: resp.ok, json, text };
}

async function postForm(url: string, form: Record<string, string>, timeoutMs = 30000): Promise<JsonResponse> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try { json = asRecord(JSON.parse(text)); } catch {
    // A few providers answer form-encoded despite Accept: application/json.
    const params = new URLSearchParams(text);
    if (params.has('access_token') || params.has('error')) json = Object.fromEntries(params);
  }
  return { status: resp.status, ok: resp.ok, json, text };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function oauthError(prefix: string, resp: JsonResponse): Error {
  const reason = str(resp.json?.['error_description']) || str(resp.json?.['error']) || resp.text.slice(0, 200);
  return new Error(`${prefix}: HTTP ${resp.status}${reason ? ` — ${reason.slice(0, 240)}` : ''}`);
}

/** Client credentials written in the MCP config (`oauth.clientId` …). */
export interface ManualClient {
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface PendingFlow<C> {
  key: string;
  serverUrl: string;
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  metadata: OAuthMetadata;
  createdAt: number;
  context: C;
}

export interface BeginOptions<C> {
  serverUrl: string;
  redirectUri: string;
  manual?: ManualClient | undefined;
  hint?: Record<string, string>;
  context: C;
  log?: LogFn;
}

export class OAuthManager<C = unknown> {
  private readonly store: StateStore;
  private readonly clientName: string;
  private readonly flows = new Map<string, PendingFlow<C>>();
  private readonly refreshing = new Map<string, Promise<boolean>>();

  constructor(store: StateStore, clientName = 'DeepSeek Harness (workspace MCP)') {
    this.store = store;
    this.clientName = clientName;
  }

  hasTokens(serverUrl: string): boolean {
    return Boolean(this.store.oauth(credentialKey(serverUrl))?.tokens?.access_token);
  }

  /** Forget stored tokens (the client registration is kept for the next sign-in). */
  signOut(serverUrl: string): void {
    this.store.updateOauth(credentialKey(serverUrl), (record) => {
      delete record.tokens;
      return record;
    });
  }

  /**
   * Discover the authorization server for `serverUrl` and cache it on the
   * credential record. `hint` is the parsed WWW-Authenticate of the 401.
   */
  async discover(serverUrl: string, hint: Record<string, string> = {}, log: LogFn = () => {}): Promise<OAuthMetadata> {
    const key = credentialKey(serverUrl);
    const cached = this.store.oauth(key)?.metadata;
    if (cached?.authorization_endpoint && cached.token_endpoint && cached.source !== 'fallback'
      && (!hint['resource_metadata'] || cached.resourceMetadataUrl === hint['resource_metadata'])) {
      return cached;
    }
    const endpoint = new URL(serverUrl);
    const path = endpoint.pathname.replace(/\/+$/, '');
    const probe = async (url: string, what: string): Promise<Record<string, unknown> | null> => {
      try {
        const r = await fetchJson(url);
        log({ phase: 'discovery', status: r.status, target: url, detail: r.ok && r.json ? what : `${what}: not available` });
        return r.ok ? r.json : null;
      } catch (error) {
        log({ phase: 'discovery', status: 0, target: url, detail: `${what}: ${(error as Error)?.message ?? error}` });
        return null;
      }
    };

    // RFC 9728 protected-resource metadata.
    const prmUrls = [hint['resource_metadata'], path ? `${endpoint.origin}/.well-known/oauth-protected-resource${path}` : undefined, `${endpoint.origin}/.well-known/oauth-protected-resource`]
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    let prm: Record<string, unknown> | null = null;
    let prmUrl = '';
    for (const url of [...new Set(prmUrls)]) {
      const md = await probe(url, 'protected resource metadata');
      if (md && strings(md['authorization_servers']).length > 0) { prm = md; prmUrl = url; break; }
    }

    const issuers = prm ? strings(prm['authorization_servers']) : [endpoint.origin];
    for (const issuer of issuers) {
      let iu: URL;
      try { iu = new URL(issuer); } catch { continue; }
      const ipath = iu.pathname.replace(/\/+$/, '');
      const candidates = ipath
        ? [
          `${iu.origin}/.well-known/oauth-authorization-server${ipath}`,
          `${iu.origin}/.well-known/openid-configuration${ipath}`,
          `${iu.origin}${ipath}/.well-known/openid-configuration`,
          `${iu.origin}${ipath}/.well-known/oauth-authorization-server`,
        ]
        : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
      for (const url of candidates) {
        const md = await probe(url, 'authorization server metadata');
        if (md && str(md['authorization_endpoint']) && str(md['token_endpoint'])) {
          const metadata: OAuthMetadata = {
            issuer: str(md['issuer']) || issuer,
            authorization_endpoint: str(md['authorization_endpoint']),
            token_endpoint: str(md['token_endpoint']),
            registration_endpoint: str(md['registration_endpoint']),
            scopes_supported: strings(md['scopes_supported']),
            resource: prm ? (str(prm['resource']) || serverUrl) : '',
            resourceMetadataUrl: prmUrl,
            resourceScopes: prm ? strings(prm['scopes_supported']) : [],
            source: prm ? 'protected-resource' : 'authorization-server',
          };
          this.store.updateOauth(key, (record) => ({ ...record, metadata }));
          return metadata;
        }
      }
    }

    // MCP 2025-03-26 fallback: default endpoints at the server's origin.
    log({ phase: 'discovery', status: 0, target: endpoint.origin, detail: 'no metadata found; falling back to /authorize, /token, /register' });
    const metadata: OAuthMetadata = {
      issuer: endpoint.origin,
      authorization_endpoint: `${endpoint.origin}/authorize`,
      token_endpoint: `${endpoint.origin}/token`,
      registration_endpoint: `${endpoint.origin}/register`,
      scopes_supported: [],
      resource: '',
      resourceMetadataUrl: '',
      resourceScopes: [],
      source: 'fallback',
    };
    this.store.updateOauth(key, (record) => ({ ...record, metadata }));
    return metadata;
  }

  private async ensureClient(key: string, metadata: OAuthMetadata, redirectUri: string, manual: ManualClient | undefined, log: LogFn): Promise<OAuthClient> {
    if (manual?.clientId) return { client_id: manual.clientId, client_secret: manual.clientSecret, redirect_uri: redirectUri, issuer: metadata.issuer };
    const existing = this.store.oauth(key)?.client;
    if (existing?.client_id && existing.redirect_uri === redirectUri && existing.issuer === metadata.issuer) return existing;
    if (!metadata.registration_endpoint) {
      throw new Error('this authorization server does not support dynamic client registration; add "oauth": { "clientId": "…" } to the server entry in the MCP config');
    }
    const resp = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await resp.text();
    let json: Record<string, unknown> | null = null;
    try { json = asRecord(JSON.parse(text)); } catch {}
    const clientId = str(json?.['client_id']);
    log({ phase: 'register', status: resp.status, target: metadata.registration_endpoint, detail: clientId ? 'dynamic client registered' : text.slice(0, 200) });
    if (!resp.ok || !clientId) throw oauthError('client registration failed', { status: resp.status, ok: resp.ok, json, text });
    const client: OAuthClient = { client_id: clientId, client_secret: str(json?.['client_secret']), redirect_uri: redirectUri, issuer: metadata.issuer };
    this.store.updateOauth(key, (record) => ({ ...record, client }));
    return client;
  }

  private pickScope(manual: ManualClient | undefined, hint: Record<string, string>, metadata: OAuthMetadata): string {
    if (manual?.scope) return manual.scope;
    if (hint['scope']) return hint['scope'];
    return metadata.resourceScopes.join(' ');
  }

  /** Begin a sign-in: returns the URL to open in the browser. */
  async begin(options: BeginOptions<C>): Promise<{ url: string; state: string }> {
    const { serverUrl, redirectUri, manual, hint = {}, context, log = () => {} } = options;
    this.prune();
    const key = credentialKey(serverUrl);
    const metadata = await this.discover(serverUrl, hint, log);
    const client = await this.ensureClient(key, metadata, redirectUri, manual, log);
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));
    const scope = this.pickScope(manual, hint, metadata);
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    if (scope) url.searchParams.set('scope', scope);
    if (metadata.resource) url.searchParams.set('resource', metadata.resource);
    this.flows.set(state, { key, serverUrl, verifier, redirectUri, client, metadata, createdAt: Date.now(), context });
    log({ phase: 'authorize', status: 0, target: metadata.authorization_endpoint, detail: `browser sign-in started (${metadata.source}${scope ? `, scope "${scope}"` : ''})` });
    return { url: url.toString(), state };
  }

  /** The pending flow for `state`, without consuming it. */
  flow(state: string): PendingFlow<C> | undefined {
    this.prune();
    return this.flows.get(state);
  }

  /** Abandon every pending flow whose context matches. */
  cancel(match: (context: C) => boolean): void {
    for (const [state, flow] of this.flows) if (match(flow.context)) this.flows.delete(state);
  }

  /** Exchange the authorization code; returns the consumed flow. */
  async complete(state: string, code: string, log: LogFn = () => {}): Promise<PendingFlow<C>> {
    const flow = this.flows.get(state);
    if (!flow) throw new Error('this sign-in link expired or was already used; start the sign-in again from DSH');
    this.flows.delete(state);
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      client_id: flow.client.client_id,
      code_verifier: flow.verifier,
    };
    if (flow.client.client_secret) form['client_secret'] = flow.client.client_secret;
    if (flow.metadata.resource) form['resource'] = flow.metadata.resource;
    const resp = await postForm(flow.metadata.token_endpoint, form);
    const token = str(resp.json?.['access_token']);
    log({ phase: 'token', status: resp.status, target: flow.metadata.token_endpoint, detail: token ? 'access token issued' : (str(resp.json?.['error']) || resp.text.slice(0, 160)) });
    if (!resp.ok || !token) throw oauthError('token exchange failed', resp);
    this.saveTokens(flow.key, resp.json ?? {});
    return flow;
  }

  private saveTokens(key: string, json: Record<string, unknown>, previousRefresh = '', previousScope = ''): void {
    const expiresIn = Number(json['expires_in']);
    this.store.updateOauth(key, (record) => ({
      ...record,
      tokens: {
        access_token: str(json['access_token']),
        refresh_token: str(json['refresh_token']) || previousRefresh,
        token_type: str(json['token_type']) || 'Bearer',
        scope: str(json['scope']) || previousScope,
        expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
        obtained_at: Date.now(),
      },
    }));
  }

  /**
   * A currently valid access token, refreshed proactively when it expired.
   * Returns '' when no usable token is stored.
   */
  async accessToken(serverUrl: string, manual?: ManualClient, log: LogFn = () => {}): Promise<string> {
    const key = credentialKey(serverUrl);
    const tokens = this.store.oauth(key)?.tokens;
    if (!tokens?.access_token) return '';
    const expired = tokens.expires_at > 0 && Date.now() > tokens.expires_at - EXPIRY_SKEW_MS;
    if (!expired) return tokens.access_token;
    const refreshed = await this.refresh(serverUrl, manual, log);
    return refreshed ? (this.store.oauth(key)?.tokens?.access_token ?? '') : '';
  }

  /** Use the refresh token once; concurrent callers share the attempt. */
  refresh(serverUrl: string, manual?: ManualClient, log: LogFn = () => {}): Promise<boolean> {
    const key = credentialKey(serverUrl);
    const running = this.refreshing.get(key);
    if (running) return running;
    const task = (async (): Promise<boolean> => {
      const record = this.store.oauth(key);
      const tokens = record?.tokens;
      const metadata = record?.metadata;
      const clientId = manual?.clientId || record?.client?.client_id;
      if (!tokens?.refresh_token || !metadata?.token_endpoint || !clientId) return false;
      const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId };
      const secret = manual?.clientId ? manual.clientSecret : record?.client?.client_secret;
      if (secret) form['client_secret'] = secret;
      if (metadata.resource) form['resource'] = metadata.resource;
      let resp: JsonResponse;
      try {
        resp = await postForm(metadata.token_endpoint, form);
      } catch (error) {
        log({ phase: 'refresh', status: 0, target: metadata.token_endpoint, detail: String((error as Error)?.message ?? error) });
        return false;
      }
      const token = str(resp.json?.['access_token']);
      log({ phase: 'refresh', status: resp.status, target: metadata.token_endpoint, detail: token ? 'access token refreshed' : (str(resp.json?.['error']) || 'refresh failed') });
      if (!resp.ok || !token) {
        // invalid_grant & co.: the refresh token is dead, so the UI asks to sign in again.
        if (resp.status === 400 || resp.status === 401) this.signOut(serverUrl);
        return false;
      }
      this.saveTokens(key, resp.json ?? {}, tokens.refresh_token, tokens.scope);
      return true;
    })().finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, task);
    return task;
  }

  private prune(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) if (now - flow.createdAt > FLOW_TTL_MS) this.flows.delete(state);
  }
}
