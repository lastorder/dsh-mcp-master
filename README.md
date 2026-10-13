# dsh-mcp-master

English | [中文](README.zh.md)

**MCP Master for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** Choose which MCP servers each session uses — from your **global** list and the workspace's **project** list — with a picker that sits right before the composer's model selector. Pick them when a session starts, and switch them at any time afterwards, just like the model.

- **Project servers** come from the files other agents already use: `.mcp.json` (Claude Code), `.cursor/mcp.json`, `.vscode/mcp.json`, `.dsh/mcp.json`.
- **Global servers** come from `~/.dsh/mcp-master/mcp.json` (same `mcpServers` format). A project server shadows a global one of the same name.

```json
// <workspace>/.mcp.json  or  ~/.dsh/mcp-master/mcp.json
{
  "mcpServers": {
    "orion-mcp":            { "command": "uv", "args": ["run", "--project", ".", "orion-mcp"] },
    "atlassian-mcp-server": { "type": "http", "url": "https://mcp.atlassian.com/v1/mcp/authv2" },
    "conduktor-console":    { "command": "npx", "args": ["mcp-remote", "https://…/api/mcp", "--header", "Authorization: Bearer ${CONDUKTOR_API_TOKEN}"], "enabled": false }
  }
}
```

## The picker

`[ 🔌 MCP 2 ● ]  [ model ▾ ]  [ ➤ ]` — in the composer row of every session, including a brand-new one.

- **Zero footprint when unused**: no global or project servers → nothing renders.
- **Chip**: number of servers active in this session and one status dot for them (green connected · amber sign-in needed · red failing · pulsing starting). A small blue dot means project servers await review.
- **Panel** (click the chip; Esc / click outside to close): *Project* and *Global* groups. Each row has a **checkbox = use in this session**, status, transport, a `default` tag, and inline **Sign in** / **Retry**. Expand a row for the command/URL (as written — never variable-expanded), auth, server version, tools, logs, Reconnect, Sign out, Revoke trust.
- **Footer**: what new sessions start with, and **Use for new sessions** to save the current selection as this workspace's default (**Reset** returns to the files' own `enabled` flags).
- Theme tokens only (light/dark follow the app); copy follows **Settings → General → Language**.

## How sessions get servers

| Topic | Behavior |
|---|---|
| New session | Starts from the workspace default: the saved one, or else every trusted server whose file entry is not `"enabled": false` / `"disabled": true`. |
| Forks & subagents | Inherit the parent session's selection (`parentSession`). |
| Switching later | Checking/unchecking registers/unregisters that server's tools in **this session only**, from the next step on. DSH itself records tool additions/removals in the session log (`developer/message` tool-addition/removal), so history, resume, and replay stay consistent — unlike an agent preset, which is a whole plugin composition and therefore locked once the session starts. |
| Persistence | Selections, defaults, trust, and OAuth tokens live in `~/.dsh/mcp-master/state.json` (0600). Config files are never modified. |
| Process lifetime | A server runs while a live session — or a session open in the UI but not started yet — selects it; it stops 2 minutes after the last one deselects it, and a workspace with no sessions or viewers shuts down after 15 idle minutes. |

## Trust (project servers)

A `.mcp.json` in a cloned repository can run any command, so project servers must be **trusted** before they run (same model as Claude Code's project-server approval). Checking an untrusted server shows the exact command/URL with **Trust & use**. Trust is per workspace and bound to the entry as written: if the command, args, env, URL, or headers change, the server becomes **Changed** and needs review again. Global servers are yours and always trusted. `autoTrust: true` skips the review.

## Transports and auth

- **stdio** (own process group, reaped with its children; cwd = workspace root), **Streamable HTTP** (session ids, SSE responses, `list_changed` stream), **legacy HTTP+SSE** (automatic fallback). Server→client `ping` / `roots/list` are answered.
- **OAuth** per the MCP authorization spec: RFC 9728 → RFC 8414/OIDC discovery → RFC 7591 dynamic client registration → authorization code + PKCE (S256) with RFC 8707 `resource`, then refresh. Tokens are keyed by server URL, so one sign-in covers every workspace. An explicit `Authorization` header is used as-is; `"oauth": { "clientId", "clientSecret", "scope" }` covers providers without dynamic registration.
- **Variables**: `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `${workspaceFolder}` — resolved from DSH's environment layered over your login-shell environment (so `~/.zshrc` exports and your shell `PATH` work in the desktop app).
- **Tools** are named `mcp__<server>__<tool>` like the built-in MCP client; input schemas are folded into the registry's JSON-Schema subset (`$ref`, nullable `anyOf`, type arrays, `allOf`; dropped constraints become description hints); `readOnlyHint` tools may run in parallel.

## Configuration (optional)

```yaml
# your profile's cordis.patch.yml
- id: mcp-master
  name: dsh-mcp-master
  config:
    globalConfigFile: ~/.dsh/mcp-master/mcp.json   # false disables the global scope
    configFiles: [.mcp.json, .cursor/mcp.json, .vscode/mcp.json, .dsh/mcp.json]
    autoTrust: false
    searchParents: true          # also look in parent directories of the session cwd
    startupWaitMs: 5000          # a new session waits this long for selected servers that are still starting
    connectTimeoutMs: 60000
    toolCallTimeoutMs: 300000
    idleShutdownMinutes: 15
```

## Security notes

- `/mcp-master/api/*` passes DSH's connection fence (Host/Origin + browser authentication); mutating calls also need a custom header that cross-origin pages cannot send without a CORS preflight; paths must be inside registered workspaces or live session directories.
- The OAuth redirect (`/mcp-master/oauth/callback`) opens in your system browser without the DSH cookie and is authorized by a single-use 192-bit `state`.
- Logs and the UI redact codes, tokens, and `Bearer` values; command lines are shown unexpanded. `state.json` holds tokens — treat it like a credentials file.

## Develop

```sh
pnpm install
pnpm run verify          # build + typecheck + tests (node --test runs the .ts tests directly)
```

| Path | Role |
|---|---|
| `src/index.ts` | Host entry: options, agent lifecycle hooks, route mounting |
| `src/host/config.ts` | Catalog discovery (project + global), dialects, variable expansion, fingerprints |
| `src/host/runtime.ts` | Trust, defaults, per-session selections, server lifecycle, per-agent tool registration |
| `src/host/state.ts` | Persistent state (`~/.dsh/mcp-master/state.json`) |
| `src/host/stdio.ts`, `http.ts`, `jsonrpc.ts` | MCP transports and JSON-RPC plumbing (zero runtime dependencies) |
| `src/host/oauth.ts` | MCP authorization (discovery, DCR, PKCE, refresh) |
| `src/host/schema.ts`, `tools.ts` | Schema folding and ToolDefinitions |
| `src/host/api.ts` | HTTP API + OAuth callback |
| `src/client/*` | Composer picker (React; `__ModuleLoader__` bundle; portal popover like the model menu) |
| `src/shared/types.ts` | Wire contract between the halves |

After rebuilding an installed copy, restart DSH: the Host module is an ES module and is not re-imported in place.

## License

MIT
