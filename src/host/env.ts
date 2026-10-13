/**
 * Environment for stdio servers and for `${VAR}` expansion.
 *
 * A desktop app launched from Finder/Dock inherits a minimal environment, so
 * tools installed through Homebrew, asdf, uv, nvm … would be "not found" and
 * tokens exported in ~/.zshrc would expand to ''. The user's login-shell
 * environment is read once (bounded, best effort) and layered under the host
 * environment; PATH is merged entry by entry with the login order first.
 */

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { delimiter } from 'node:path';

const MARK = '__DSH_WORKSPACE_MCP_ENV__';
const SKIP_FROM_LOGIN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'TERM_SESSION_ID', 'TMUX', 'TMUX_PANE']);

let loginEnvPromise: Promise<Record<string, string>> | null = null;

function readLoginShellEnv(timeoutMs = 6000): Promise<Record<string, string>> {
  if (process.platform === 'win32') return Promise.resolve({});
  let shell = process.env['SHELL'];
  try { shell ||= userInfo().shell ?? undefined; } catch {}
  if (!shell) return Promise.resolve({});
  return new Promise((resolve) => {
    const child = execFile(shell, ['-ilc', `printf '%s' '${MARK}'; /usr/bin/env -0; printf '%s' '${MARK}'`], {
      timeout: timeoutMs,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' },
      maxBuffer: 4 * 1024 * 1024,
    }, (_error, stdout) => {
      const text = String(stdout ?? '');
      const start = text.indexOf(MARK);
      const end = text.lastIndexOf(MARK);
      if (start < 0 || end <= start) { resolve({}); return; }
      const env: Record<string, string> = {};
      for (const entry of text.slice(start + MARK.length, end).split('\0')) {
        const eq = entry.indexOf('=');
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      resolve(env);
    });
    child.stdin?.end();
  });
}

/** The login-shell environment (cached; {} when unavailable). */
export function loginEnv(): Promise<Record<string, string>> {
  loginEnvPromise ??= readLoginShellEnv().catch(() => ({}));
  return loginEnvPromise;
}

/**
 * Host env layered over the login env, minus Harness-internal `DSH_*`
 * variables, with a merged PATH. Used for spawning and for expansion.
 */
export async function baseEnv(): Promise<Record<string, string>> {
  const login = await loginEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(login)) {
    if (SKIP_FROM_LOGIN.has(key) || key.startsWith('DSH_')) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('DSH_')) continue;
    env[key] = value;
  }
  const parts = [...(login['PATH'] ?? '').split(delimiter), ...(process.env['PATH'] ?? '').split(delimiter)].filter(Boolean);
  env['PATH'] = [...new Set(parts)].join(delimiter);
  return env;
}
