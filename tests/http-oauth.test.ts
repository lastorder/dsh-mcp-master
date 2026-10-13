import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Agent, Disposer, ToolDefinition } from '../src/host/dsh.ts';
import { McpMasterManager } from '../src/host/runtime.ts';
import { StateStore } from '../src/host/state.ts';
import type { ToolServices } from '../src/host/tools.ts';
import type { ServerView } from '../src/shared/types.ts';

const silent = { info() {}, warn() {}, error() {} };

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Streamable-HTTP MCP server protected by OAuth (RFC 9728 + 8414 + 7591 + PKCE). */
function startStub(): Promise<{ server: Server; base: string; calls: string[] }> {
  const calls: string[] = [];
  let challenge = '';
  const issued = new Set<string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const base = `http://${req.headers.host}`;
    calls.push(`${req.method} ${url.pathname}`);
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ['read'] });
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
      return json(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`, code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname === '/auth/register') {
      const reg = JSON.parse(await body(req)) as { redirect_uris: string[] };
      return json(201, { client_id: 'client-1', redirect_uris: reg.redirect_uris });
    }
    if (url.pathname === '/auth/token') {
      const form = new URLSearchParams(await body(req));
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? '';
        const computed = createHash('sha256').update(verifier).digest('base64url');
        if (form.get('code') !== 'good-code' || computed !== challenge || form.get('resource') !== `${base}/mcp`) return json(400, { error: 'invalid_grant' });
        issued.add('token-1');
        return json(200, { access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/test/challenge') {
      challenge = url.searchParams.get('c') ?? '';
      return json(200, {});
    }
    if (url.pathname === '/mcp') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!issued.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"` });
        return res.end('unauthorized');
      }
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET') { res.writeHead(405); return res.end(); }
      const msg = JSON.parse(await body(req)) as { id?: number; method: string; params?: { name?: string; arguments?: { a: number; b: number } } };
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') {
        // Answer as an SSE stream to exercise that code path.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-http', version: '0.0.1' } } })}\n\n`);
        return res.end();
      }
      if (req.headers['mcp-session-id'] !== 'sess-1') return json(400, { error: 'missing session' });
      if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] } });
      if (msg.method === 'tools/call') {
        const { a, b } = msg.params?.arguments ?? { a: 0, b: 0 };
        return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }] } });
      }
      return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls });
  }));
}

async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 10000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('workspace runtime (streamable HTTP + OAuth)', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let root: string;
  let stateDir: string;
  let manager: McpMasterManager;
  const server = (): ServerView | undefined => manager.requireWorkspace(root).workspaceView().servers[0];

  before(async () => {
    stub = await startStub();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpm-http-')));
    stateDir = mkdtempSync(join(tmpdir(), 'mcpm-http-state-'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: `${stub.base}/mcp` } } }));
    manager = new McpMasterManager({
      logger: silent,
      store: new StateStore(join(stateDir, 'state.json')),
      services: { get: () => undefined } as unknown as ToolServices,
      toolsOf: (agent) => agent.ctx.tools,
      options: { configFiles: ['.mcp.json'], globalConfigFile: undefined, autoTrust: true, searchParents: false, startupWaitMs: 2000, connectTimeoutMs: 5000, toolCallTimeoutMs: 5000, idleShutdownMs: 60000 },
    });
  });

  after(async () => {
    await manager.dispose();
    stub.server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('detects that the server needs sign-in', async () => {
    await manager.state(root, 'viewer-1');
    const view = await until(server, (s) => s?.status === 'needs-auth');
    assert.equal(view?.auth.mode, 'oauth');
    assert.equal(view?.auth.canSignIn, true);
  });

  it('signs in with discovery, dynamic registration and PKCE, then registers tools', async () => {
    const tools = new Map<string, ToolDefinition>();
    const agent = { id: 'h1', session: { id: 'h1', header: { cwd: root } }, ctx: { tools: { register(d: ToolDefinition): Disposer { tools.set(d.name, d); return () => tools.delete(d.name); } } } } as unknown as Agent;
    await manager.attachAgent(agent);

    const url = new URL(await manager.requireWorkspace(root).server('remote').beginSignIn('http://127.0.0.1:19387'));
    assert.equal(url.pathname, '/auth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'client-1');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:19387/mcp-master/oauth/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'read');
    assert.equal(url.searchParams.get('resource'), `${stub.base}/mcp`);
    assert.equal(server()?.status, 'authorizing');
    await fetch(`${stub.base}/test/challenge?c=${url.searchParams.get('code_challenge')}`);

    const bad = await manager.completeSignIn('not-a-state', 'good-code', null);
    assert.equal(bad.ok, false);

    const outcome = await manager.completeSignIn(url.searchParams.get('state') ?? '', 'good-code', null);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(server()?.status, 'connected');
    assert.equal(server()?.auth.signedIn, true);
    const add = tools.get('mcp__remote__add');
    assert.ok(add);
    const value = await add.execute({ a: 2, b: 40 }, { signal: new AbortController().signal }) as { content: Array<{ text: string }> };
    assert.equal(value.content[0]?.text, '42');

    const replay = await manager.completeSignIn(url.searchParams.get('state') ?? '', 'good-code', null);
    assert.equal(replay.ok, false, 'a state is single-use');
  });

  it('signs out back to needs-auth and drops the tools', async () => {
    await manager.requireWorkspace(root).server('remote').signOut();
    assert.equal(server()?.status, 'needs-auth');
    assert.equal(server()?.auth.signedIn, false);
    assert.equal(server()?.toolCount, 1, 'the last known tool list stays visible in the picker');
    const tools = new Map<string, ToolDefinition>();
    const agent = { id: 'h2', session: { id: 'h2', header: { cwd: root } }, ctx: { tools: { register(d: ToolDefinition): Disposer { tools.set(d.name, d); return () => tools.delete(d.name); } } } } as unknown as Agent;
    await manager.attachAgent(agent);
    assert.equal(tools.size, 0, 'no tools are registered while signed out');
  });
});
