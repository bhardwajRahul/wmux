/**
 * Ordering gate for bytes we write to the PTY ourselves while an IME
 * composition is being committed (#1361).
 *
 * The bug it exists for: with the Korean IME, typing `대한민국` and pressing
 * Ctrl+Enter put the newline BEFORE the last syllable — `대한민⏎국`. Korean has
 * no candidate window, so the last syllable of whatever was just typed is
 * *always* still under composition when the newline key arrives.
 *
 * Two pieces of timing produce the inversion:
 *
 *   1. A key the IME does not consume (Ctrl+Enter) makes Chromium end the
 *      composition first. xterm's `CompositionHelper._finalizeComposition(true)`
 *      then DEFERS the actual send:
 *
 *        this._isSendingComposition = true;
 *        setTimeout(() => ... this._coreService.triggerDataEvent(s, true), 0);
 *
 *   2. The `keydown` for Ctrl+Enter follows immediately, now with
 *      `isComposing === false`, so the newline resolver accepts it and the
 *      custom key handler writes to the PTY SYNCHRONOUSLY and returns false.
 *      Returning false skips `CompositionHelper.keydown()`, which is the one
 *      method that would have flushed the pending composition synchronously.
 *
 * So the PTY receives `\n` now and `국` one macrotask later.
 *
 * The fix is ordering, not flushing: while a commit is in flight, the byte is
 * queued onto a macrotask of our own. Timer callbacks run FIFO, and xterm's
 * timer was armed first (at `compositionend`, before the keydown), so the
 * syllable goes out first and the newline follows it. Nothing is flushed by
 * force and xterm's composition state is never touched — an upstream fix would
 * simply make the window never open.
 *
 * Why a time window rather than a flag cleared on our own macrotask: the flag
 * would only be correct if our `compositionend` listener were guaranteed to run
 * AFTER xterm's, which depends on listener registration order. A short window
 * measured from `compositionend` is order-independent, and the only cost when
 * it fires spuriously is that the byte leaves one macrotask (sub-millisecond)
 * later, in the same order.
 *
 * With no IME active there is no `compositionend` at all, so `runAfterCommit`
 * runs its callback synchronously — Ctrl+Enter keeps its current, immediate
 * behavior for everyone else.
 */

/**
 * How long after `compositionend` a commit still counts as in flight. xterm's
 * send is a `setTimeout(…, 0)` armed at `compositionend`, so the real window is
 * a single macrotask; this is deliberately an order of magnitude wider than
 * that so a busy frame (an agent streaming into the pane between the two
 * events) cannot close it early.
 */
export const COMPOSITION_COMMIT_WINDOW_MS = 50;

/**
 * How long a byte waits for a `compositionend` that never arrives. Only
 * reachable when a caller defers while a preedit is genuinely open; without
 * the fallback a composition abandoned by focus loss would strand the byte.
 */
export const COMPOSITION_COMMIT_FALLBACK_MS = 200;

export interface CompositionCommitGateTextarea {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface CompositionCommitGateTerminal {
  textarea: CompositionCommitGateTextarea | undefined;
}

export interface CompositionCommitGateOptions {
  /** Override the post-`compositionend` window (tests). */
  windowMs?: number;
  /** Override the no-`compositionend` fallback delay (tests). */
  fallbackMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable macrotask scheduler (tests). Defaults to setTimeout. */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  /** Cancels a handle returned by `schedule`. Defaults to clearTimeout. */
  cancel?: (handle: unknown) => void;
}

export interface CompositionCommitGate {
  /** True while an IME commit could still be in flight. */
  isCommitPending(): boolean;
  /**
   * Run `fn` once any in-flight IME commit has reached the PTY. Runs
   * synchronously when no commit is pending, which is every keystroke with no
   * IME in the picture.
   */
  runAfterCommit(fn: () => void): void;
  dispose(): void;
}

/** A gate that never defers — used when the terminal has no textarea. */
function passthroughGate(): CompositionCommitGate {
  return {
    isCommitPending: () => false,
    runAfterCommit: (fn) => fn(),
    dispose: () => undefined,
  };
}

export function attachCompositionCommitGate(
  terminal: CompositionCommitGateTerminal,
  options: CompositionCommitGateOptions = {},
): CompositionCommitGate {
  const textarea = terminal.textarea;
  if (!textarea) return passthroughGate();

  const windowMs = options.windowMs ?? COMPOSITION_COMMIT_WINDOW_MS;
  const fallbackMs = options.fallbackMs ?? COMPOSITION_COMMIT_FALLBACK_MS;
  const now = options.now ?? ((): number => Date.now());
  const schedule = options.schedule
    ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const cancel = options.cancel
    ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let composing = false;
  let lastEndAt = -Infinity;
  // Bytes waiting for a composition that is still OPEN. The reported path
  // never lands here (Chromium ends the composition before delivering the
  // key), but a caller that defers on `isComposing` / keyCode 229 does.
  let queued: Array<() => void> = [];
  let fallbackHandle: unknown = null;
  const pending = new Set<unknown>();
  let disposed = false;

  const flushQueue = (): void => {
    if (fallbackHandle !== null) {
      cancel(fallbackHandle);
      fallbackHandle = null;
    }
    const due = queued;
    queued = [];
    for (const fn of due) fn();
  };

  const deferOne = (fn: () => void): void => {
    let handle: unknown = null;
    handle = schedule(() => {
      pending.delete(handle);
      fn();
    }, 0);
    pending.add(handle);
  };

  const onCompositionActive = (): void => {
    composing = true;
  };

  const onCompositionEnd = (): void => {
    composing = false;
    lastEndAt = now();
    if (queued.length > 0) {
      // Two macrotasks, not one: xterm arms its own 0ms send from a listener
      // on this same event, and which of the two listeners runs first depends
      // on registration order. One hop only wins the race if xterm's listener
      // ran first; a second hop lands after any timer armed during this
      // dispatch, whichever order that was.
      deferOne(() => deferOne(flushQueue));
    }
  };

  textarea.addEventListener('compositionstart', onCompositionActive);
  textarea.addEventListener('compositionupdate', onCompositionActive);
  textarea.addEventListener('compositionend', onCompositionEnd);

  return {
    isCommitPending(): boolean {
      return composing || now() - lastEndAt < windowMs;
    },
    runAfterCommit(fn: () => void): void {
      if (disposed) return;
      if (composing) {
        queued.push(fn);
        if (fallbackHandle === null) {
          fallbackHandle = schedule(() => {
            fallbackHandle = null;
            flushQueue();
          }, fallbackMs);
        }
        return;
      }
      if (now() - lastEndAt < windowMs) {
        deferOne(fn);
        return;
      }
      fn();
    },
    dispose(): void {
      disposed = true;
      textarea.removeEventListener('compositionstart', onCompositionActive);
      textarea.removeEventListener('compositionupdate', onCompositionActive);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      // Anything still waiting belongs to a pane that is going away; dropping
      // it is the only safe option, since its pty is about to be gone.
      if (fallbackHandle !== null) {
        cancel(fallbackHandle);
        fallbackHandle = null;
      }
      for (const handle of pending) cancel(handle);
      pending.clear();
      queued = [];
    },
  };
}
