// @vitest-environment jsdom
//
// Dynamic verification for useRemoteAttachmentsLifecycle. The restore replay,
// the exit-driven refetch and the safety-net poll all live INSIDE React
// effects, so — like useNotificationListener.activity.dynamic.test.tsx — the
// REAL hook is mounted against the REAL store with a mocked
// `window.electronAPI.remote`, and the assertions are made on the live store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRemoteAttachmentsLifecycle } from '../useRemoteAttachmentsLifecycle';
import { useStore } from '../../stores';
import { selectAttachedRemoteWorkspaces } from '../../stores/slices/remoteWorkspacesSlice';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { createRemoteSurface, createWorkspace } from '../../../shared/types';
import type { PaneLeaf } from '../../../shared/types';
import type { RemoteAttachmentDescriptor, RemoteWorkspaceSummary } from '../../../shared/remoteHosts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** The captured REMOTE_PANE_EXIT callback the hook registered at mount. */
let exitCb: (() => void) | undefined;
/** Unsubscribe spy for that callback — proves teardown. */
let exitUnsub: ReturnType<typeof vi.fn>;

interface RemoteApiStub {
  attachmentsList: ReturnType<typeof vi.fn>;
  attachmentsAdd: ReturnType<typeof vi.fn>;
  attachmentsRemove: ReturnType<typeof vi.fn>;
  workspacesList: ReturnType<typeof vi.fn>;
  onPaneExit: ReturnType<typeof vi.fn>;
  /** #1329 — only the surface-row reconcile reads it, and only for the roster's
   *  origin badge. Deliberately absent from the default stub: the hook must
   *  survive an older preload bundle that has no such route. */
  hostsList?: ReturnType<typeof vi.fn>;
}

let api: RemoteApiStub;

/** A promise the test resolves by hand — models a host that has not answered
 *  yet (an asleep laptop burns the full request timeout before it fails). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListResult = any;

function installElectronApi(opts: {
  descriptors?: RemoteAttachmentDescriptor[];
  workspaces?: RemoteWorkspaceSummary[];
  listFails?: boolean;
  /** Full control over the per-host answer, for the multi-host cases. */
  listImpl?: (hostId: string) => Promise<ListResult>;
  attachmentsListImpl?: () => Promise<RemoteAttachmentDescriptor[]>;
  /** #1329 — paired hosts, for the surface-row reconcile's label lookup. */
  hosts?: Array<{ id: string; label: string; origin: string }>;
} = {}): void {
  exitCb = undefined;
  exitUnsub = vi.fn();
  api = {
    attachmentsList: vi.fn(opts.attachmentsListImpl ?? (async () => opts.descriptors ?? [])),
    attachmentsAdd: vi.fn(async () => true),
    attachmentsRemove: vi.fn(async () => true),
    workspacesList: vi.fn(opts.listImpl ?? (async () =>
      opts.listFails
        ? { ok: false as const, error: 'could not reach that host' }
        : { ok: true as const, workspaces: opts.workspaces ?? [] })),
    onPaneExit: vi.fn((cb: () => void) => {
      exitCb = cb;
      return exitUnsub;
    }),
    ...(opts.hosts ? { hostsList: vi.fn(async () => opts.hosts) } : {}),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { remote: api };
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useRemoteAttachmentsLifecycle();
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
}

function unmount(): void {
  act(() => { root.unmount(); });
  container.remove();
}

/** Lets the hook's queued promise chain settle inside act(). */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const descriptor: RemoteAttachmentDescriptor = {
  key: 'h1:ws-1',
  hostId: 'h1',
  hostLabel: 'office-mac',
  workspaceId: 'ws-1',
  name: 'Remote WS',
};

function seedAttached(panes: Array<{ sessionId: string }>): void {
  act(() => {
    useStore.setState((s) => {
      s.remoteWorkspaces = [{ ...descriptor, panes }];
      s.activeRemoteKey = null;
    });
  });
}

/** Descriptor for a SECOND host — the parallelism and one-bad-host cases need
 *  two machines to have anything to say. */
const descriptor2: RemoteAttachmentDescriptor = {
  key: 'h2:ws-2',
  hostId: 'h2',
  hostLabel: 'shed-linux',
  workspaceId: 'ws-2',
  name: 'Other WS',
};

beforeEach(() => {
  act(() => {
    useStore.setState((s) => {
      s.remoteWorkspaces = [];
      s.activeRemoteKey = null;
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRemoteAttachmentsLifecycle — boot restore', () => {
  it('restores a persisted descriptor with FRESHLY fetched panes', async () => {
    installElectronApi({
      descriptors: [descriptor],
      workspaces: [{ id: 'ws-1', name: 'Renamed remotely', panes: [{ sessionId: 's1' }, { sessionId: 's2' }] }],
    });
    mount();
    await settle();

    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].panes.map((p) => p.sessionId)).toEqual(['s1', 's2']);
    expect(entries[0].name).toBe('Renamed remotely');
    expect(entries[0].stale).toBe(false);
    // A restore must not steal the user's current view.
    expect(useStore.getState().activeRemoteKey).toBeNull();
    unmount();
  });

  it('keeps the entry in a stale state when the host is unreachable', async () => {
    installElectronApi({ descriptors: [descriptor], listFails: true });
    mount();
    await settle();

    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].stale).toBe(true);
    expect(entries[0].panes).toEqual([]);
    unmount();
  });

  it('keeps the entry in a stale state when the workspace is gone from the host', async () => {
    installElectronApi({
      descriptors: [descriptor],
      workspaces: [{ id: 'other-ws', name: 'Other', panes: [{ sessionId: 'x' }] }],
    });
    mount();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(true);
    unmount();
  });

  it('makes no host request when nothing was persisted', async () => {
    installElectronApi({ descriptors: [] });
    mount();
    await settle();

    expect(api.workspacesList).not.toHaveBeenCalled();
    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    unmount();
  });
});

// Findings 1 and 4 — boot restore is not instantaneous: it waits on hosts that
// may take a full request timeout to fail, and the user is free to act on the
// same keys in the meantime.
describe('useRemoteAttachmentsLifecycle — boot restore races the user', () => {
  it('shows every row IMMEDIATELY, before any host has answered', async () => {
    const pendingHost = deferred<ListResult>();
    installElectronApi({ descriptors: [descriptor], listImpl: () => pendingHost.promise });
    mount();
    await settle();

    // The host is still hanging — the sidebar must not be empty for that long.
    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Remote WS');
    expect(entries[0].stale).toBe(true);
    expect(entries[0].panes).toEqual([]);

    pendingHost.resolve({ ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 's1' }] }] });
    await settle();
    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['s1']);
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(false);
    unmount();
  });

  it('queries hosts in PARALLEL, not one timeout after another', async () => {
    const pending = deferred<ListResult>();
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: () => pending.promise,
    });
    mount();
    await settle();

    // Sequentially, the second host would not be contacted until the first
    // one had answered — which it still has not.
    expect(api.workspacesList.mock.calls.map((c) => c[0]).sort()).toEqual(['h1', 'h2']);
    pending.resolve({ ok: true, workspaces: [] });
    await settle();
    unmount();
  });

  it('a manual attach during restore is NOT clobbered by the late restore', async () => {
    const pendingDescriptors = deferred<RemoteAttachmentDescriptor[]>();
    installElectronApi({
      attachmentsListImpl: () => pendingDescriptors.promise,
      workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'live' }] }],
    });
    mount();
    await settle();

    // The user attaches the very workspace the restore is about to replay.
    act(() => {
      useStore.getState().attachRemoteWorkspace({ ...descriptor, panes: [{ sessionId: 'live' }] });
    });

    pendingDescriptors.resolve([descriptor]);
    await settle();

    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].panes.map((p) => p.sessionId)).toEqual(['live']);
    // The live entry keeps the selection the attach gave it.
    expect(useStore.getState().activeRemoteKey).toBe('h1:ws-1');
    unmount();
  });

  it('a detach during restore is NOT resurrected as a ghost row', async () => {
    const pendingHost = deferred<ListResult>();
    installElectronApi({ descriptors: [descriptor], listImpl: () => pendingHost.promise });
    mount();
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);

    // The user detaches the restored row while the host is still hanging;
    // main drops the descriptor from disk with it.
    act(() => { useStore.getState().detachRemoteWorkspace('h1:ws-1'); });
    expect(useStore.getState().remoteWorkspaces).toHaveLength(0);

    pendingHost.resolve({ ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 's1' }] }] });
    await settle();

    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    unmount();
  });
});

// Finding 3 — /api/workspaces is another machine's answer. A body that does
// not match the declared shape must cost that host its round, nothing more.
describe('useRemoteAttachmentsLifecycle — malformed remote responses', () => {
  it('a non-array `workspaces` does not abort the round for other hosts', async () => {
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: async (hostId: string) => (hostId === 'h1'
        ? { ok: true, workspaces: 'not an array' }
        : { ok: true, workspaces: [{ id: 'ws-2', name: 'Other WS', panes: [{ sessionId: 'ok' }] }] }),
    });
    mount();
    await settle();

    const byKey = new Map(useStore.getState().remoteWorkspaces.map((w) => [w.key, w]));
    expect(byKey.get('h1:ws-1')?.stale).toBe(true);
    expect(byKey.get('h2:ws-2')?.stale).toBe(false);
    expect(byKey.get('h2:ws-2')?.panes.map((p) => p.sessionId)).toEqual(['ok']);
    unmount();
  });

  it('a workspace with a null pane list goes stale instead of throwing', async () => {
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: async (hostId: string) => (hostId === 'h1'
        ? { ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: null }] }
        : { ok: true, workspaces: [{ id: 'ws-2', name: 'Other WS', panes: [{ sessionId: 'ok' }] }] }),
    });
    mount();
    await settle();

    const byKey = new Map(useStore.getState().remoteWorkspaces.map((w) => [w.key, w]));
    expect(byKey.get('h1:ws-1')?.stale).toBe(true);
    expect(byKey.get('h2:ws-2')?.panes.map((p) => p.sessionId)).toEqual(['ok']);
    unmount();
  });

  it('an IPC rejection for one host leaves the other host restored', async () => {
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: async (hostId: string) => {
        if (hostId === 'h1') throw new Error('channel closed');
        return { ok: true, workspaces: [{ id: 'ws-2', name: 'Other WS', panes: [{ sessionId: 'ok' }] }] };
      },
    });
    mount();
    await settle();

    const byKey = new Map(useStore.getState().remoteWorkspaces.map((w) => [w.key, w]));
    expect(byKey.get('h1:ws-1')?.stale).toBe(true);
    expect(byKey.get('h2:ws-2')?.panes.map((p) => p.sessionId)).toEqual(['ok']);
    unmount();
  });
});

describe('useRemoteAttachmentsLifecycle — exit-driven refresh', () => {
  it('an exit event refetches and drops the pane that closed', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] });
    mount();
    seedAttached([{ sessionId: 'a' }, { sessionId: 'b' }]);
    expect(exitCb).toBeTruthy();

    act(() => { exitCb!(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['a']);
    unmount();
  });

  it('an exit BURST collapses into a single refetch', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [] }] });
    mount();
    seedAttached([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]);

    act(() => { exitCb!(); exitCb!(); exitCb!(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('unsubscribes the exit listener on unmount', () => {
    installElectronApi();
    mount();
    expect(exitUnsub).not.toHaveBeenCalled();
    unmount();
    expect(exitUnsub).toHaveBeenCalledTimes(1);
  });
});

describe('useRemoteAttachmentsLifecycle — safety-net poll', () => {
  // Asserting only "workspacesList was never called" would pass even with the
  // guard deleted — an empty remoteWorkspaces yields no hostIds, so a running
  // interval would still make no request. Count the TIMER instead.
  it('arms no interval at all while nothing is attached', async () => {
    vi.useFakeTimers();
    installElectronApi();
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(vi.getTimerCount()).toBe(0);
    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });

  it('polls once attached and picks up a pane OPENED on the remote', async () => {
    vi.useFakeTimers();
    installElectronApi({
      workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }, { sessionId: 'new' }] }],
    });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['a', 'new']);
    unmount();
  });

  it('clears the interval on detach and arms exactly one again on re-attach', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    act(() => { useStore.getState().detachRemoteWorkspace('h1:ws-1'); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    // Re-attaching must leave ONE interval, not stack a second one.
    seedAttached([{ sessionId: 'a' }]);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
  });

  it('a failed poll marks the entry stale without dropping it', async () => {
    vi.useFakeTimers();
    installElectronApi({ listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(true);
    unmount();
  });

  // Finding 6 — the SSE layer backs off and eventually gives up; the poll used
  // to retry a permanently dead host at full rate forever.
  it('backs a repeatedly failing host off instead of retrying every 10s', async () => {
    vi.useFakeTimers();
    installElectronApi({ listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    // 6 poll ticks. Without backoff that is 6 requests; with it, the delay
    // doubles from one poll interval after each consecutive failure.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const backedOff = api.workspacesList.mock.calls.length;
    expect(backedOff).toBeGreaterThan(0);
    expect(backedOff).toBeLessThan(6);
    unmount();
  });

  it('a host that answers again is polled at full rate immediately', async () => {
    vi.useFakeTimers();
    let healthy = false;
    installElectronApi({
      listImpl: async () => (healthy
        ? { ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] }
        : { ok: false, error: 'could not reach that host' }),
    });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(true);

    healthy = true;
    // Far enough past the first backoff step for the retry to land.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(false);

    // Backoff cleared: the next two ticks are both requests again.
    const afterRecovery = api.workspacesList.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.workspacesList.mock.calls.length).toBe(afterRecovery + 2);
    unmount();
  });
});

// ─── #1329 / #1322 ───────────────────────────────────────────────────────────
//
// A remote-terminal SURFACE ("Split right|down — remote", "New remote pane")
// is not an attachment: nothing ever put it in `remoteWorkspaces`, so the poll
// above never asked its host anything and its agent stayed invisible to both
// readers of that feed forever. These assert the whole chain end to end,
// against the REAL store: surface in a pane tree → ephemeral row → poll →
// agent metadata → a roster row (the sidebar half of #1322) and a hit on the
// lookup `pane.list`'s `agents:` builder performs (#1324's half).
describe('useRemoteAttachmentsLifecycle — remote-terminal surface rows (#1329)', () => {
  /** The local workspace a split-remote pane lives in. */
  function seedSurfaceWorkspace(opts: {
    hostId?: string;
    remoteWorkspaceId?: string;
    sessionId?: string;
  } = {}): string {
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    const surface = createRemoteSurface(
      opts.hostId ?? 'h1',
      opts.sessionId ?? 'sess-remote',
      'bash',
      '/root',
      true,
      opts.remoteWorkspaceId ?? 'remote-pane-1',
    );
    leaf.surfaces = [surface];
    leaf.activeSurfaceId = surface.id;
    act(() => {
      useStore.setState((s) => {
        s.workspaces = [ws];
        s.activeWorkspaceId = ws.id;
      });
    });
    return ws.id;
  }

  function clearWorkspaces(): void {
    act(() => { useStore.setState((s) => { s.workspaces = []; }); });
  }

  afterEach(() => { clearWorkspaces(); });

  it('gives the pane an INVISIBLE row and polls its host — the agent reaches the roster', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      listImpl: async () => ({
        ok: true as const,
        workspaces: [{
          id: 'remote-pane-1',
          name: '',
          panes: [{ sessionId: 'sess-remote', shell: 'bash', agentName: 'Claude', agentStatus: 'working' }],
        }],
      }),
    });
    const wsId = seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    // Invisible: a poll input, not a mirror the user asked for.
    expect(rows[0].ephemeral).toBe(true);
    expect(selectAttachedRemoteWorkspaces(useStore.getState())).toEqual([]);
    // Never persisted, so it can't come back on a later boot as a ghost.
    expect(api.attachmentsAdd).not.toHaveBeenCalled();
    // The host actually answered, and the label came from hostsList.
    expect(rows[0].stale).toBe(false);
    expect(rows[0].hostLabel).toBe('office-mac');

    // The sidebar half of #1322.
    const roster = selectWorkspaceAgentRoster(useStore.getState(), wsId);
    expect(roster.rows.map((r) => ({ agentName: r.agentName, status: r.status, host: r.remote?.hostLabel })))
      .toEqual([{ agentName: 'Claude', status: 'working', host: 'office-mac' }]);

    // …and the lookup pane.list's `agents:` builder performs (#1324).
    const found = useStore.getState().remoteWorkspaces.find(
      (r) => r.hostId === 'h1' && !r.stale && r.panes.some((p) => p.sessionId === 'sess-remote'),
    );
    expect(found?.panes.find((p) => p.sessionId === 'sess-remote')?.agentName).toBe('Claude');
    unmount();
  });

  it('reaps the row when the pane closes — no poller outlives its surface', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'sess-remote' }] }],
    });
    seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);

    // Whatever the close path (tab X, Ctrl+W, pane or workspace teardown), it
    // ends here: the surface is gone from state.workspaces.
    act(() => {
      useStore.setState((s) => {
        const leaf = s.workspaces[0].rootPane as PaneLeaf;
        leaf.surfaces = [];
        leaf.activeSurfaceId = '';
      });
    });
    await settle();

    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    unmount();
  });

  it('never demotes a mirror the user attached on the same key', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'sess-remote' }] }],
    });
    // The mint flows create a REAL workspace on the host, so AttachRemoteModal
    // lists it and the user can attach the very same hostId:workspaceId.
    act(() => {
      useStore.setState((s) => {
        s.remoteWorkspaces = [{
          key: 'h1:remote-pane-1',
          hostId: 'h1',
          hostLabel: 'office-mac',
          workspaceId: 'remote-pane-1',
          name: '',
          label: 'my alias',
          panes: [],
        }];
      });
    });
    seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    expect(rows[0].ephemeral).toBeUndefined();
    expect(rows[0].label).toBe('my alias');
    expect(selectAttachedRemoteWorkspaces(useStore.getState())).toHaveLength(1);

    // Closing the pane must NOT reap the user's attachment.
    act(() => {
      useStore.setState((s) => {
        const leaf = s.workspaces[0].rootPane as PaneLeaf;
        leaf.surfaces = [];
        leaf.activeSurfaceId = '';
      });
    });
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    unmount();
  });

  // The demotion path. Attaching the same host workspace from the sidebar
  // PROMOTES the ephemeral row; detaching it then removes the row outright,
  // while the pane is still open and its surfaces have not changed. A
  // reconcile keyed on the surfaces alone would sit still here and leave that
  // pane agent-less for the rest of the session — #1322, silently restored.
  it('re-mints the row if the user detaches an attachment out from under a live pane', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{
        id: 'remote-pane-1',
        name: '',
        panes: [{ sessionId: 'sess-remote', agentName: 'Claude' }],
      }],
    });
    const wsId = seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);

    // The user attaches the very same workspace as a sidebar mirror…
    act(() => {
      useStore.getState().attachRemoteWorkspace({
        key: 'h1:remote-pane-1',
        hostId: 'h1',
        hostLabel: 'office-mac',
        workspaceId: 'remote-pane-1',
        name: '',
        panes: [],
      });
    });
    expect(useStore.getState().remoteWorkspaces[0].ephemeral).toBeUndefined();

    // …then changes their mind. The pane never moved.
    act(() => { useStore.getState().detachRemoteWorkspace('h1:remote-pane-1'); });
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    expect(rows[0].ephemeral).toBe(true);
    expect(selectWorkspaceAgentRoster(useStore.getState(), wsId).rows).toHaveLength(1);
    unmount();
  });

  // collectRemoteSurfaceWorkspaces promises this explicitly: ownership decides
  // who may DESTROY a session, not who may watch one.
  it('feeds a surface that only VIEWS a session it does not own', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'ws-theirs', name: '', panes: [{ sessionId: 'theirs', agentName: 'Codex' }] }],
    });
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    // owned = false — somebody else's running work, merely mirrored here.
    leaf.surfaces = [createRemoteSurface('h1', 'theirs', 'bash', '/root', false, 'ws-theirs')];
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    act(() => { useStore.setState((s) => { s.workspaces = [ws]; s.activeWorkspaceId = ws.id; }); });

    mount();
    await settle();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    expect(leaf.surfaces[0].remoteOwned).toBeUndefined();
    expect(selectWorkspaceAgentRoster(useStore.getState(), ws.id).rows.map((r) => r.agentName))
      .toEqual(['Codex']);
    unmount();
  });

  it('two panes on one host share ONE row and one request per round', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'a' }, { sessionId: 'b' }] }],
    });
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    // Both panes point at the SAME minted workspace on the host.
    leaf.surfaces = [
      createRemoteSurface('h1', 'a', 'bash', '/root', true, 'remote-pane-1'),
      createRemoteSurface('h1', 'b', 'bash', '/root', true, 'remote-pane-1'),
    ];
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    act(() => { useStore.setState((s) => { s.workspaces = [ws]; s.activeWorkspaceId = ws.id; }); });

    mount();
    await settle();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    // One row, one hostId, so refresh() makes exactly one workspacesList call
    // per round — no duplicate poller.
    expect(api.workspacesList.mock.calls.every((c) => c[0] === 'h1')).toBe(true);
    unmount();
  });

  it('survives a preload bundle with no hostsList route — hostId is the fallback label', async () => {
    // No `hosts` option, so the stub genuinely has no hostsList (see
    // RemoteApiStub). The pane must still get its feed.
    installElectronApi({
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'sess-remote', agentName: 'Codex' }] }],
    });
    const wsId = seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    expect(rows[0].hostLabel).toBe('h1');
    expect(selectWorkspaceAgentRoster(useStore.getState(), wsId).rows).toHaveLength(1);
    unmount();
  });

  it('a surface from before #1329 (no remote workspace id) is skipped, not crashed on', async () => {
    installElectronApi({ workspaces: [] });
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    // createRemoteSurface without the trailing id — exactly what a session.json
    // written by an older build restores.
    leaf.surfaces = [createRemoteSurface('h1', 'legacy', 'bash', '/root', true)];
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    act(() => { useStore.setState((s) => { s.workspaces = [ws]; s.activeWorkspaceId = ws.id; }); });

    mount();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });
});
