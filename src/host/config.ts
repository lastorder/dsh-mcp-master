/**
 * MCP catalog discovery and parsing.
 *
 * Project scope reads the files other agents already use, so a workspace
 * needs no DSH-specific file:
 *
 *   .mcp.json            Claude Code project scope   { "mcpServers": { ... } }
 *   .cursor/mcp.json     Cursor                       { "mcpServers": { ... } }
 *   .vscode/mcp.json     VS Code (JSONC)              { "servers":    { ... } }
 *   .dsh/mcp.json        DSH-local                    { "mcpServers": { ... } }
 *
 * Global scope is one user file (default `~/.dsh/mcp-master/mcp.json`) in the
 * same format. A project server shadows a global server of the same name.
 *
 * Everything here is pure apart from synchronous file reads, so the parser is
 * unit-testable without a Harness.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Scope, Transport } from '../shared/types.ts';

export const DEFAULT_CONFIG_FILES: readonly string[] = Object.freeze(['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.dsh/mcp.json']);

/** Upper bound on one config file; anything larger is not a hand-written MCP list. */
const MAX_CONFIG_BYTES = 512 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RawEntry = Record<string, unknown>;

export interface OAuthOverrides {
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** One launchable server, after variable expansion. */
export interface ServerSpec {
  name: string;
  scope: Scope;
  /** Config file that declares the entry (workspace-relative, or ~-relative for global). */
  source: string;
  transport: Transport;
  /** Hash of the entry as written; approvals are tied to it. */
  fingerprint: string;
  /** The file's own enabled flag. */
  declaredEnabled: boolean;
  description: string;
  /** Command line or URL as written (unexpanded, safe to show). */
  display: string;
  /** Non-empty when the entry cannot be launched. */
  invalid: string;
  warnings: string[];
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
  oauth?: OAuthOverrides;
}

export interface ConfigFileInfo {
  scope: Scope;
  rel: string;
  path: string;
  mtimeMs: number;
  size: number;
  error: string;
  count: number;
}

export interface WorkspaceConfig {
  root: string;
  files: ConfigFileInfo[];
  servers: ServerSpec[];
  shadowed: Array<{ name: string; source: string; winner: string }>;
}

export interface FindRootOptions {
  configFiles?: readonly string[];
  searchParents?: boolean;
  home?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Whether `dir` holds at least one of the configured MCP files. */
export function hasConfigFile(dir: string, configFiles: readonly string[] = DEFAULT_CONFIG_FILES): boolean {
  return configFiles.some((rel) => {
    try { return statSync(join(dir, rel)).isFile(); } catch { return false; }
  });
}

/**
 * Find the directory whose MCP files govern `cwd`: `cwd` itself, else the
 * nearest ancestor holding a config file. The walk stops at a repository root
 * (a directory containing `.git`) and never reaches the home directory or the
 * filesystem root, so an unrelated file far above the project is ignored.
 */
export function findConfigRoot(cwd: unknown, options: FindRootOptions = {}): string | null {
  const { configFiles = DEFAULT_CONFIG_FILES, searchParents = true, home = homedir() } = options;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  let dir = resolve(cwd);
  const stop = resolve(home);
  for (let depth = 0; depth < 32; depth += 1) {
    if (hasConfigFile(dir, configFiles)) return dir;
    if (!searchParents) return null;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir || parent === stop) return null;
    dir = parent;
  }
  return null;
}

export interface ExpansionVars {
  workspaceFolder?: string;
  userHome?: string;
}

/**
 * Expand `${VAR}`, `${VAR:-default}`, `${env:VAR}` (VS Code) and
 * `${workspaceFolder}` inside one string. Unresolved names are collected in
 * `missing` and replaced with '' (or the default), matching Claude Code.
 */
export function expandString(
  value: string,
  env: Record<string, string | undefined>,
  vars: ExpansionVars = {},
  missing?: Set<string>,
  unsupported?: Set<string>,
): string {
  if (!value.includes('${')) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_match, body: string) => {
    const expr = body.trim();
    if (expr === 'workspaceFolder' || expr === 'workspaceRoot') return vars.workspaceFolder ?? '';
    if (expr === 'userHome') return vars.userHome ?? '';
    if (expr.startsWith('input:')) { unsupported?.add(expr); return ''; }
    let name = expr.startsWith('env:') ? expr.slice(4) : expr;
    let fallback: string | undefined;
    const dflt = name.indexOf(':-');
    if (dflt >= 0) { fallback = name.slice(dflt + 2); name = name.slice(0, dflt); }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { unsupported?.add(expr); return ''; }
    const resolved = env[name];
    if (resolved !== undefined && resolved !== '') return resolved;
    if (fallback !== undefined) return fallback;
    missing?.add(name);
    return '';
  });
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (!key || v === null || v === undefined) continue;
    out[key] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
  if (typeof value === 'string' && value.trim()) return value.trim().split(/\s+/);
  return [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalize the transport keyword used by the different config dialects. */
export function normalizeTransport(raw: RawEntry): Transport | null {
  const type = (str(raw['type']) || str(raw['transport'])).trim().toLowerCase();
  if (type === 'stdio' || type === 'local') return 'stdio';
  if (type === 'sse') return 'sse';
  if (['http', 'streamable-http', 'streamablehttp', 'streamable_http', 'remote'].includes(type)) return 'http';
  if (str(raw['command']).trim()) return 'stdio';
  if (str(raw['url'] ?? raw['serverUrl'])) return 'http';
  return null;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

/**
 * The launch identity of one server as written in the file (before variable
 * expansion). An approval is tied to this hash: when the command, arguments,
 * URL, or headers change, the user reviews the server again.
 */
export function fingerprintOf(raw: RawEntry): string {
  const canon = {
    t: normalizeTransport(raw) ?? '',
    command: str(raw['command']),
    args: stringList(raw['args']),
    env: stringMap(raw['env']),
    cwd: str(raw['cwd']),
    url: str(raw['url'] ?? raw['serverUrl']),
    headers: stringMap(raw['headers']),
  };
  return createHash('sha256').update(sortedJson(canon)).digest('hex').slice(0, 16);
}

/** Whether the file itself marks the server off (`enabled: false` / `disabled: true`). */
export function declaredEnabled(raw: RawEntry): boolean {
  if (raw['enabled'] === false || raw['enabled'] === 'false') return false;
  if (raw['disabled'] === true || raw['disabled'] === 'true') return false;
  return true;
}

export interface ParseContext {
  root: string;
  source: string;
  scope?: Scope;
  env?: Record<string, string | undefined>;
}

/**
 * Turn one `mcpServers[name]` entry into a launch spec. Never throws: a
 * malformed entry becomes a spec with `invalid` set so the UI can name it.
 */
export function parseServerEntry(name: string, raw: unknown, context: ParseContext): ServerSpec {
  const { root, source, scope = 'project', env = process.env } = context;
  if (!isRecord(raw)) {
    return { name, scope, source, transport: 'stdio', fingerprint: '', declaredEnabled: false, description: '', display: '', invalid: 'entry must be a JSON object', warnings: [] };
  }
  const transport = normalizeTransport(raw);
  const missing = new Set<string>();
  const unsupported = new Set<string>();
  const vars: ExpansionVars = { workspaceFolder: root, userHome: homedir() };
  const x = (s: string): string => expandString(s, env, vars, missing, unsupported);
  const spec: ServerSpec = {
    name,
    scope,
    source,
    transport: transport ?? 'stdio',
    fingerprint: fingerprintOf(raw),
    declaredEnabled: declaredEnabled(raw),
    description: str(raw['description']).slice(0, 300),
    display: '',
    invalid: '',
    warnings: [],
  };
  if (!transport) {
    spec.invalid = 'entry needs either "command" (stdio) or "url" (http/sse)';
    return spec;
  }
  if (transport === 'stdio') {
    const rawCommand = str(raw['command']).trim();
    spec.display = [rawCommand, ...stringList(raw['args'])].filter(Boolean).join(' ');
    spec.command = x(rawCommand);
    if (!spec.command) spec.invalid = 'stdio server is missing "command"';
    spec.args = stringList(raw['args']).map(x);
    spec.env = Object.fromEntries(Object.entries(stringMap(raw['env'])).map(([k, v]) => [k, x(v)]));
    const cwd = str(raw['cwd']).trim() ? x(str(raw['cwd']).trim()) : '';
    spec.cwd = cwd ? resolve(root, cwd) : root;
    if (cwd && !isDirectory(spec.cwd)) spec.warnings.push(`working directory ${spec.cwd} does not exist`);
  } else {
    spec.display = str(raw['url'] ?? raw['serverUrl']).trim();
    const url = x(spec.display);
    spec.url = url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') spec.invalid = 'url must be http(s)';
    } catch {
      spec.invalid = url ? `invalid url "${url}"` : 'http server is missing "url"';
    }
    spec.headers = Object.fromEntries(Object.entries(stringMap(raw['headers'])).map(([k, v]) => [k, x(v)]));
    const oauth = isRecord(raw['oauth']) ? raw['oauth'] : {};
    const clientId = oauth['clientId'] ?? oauth['client_id'] ?? raw['clientId'];
    const clientSecret = oauth['clientSecret'] ?? oauth['client_secret'];
    const scope = oauth['scope'] ?? oauth['scopes'] ?? raw['scope'];
    spec.oauth = {
      clientId: typeof clientId === 'string' ? x(clientId.trim()) : '',
      clientSecret: typeof clientSecret === 'string' ? x(clientSecret) : '',
      scope: Array.isArray(scope) ? scope.map(String).join(' ') : (typeof scope === 'string' ? x(scope.trim()) : ''),
    };
  }
  for (const variable of missing) spec.warnings.push(`environment variable ${variable} is not set`);
  for (const expr of unsupported) spec.warnings.push(`\${${expr}} is not supported and was left empty`);
  return spec;
}

/**
 * Remove `//` and `/* *\/` comments and trailing commas outside strings
 * (VS Code's mcp.json is JSONC). Only used when strict JSON fails.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface ParsedFile extends ConfigFileInfo {
  servers: ServerSpec[];
}

export interface FileRef {
  /** Absolute path. */
  path: string;
  /** How the file is shown (workspace-relative or ~-relative). */
  rel: string;
  scope: Scope;
}

/** Read and parse one config file. Missing files return null. */
export function readConfigFile(file: FileRef, root: string, env: Record<string, string | undefined> = process.env): ParsedFile | null {
  const { path, rel, scope } = file;
  let stat;
  try { stat = statSync(path); } catch { return null; }
  if (!stat.isFile()) return null;
  const parsedFile: ParsedFile = { scope, rel, path, mtimeMs: stat.mtimeMs, size: stat.size, error: '', count: 0, servers: [] };
  return parseFileBody(parsedFile, stat.size, root, env);
}

function parseFileBody(file: ParsedFile, size: number, root: string, env: Record<string, string | undefined>): ParsedFile {
  const { path, rel, scope } = file;
  if (size > MAX_CONFIG_BYTES) { file.error = `file is larger than ${MAX_CONFIG_BYTES} bytes`; return file; }
  let json: Json;
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) json = {};
    else {
      try { json = JSON.parse(text) as Json; } catch (strictError) {
        try { json = JSON.parse(stripJsonComments(text)) as Json; } catch { throw strictError; }
      }
    }
  } catch (error) {
    file.error = `invalid JSON: ${(error as Error)?.message ?? error}`;
    return file;
  }
  if (!isRecord(json)) { file.error = 'root must be a JSON object'; return file; }
  const mcp = json['mcp'];
  const table = isRecord(json['mcpServers']) ? json['mcpServers']
    : isRecord(json['servers']) ? json['servers']
      : isRecord(mcp) && isRecord(mcp['servers']) ? mcp['servers']
        : null;
  if (!table) return file;
  for (const [name, raw] of Object.entries(table)) {
    if (!name.trim()) continue;
    file.servers.push(parseServerEntry(name, raw, { root, source: rel, scope, env }));
  }
  file.count = file.servers.length;
  return file;
}

/** `~/x` form of an absolute path under the home directory. */
export function displayPath(path: string, home = homedir()): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export interface CatalogOptions {
  configFiles?: readonly string[];
  /** Absolute path of the global catalog file; omit for none. */
  globalFile?: string | undefined;
  env?: Record<string, string | undefined>;
}

/** The files that make up one workspace's catalog, project files first. */
export function catalogFiles(root: string, options: CatalogOptions = {}): FileRef[] {
  const { configFiles = DEFAULT_CONFIG_FILES, globalFile } = options;
  const files: FileRef[] = configFiles.map((rel) => ({ path: join(root, rel), rel, scope: 'project' as const }));
  if (globalFile) files.push({ path: globalFile, rel: displayPath(globalFile), scope: 'global' });
  return files;
}

/**
 * Load the catalog of one workspace: every project file under `root`, then
 * the global file. The first declaration of a name wins (project before
 * global); later duplicates are reported as shadowed rather than merged.
 */
export function loadCatalog(root: string, options: CatalogOptions = {}): WorkspaceConfig {
  const { env = process.env } = options;
  const files: ConfigFileInfo[] = [];
  const servers: ServerSpec[] = [];
  const shadowed: WorkspaceConfig['shadowed'] = [];
  const seen = new Map<string, string>();
  for (const ref of catalogFiles(root, options)) {
    const file = readConfigFile(ref, root, env);
    if (!file) continue;
    const { servers: parsed, ...info } = file;
    files.push(info);
    for (const spec of parsed) {
      const winner = seen.get(spec.name);
      if (winner !== undefined) { shadowed.push({ name: spec.name, source: spec.source, winner }); continue; }
      seen.set(spec.name, spec.source);
      servers.push(spec);
    }
  }
  return { root, files, servers, shadowed };
}

/** Project-only catalog (kept for callers that do not use a global file). */
export function loadWorkspaceConfig(root: string, options: Omit<CatalogOptions, 'globalFile'> = {}): WorkspaceConfig {
  return loadCatalog(root, options);
}

/** Cheap change detector for the watcher: (path, mtime, size) of each catalog file. */
export function configStamp(root: string, options: CatalogOptions = {}): string {
  return catalogFiles(root, options).map(({ path }) => {
    try {
      const s = statSync(path);
      return `${path}:${s.mtimeMs}:${s.size}`;
    } catch {
      return `${path}:-`;
    }
  }).join('|');
}

/** Launch-relevant fields after expansion; a change means the process must restart. */
export function launchKey(spec: ServerSpec): string {
  return sortedJson({
    transport: spec.transport,
    command: spec.command ?? '',
    args: spec.args ?? [],
    env: spec.env ?? {},
    cwd: spec.cwd ?? '',
    url: spec.url ?? '',
    headers: spec.headers ?? {},
    oauth: spec.oauth ?? {},
    invalid: spec.invalid,
  });
}
