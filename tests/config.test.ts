import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  configStamp, displayPath, expandString, findConfigRoot, fingerprintOf, loadCatalog, loadWorkspaceConfig, parseServerEntry, stripJsonComments,
} from '../src/host/config.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpm-config-'));
  dirs.push(dir);
  return dir;
}
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('config parsing', () => {
  it('parses the Claude Code .mcp.json dialect (stdio, http, enabled:false)', () => {
    const root = tempDir();
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'orion-mcp': { command: 'uv', args: ['run', '--project', '.', 'orion-mcp'] },
        'atlassian-mcp-server': { url: 'https://mcp.atlassian.com/v1/mcp/authv2', type: 'http' },
        'conduktor-console': {
          command: 'npx',
          args: ['mcp-remote', 'https://console.example/api/mcp', '--header', 'Authorization: Bearer ${CONDUKTOR_API_TOKEN}'],
          env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
          enabled: false,
        },
      },
    }));
    const config = loadWorkspaceConfig(root, { env: { CONDUKTOR_API_TOKEN: 's3cret' } });
    assert.equal(config.files.length, 1);
    const [orion, atlassian, conduktor] = config.servers;
    assert.equal(orion?.transport, 'stdio');
    assert.equal(orion?.cwd, root);
    assert.equal(orion?.declaredEnabled, true);
    assert.equal(atlassian?.transport, 'http');
    assert.equal(atlassian?.url, 'https://mcp.atlassian.com/v1/mcp/authv2');
    assert.equal(conduktor?.declaredEnabled, false);
    assert.equal(conduktor?.args?.[3], 'Authorization: Bearer s3cret', 'variables expand in args');
    assert.ok(!conduktor?.display.includes('s3cret'), 'display keeps the unexpanded text');
    assert.ok(conduktor?.display.includes('${CONDUKTOR_API_TOKEN}'));
  });

  it('reports missing variables as warnings', () => {
    const spec = parseServerEntry('x', { command: 'run', args: ['${NOPE}', '${HAS:-fallback}'] }, { root: '/tmp', source: '.mcp.json', env: {} });
    assert.deepEqual(spec.args, ['', 'fallback']);
    assert.match(spec.warnings.join('\n'), /NOPE is not set/);
  });

  it('reads VS Code JSONC with the "servers" key', () => {
    const root = tempDir();
    mkdirSync(join(root, '.vscode'));
    writeFileSync(join(root, '.vscode', 'mcp.json'), `{
      // comment
      "servers": { "gh": { "type": "sse", "url": "https://example.com/sse", }, },
    }`);
    const config = loadWorkspaceConfig(root, { env: {} });
    assert.equal(config.servers[0]?.name, 'gh');
    assert.equal(config.servers[0]?.transport, 'sse');
  });

  it('keeps the first definition of a duplicated name and reports the shadow', () => {
    const root = tempDir();
    mkdirSync(join(root, '.cursor'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'one' } } }));
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'two' }, b: { url: 'http://localhost:1/mcp' } } }));
    const config = loadWorkspaceConfig(root, { env: {} });
    assert.deepEqual(config.servers.map((s) => s.name), ['a', 'b']);
    assert.equal(config.servers[0]?.command, 'one');
    assert.deepEqual(config.shadowed, [{ name: 'a', source: '.cursor/mcp.json', winner: '.mcp.json' }]);
  });

  it('marks unusable entries invalid instead of throwing', () => {
    const root = tempDir();
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { bad: { url: 'ftp://x' }, empty: {} } }));
    const config = loadWorkspaceConfig(root, { env: {} });
    assert.match(config.servers[0]?.invalid ?? '', /http/);
    assert.match(config.servers[1]?.invalid ?? '', /command/);
  });

  it('reports invalid JSON per file', () => {
    const root = tempDir();
    writeFileSync(join(root, '.mcp.json'), '{ nope');
    const config = loadWorkspaceConfig(root, { env: {} });
    assert.match(config.files[0]?.error ?? '', /invalid JSON/);
  });

  it('fingerprints the entry as written, not the expanded values', () => {
    const a = fingerprintOf({ command: 'x', args: ['${T}'] });
    const b = fingerprintOf({ args: ['${T}'], command: 'x' });
    assert.equal(a, b);
    assert.notEqual(a, fingerprintOf({ command: 'x', args: ['other'] }));
  });

  it('finds the config root from a nested cwd but stops at the repository root', () => {
    const root = tempDir();
    writeFileSync(join(root, '.mcp.json'), '{}');
    mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
    assert.equal(findConfigRoot(join(root, 'pkg', 'src'), { home: '/nonexistent-home' }), root);
    mkdirSync(join(root, 'pkg', '.git'));
    assert.equal(findConfigRoot(join(root, 'pkg', 'src'), { home: '/nonexistent-home' }), null);
    assert.equal(findConfigRoot(join(root, 'pkg', 'src'), { searchParents: false }), null);
  });

  it('expands VS Code style variables', () => {
    assert.equal(expandString('${workspaceFolder}/x ${env:A}', { A: '1' }, { workspaceFolder: '/w' }), '/w/x 1');
  });

  it('strips JSONC comments without touching strings', () => {
    assert.equal(JSON.parse(stripJsonComments('{"a":"//not a comment", /* c */ "b":1,}')).a, '//not a comment');
  });

  it('merges the global catalog after project files; project names shadow global ones', () => {
    const root = tempDir();
    const home = tempDir();
    const globalFile = join(home, 'mcp.json');
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'project-one' }, p: { command: 'p' } } }));
    writeFileSync(globalFile, JSON.stringify({ mcpServers: { shared: { command: 'global-one' }, g: { url: 'https://example.com/mcp', type: 'http' } } }));
    const catalog = loadCatalog(root, { configFiles: ['.mcp.json'], globalFile, env: {} });
    assert.deepEqual(catalog.servers.map((s) => `${s.scope}:${s.name}`), ['project:shared', 'project:p', 'global:g']);
    assert.equal(catalog.servers[0]?.command, 'project-one');
    assert.equal(catalog.shadowed[0]?.name, 'shared');
    assert.equal(catalog.servers[2]?.cwd, undefined, 'http entries have no cwd');
    assert.deepEqual(catalog.files.map((f) => f.scope), ['project', 'global']);
    assert.notEqual(configStamp(root, { configFiles: ['.mcp.json'], globalFile }), configStamp(root, { configFiles: ['.mcp.json'] }));
  });

  it('runs global stdio servers in the workspace root and shows ~ paths', () => {
    const root = tempDir();
    const home = tempDir();
    const globalFile = join(home, 'mcp.json');
    writeFileSync(globalFile, JSON.stringify({ mcpServers: { g: { command: 'run', args: ['${workspaceFolder}'] } } }));
    const catalog = loadCatalog(root, { configFiles: [], globalFile, env: {} });
    assert.equal(catalog.servers[0]?.cwd, root);
    assert.deepEqual(catalog.servers[0]?.args, [root]);
    assert.equal(displayPath(join(home, 'x.json'), home), '~/x.json');
  });
});
