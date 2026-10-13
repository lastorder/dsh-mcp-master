/**
 * One live feed per (workspace cwd, session), shared by every mounted picker.
 *
 * The feed long-polls `GET /state` (the Host answers as soon as anything
 * changes, or after 25s), pauses to a slow poll while the page is hidden, and
 * stops entirely when its last subscriber unmounts. While a feed runs, the
 * Host treats the session as "viewed" and keeps its selected servers warm.
 */

import { useSyncExternalStore } from 'react';
import type { ActionResponse, SessionView, WorkspaceView } from '../shared/types.ts';
import { ApiError, fetchState } from './api.ts';

export interface FeedSnapshot {
  /** `none`: no catalog for this cwd (or not a known workspace). */
  phase: 'loading' | 'ready' | 'none' | 'error';
  workspace: WorkspaceView | null;
  session: SessionView | null;
  error: string;
}

const LOADING: FeedSnapshot = Object.freeze({ phase: 'loading', workspace: null, session: null, error: '' });
const IDLE_POLL_MS = 30000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function hasCatalog(workspace: WorkspaceView | null | undefined): workspace is WorkspaceView {
  return workspace !== null && workspace !== undefined && workspace.servers.length > 0;
}

export class SessionFeed {
  readonly cwd: string;
  readonly sessionId: string;
  private snapshot: FeedSnapshot = LOADING;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private rev: number | undefined;
  private wake: (() => void) | null = null;

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
  }

  getSnapshot = (): FeedSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Apply the views an action returned, then let the loop catch up. */
  accept(response: ActionResponse): void {
    if (response.workspace === undefined) return;
    const workspace = response.workspace ?? null;
    this.publish({ phase: hasCatalog(workspace) ? 'ready' : 'none', workspace, session: response.session ?? this.snapshot.session, error: '' });
    this.rev = workspace?.rev;
    this.poke();
  }

  /** Re-query immediately (e.g. when the picker opens). */
  poke(): void {
    this.controller?.abort();
    if (this.listeners.size > 0) this.start();
  }

  private publish(next: FeedSnapshot): void {
    const prev = this.snapshot;
    if (prev.phase === next.phase && prev.error === next.error && prev.workspace?.rev === next.workspace?.rev
      && (prev.workspace === null) === (next.workspace === null)
      && JSON.stringify(prev.session) === JSON.stringify(next.session)) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private start(): void {
    const controller = new AbortController();
    this.controller = controller;
    const onVisible = (): void => { if (!document.hidden) this.wake?.(); };
    document.addEventListener('visibilitychange', onVisible);
    controller.signal.addEventListener('abort', () => document.removeEventListener('visibilitychange', onVisible), { once: true });
    void this.loop(controller.signal);
  }

  private stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    const local = new AbortController();
    this.wake = () => local.abort();
    await sleep(ms, AbortSignal.any([signal, local.signal]));
    this.wake = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const hidden = typeof document !== 'undefined' && document.hidden;
      try {
        const wait = !hidden && this.rev !== undefined;
        const response = await fetchState(this.cwd, this.sessionId, this.rev, wait, signal);
        failures = 0;
        this.rev = response.workspace ? response.rev : undefined;
        this.publish({ phase: hasCatalog(response.workspace) ? 'ready' : 'none', workspace: response.workspace, session: response.session, error: '' });
        if (!response.workspace || hidden) await this.pause(IDLE_POLL_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          this.publish({ phase: 'none', workspace: null, session: null, error: '' });
          await this.pause(IDLE_POLL_MS * 2, signal);
          continue;
        }
        failures += 1;
        this.publish({ ...this.snapshot, phase: this.snapshot.workspace ? 'ready' : 'error', error: String((error as Error)?.message ?? error) });
        await this.pause(Math.min(30000, 1500 * 2 ** Math.min(failures, 5)), signal);
      }
    }
  }
}

const feeds = new Map<string, SessionFeed>();

export function feedFor(cwd: string, sessionId: string): SessionFeed {
  const key = `${cwd}\n${sessionId}`;
  let feed = feeds.get(key);
  if (!feed) {
    feed = new SessionFeed(cwd, sessionId);
    feeds.set(key, feed);
  }
  return feed;
}

export function useSessionFeed(feed: SessionFeed): FeedSnapshot {
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
}
