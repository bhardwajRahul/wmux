import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A failure a main handler RETURNS is still a failure (#1328).
 *
 * `attemptRpc` rejects only when a handler THREW. A handler that returns
 * `{error: ...}` — the renderer bridge's answer for a surface whose webview is
 * not mounted, main's own refusals, and `browser.tabs`'s structured
 * `{ok:false, error:{code,message}}` — arrives as a perfectly successful
 * result. browser_navigate reported `Navigated to <url>` for one of those.
 *
 * These pin both halves of the contract at the funnel: what must throw, and
 * the success shapes that must NOT be rewritten.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { sendScopedBrowserRpc, type BrowserTargetScope } from '../browserScope';

// An explicit surfaceId, so nothing here routes or opens: the funnel's own
// behaviour is what is under test.
const SCOPE: BrowserTargetScope = Object.freeze({ workspaceId: 'ws-1', surfaceId: 'surf-1' });

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('a returned failure', () => {
  it('throws the bare-string convention the renderer bridge uses', async () => {
    mockSendRpc.mockResolvedValue({ error: 'browser: surface surf-1 not found or not a browser' });

    await expect(sendScopedBrowserRpc('browser.navigate', SCOPE, { url: 'https://a.test/' }))
      .rejects.toThrow('surface surf-1 not found');
  });

  it('throws the structured convention browser.tabs uses', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'BROWSER_TAB_CREATE_FAILED', message: 'pane cap reached' },
    });

    await expect(sendScopedBrowserRpc('browser.tabs', SCOPE, { action: 'list' }))
      .rejects.toThrow('BROWSER_TAB_CREATE_FAILED: pane cap reached');
  });
});

describe('a success', () => {
  /**
   * The rule this rests on: no browser method answers a top-level `error` on a
   * path that worked. Every success shape reachable through this funnel is
   * here, so a handler that ever starts returning one breaks THIS test rather
   * than a tool.
   */
  const successes: Array<[string, unknown]> = [
    ['browser.navigate', { ok: true, url: 'https://a.test/' }],
    ['browser.goBack: refused, but with a reason not an error', { ok: false, reason: 'no history entry' }],
    ['browser.evaluate', { value: 'https://a.test/' }],
    ['browser.evaluate: a page value that is itself an error object', { value: { error: 'thrown in page' } }],
    ['browser.screenshot', { data: 'iVBORw0KGgo=' }],
    ['browser.console.get', { entries: [], since: 0, missedBefore: 0 }],
    ['browser.responseBody.get', { body: null }],
    ['browser.lifecycle.get', { entries: [] }],
    ['browser.lease.acquire: nothing to lease', { token: null }],
    ['browser.lease.release', { ok: false }],
    ['browser.actionCache.list', { traces: [] }],
    ['browser.actionCache.put: refused with a reason', { ok: false, reason: 'not promotable' }],
    ['browser.cookies', { cookies: [] }],
    ['browser.resize', { applied: ['width=800'] }],
    ['browser.siteGuides.match', { guides: [] }],
    ['browser.tabs list', { ok: true, action: 'list', tabs: [{ surfaceId: 'surf-1' }] }],
    ['a bare string answer', 'ok'],
    ['an array answer', [{ id: 'surf-1' }]],
    ['no answer at all', undefined],
  ];

  for (const [name, payload] of successes) {
    it(`passes ${name} through untouched`, async () => {
      mockSendRpc.mockResolvedValue(payload);
      await expect(sendScopedBrowserRpc('browser.evaluate', SCOPE)).resolves.toEqual(payload);
    });
  }

  it('does not rewrite an ok:true answer, whatever else it carries', async () => {
    // `ok: true` short-circuits: a handler that says it worked is believed.
    const payload = { ok: true, error: 'a diagnostic, not a failure' };
    mockSendRpc.mockResolvedValue(payload);

    await expect(sendScopedBrowserRpc('browser.evaluate', SCOPE)).resolves.toEqual(payload);
  });

  it('keeps a transport rejection as itself', async () => {
    mockSendRpc.mockRejectedValue(new Error('RPC timeout: browser.evaluate (10000ms)'));

    await expect(sendScopedBrowserRpc('browser.evaluate', SCOPE)).rejects.toThrow('RPC timeout');
  });
});
