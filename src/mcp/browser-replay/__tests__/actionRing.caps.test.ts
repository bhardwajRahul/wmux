import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../playwright/snapshot', () => ({
  getRefEntry: () => undefined,
  listRefEntries: () => [],
  browserScopeKey: (scope: { workspaceId: string; surfaceId?: string }) =>
    `${scope.workspaceId}:${scope.surfaceId ?? ''}`,
}));

import { ActionRing } from '../actionRing';
import {
  ACTION_RING_CAPACITY,
  ACTION_RING_MAX_BYTES,
} from '../../../shared/browserReplay/actionTrace';

// #1360: the ring held 40 actions, so a browser_repl session of 125 calls had
// already lost its start by the time the agent knew the flow had worked. The
// count is now 200 — which is no longer a memory bound on its own, hence the
// byte ceiling beside it.

const SCOPE_KEY = 'ws-1:s1';

let ring: ActionRing;

beforeEach(() => {
  ring = new ActionRing();
});

function entry(tag: number, padding = '') {
  return {
    step: {
      tool: 'browser_click' as const,
      axis: { kind: 'none' as const },
      args: { tag, ...(padding && { text: padding }) },
    },
    urlKey: 'u',
    scopeKey: SCOPE_KEY,
    surfaceShape: '',
    at: tag,
  };
}

describe('ActionRing capacity (#1360)', () => {
  it('holds enough of a long repl session to be worth saving', () => {
    expect(ACTION_RING_CAPACITY).toBeGreaterThanOrEqual(125);
  });

  it('keeps a 125-step session whole', () => {
    for (let i = 0; i < 125; i++) ring.push(entry(i));

    const all = ring.all();
    expect(all).toHaveLength(125);
    expect(all[0].step.args.tag).toBe(0);
  });

  it('still drops the oldest past the count', () => {
    for (let i = 0; i < ACTION_RING_CAPACITY + 5; i++) ring.push(entry(i));

    const all = ring.all();
    expect(all).toHaveLength(ACTION_RING_CAPACITY);
    expect(all[0].step.args.tag).toBe(5);
  });
});

describe('ActionRing byte ceiling (#1360)', () => {
  it('drops the oldest once the bytes exceed the ceiling, before the count does', () => {
    // ~8 KiB per step: 200 of them would be 1.6 MiB, well past the ceiling.
    const fat = 'x'.repeat(8 * 1024);
    for (let i = 0; i < ACTION_RING_CAPACITY; i++) ring.push(entry(i, fat));

    const all = ring.all();
    expect(all.length).toBeLessThan(ACTION_RING_CAPACITY);
    // Oldest-first eviction: the tail is what a save cuts from, so it is the
    // front that has to go.
    expect(all[all.length - 1].step.args.tag).toBe(ACTION_RING_CAPACITY - 1);
    const held = all.reduce((sum, a) => sum + JSON.stringify(a).length, 0);
    expect(held).toBeLessThanOrEqual(ACTION_RING_MAX_BYTES);
  });

  it('never empties itself for one oversized step', () => {
    // A single step larger than the whole ceiling must still be recorded —
    // dropping it would lose the action the ring exists to observe.
    ring.push(entry(1, 'x'.repeat(ACTION_RING_MAX_BYTES * 2)));

    expect(ring.all()).toHaveLength(1);
  });

  it('clear() resets the byte accounting too', () => {
    const fat = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 40; i++) ring.push(entry(i, fat));
    ring.clear();

    for (let i = 0; i < 10; i++) ring.push(entry(i));
    expect(ring.all()).toHaveLength(10);
  });
});
