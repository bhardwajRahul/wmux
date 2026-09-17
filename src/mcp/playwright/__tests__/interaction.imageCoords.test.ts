import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';

const { mockSendRpc, getPage, resolveWorkspaceBackend } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      resolveWorkspaceBackend,
      drainLocalLifecycle: () => [],
    }),
  },
}));

import { registerInteractionTools } from '../tools/interaction';
import { browserScopeKey } from '../snapshot';
import { clearScreenshotScaleState, rememberScreenshotScale } from '../screenshotRefs';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps);
  return tools;
}

const click = collectTools().get('browser_click');
if (!click) throw new Error('browser_click failed to register');

const clicks: { x: number; y: number }[] = [];

function makePage(): Page {
  return {
    url: () => 'about:blank',
    viewportSize: () => ({ width: 400, height: 800 }),
    mouse: {
      click: async (x: number, y: number) => {
        clicks.push({ x, y });
      },
      move: async () => undefined,
    },
    on: () => undefined,
    off: () => undefined,
  } as unknown as Page;
}

/** The scope key browser_click looks the scale up under. */
const scopeKey = browserScopeKey({ workspaceId: 'ws-test', surfaceId: undefined } as never);

beforeEach(() => {
  clicks.length = 0;
  clearScreenshotScaleState();
  mockSendRpc.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('chrome');
  getPage.mockReset();
  getPage.mockResolvedValue(makePage());
});

function rememberScale(scale: number): void {
  rememberScreenshotScale(scopeKey, {
    imageWidth: 400 * scale,
    imageHeight: 800 * scale,
    viewportWidth: 400,
    viewportHeight: 800,
    scale,
  });
}

describe('browser_click imageX/imageY (#1358)', () => {
  it('divides image pixels by the last screenshot scale', async () => {
    rememberScale(2.25);

    const result = await click({ imageX: 450, imageY: 900 });

    expect(result.isError).toBeFalsy();
    expect(clicks).toEqual([{ x: 200, y: 400 }]);
    expect(result.content[0].text).toContain('viewport CSS px (200, 400)');
    expect(result.content[0].text).toContain('image px (450, 900) / scale 2.25');
  });

  it('clicks image pixels unchanged when the capture was 1:1', async () => {
    rememberScale(1);

    await click({ imageX: 120, imageY: 240 });

    expect(clicks).toEqual([{ x: 120, y: 240 }]);
  });

  it('says clearly that no scale is known rather than clicking raw pixels', async () => {
    const result = await click({ imageX: 450, imageY: 900 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No screenshot scale is known for this surface');
    expect(clicks).toEqual([]);
  });

  it('refuses image pixels mixed with a ref or with viewport coordinates', async () => {
    rememberScale(2);

    for (const args of [{ imageX: 10, imageY: 10, ref: '3' }, { imageX: 10, imageY: 10, x: 5, y: 5 }]) {
      const result = await click(args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Pass imageX/imageY alone');
    }
    expect(clicks).toEqual([]);
  });

  it('needs both halves of an image coordinate', async () => {
    rememberScale(2);

    const result = await click({ imageX: 10 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('both imageX and imageY');
  });
});
