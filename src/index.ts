/**
 * dsh-mcp-master — Host half.
 *
 * Builds each workspace's MCP catalog (project files such as `.mcp.json` plus
 * the global `~/.dsh/mcp-master/mcp.json`), runs the servers that sessions
 * select, and registers their tools into exactly those sessions. The Client
 * half renders the MCP picker beside the composer's model selector through
 * the routes in `host/api.ts`.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createRoute } from './host/api.ts';
import { DEFAULT_CONFIG_FILES } from './host/config.ts';
import { loginEnv } from './host/env.ts';
import type {
  Agent, AgentRegistry, Connection, HostContext, PluginConfig, ToolRegistry, WebServer, WorkspaceRegistry,
} from './host/dsh.ts';
import { McpMasterManager, type ManagerOptions } from './host/runtime.ts';
import { StateStore, defaultGlobalConfigPath, defaultStatePath } from './host/state.ts';
import type { ToolServices } from './host/tools.ts';

declare const __PLUGIN_VERSION__: string;
const VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0-dev';

export const name = 'dsh-mcp-master';
export const inject = ['tools'];

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveOptions(config: PluginConfig = {}): ManagerOptions {
  const files = Array.isArray(config.configFiles) ? config.configFiles.filter((f) => typeof f === 'string' && f.trim()) : [];
  return {
    configFiles: files.length > 0 ? files : DEFAULT_CONFIG_FILES,
    globalConfigFile: config.globalConfigFile === false
      ? undefined
      : (typeof config.globalConfigFile === 'string' && config.globalConfigFile.trim() ? resolve(config.globalConfigFile) : defaultGlobalConfigPath()),
    autoTrust: config.autoTrust === true,
    searchParents: config.searchParents !== false,
    startupWaitMs: typeof config.startupWaitMs === 'number' && config.startupWaitMs >= 0 ? config.startupWaitMs : 5000,
    connectTimeoutMs: positive(config.connectTimeoutMs, 60000),
    toolCallTimeoutMs: positive(config.toolCallTimeoutMs, 300000),
    idleShutdownMs: positive(config.idleShutdownMinutes, 15) * 60 * 1000,
  };
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The agent-scoped registry: registrations land in (and die with) that agent's scope. */
function toolsOf(agent: Agent): ToolRegistry | undefined {
  try {
    if (agent.ctx.tools) return agent.ctx.tools;
  } catch {}
  try {
    return agent.ctx.get('tools') as ToolRegistry | undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const options = resolveOptions(config);
  const store = new StateStore(config.stateFile?.trim() ? config.stateFile : defaultStatePath(), ctx.logger);
  const services = { get: (key: string) => ctx.get(key) } as ToolServices;
  const manager = new McpMasterManager({ logger: ctx.logger, store, services, options, toolsOf });
  // Read the login-shell environment once in the background (PATH for npx/uvx, exported tokens).
  void loginEnv();
  ctx.effect(() => () => manager.dispose(), 'mcp-master: manager');

  ctx.on('agent/created', async (payload: { agent: Agent; signal?: AbortSignal }) => {
    try {
      await manager.attachAgent(payload.agent, payload.signal);
    } catch (error) {
      ctx.logger.warn(`mcp-master: attaching session ${payload.agent?.id} failed: ${(error as Error)?.message ?? error}`);
    }
  });
  ctx.on('agent/disposed', (payload: { agent: Agent }) => manager.detachAgent(payload.agent));

  // Sessions that were already live when the plugin (re)loaded.
  ctx.effect(() => {
    const fiber = ctx.inject(['agents'], (inner) => {
      const agents = inner.get('agents') as AgentRegistry | undefined;
      for (const agent of agents?.list() ?? []) {
        void manager.attachAgent(agent).catch((error: unknown) => ctx.logger.warn(`mcp-master: attaching ${agent.id} failed: ${String(error)}`));
      }
    });
    return () => fiber.dispose();
  }, 'mcp-master: existing agents');

  const isKnownPath = (cwd: string): boolean => {
    const path = canonical(cwd);
    const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined;
    const agents = ctx.get('agents') as AgentRegistry | undefined;
    if (!registry && !agents) return true;
    for (const ws of registry?.list() ?? []) {
      if (typeof ws?.path === 'string' && ws.path && within(path, canonical(ws.path))) return true;
    }
    for (const agent of agents?.list() ?? []) {
      const agentCwd = agent?.session?.header?.cwd;
      if (typeof agentCwd === 'string' && agentCwd && canonical(agentCwd) === path) return true;
    }
    return false;
  };

  // The panel needs the GUI webserver; agent-side tools do not, so mount lazily.
  ctx.effect(() => {
    const fiber = ctx.inject(['webServer'], (inner) => {
      const web = inner.get('webServer') as WebServer;
      inner.effect(() => web.register(createRoute({
        manager,
        logger: ctx.logger,
        connection: () => ctx.get('connection') as Connection | undefined,
        isKnownPath,
        version: VERSION,
      })), 'mcp-master: routes');
    });
    return () => fiber.dispose();
  }, 'mcp-master: webserver');
}
