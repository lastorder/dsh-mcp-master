import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeTone, sameSet, serversOf, statusTone } from '../src/client/presentation.ts';
import { redact } from '../src/host/runtime.ts';
import { parseWwwAuthenticate } from '../src/host/oauth.ts';
import { publicToolName, projectContent } from '../src/host/tools.ts';
import type { ServerView } from '../src/shared/types.ts';

const view = (name: string, status: ServerView['status'], scope: ServerView['scope'] = 'project'): ServerView => ({
  name, status, scope, source: '.mcp.json', transport: 'stdio', target: '', description: '', trust: 'trusted', declaredEnabled: true, isDefault: false,
  error: '', warnings: [], auth: { mode: 'none', signedIn: false, canSignIn: false }, tools: [], toolCount: 0, serverInfo: null, connectedAt: 0, retryAt: 0, attempts: 0,
});

describe('helpers', () => {
  it('names tools like the built-in MCP client', () => {
    assert.equal(publicToolName('orion-mcp', 'search'), 'mcp__orion-mcp__search');
    const long = publicToolName('a.b', 'x'.repeat(80));
    assert.ok(long.length <= 64);
    assert.match(long, /^[A-Za-z0-9_-]+$/);
  });

  it('projects MCP content to text', () => {
    assert.deepEqual(projectContent([{ type: 'text', text: 'a' }, { type: 'resource_link', uri: 'file:///x', name: 'x' }], 't'), [{ type: 'text', text: 'a\nResource link: x (file:///x)' }]);
    assert.deepEqual(projectContent([], 't'), [{ type: 'text', text: '(t returned no content)' }]);
  });

  it('redacts secrets in logs', () => {
    const out = redact('GET https://x/cb?code=abc&state=def Authorization: Bearer abcdefghijkl access_token=zzz');
    assert.ok(!/abc&|def|abcdefghijkl|zzz/.test(out), out);
  });

  it('parses WWW-Authenticate parameters', () => {
    assert.deepEqual(parseWwwAuthenticate('Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource", scope="a b"'), {
      error: 'invalid_token', resource_metadata: 'https://x/.well-known/oauth-protected-resource', scope: 'a b',
    });
  });

  it('chooses the most urgent tone among active servers and floats attention to the top', () => {
    assert.equal(statusTone('untrusted'), 'new');
    assert.equal(activeTone([]), 'idle');
    assert.equal(activeTone([view('a', 'connected'), view('b', 'needs-auth')]), 'warning');
    assert.equal(activeTone([view('a', 'connected'), view('b', 'error')]), 'error');
    assert.equal(activeTone([view('a', 'connected')]), 'done');
    const servers = [view('a', 'connected'), view('b', 'needs-auth'), view('g', 'idle', 'global'), view('c', 'idle')];
    assert.deepEqual(serversOf(servers, 'project').map((s) => s.name), ['b', 'a', 'c']);
    assert.deepEqual(serversOf(servers, 'global').map((s) => s.name), ['g']);
    assert.equal(sameSet(['a', 'b'], ['b', 'a']), true);
    assert.equal(sameSet(['a'], ['a', 'b']), false);
  });
});
