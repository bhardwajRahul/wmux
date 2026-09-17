/**
 * Protocol-aware Escape encoding for the terminal input path.
 *
 * xterm.js emits a bare ESC (`\x1b`) for the Escape key. That is correct
 * until the pane has negotiated an extended keyboard protocol: kitty CSI-u
 * wants `CSI 27 u`. Sending the bare byte into a protocol the app asked for
 * leaves the app waiting for the rest of a CSI sequence — Escape then appears
 * to do nothing for the rest of the turn (#1152 follow-up).
 *
 * The local pane writes this byte itself and bypasses xterm, the same way
 * newlineKeys does for Shift+Enter. That also covers the IME keyCode-229
 * drop: xterm's CompositionHelper swallows every 229 keydown, so a CJK IME
 * (or a TSF desync during a streaming TUI) would otherwise eat Escape.
 */
import type { KeyboardProtocolHint } from './newlineKeys';

/** Kitty CSI-u Escape. Functional key 27; modifier 1 is the default and omitted. */
export const ESCAPE_CSI_U = '\x1b[27u';

export const BARE_ESC = '\x1b';

/**
 * Encode Escape for the protocol the pane actually asked for.
 *
 * win32-input-mode gets the bare byte, not a KEY_EVENT_RECORD pair. Measured
 * 2026-09-17 against a live Claude Code pane on Windows: writing the bare ESC,
 * the record pair, or the key-down record alone all interrupt the running turn
 * identically — ConPTY converts the record back into a bare ESC for the client
 * either way — so the pair buys nothing and is the only thing Escape gained in
 * 3.56.0, where Escape was reported dead (#1373). The bare byte is exactly what
 * 3.55.0 sent. modifyOtherKeys does not re-encode unmodified Escape either, so
 * only a kitty push changes the bytes.
 */
export function encodeEscape(protocol: KeyboardProtocolHint | undefined): string {
  if (protocol?.kitty) return ESCAPE_CSI_U;
  return BARE_ESC;
}

export interface EscapeKeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * Whether this keydown is a bare Escape we should encode ourselves.
 *
 * `code` is the IME-safe match (key becomes 'Process' under a CJK IME).
 * `key === 'Escape'` covers the empty-code case. Modifiers and an open
 * IME preedit are left to the caller / IME — Escape then cancels the
 * candidate window instead of the foreground app.
 */
export function isBareEscape(e: EscapeKeyEventLike): boolean {
  if (e.isComposing || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  return e.code === 'Escape' || e.key === 'Escape';
}
