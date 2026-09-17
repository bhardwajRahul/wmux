import { describe, expect, it, vi } from 'vitest';
import { formatBracketedPastePayload, submitBracketedPasteToPty } from '../ptyMessageDelivery';
import {
  DEFAULT_SUBMIT_DELAY_MS,
  PASTE_BURST_SUBMIT_DELAY_MS,
  submitProfileForAgent,
} from '../../../shared/ptyMessageDelivery';

describe('PTY message delivery', () => {
  it('wraps inter-agent messages in bracketed paste and neutralizes ESC bytes', () => {
    const payload = formatBracketedPastePayload('line 1\n\x1b[201~printf ESCAPED');

    expect(payload).toBe('\x1b[200~line 1\n␛[201~printf ESCAPED\x1b[201~');
  });

  it('submits bracketed paste separately from Enter', () => {
    vi.useFakeTimers();
    const writes: Array<[string, string]> = [];

    submitBracketedPasteToPty('pty-1', 'line 1\nline 2', {
      write: (ptyId, data) => {
        writes.push([ptyId, data]);
      },
    });

    expect(writes).toEqual([['pty-1', '\x1b[200~line 1\nline 2\x1b[201~']]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual([
      ['pty-1', '\x1b[200~line 1\nline 2\x1b[201~'],
      ['pty-1', '\r\r'],
    ]);
    vi.useRealTimers();
  });

  // #1337 — a Codex composer classifies rapid input as a paste, so an Enter
  // written at the Claude-tuned 100 ms is absorbed by the burst and the nudge
  // is stranded in the composer. Measured against codex-cli 0.154.0: stranded
  // at 100 ms and 250 ms, submitted at every gap from 300 ms up.
  it('waits longer before Enter for a paste-burst agent', () => {
    vi.useFakeTimers();
    const writes: string[] = [];

    submitBracketedPasteToPty('pty-codex', 'nudge', {
      agent: 'Codex CLI',
      write: (_ptyId, data) => {
        writes.push(data);
      },
    });

    // Still nothing at the old default — the whole point of the change.
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(['\x1b[200~nudge\x1b[201~']);

    vi.advanceTimersByTime(400);
    expect(writes).toEqual(['\x1b[200~nudge\x1b[201~', '\r']);
    vi.useRealTimers();
  });

  // The full-body notification path (a pane with no live agent) is multi-line
  // and submits with '\r\r'. That shape is unchanged; only the gap moves.
  it('applies the paste-burst gap to the multi-line double-Enter too', () => {
    vi.useFakeTimers();
    const writes: string[] = [];

    submitBracketedPasteToPty('pty-codex', 'line 1\nline 2', {
      agent: 'codex',
      write: (_ptyId, data) => {
        writes.push(data);
      },
    });

    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(writes[1]).toBe('\r\r');
    vi.useRealTimers();
  });

  it('keeps the default gap for Claude Code and for an unnamed pane', () => {
    vi.useFakeTimers();
    for (const agent of ['Claude Code', undefined]) {
      const writes: string[] = [];
      submitBracketedPasteToPty('pty-1', 'nudge', {
        agent,
        write: (_ptyId, data) => {
          writes.push(data);
        },
      });
      vi.advanceTimersByTime(100);
      expect(writes).toEqual(['\x1b[200~nudge\x1b[201~', '\r']);
    }
    vi.useRealTimers();
  });
});

describe('submitProfileForAgent', () => {
  // The numbers ARE the fix, so they are asserted literally. Advancing fake
  // timers by the constant under test would stay green for any value.
  it('pins the measured gaps', () => {
    expect(DEFAULT_SUBMIT_DELAY_MS).toBe(100);
    expect(PASTE_BURST_SUBMIT_DELAY_MS).toBe(500);
    expect(submitProfileForAgent('codex').submitDelayMs).toBe(500);
    expect(submitProfileForAgent('claude').submitDelayMs).toBe(100);
    expect(submitProfileForAgent(undefined).submitDelayMs).toBe(100);
  });

  it('accepts slugs and display names alike', () => {
    expect(submitProfileForAgent('codex')).toEqual(submitProfileForAgent('Codex CLI'));
    expect(submitProfileForAgent('claude')).toEqual(submitProfileForAgent('Claude Code'));
  });

  it('assures submit for Claude Code only', () => {
    expect(submitProfileForAgent('claude').assurance).toBe('assured');
    for (const agent of ['codex', 'gemini', 'aider', 'opencode', 'copilot', 'kiro', 'grok']) {
      expect(submitProfileForAgent(agent).assurance).toBe('unverified');
    }
  });

  // A dialog on screen means the CR answers the dialog, not starts a turn.
  it('drops Claude to unverified while the pane is awaiting input', () => {
    expect(submitProfileForAgent('claude', 'awaiting_input').assurance).toBe('unverified');
    for (const status of ['running', 'waiting', 'idle', 'complete', undefined]) {
      expect(submitProfileForAgent('claude', status).assurance).toBe('assured');
    }
  });

  // Status never widens the claim: a busy Codex pane is not suddenly assured.
  it('never lets a status promote a non-Claude agent', () => {
    for (const status of ['running', 'idle', undefined, 'awaiting_input']) {
      expect(submitProfileForAgent('codex', status).assurance).toBe('unverified');
    }
  });

  // A pane we cannot name may be a bare shell, a remote session, or an agent
  // this build predates. None of those is evidence that Enter submitted.
  it('treats an unknown, empty, or absent agent as unverified at the default gap', () => {
    for (const agent of [undefined, null, '', 'Some New Agent']) {
      expect(submitProfileForAgent(agent)).toEqual({
        submitDelayMs: 100,
        assurance: 'unverified',
      });
    }
  });
});
