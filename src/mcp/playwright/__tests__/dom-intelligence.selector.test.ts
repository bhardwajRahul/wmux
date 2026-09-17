// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildDomSnapshotExpression, type DomSnapshotPayload } from '../dom-intelligence';
import {
  clearRefDescriptors,
  nextRefFor,
  priorRefDescriptors,
  recordRefGeneration,
  type RefDescriptor,
} from '../refDescriptors';

// Selector-scoped DOM snapshot (Phase 1): the expression runs against jsdom
// (document/location are globals there), the same way the markdown-extractor
// dom tests execute in-page code.

function run(expr: string): string {
  // Indirect eval → runs in global scope where jsdom's document lives.
  return (0, eval)(expr) as string;
}

describe('buildDomSnapshotExpression(rootSelector)', () => {
  it('tags and lists only interactive elements under the scope root', () => {
    document.body.innerHTML =
      '<main><h2>Inside</h2><button id="b1">In</button></main>' +
      '<h2>Outside</h2><button id="b2">Out</button>';

    const out = run(buildDomSnapshotExpression('main'));

    expect(out).toContain('Scope: main');
    expect(out).toContain('"In"');
    expect(out).not.toContain('"Out"');
    expect(out).toContain('H2: Inside');
    expect(out).not.toContain('H2: Outside');
    expect(document.getElementById('b1')?.getAttribute('data-wmux-ref')).toBe('0');
    expect(document.getElementById('b2')?.hasAttribute('data-wmux-ref')).toBe(false);
  });

  it('wipes stale refs document-wide even when they fall outside the scope', () => {
    document.body.innerHTML =
      '<main><button id="b1">In</button></main><button id="b2" data-wmux-ref="7">Out</button>';

    run(buildDomSnapshotExpression('main'));

    // The out-of-scope stale ref must not survive to collide with fresh 0-based numbering.
    expect(document.getElementById('b2')?.hasAttribute('data-wmux-ref')).toBe(false);
  });

  it('reports a non-matching selector instead of throwing', () => {
    document.body.innerHTML = '<button>x</button>';
    const out = run(buildDomSnapshotExpression('#nope'));
    expect(out).toBe('No element matches selector: #nope');
  });
});

describe('buildDomSnapshotExpression filter:"interactive" (#1066)', () => {
  it('drops the heading block but keeps interactives and the Page/URL header', () => {
    document.body.innerHTML = '<h1>Title</h1><h2>Section</h2><button id="b1">Go</button>';

    const out = run(buildDomSnapshotExpression(undefined, { filter: 'interactive' }));

    expect(out).not.toContain('H1: Title');
    expect(out).not.toContain('H2: Section');
    expect(out).toContain('"Go"');
    // The auto-diff URL guard parses the "URL: …" line — it must survive the filter.
    expect(out).toMatch(/^URL: /m);
    expect(document.getElementById('b1')?.getAttribute('data-wmux-ref')).toBe('0');
  });

  it('composes with a rootSelector: scoped AND heading-free', () => {
    document.body.innerHTML =
      '<main><h2>Inside</h2><button id="b1">In</button></main>' +
      '<h2>Outside</h2><button id="b2">Out</button>';

    const out = run(buildDomSnapshotExpression('main', { filter: 'interactive' }));

    expect(out).toContain('Scope: main');
    expect(out).not.toContain('H2: Inside');
    expect(out).not.toContain('H2: Outside');
    expect(out).toContain('"In"');
    expect(out).not.toContain('"Out"');
  });

  it('without the filter, headings remain (control)', () => {
    document.body.innerHTML = '<h1>Title</h1><button>Go</button>';
    const out = run(buildDomSnapshotExpression());
    expect(out).toContain('H1: Title');
  });
});

// #1355 — the lane that actually renumbered. With plain positional numbering a
// dropdown opening above a link moved it from ref 2 to ref 14, and the ref the
// agent was holding then resolved to a menu item or was refused as stale.
describe('buildDomSnapshotExpression stable numbering (#1355)', () => {
  const NAV = '<a href="/home">Home</a><a href="/reports">Reports</a>';
  const MENU = Array.from({ length: 12 }, (_, i) => `<button>Item ${i}</button>`).join('');

  function listing(stable?: { prior: RefDescriptor[]; nextRef: number }): DomSnapshotPayload {
    return run(
      buildDomSnapshotExpression(undefined, { ...(stable && { stable }), withEntries: true }),
    ) as unknown as DomSnapshotPayload;
  }

  it('gives an element the same number after a dropdown opens above it', () => {
    clearRefDescriptors();
    document.body.innerHTML = NAV;
    const first = listing();
    expect(first.entries.map((e) => e.ref)).toEqual([0, 1]);
    recordRefGeneration('surface', 0, first.entries);

    document.body.innerHTML = MENU + NAV;
    const second = listing({
      prior: priorRefDescriptors('surface', 0),
      nextRef: nextRefFor('surface', 0),
    });

    const reports = second.entries.find((e) => e.name === 'Reports');
    expect(reports?.ref).toBe(1);
    expect(second.entries.find((e) => e.name === 'Home')?.ref).toBe(0);
    // The attribute the agent clicks through carries the same number.
    expect(document.querySelector('a[href="/reports"]')?.getAttribute('data-wmux-ref')).toBe('1');
    // New elements take numbers after the previous maximum; nothing is reused.
    expect(second.entries.find((e) => e.name === 'Item 0')?.ref).toBe(2);
    expect(new Set(second.entries.map((e) => e.ref)).size).toBe(second.entries.length);
  });

  it('numbers from zero, exactly as before, when no history is supplied', () => {
    clearRefDescriptors();
    document.body.innerHTML = MENU + NAV;
    expect(listing().entries.map((e) => e.ref)).toEqual([...Array(14).keys()]);
  });
});
