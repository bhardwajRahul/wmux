/**
 * Tests for the IME commit ordering gate (#1361).
 *
 * Regression target: with the Korean IME, `대한민국` + Ctrl+Enter reached the
 * PTY as `대한민` `\n` `국`. The last syllable is still under composition when
 * the newline key arrives; Chromium ends the composition first, xterm's
 * CompositionHelper sends the composed text from a `setTimeout(…, 0)`, and the
 * custom key handler's synchronous write overtook it.
 *
 * The fake below models exactly that: a textarea that emits the real event
 * sequence, and an xterm stand-in that sends the composed text on a 0ms timer
 * armed at `compositionend`. The assertion is byte order at the PTY.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attachCompositionCommitGate,
  COMPOSITION_COMMIT_WINDOW_MS,
  type CompositionCommitGateTextarea,
} from '../compositionCommitGate';

/** Minimal event target with the two methods the gate uses. */
function fakeTextarea(): CompositionCommitGateTextarea & { emit(type: string): void; listenerCount(): number } {
  const listeners = new Map<string, Array<(e: Event) => void>>();
  return {
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ type } as Event);
      }
    },
    listenerCount() {
      let n = 0;
      for (const list of listeners.values()) n += list.length;
      return n;
    },
  };
}

describe('attachCompositionCommitGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts the committed syllable before the newline (대한민국 + Ctrl+Enter)', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    // The user types 대한민 — committed as they go — and 국 is still composing.
    pty.push('대한민');
    textarea.emit('compositionstart');
    textarea.emit('compositionupdate');

    // Ctrl+Enter: Chromium ends the composition first. xterm's
    // CompositionHelper._finalizeComposition(true) defers the send by a
    // macrotask; model it by arming the same 0ms timer from the same event.
    textarea.emit('compositionend');
    setTimeout(() => pty.push('국'), 0);

    // The keydown follows in the same task, with isComposing already false.
    gate.runAfterCommit(() => pty.push('\n'));

    // Nothing has been written synchronously — that is the whole fix.
    expect(pty).toEqual(['대한민']);

    vi.runAllTimers();
    expect(pty).toEqual(['대한민', '국', '\n']);
    expect(pty.join('')).toBe('대한민국\n');

    gate.dispose();
  });

  it('writes synchronously when no IME is active (plain Ctrl+Enter)', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    gate.runAfterCommit(() => pty.push('\n'));

    expect(pty).toEqual(['\n']);
    expect(gate.isCommitPending()).toBe(false);
    gate.dispose();
  });

  it('writes synchronously again once the commit window has passed', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    let clock = 1000;
    const gate = attachCompositionCommitGate({ textarea }, { now: () => clock });

    textarea.emit('compositionstart');
    textarea.emit('compositionend');
    expect(gate.isCommitPending()).toBe(true);

    clock += COMPOSITION_COMMIT_WINDOW_MS;
    expect(gate.isCommitPending()).toBe(false);
    gate.runAfterCommit(() => pty.push('\n'));
    expect(pty).toEqual(['\n']);

    gate.dispose();
  });

  it('holds the byte until compositionend while a preedit is still open', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    textarea.emit('compositionstart');
    expect(gate.isCommitPending()).toBe(true);

    // A caller that defers on `isComposing` / keyCode 229 queues here.
    gate.runAfterCommit(() => pty.push('\n'));
    vi.advanceTimersByTime(1);
    expect(pty).toEqual([]);

    textarea.emit('compositionend');
    setTimeout(() => pty.push('국'), 0);
    vi.runAllTimers();
    expect(pty).toEqual(['국', '\n']);

    gate.dispose();
  });

  it('releases a byte on the fallback timer when compositionend never arrives', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea }, { fallbackMs: 200 });

    textarea.emit('compositionstart');
    gate.runAfterCommit(() => pty.push('\n'));
    vi.advanceTimersByTime(199);
    expect(pty).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pty).toEqual(['\n']);

    gate.dispose();
  });

  it('preserves the order of two deferred bytes', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    textarea.emit('compositionstart');
    textarea.emit('compositionend');
    setTimeout(() => pty.push('국'), 0);
    gate.runAfterCommit(() => pty.push('\n'));
    gate.runAfterCommit(() => pty.push('\x1b'));

    vi.runAllTimers();
    expect(pty).toEqual(['국', '\n', '\x1b']);

    gate.dispose();
  });

  it('drops queued bytes and detaches on dispose', () => {
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    textarea.emit('compositionstart');
    gate.runAfterCommit(() => pty.push('\n'));
    gate.dispose();

    vi.runAllTimers();
    expect(pty).toEqual([]);
    expect(textarea.listenerCount()).toBe(0);
    // A post-dispose call is a no-op rather than a write into a dead pty.
    gate.runAfterCommit(() => pty.push('x'));
    expect(pty).toEqual([]);
  });

  it('never defers when the terminal has no textarea', () => {
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea: undefined });
    gate.runAfterCommit(() => pty.push('\n'));
    expect(pty).toEqual(['\n']);
    expect(gate.isCommitPending()).toBe(false);
    gate.dispose();
  });
});

/**
 * The full keydown sequence as the custom key handler sees it, including the
 * keyCode-229 keydown that carries the composing syllable. This is the test
 * that models the issue's repro end to end: resolver + gate + PTY.
 */
describe('newline keydown with a pending composition (#1361)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delivers 국 before the LF for Ctrl+Enter', async () => {
    const { resolveNewlineKeyByte } = await import('../newlineKeys');
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    // `국` is typed: the IME claims the keydown (keyCode 229) and opens a
    // composition. The handler sees isComposing and the resolver declines.
    const composingKey = {
      key: 'Process', code: 'KeyR', ctrlKey: false, shiftKey: false,
      altKey: false, metaKey: false, isComposing: true,
    };
    expect(resolveNewlineKeyByte(composingKey)).toBeNull();
    textarea.emit('compositionstart');
    textarea.emit('compositionupdate');

    // Ctrl+Enter. Chromium ends the composition first; xterm queues the send.
    textarea.emit('compositionend');
    setTimeout(() => pty.push('국'), 0);

    const newlineKey = {
      key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: false,
      altKey: false, metaKey: false, isComposing: false,
    };
    const byte = resolveNewlineKeyByte(newlineKey);
    expect(byte).toBe('\n');
    gate.runAfterCommit(() => pty.push(byte as string));

    vi.runAllTimers();
    expect(pty.join('')).toBe('국\n');

    gate.dispose();
  });

  it('delivers 국 before the LF for Shift+Enter on a local pane', async () => {
    const { resolveNewlineKeyByte } = await import('../newlineKeys');
    const textarea = fakeTextarea();
    const pty: string[] = [];
    const gate = attachCompositionCommitGate({ textarea });

    textarea.emit('compositionstart');
    textarea.emit('compositionend');
    setTimeout(() => pty.push('국'), 0);

    const byte = resolveNewlineKeyByte({
      key: 'Enter', code: 'Enter', ctrlKey: false, shiftKey: true,
      altKey: false, metaKey: false, isComposing: false,
    }, { shiftEnterFallback: 'lf' });
    expect(byte).toBe('\n');
    gate.runAfterCommit(() => pty.push(byte as string));

    vi.runAllTimers();
    expect(pty.join('')).toBe('국\n');

    gate.dispose();
  });
});
