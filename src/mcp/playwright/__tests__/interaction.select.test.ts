import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

const { resolveRef } = vi.hoisted(() => ({ resolveRef: vi.fn() }));
vi.mock('../snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snapshot')>()),
  resolveRef,
}));

import { registerInteractionTools } from '../tools/interaction';

// #1360: browser_select only drives native <select>. A custom dropdown got
// Playwright's "Element is not a <select> element" on one lane and a bare "ref
// not found" on the other — both of which send the caller back to re-snapshot a
// page that is fine. The error now names the two-click workaround.

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function selectTool(): ToolHandler {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps);
  const tool = tools.get('browser_select');
  if (!tool) throw new Error('browser_select failed to register');
  return tool;
}

const select = selectTool();

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ value: 'ok' });
  getPage.mockReset();
  getPage.mockResolvedValue(null);
  resolveRef.mockReset();
});

describe('browser_select on a custom dropdown (#1360)', () => {
  it('Playwright lane: rewrites "not a <select> element" into the workaround', async () => {
    getPage.mockResolvedValue({ url: () => 'https://x.test/app' });
    resolveRef.mockResolvedValue({
      selectOption: async () => {
        throw new Error('Element is not a <select> element');
      },
    });

    const result = await select({ ref: '7', values: ['a'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ref=7 is not a native <select>');
    expect(result.content[0].text).toContain('click the trigger then the option');
    // The old message sent the caller to re-snapshot a page that was fine.
    expect(result.content[0].text).not.toContain('Run browser_snapshot to get current refs');
  });

  it('Playwright lane: leaves an unrelated failure alone', async () => {
    getPage.mockResolvedValue({ url: () => 'https://x.test/app' });
    resolveRef.mockResolvedValue({
      selectOption: async () => {
        throw new Error('Timeout 30000ms exceeded');
      },
    });

    const result = await select({ ref: '7', values: ['a'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timeout 30000ms exceeded');
    expect(result.content[0].text).not.toContain('not a native <select>');
  });

  it('RPC lane: tells a custom dropdown apart from a ref that is gone', async () => {
    mockSendRpc.mockResolvedValue({ value: 'not_select' });

    const result = await select({ ref: '7', values: ['a'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a native <select>');
  });

  it('RPC lane: a genuinely missing ref still reports a missing ref', async () => {
    mockSendRpc.mockResolvedValue({ value: 'not_found' });

    const result = await select({ ref: '7', values: ['a'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(result.content[0].text).not.toContain('not a native <select>');
  });

  it('RPC lane: a real <select> still succeeds', async () => {
    mockSendRpc.mockResolvedValue({ value: 'ok' });

    const result = await select({ ref: '7', values: ['a', 'b'] });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Selected value(s) [a, b]');
  });
});
