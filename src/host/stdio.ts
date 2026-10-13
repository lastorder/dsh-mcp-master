/**
 * stdio transport: spawn the server and speak newline-delimited JSON-RPC over
 * its stdin/stdout. On POSIX the child leads its own process group so that
 * wrappers such as `npx` or `uv run` are reaped together with their children.
 */

import { spawn } from 'node:child_process';
import {
  McpError, PendingRequests, kindOf, replyToServerRequest,
  type JsonRpcMessage, type LogFn, type McpConnection, type RequestOptions, type Root,
} from './jsonrpc.ts';

const STDERR_TAIL = 4000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface StdioSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Command line as written, for logs (never variable-expanded). */
  display: string;
}

export interface StdioOptions {
  env: Record<string, string>;
  roots?: Root[];
  log?: LogFn;
}

export interface StdioConnection extends McpConnection {
  readonly pid: number | undefined;
  stderrTail(): string;
}

function quoteWindows(token: string): string {
  if (token === '') return '""';
  if (/^"[^"]*"$/.test(token) || !/[\s"]/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

export function openStdio(spec: StdioSpec, options: StdioOptions): StdioConnection {
  const { env, roots = [], log = () => {} } = options;
  const isWin = process.platform === 'win32';
  const child = spawn(isWin ? quoteWindows(spec.command) : spec.command, isWin ? spec.args.map(quoteWindows) : spec.args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: isWin,
    detached: !isWin,
    windowsHide: true,
  });
  const pending = new PendingRequests();
  let stdoutBuffer = '';
  let stderrTail = '';
  let closed = false;
  let exited = false;
  const exitWaiters: Array<() => void> = [];

  const write = (payload: JsonRpcMessage): void => {
    if (closed || !child.stdin.writable) throw new McpError('server process is not running');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const conn: StdioConnection = {
    transport: 'stdio',
    pid: child.pid,
    protocolVersion: '',
    capabilities: {},
    serverInfo: {},
    instructions: '',
    onNotification: null,
    onClose: null,
    stderrTail: () => stderrTail,
    request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
      if (closed) return Promise.reject(new McpError('server process is not running'));
      const id = pending.allocate();
      const promise = pending.track(id, method, {
        ...opts,
        onAbort: (requestId, reason) => {
          try { write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } }); } catch {}
        },
      });
      try {
        write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        pending.reject(id, error as Error);
      }
      return promise;
    },
    async notify(method: string, params?: unknown): Promise<void> {
      try { write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); } catch {}
    },
    close,
  };

  log({ phase: 'spawn', target: spec.cwd, detail: `${spec.display}${child.pid ? ` (pid ${child.pid})` : ''}` });

  const fail = (error: Error): void => {
    if (closed) return;
    closed = true;
    pending.rejectAll(error);
    try { conn.onClose?.(error); } catch {}
  };

  child.on('error', (error: NodeJS.ErrnoException) => {
    const message = error?.code === 'ENOENT'
      ? `command not found: ${spec.command} — make sure it is installed and on PATH`
      : `failed to start ${spec.command}: ${error?.message ?? error}`;
    log({ phase: 'exit', detail: message });
    fail(new McpError(message));
  });
  child.on('exit', (code, signal) => {
    exited = true;
    for (const resolve of exitWaiters.splice(0)) resolve();
    const tail = stderrTail.trim();
    const detail = `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    log({ phase: 'exit', detail: tail ? `${detail}; stderr: ${tail.slice(-600)}` : detail });
    const lastLines = tail.split('\n').filter(Boolean).slice(-3).join(' | ').slice(-400);
    fail(new McpError(lastLines ? `server process ${detail}: ${lastLines}` : `server process ${detail}`));
  });
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    if (stdoutBuffer.length > MAX_BUFFER) {
      stdoutBuffer = '';
      log({ phase: 'protocol', detail: 'dropped an oversized stdout line' });
    }
    let index: number;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      for (const item of Array.isArray(message) ? message : [message]) dispatch(item as JsonRpcMessage);
    }
  });

  function dispatch(message: JsonRpcMessage): void {
    switch (kindOf(message)) {
      case 'response':
        pending.settle(message);
        break;
      case 'notification':
        try { conn.onNotification?.(message); } catch {}
        break;
      case 'request':
        try { write(replyToServerRequest(message, roots)); } catch {}
        break;
      default:
        break;
    }
  }

  function killGroup(sig: NodeJS.Signals): void {
    try {
      if (!isWin && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch {}
    }
  }

  async function close(): Promise<void> {
    const wasClosed = closed;
    closed = true;
    if (!wasClosed) pending.rejectAll(new McpError('connection closed'));
    if (exited) return;
    try { child.stdin.end(); } catch {}
    killGroup('SIGTERM');
    const exitedInTime = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      timer.unref?.();
      exitWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
    if (!exitedInTime) killGroup('SIGKILL');
  }

  return conn;
}
