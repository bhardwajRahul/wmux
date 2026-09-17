import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1357: the Playwright lane's `device: null` used to clear the UA emulation and
// tell the caller to run browser_resize, leaving the page at the preset's
// viewport, so its media queries and touch checks kept matching the phone.

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    typeof method === 'string'
    && (method.startsWith('browser.lease.')
      || method === 'browser.lifecycle.get'
      || method === 'browser.cdp.info'
      || method === 'browser.tabs'
      || method === 'browser.surface.adopt'
      || method === 'browser.open')
      ? Promise.resolve({ token: null, targets: [], ok: false })
      : mockSendRpc(method, ...args),
}));

const getPage = vi.fn();
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

const applyUserAgentEmulation = vi.fn(async () => true);
const clearUserAgentEmulation = vi.fn(async () => undefined);
let uaEmulated = false;
vi.mock('../ua-emulation', () => ({
  applyUserAgentEmulation: (...a: unknown[]) => applyUserAgentEmulation(...(a as [])),
  clearUserAgentEmulation: (...a: unknown[]) => clearUserAgentEmulation(...(a as [])),
  hasUserAgentEmulation: () => uaEmulated,
}));

const evaluateIsolated = vi.fn();
vi.mock('../isolated-eval', () => ({
  evaluateIsolated: (...a: unknown[]) => evaluateIsolated(...(a as [])),
}));

import { registerStateTools } from '../tools/state';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerStateTools(server as never, browserToolDeps);
  return tools;
}

const emulate = collectTools().get('browser_emulate')!;

let viewport: { width: number; height: number } | null;
const setViewportSize = vi.fn(async (size: { width: number; height: number }): Promise<void> => {
  viewport = { ...size };
});
const reload = vi.fn(async () => undefined);
const setExtraHTTPHeaders = vi.fn(async () => undefined);

function fakePage(): unknown {
  const context = {
    setOffline: vi.fn(async () => undefined),
    setExtraHTTPHeaders,
    setHTTPCredentials: vi.fn(async () => undefined),
    setGeolocation: vi.fn(async () => undefined),
    grantPermissions: vi.fn(async () => undefined),
    newCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({})), detach: vi.fn(async () => undefined) })),
  };
  return {
    context: () => context,
    viewportSize: () => viewport,
    setViewportSize,
    reload,
    emulateMedia: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  __resetSurfaceRoutingForTesting();
  mockSendRpc.mockReset();
  getPage.mockReset();
  setViewportSize.mockClear();
  reload.mockClear();
  applyUserAgentEmulation.mockClear();
  clearUserAgentEmulation.mockClear();
  evaluateIsolated.mockReset();
  uaEmulated = false;
  viewport = { width: 1280, height: 720 };
  // One page object per test: the pre-preset viewport is remembered per page,
  // so a fresh object on every call would never find its own entry.
  const page = fakePage();
  getPage.mockImplementation(async () => page);
  evaluateIsolated.mockImplementation(async () => ({
    w: viewport?.width ?? 0,
    h: viewport?.height ?? 0,
    dpr: 1,
    touch: 0,
  }));
});

describe('browser_emulate device reset (Playwright lane)', () => {
  it('restores the pre-preset viewport and reloads', async () => {
    await emulate({ device: 'iPhone 13' });
    uaEmulated = true;
    expect(viewport).not.toEqual({ width: 1280, height: 720 });

    const res = await emulate({ device: null });

    expect(clearUserAgentEmulation).toHaveBeenCalled();
    expect(viewport).toEqual({ width: 1280, height: 720 });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toContain('device=reset (viewport 1280x720 restored, reloaded)');
    expect(res.content[0].text).not.toContain('use browser_resize to set viewport');
  });

  it('appends the page probe after apply and after reset', async () => {
    const applied = await emulate({ device: 'iPhone 13' });
    expect(applied.content[0].text).toMatch(/probe=\d+x\d+ dpr=1 maxTouchPoints=0/);
    expect(applied.content[0].text).toContain(`probe=${viewport!.width}x${viewport!.height}`);

    uaEmulated = true;
    const reset = await emulate({ device: null });
    expect(reset.content[0].text).toContain('probe=1280x720 dpr=1 maxTouchPoints=0');
  });

  it('keeps the first preset viewport across a chain of presets', async () => {
    await emulate({ device: 'iPhone 13' });
    await emulate({ device: 'Pixel 5' });
    uaEmulated = true;

    const res = await emulate({ device: null });

    expect(viewport).toEqual({ width: 1280, height: 720 });
    expect(res.content[0].text).toContain('viewport 1280x720 restored');
  });

  it('says so when no pre-preset viewport was recorded', async () => {
    uaEmulated = true;
    viewport = { width: 390, height: 844 };

    const res = await emulate({ device: null });

    expect(res.content[0].text).toContain(
      'device=reset (viewport 390x844 kept (no pre-preset viewport recorded), reloaded)',
    );
  });

  it('does not fail the reset when the probe cannot be read', async () => {
    await emulate({ device: 'iPhone 13' });
    uaEmulated = true;
    evaluateIsolated.mockRejectedValue(new Error('no execution context'));

    const res = await emulate({ device: null });

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('viewport 1280x720 restored');
    expect(res.content[0].text).not.toContain('probe=');
  });
});

