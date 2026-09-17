import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import type { RemoteHostPublic } from '../../../shared/remoteHosts';

export interface AddRemotePaneModalProps {
  onClose: () => void;
  /** Resolves once a session exists on the chosen host — the caller adds the
   *  surface to its own pane; this component only picks the host and mints
   *  the remote session.
   *
   *  #1329 — `workspaceId` is the id this modal minted for that session on the
   *  host. It used to stay private here ("opaque bookkeeping, never referenced
   *  again"), which is precisely why the pane it produced had no way to ask
   *  the host about its own agent: `/api/workspaces` is keyed by this id. */
  onCreated: (hostId: string, sessionId: string, workspaceId: string) => void;
  /** Heading shown above the host list. The modal serves three menu entries
   *  since #1140 (tab, split right, split down), and the heading is the only
   *  place the dialog can say which one it is answering — omitted falls back
   *  to the tab flow's "New remote pane". */
  title?: string;
}

/**
 * #1086/#1091 — "Add remote pane": pick one of the already-paired hosts
 * (same list `AttachRemoteModal` shows) and bootstrap a fresh session on it
 * via `remote.workspaceCreate` (#1001's operator-mint path). The `workspaceId`
 * that call requires is minted here purely to satisfy the bootstrap contract —
 * this feature does not create a remote "workspace" the user ever sees.
 *
 * #1329 — it IS handed back to the caller, though. The remote daemon groups its
 * sessions into `/api/workspaces` rows by exactly this id, and that listing is
 * the only channel carrying the session's agent name/status to this desktop.
 * Dropping the id (the original behaviour) left every pane this modal created
 * permanently agent-less in the sidebar roster and in `pane_list` (#1322).
 */
export default function AddRemotePaneModal({ onClose, onCreated, title }: AddRemotePaneModalProps) {
  const t = useT();
  const [hosts, setHosts] = useState<RemoteHostPublic[] | null>(null);
  const [creatingHostId, setCreatingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  // Escape closes, same listener AttachRemoteModal binds — until #1140 the
  // backdrop click was the only way out of this dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.remote?.hostsList().then((list) => {
      if (!cancelled) setHosts(list);
    });
    return () => { cancelled = true; };
  }, []);

  const pick = async (hostId: string): Promise<void> => {
    setError(undefined);
    const remote = window.electronAPI?.remote;
    // #1100, CodeRabbit round 1 — the guard must run BEFORE the spinner
    // latches: a missing bridge with no reset would leave every host button
    // disabled forever (setCreatingHostId(null) was only reachable after
    // this line). The `await` below gets the same protection via try/catch —
    // a rejected IPC call (as opposed to an { ok: false } response, already
    // handled) is the second way to strand the same spinner, and the caller
    // (`onClick={() => void pick(h.id)}`) attaches no handler of its own, so
    // an uncaught rejection here would surface as a genuine unhandled
    // promise rejection, not just leave the spinner stuck.
    if (!remote) return;
    setCreatingHostId(hostId);
    const freshId = `remote-pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await remote.workspaceCreate(hostId, freshId);
      if (res.ok) {
        onCreated(hostId, res.sessionId, freshId);
        onClose();
      } else {
        setError(res.error);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingHostId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onMouseDown={onClose}
    >
      <div
        className="w-[360px] max-h-[70vh] overflow-y-auto rounded-[7px] p-3"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-soft)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-main)' }}>
          {title ?? t('pane.newRemote')}
        </div>
        {error && (
          <div className="text-xs mb-2" style={{ color: 'var(--accent-red)' }}>{error}</div>
        )}
        {hosts === null ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>…</div>
        ) : hosts.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('remote.noHostsHint')}</div>
        ) : (
          <div className="flex flex-col gap-1">
            {hosts.map((h) => (
              <button
                key={h.id}
                type="button"
                disabled={creatingHostId !== null}
                className="text-left px-2 py-1.5 rounded text-xs font-mono truncate hover:bg-[rgba(var(--bg-surface-rgb),0.6)] disabled:opacity-50"
                style={{ color: 'var(--text-main)' }}
                onClick={() => void pick(h.id)}
              >
                {h.label || h.origin} {creatingHostId === h.id ? '…' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
