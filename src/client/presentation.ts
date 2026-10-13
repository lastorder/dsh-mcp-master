/** Pure presentation rules for the picker (unit-tested). */

import type { Scope, ServerStatus, ServerView } from '../shared/types.ts';

export type Tone = 'done' | 'warning' | 'error' | 'idle' | 'ongoing' | 'new';

export function statusTone(status: ServerStatus): Tone {
  switch (status) {
    case 'connected': return 'done';
    case 'connecting': return 'ongoing';
    case 'needs-auth':
    case 'authorizing':
    case 'changed': return 'warning';
    case 'error':
    case 'invalid': return 'error';
    case 'untrusted': return 'new';
    default: return 'idle';
  }
}

/** One tone for the servers active in this session, most urgent first. */
export function activeTone(active: readonly ServerView[]): Tone {
  if (active.length === 0) return 'idle';
  if (active.some((s) => s.status === 'error' || s.status === 'invalid')) return 'error';
  if (active.some((s) => s.status === 'needs-auth' || s.status === 'authorizing')) return 'warning';
  if (active.some((s) => s.status === 'connecting' || s.status === 'idle')) return 'ongoing';
  return 'done';
}

/** Servers of one scope, the ones needing the user first, otherwise in config order. */
export function serversOf(servers: readonly ServerView[], scope: Scope): ServerView[] {
  const rank = (s: ServerView): number => {
    switch (s.status) {
      case 'needs-auth':
      case 'authorizing':
      case 'error':
      case 'changed': return 0;
      default: return 1;
    }
  };
  return servers
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.scope === scope)
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => s);
}

/** Whether two selections contain the same names. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

export function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function formatLogTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
