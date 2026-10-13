import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Agent, Disposer, ToolDefinition } from '../src/host/dsh.ts';
import { McpMasterManager, TrustRequiredError } from '../src/host/runtime.ts';
import { StateStore } from '../src/host/state.ts';
import type { ToolServices } from '../src/host/tools.ts';
import type { ServerView } from '../src/shared/types.ts';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdio-server.mjs');
const silent = { info() {}, warn() {}, error() {} };
const signal = (): AbortSignal => new AbortController().signal;

function makeAgent(id: string, cwd: string, parentSession?: string): { agent: Agent; tools: Map<string, ToolDefinition> } {
  const tools = new Map<string, ToolDefinition>();
  const agent = {
    id,
    session: { id, header: { cwd, ...(parentSession ? { parentSession } : {}) } },
    ctx: {
      tools: {
        register(definition: ToolDefinition): Disposer {
          if (tools.has(definition.name)) throw new Error(`duplicate ${definition.name}`);
          tools.set(definition.name, definition);
          return () => { tools.delete(definition.name); };
        },
      },
    },
  } as unknown as Agent;
  return { agent, tools };
}

async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const names = (tools: Map<string, ToolDefinition>, server: string): string[] => [...tools.keys()].filter((n) => n.startsWith(`mcp__${server}__`)).sort();

describe('MCP Master runtime (per-session activation)', () => {
  let root: string;
  let stateDir: string;
  let globalFile: string;
  let manager: McpMasterManager;

  const writeProject = (args: string[] = [fixture]): void => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        local: { command: process.execPath, args, env: { FIXTURE_TOKEN: '${WMCP_TEST_TOKEN:-tok}' } },
        off: { command: process.execPath, args: [fixture], enabled: false },
      },
    }));
  };
  const server = (name: string): ServerView | undefined => manager.requireWorkspace(root).workspaceView().servers.find((s) => s.name === name);

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpm-ws-')));
    stateDir = mkdtempSync(join(tmpdir(), 'mcpm-state-'));
    globalFile = join(stateDir, 'mcp.json');
    writeProject();
    writeFileSync(globalFile, JSON.stringify({ mcpServers: { glob: { command: process.execPath, args: [fixture] } } }));
    manager = new McpMasterManager({
      logger: silent,
      store: new StateStore(join(stateDir, 'state.json')),
      services: { get: () => undefined } as unknown as ToolServices,
      toolsOf: (agent) => agent.ctx.tools,
      options: {
        configFiles: ['.mcp.json'],
        globalConfigFile: globalFile,
        autoTrust: false,
        searchParents: true,
        startupWaitMs: 8000,
        connectTimeoutMs: 15000,
        toolCallTimeoutMs: 15000,
        idleShutdownMs: 60000,
        stopGraceMs: 0,
        viewerTtlMs: 60000,
      },
    });
  });

  after(async () => {
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('builds the catalog from project and global files with trust per scope', async () => {
    const state = await manager.state(root, undefined);
    const view = state.workspace;
    assert.ok(view);
    assert.deepEqual(view.servers.map((s) => `${s.scope}:${s.name}:${s.trust}`), ['project:local:untrusted', 'project:off:untrusted', 'global:glob:trusted']);
    assert.deepEqual(view.defaults, ['glob'], 'defaults: trusted servers the files mark enabled');
    assert.ok(view.globalFile);
  });

  it('a new session starts with the defaults and only gets those tools', async () => {
    const { agent, tools } = makeAgent('s1', root);
    await manager.attachAgent(agent);
    await until(() => names(tools, 'glob').length, (n) => n === 3);
    assert.deepEqual(names(tools, 'local'), []);
    const echo = tools.get('mcp__glob__echo');
    assert.ok(echo);
    const value = await echo.execute({ text: 'hi', mode: 'loud' }, { signal: signal() }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    assert.equal(value.content[0]?.text, 'HI');
    assert.equal(value.structuredContent['cwd'], root, 'global stdio servers run in the workspace root');
    assert.equal(value.structuredContent['pingAnswered'], true);
    assert.equal(manager.requireWorkspace(root).sessionView('s1').explicit, true, 'the selection is materialized at attach');
  });

  it('refuses an untrusted project server until the user trusts it, then activates only in that session', async () => {
    const ws = manager.requireWorkspace(root);
    assert.throws(() => ws.setActive('s1', 'local', true, false), TrustRequiredError);
    const { agent: other, tools: otherTools } = makeAgent('s-other', root);
    await manager.attachAgent(other);
    ws.setActive('s1', 'local', true, true);
    await until(() => server('local')?.status, (s) => s === 'connected');
    assert.equal(server('local')?.trust, 'trusted');
    assert.deepEqual(names(otherTools, 'local'), [], 'other sessions keep their own selection');
    manager.detachAgent(other);
  });

  it('switches servers mid-session without touching other sessions', async () => {
    const ws = manager.requireWorkspace(root);
    const { agent, tools } = makeAgent('s2', root);
    await manager.attachAgent(agent);
    await until(() => names(tools, 'local').length, (n) => n === 3);
    assert.deepEqual(ws.sessionView('s2').active.sort(), ['glob', 'local'], 'trusting made local part of the derived defaults');
    ws.setActive('s2', 'glob', false, false);
    assert.deepEqual(names(tools, 'glob'), []);
    const s1 = manager.requireWorkspace(root);
    assert.ok(s1.sessionView('s1').active.includes('glob'));
    ws.setActive('s2', 'glob', true, false);
    await until(() => names(tools, 'glob').length, (n) => n === 3);
    manager.detachAgent(agent);
  });

  it('saves a selection as the default for new sessions', async () => {
    const ws = manager.requireWorkspace(root);
    ws.setActive('blank', 'glob', false, false);
    ws.setActive('blank', 'local', true, false);
    ws.saveDefaults('blank');
    assert.deepEqual(ws.workspaceView().defaults, ['local']);
    assert.equal(ws.workspaceView().customDefaults, true);
    const { agent, tools } = makeAgent('s3', root);
    await manager.attachAgent(agent);
    await until(() => names(tools, 'local').length, (n) => n === 3);
    assert.deepEqual(names(tools, 'glob'), []);
    ws.resetDefaults();
    assert.equal(ws.workspaceView().customDefaults, false);
    manager.detachAgent(agent);
  });

  it('forks and subagents inherit the parent session selection', async () => {
    const ws = manager.requireWorkspace(root);
    ws.setActive('parent', 'glob', false, false);
    ws.setActive('parent', 'local', true, false);
    const { agent, tools } = makeAgent('child', root, 'parent');
    await manager.attachAgent(agent);
    assert.deepEqual(ws.sessionView('child').active.sort(), ['local']);
    await until(() => names(tools, 'local').length, (n) => n === 3);
    assert.deepEqual(names(tools, 'glob'), []);
    manager.detachAgent(agent);
  });

  it('a viewed but not yet started session keeps its servers warm', async () => {
    const ws = manager.requireWorkspace(root);
    for (const agent of [...ws.agents.keys()]) manager.detachAgent(agent);
    await manager.tick();
    await until(() => server('glob')?.status, (s) => s === 'idle');
    await manager.state(root, 'fresh-session');
    await until(() => server('glob')?.status, (s) => s === 'connected');
    assert.equal(server('off')?.status, 'untrusted');
  });

  it('follows tools/list_changed for sessions that use the server', async () => {
    const { agent, tools } = makeAgent('s4', root);
    await manager.attachAgent(agent);
    await until(() => tools.has('mcp__glob__grow'), Boolean);
    await tools.get('mcp__glob__grow')!.execute({}, { signal: signal() });
    await until(() => tools.has('mcp__glob__extra'), Boolean);
    manager.detachAgent(agent);
  });

  it('asks for review when a trusted project server changes, and drops its tools meanwhile', async () => {
    const { agent, tools } = makeAgent('s5', root);
    await manager.attachAgent(agent);
    const ws = manager.requireWorkspace(root);
    ws.setActive('s5', 'local', true, false);
    await until(() => names(tools, 'local').length, (n) => n === 3);
    writeProject([fixture, '--changed']);
    await ws.scheduleReload();
    await until(() => server('local')?.status, (s) => s === 'changed');
    assert.deepEqual(names(tools, 'local'), []);
    assert.throws(() => ws.setActive('s5', 'local', true, false), TrustRequiredError);
    ws.setActive('s5', 'local', true, true);
    await until(() => names(tools, 'local').length, (n) => n === 3);
    manager.detachAgent(agent);
  });

  it('long-polls until the view changes', async () => {
    const first = await manager.state(root, 's6');
    const started = Date.now();
    const waiting = manager.state(root, 's6', first.rev, 5000);
    setTimeout(() => manager.requireWorkspace(root).setActive('s6', 'glob', false, false), 100);
    const next = await waiting;
    assert.notEqual(next.rev, first.rev);
    assert.ok(Date.now() - started < 4000);
    assert.equal(next.session?.active.includes('glob'), false);
  });

  it('reports a missing command as an error with a retry', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { ghost: { command: 'definitely-not-a-real-binary-mcpm' } } }));
    const ws = manager.requireWorkspace(root);
    await ws.scheduleReload();
    ws.setActive('s7', 'ghost', true, true);
    const view = await until(() => server('ghost'), (s) => s?.status === 'error');
    assert.match(view?.error ?? '', /not found/);
    assert.ok((view?.retryAt ?? 0) > 0);
    assert.equal(server('local'), undefined, 'removed servers disappear');
  });

  it('stops servers no session selects any more', async () => {
    const ws = manager.requireWorkspace(root);
    ws.setActive('s7', 'ghost', false, false);
    await manager.tick();
    // Trusting ghost made it part of the derived defaults, so sessions following them still want it.
    for (const id of ['s6', 's7', 'fresh-session', 'blank', 'parent']) {
      ws.setActive(id, 'glob', false, false);
      ws.setActive(id, 'ghost', false, false);
    }
    await manager.tick();
    await until(() => server('glob')?.status, (s) => s === 'idle');
    assert.equal(server('ghost')?.status, 'idle');
  });
});
