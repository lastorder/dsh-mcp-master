/**
 * Composer MCP picker — sits right before the model selector.
 *
 * Collapsed it is one chip ("🔌 MCP 2 ●") and renders nothing when the
 * workspace has no MCP catalog. Open, it lists project and global servers
 * with a checkbox per server for THIS session (works in a brand-new session
 * and at any time later, like switching the model), live status, sign-in,
 * trust review for project servers, details/logs, and "Use for new sessions"
 * to save the current selection as the workspace default.
 */

import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { ActionResponse, LogEntryView, Scope, ServerAction, ServerView, SessionView, WorkspaceView } from '../shared/types.ts';
import { serverAction, sessionAction, workspaceAction } from './api.ts';
import { feedFor, useSessionFeed, type SessionFeed } from './feed.ts';
import { CheckIcon, ChevronIcon, CloseIcon, ExternalIcon, PlugIcon, RefreshIcon } from './icons.tsx';
import type { MessageKey, Translate } from './locale.ts';
import { activeTone, formatLogTime, sameSet, secondsUntil, serversOf, statusTone } from './presentation.ts';

interface SessionRow {
  cwd?: string;
}

/** Props the `conversation.input.right` slot passes (subset used here). */
export interface PickerProps {
  sessionId: string;
  useSessions: <T>(selector: (state: { byId: Record<string, SessionRow | undefined> }) => T) => T;
  t: Translate;
}

const TOOL_PREVIEW = 24;
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 };
const GAP = 8;
const MARGIN = 12;

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

export function McpPicker({ sessionId, useSessions, t }: PickerProps) {
  const cwd = useSessions((state) => state.byId[sessionId]?.cwd);
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return <PickerControl key={`${cwd}\n${sessionId}`} cwd={cwd} sessionId={sessionId} t={t} />;
}

/** Fixed position above the trigger, right-aligned, clamped to the viewport (below when there is no room). */
function useAnchoredPosition(open: boolean, anchorRef: RefObject<HTMLElement | null>, panelRef: RefObject<HTMLElement | null>): CSSProperties | null {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!rect || !panel) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      let left = rect.right - width;
      let top = rect.top - GAP - height;
      if (top < MARGIN) top = Math.min(rect.bottom + GAP, window.innerHeight - height - MARGIN);
      left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN);
      top = Math.max(top, MARGIN);
      setPosition({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' || !panelRef.current ? null : new ResizeObserver(place);
    if (observer && panelRef.current) observer.observe(panelRef.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, panelRef]);
  return position;
}

function PickerControl({ cwd, sessionId, t }: { cwd: string; sessionId: string; t: Translate }) {
  const feed = feedFor(cwd, sessionId);
  const snapshot = useSessionFeed(feed);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const position = useAnchoredPosition(open, triggerRef, panelRef);
  const { workspace, session } = snapshot;
  const visible = workspace !== null && session !== null && workspace.servers.length > 0;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (open) feed.poke();
  }, [open, feed]);

  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [visible, open]);

  if (!visible || workspace === null || session === null) return null;

  const byName = new Map(workspace.servers.map((s) => [s.name, s]));
  const active = session.active.map((name) => byName.get(name)).filter((s): s is ServerView => s !== undefined && s.trust === 'trusted');
  const count = active.length;
  const hasNew = workspace.servers.some((s) => s.trust === 'untrusted' || s.trust === 'changed');
  const title = t('trigger.title', { count, names: count > 0 ? `: ${active.map((s) => s.name).join(', ')}` : '' });
  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div className="mcpm-root" ref={rootRef} onKeyDown={onKeyDown} data-mcp-master="">
      <button
        ref={triggerRef}
        type="button"
        className="mcpm-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={t('trigger.aria', { count })}
        title={hasNew ? `${title}\n${t('trigger.new')}` : title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <PlugIcon size={15} />
        <span className="mcpm-trigger-label">{t('trigger.label')}</span>
        <span className="mcpm-trigger-count">{count}</span>
        {count > 0 ? <span className="mcpm-dot" data-tone={activeTone(active)} aria-hidden="true" /> : null}
        {hasNew ? <span className="mcpm-trigger-new" aria-hidden="true" /> : null}
      </button>
      {open
        ? createPortal(
          <Panel
            id={panelId}
            panelRef={panelRef}
            style={position ?? MEASURE_STYLE}
            feed={feed}
            cwd={cwd}
            sessionId={sessionId}
            workspace={workspace}
            session={session}
            feedError={snapshot.error}
            t={t}
            onClose={close}
          />,
          document.body,
        )
        : null}
    </div>
  );
}

interface PanelProps {
  id: string;
  panelRef: RefObject<HTMLDivElement>;
  style: CSSProperties;
  feed: SessionFeed;
  cwd: string;
  sessionId: string;
  workspace: WorkspaceView;
  session: SessionView;
  feedError: string;
  t: Translate;
  onClose(): void;
}

function Panel({ id, panelRef, style, feed, cwd, sessionId, workspace, session, feedError, t, onClose }: PanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const retrying = workspace.servers.some((s) => s.retryAt > 0);

  useEffect(() => {
    if (!retrying) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retrying]);

  const run = async (key: string, action: () => Promise<ActionResponse>): Promise<void> => {
    setBusy(key);
    setError('');
    try {
      feed.accept(await action());
    } catch (e) {
      setError(t('error.action', { error: messageOf(e) }));
    } finally {
      setBusy(null);
    }
  };

  const activeSet = new Set(session.active);
  const toggleActive = (server: ServerView): void => {
    if (activeSet.has(server.name)) {
      void run(`row:${server.name}`, () => sessionAction(cwd, sessionId, server.name, 'deactivate'));
      return;
    }
    if (server.trust === 'untrusted' || server.trust === 'changed') {
      setConfirming((current) => (current === server.name ? null : server.name));
      return;
    }
    void run(`row:${server.name}`, () => sessionAction(cwd, sessionId, server.name, 'activate'));
  };
  const confirmTrust = (server: ServerView): void => {
    setConfirming(null);
    void run(`row:${server.name}`, () => sessionAction(cwd, sessionId, server.name, 'activate', true));
  };

  const trustedActive = session.active.filter((name) => workspace.servers.some((s) => s.name === name && s.trust === 'trusted'));
  const matchesDefault = sameSet(trustedActive, workspace.defaults);
  const untrusted = workspace.servers.filter((s) => s.trust === 'untrusted').length;

  const group = (scope: Scope): ReactNode => {
    const servers = serversOf(workspace.servers, scope);
    const files = workspace.files.filter((f) => f.scope === scope);
    if (scope === 'project' && servers.length === 0 && files.length === 0) return null;
    if (scope === 'global' && workspace.globalFile === null) return null;
    const fileText = scope === 'global' ? workspace.globalFile ?? '' : files.map((f) => f.rel).join(' · ');
    const fileError = files.find((f) => f.error);
    return (
      <section key={scope} aria-label={t(scope === 'project' ? 'group.project' : 'group.global')}>
        <div className="mcpm-group">
          <span className="mcpm-group-title">{t(scope === 'project' ? 'group.project' : 'group.global')}</span>
          <span className="mcpm-group-file" data-error={fileError ? 'true' : undefined} title={fileError?.error ?? fileText}>{fileText}</span>
        </div>
        {servers.length === 0 && scope === 'global'
          ? <div className="mcpm-empty">{t('group.globalEmpty', { file: workspace.globalFile ?? '' })}</div>
          : (
            <ul className="mcpm-list">
              {servers.map((server) => (
                <ServerRow
                  key={server.name}
                  cwd={cwd}
                  sessionId={sessionId}
                  feed={feed}
                  server={server}
                  active={activeSet.has(server.name)}
                  open={expanded === server.name}
                  confirming={confirming === server.name}
                  busy={busy === `row:${server.name}`}
                  now={now}
                  t={t}
                  onToggleOpen={() => setExpanded((current) => (current === server.name ? null : server.name))}
                  onToggleActive={() => toggleActive(server)}
                  onConfirmTrust={() => confirmTrust(server)}
                  onCancelTrust={() => setConfirming(null)}
                />
              ))}
            </ul>
          )}
      </section>
    );
  };

  return (
    <div id={id} ref={panelRef} className="mcpm-panel" role="dialog" aria-label={t('panel.title')} style={style}>
      <div className="mcpm-head">
        <div className="mcpm-head-text">
          <div className="mcpm-title">{t('panel.title')}</div>
          <div className="mcpm-subtitle" title={workspace.root}>{t('panel.subtitle', { name: workspace.name })}</div>
        </div>
        <button
          type="button"
          className="mcpm-iconbtn"
          title={t('panel.reload')}
          aria-label={t('panel.reload')}
          data-spin={busy === 'reload' ? 'true' : undefined}
          disabled={busy !== null}
          onClick={() => void run('reload', () => workspaceAction(cwd, sessionId, 'reload'))}
        >
          <RefreshIcon />
        </button>
        <button type="button" className="mcpm-iconbtn" title={t('panel.close')} aria-label={t('panel.close')} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {untrusted > 0 ? <div className="mcpm-alert" data-tone="brand">{t('panel.untrusted', { count: untrusted })}</div> : null}
      {workspace.files.filter((f) => f.error).map((file) => (
        <div key={file.rel} className="mcpm-alert">{t('panel.fileError', { file: file.rel, error: file.error })}</div>
      ))}
      {workspace.shadowed.map((s) => (
        <div key={`${s.source}:${s.name}`} className="mcpm-alert" data-tone="muted">{t('panel.shadowed', { name: s.name, source: s.source, winner: s.winner })}</div>
      ))}
      {feedError ? <div className="mcpm-alert" data-tone="muted">{t('panel.feedError', { error: feedError })}</div> : null}
      {error ? <div className="mcpm-alert">{error}</div> : null}

      <div className="mcpm-body">
        {group('project')}
        {group('global')}
      </div>

      <div className="mcpm-foot">
        <div className="mcpm-foot-row">
          <span className="mcpm-foot-text" title={workspace.defaults.join(', ')}>
            {workspace.defaults.length > 0 ? t('foot.defaults', { names: workspace.defaults.join(', ') }) : t('foot.defaultsNone')}
          </span>
          {workspace.customDefaults ? (
            <button type="button" className="mcpm-linkbtn" disabled={busy !== null} onClick={() => void run('default', () => workspaceAction(cwd, sessionId, 'reset-default'))}>
              {t('foot.resetDefault')}
            </button>
          ) : null}
          <button
            type="button"
            className="mcpm-btn"
            disabled={busy !== null || matchesDefault}
            title={matchesDefault ? t('foot.isDefault') : undefined}
            onClick={() => void run('default', () => workspaceAction(cwd, sessionId, 'save-default'))}
          >
            {t('foot.saveDefault')}
          </button>
        </div>
        <span className="mcpm-foot-hint">{t('foot.hint')}</span>
      </div>
    </div>
  );
}

function Checkbox({ checked, disabled, label, onToggle }: { checked: boolean; disabled: boolean; label: string; onToggle(): void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} title={label} disabled={disabled} className="mcpm-check" onClick={onToggle}>
      {checked ? <CheckIcon /> : null}
    </button>
  );
}

interface RowProps {
  cwd: string;
  sessionId: string;
  feed: SessionFeed;
  server: ServerView;
  active: boolean;
  open: boolean;
  confirming: boolean;
  busy: boolean;
  now: number;
  t: Translate;
  onToggleOpen(): void;
  onToggleActive(): void;
  onConfirmTrust(): void;
  onCancelTrust(): void;
}

function ServerRow(props: RowProps) {
  const { cwd, sessionId, feed, server, active, open, confirming, busy, now, t } = props;
  const [pending, setPending] = useState<ServerAction | null>(null);
  const [error, setError] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [logs, setLogs] = useState<LogEntryView[] | null>(null);

  useEffect(() => {
    if (server.status !== 'authorizing') setAuthUrl('');
  }, [server.status]);

  const act = async (action: ServerAction): Promise<void> => {
    setPending(action);
    setError('');
    try {
      const result = await serverAction(cwd, sessionId, server.name, action);
      if (action === 'logs') {
        setLogs(result.logs ?? []);
        return;
      }
      feed.accept(result);
      if (result.authorizeUrl) {
        setAuthUrl(result.authorizeUrl);
        window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (e) {
      setError(t('error.action', { error: messageOf(e) }));
    } finally {
      setPending(null);
    }
  };

  const tone = statusTone(server.status);
  let status: string;
  if (server.status === 'connected') status = t('status.connected', { count: server.toolCount });
  else if (server.status === 'idle' && server.toolCount > 0) status = t('status.idleTools', { count: server.toolCount });
  else status = t(`status.${server.status}` as MessageKey);
  if (server.status === 'error' && server.retryAt > 0) status = `${status} · ${t('row.retryIn', { seconds: secondsUntil(server.retryAt, now) })}`;

  let sub = server.target;
  let subTone: 'error' | 'hint' | undefined;
  if (server.error) { sub = server.error; subTone = 'error'; }
  else if (server.status === 'authorizing') { sub = t('row.authorizingHint'); subTone = 'hint'; }
  else if (!server.declaredEnabled && !active) { sub = t('row.disabledByConfig', { source: server.source }); subTone = 'hint'; }

  let inline: ReactNode = null;
  if (server.status === 'needs-auth' && server.auth.canSignIn) {
    inline = (
      <button type="button" className="mcpm-btn" data-variant="primary" disabled={pending !== null} onClick={() => void act('sign-in')}>
        {pending === 'sign-in' ? '…' : t('row.signIn')}
      </button>
    );
  } else if (server.status === 'authorizing' && authUrl) {
    inline = (
      <a className="mcpm-btn" href={authUrl} target="_blank" rel="noopener noreferrer">
        <ExternalIcon />
        {t('row.signIn')}
      </a>
    );
  } else if (server.status === 'error' && active) {
    inline = (
      <button type="button" className="mcpm-btn" disabled={pending !== null} onClick={() => void act('reconnect')}>
        {pending === 'reconnect' ? '…' : t('row.retry')}
      </button>
    );
  }

  return (
    <li className="mcpm-row" data-open={open ? 'true' : undefined}>
      <div className="mcpm-line">
        <Checkbox
          checked={active && server.trust === 'trusted'}
          disabled={busy || server.trust === 'invalid'}
          label={t('row.toggle', { name: server.name })}
          onToggle={props.onToggleActive}
        />
        <span className="mcpm-dot" data-tone={tone} aria-hidden="true" />
        <button type="button" className="mcpm-main" aria-expanded={open} aria-label={t('row.details', { name: server.name })} onClick={props.onToggleOpen}>
          <span className="mcpm-top">
            <span className="mcpm-name" title={server.name}>{server.name}</span>
            <span className="mcpm-tag">{server.transport}</span>
            {server.isDefault ? <span className="mcpm-tag" data-kind="default">{t('tag.default')}</span> : null}
            <span className="mcpm-status" data-tone={tone}>{status}</span>
            <span className="mcpm-chevron" data-open={open ? 'true' : undefined}><ChevronIcon /></span>
          </span>
          <span className="mcpm-sub" data-tone={subTone} title={sub}>{sub}</span>
        </button>
        {inline}
      </div>
      {confirming ? <TrustPrompt server={server} t={t} onConfirm={props.onConfirmTrust} onCancel={props.onCancelTrust} /> : null}
      {error ? <div className="mcpm-alert">{error}</div> : null}
      {open ? <ServerDetail server={server} pending={pending} logs={logs} onAct={act} onHideLogs={() => setLogs(null)} t={t} /> : null}
    </li>
  );
}

function TrustPrompt({ server, t, onConfirm, onCancel }: { server: ServerView; t: Translate; onConfirm(): void; onCancel(): void }) {
  const body = server.transport === 'stdio'
    ? t(server.trust === 'changed' ? 'trust.bodyChanged' : 'trust.bodyNew', { source: server.source })
    : t('trust.http', { source: server.source });
  return (
    <div className="mcpm-trust" role="group" aria-label={t('trust.title', { name: server.name })}>
      <span className="mcpm-trust-title">{t('trust.title', { name: server.name })}</span>
      <span className="mcpm-trust-body">{body}</span>
      <code className="mcpm-code">{server.target}</code>
      <span className="mcpm-actions">
        <button type="button" className="mcpm-btn" data-variant="primary" onClick={onConfirm}>{t('trust.confirm')}</button>
        <button type="button" className="mcpm-btn" onClick={onCancel}>{t('trust.cancel')}</button>
      </span>
    </div>
  );
}

interface DetailProps {
  server: ServerView;
  pending: ServerAction | null;
  logs: LogEntryView[] | null;
  onAct(action: ServerAction): Promise<void>;
  onHideLogs(): void;
  t: Translate;
}

function ServerDetail({ server, pending, logs, onAct, onHideLogs, t }: DetailProps) {
  const [allTools, setAllTools] = useState(false);
  const [copied, setCopied] = useState(false);
  const tools = allTools ? server.tools : server.tools.slice(0, TOOL_PREVIEW);
  const auth = server.auth.mode === 'oauth'
    ? t(server.auth.signedIn ? 'auth.oauthSignedIn' : 'auth.oauth')
    : t(`auth.${server.auth.mode}` as MessageKey);
  const logText = useMemo(() => (logs && logs.length > 0
    ? logs.map((e) => `${formatLogTime(e.at)} ${e.phase}${e.status ? ` ${e.status}` : ''} ${e.detail}${e.target ? ` — ${e.target}` : ''}`).join('\n')
    : ''), [logs]);
  const copyLogs = (): void => {
    void navigator.clipboard?.writeText(logText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  const trusted = server.trust === 'trusted';

  return (
    <div className="mcpm-detail">
      <dl className="mcpm-facts">
        <dt>{t('detail.target')}</dt>
        <dd className="mcpm-mono">{server.target || '—'}</dd>
        <dt>{t('detail.source')}</dt>
        <dd className="mcpm-mono">{server.source}</dd>
        <dt>{t('detail.transport')}</dt>
        <dd>{server.transport}</dd>
        <dt>{t('detail.auth')}</dt>
        <dd>{auth}</dd>
        {server.serverInfo ? (
          <>
            <dt>{t('detail.server')}</dt>
            <dd>{`${server.serverInfo.name} ${server.serverInfo.version}`.trim()} · MCP {server.serverInfo.protocolVersion}</dd>
          </>
        ) : null}
      </dl>
      {server.description ? <div className="mcpm-hint">{server.description}</div> : null}
      {server.error ? <div className="mcpm-hint" data-tone="error">{server.error}</div> : null}
      {server.warnings.map((warning) => <div key={warning} className="mcpm-hint" data-tone="warning">{warning}</div>)}

      {server.tools.length > 0 ? (
        <>
          <div className="mcpm-section-title">{t('detail.tools', { count: server.toolCount })}</div>
          <div className="mcpm-tools">
            {tools.map((tool) => (
              <span
                key={tool.name}
                className="mcpm-tool"
                data-readonly={tool.readOnly ? 'true' : undefined}
                title={`${tool.publicName}${tool.readOnly ? ` (${t('detail.readOnly')})` : ''}${tool.description ? `\n\n${tool.description}` : ''}`}
              >
                {tool.name}
              </span>
            ))}
            {server.tools.length > TOOL_PREVIEW ? (
              <button type="button" className="mcpm-linkbtn" onClick={() => setAllTools((v) => !v)}>
                {allTools ? t('detail.lessTools') : t('detail.moreTools', { count: server.tools.length - TOOL_PREVIEW })}
              </button>
            ) : null}
          </div>
        </>
      ) : server.status === 'connected' ? <div className="mcpm-hint">{t('detail.noTools')}</div> : null}

      <div className="mcpm-actions">
        {trusted && server.status !== 'connecting' && server.status !== 'needs-auth' ? (
          <button type="button" className="mcpm-btn" disabled={pending !== null} onClick={() => void onAct('reconnect')}>{t('row.reconnect')}</button>
        ) : null}
        {server.auth.canSignIn && server.status !== 'needs-auth' ? (
          <button type="button" className="mcpm-btn" disabled={pending !== null} onClick={() => void onAct('sign-in')}>{t('row.signIn')}</button>
        ) : null}
        {server.auth.signedIn ? (
          <button type="button" className="mcpm-btn" data-variant="danger" disabled={pending !== null} onClick={() => void onAct('sign-out')}>{t('row.signOut')}</button>
        ) : null}
        <button type="button" className="mcpm-btn" disabled={pending === 'logs'} onClick={() => (logs ? onHideLogs() : void onAct('logs'))}>
          {logs ? t('row.hideLogs') : t('row.logs')}
        </button>
        {logs && logs.length > 0 ? (
          <button type="button" className="mcpm-btn" onClick={copyLogs}>{copied ? t('row.copied') : t('row.copy')}</button>
        ) : null}
        {server.scope === 'project' && trusted ? (
          <button type="button" className="mcpm-btn" data-variant="danger" disabled={pending !== null} onClick={() => void onAct('untrust')}>{t('row.untrust')}</button>
        ) : null}
      </div>
      {logs ? <pre className="mcpm-logs">{logText || t('row.noLogs')}</pre> : null}
    </div>
  );
}
