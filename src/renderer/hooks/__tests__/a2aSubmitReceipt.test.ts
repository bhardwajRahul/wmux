// #1337 — `notified: true` never meant "the receiving agent woke", only "a pty
// was written to". These lock the honest half of the receipt.
import { describe, expect, it } from 'vitest';
import { submitReceiptFields, UNVERIFIED_SUBMIT_HINT } from '../a2aAddressing';

describe('submitReceiptFields', () => {
  it('claims an assured submit for a Claude Code pane and ships no hint', () => {
    expect(submitReceiptFields({ name: 'Claude Code', status: 'running' })).toEqual({
      submit: 'assured',
    });
    expect(submitReceiptFields({ name: 'claude' })).toEqual({ submit: 'assured' });
  });

  // A Claude pane on an AskUserQuestion / approval dialog takes the CR as an
  // ANSWER to that dialog. Nothing starts a turn, so nothing may be assured.
  it('refuses to assure a Claude pane that is awaiting input', () => {
    expect(submitReceiptFields({ name: 'Claude Code', status: 'awaiting_input' })).toEqual({
      submit: 'unverified',
      hint: UNVERIFIED_SUBMIT_HINT,
    });
  });

  it('reports a Codex pane as unverified with a recovery hint', () => {
    expect(submitReceiptFields({ name: 'Codex CLI', status: 'running' })).toEqual({
      submit: 'unverified',
      hint: UNVERIFIED_SUBMIT_HINT,
    });
  });

  it('reports every other agent, and an unnamed pane, as unverified', () => {
    const panes = [
      { name: 'Gemini CLI' },
      { name: 'OpenCode' },
      { name: 'Aider' },
      { name: 'Grok' },
      { name: 'Something Else' },
      {},
    ];
    for (const pane of panes) {
      expect(submitReceiptFields(pane).submit).toBe('unverified');
    }
  });

  // The hint is what a sending agent reads instead of blocking on a turn that
  // may never start, so it has to name the fallback.
  it('points the sender at polling rather than waiting', () => {
    expect(UNVERIFIED_SUBMIT_HINT).toContain('a2a_task_query');
    expect(UNVERIFIED_SUBMIT_HINT).toContain('cannot confirm');
  });
});
