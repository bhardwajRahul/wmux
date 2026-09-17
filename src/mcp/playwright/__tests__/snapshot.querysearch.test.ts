import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot } from '../snapshot';

// #1356: `q` used to make Chrome compute and marshal the whole accessibility
// tree before there was anything to filter. Profiled on a 35 000-node fixture
// (Chrome 141): Accessibility.getFullAXTree 9872 ms, DOM.performSearch plus
// getSearchResults 119 ms, Accessibility.getPartialAXTree 12 ms, and every
// downstream stage — buildTree, the prune, serialisation — under 30 ms
// together. So the fetch is the cost, and `q` now narrows the fetch.
//
// What these tests pin is the thing that must NOT change with it: the tree the
// caller gets back. Every case below compares the search route's output against
// the full-tree route's output for the same question, and the routes have to
// agree line for line, refs included.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
  parentId?: string;
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

const TREE: CdpNode[] = [
  { nodeId: '1', backendDOMNodeId: 1, role: role('RootWebArea'), name: name('Settings'), childIds: ['2', '9'] },
  { nodeId: '2', backendDOMNodeId: 2, role: role('listbox'), name: name('Country'), childIds: ['3', '4', '5'], parentId: '1' },
  { nodeId: '3', backendDOMNodeId: 3, role: role('option'), name: name('Germany'), childIds: [], parentId: '2' },
  { nodeId: '4', backendDOMNodeId: 4, role: role('option'), name: name('Republic of Korea'), childIds: ['6'], parentId: '2' },
  { nodeId: '6', backendDOMNodeId: 6, role: role('StaticText'), name: name('Republic of Korea'), childIds: [], parentId: '4' },
  { nodeId: '5', backendDOMNodeId: 5, role: role('option'), name: name('United States'), childIds: [], parentId: '2' },
  { nodeId: '9', backendDOMNodeId: 9, role: role('paragraph'), name: name('Choose a country'), childIds: [], parentId: '1' },
];

const byNodeId = new Map(TREE.map((n) => [n.nodeId, n]));
const byBackendId = new Map(TREE.map((n) => [n.backendDOMNodeId!, n]));

/** The requested node, then its ancestor chain — what fetchRelatives returns. */
function partialFor(backendNodeId: number): CdpNode[] {
  const node = byBackendId.get(backendNodeId);
  if (!node) return [];
  const out: CdpNode[] = [node];
  let cursor = node.parentId;
  while (cursor) {
    const parent = byNodeId.get(cursor);
    if (!parent) break;
    out.push(parent);
    cursor = parent.parentId;
  }
  return out;
}

interface FakeOptions {
  /** DOM search hits, as backendNodeIds, keyed by the query text. */
  hits?: Record<string, number[]>;
  /** How many `<iframe>`/`<frame>` elements the document reports. */
  frames?: number;
}

function makePage(options: FakeOptions = {}) {
  const calls: string[] = [];
  const client = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push(method);
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return { nodes: TREE };
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } };
        case 'DOM.querySelectorAll':
          return { nodeIds: Array.from({ length: options.frames ?? 0 }, (_, i) => 100 + i) };
        case 'DOM.performSearch': {
          const query = String(params?.query ?? '');
          const found = options.hits?.[query] ?? [];
          return { searchId: `s:${query}`, resultCount: found.length };
        }
        case 'DOM.getSearchResults': {
          const query = String(params?.searchId ?? '').slice(2);
          return { nodeIds: options.hits?.[query] ?? [] };
        }
        case 'DOM.describeNode':
          // The fake numbers nodeIds and backendNodeIds alike, so a search hit
          // describes to itself.
          return { node: { backendNodeId: params?.nodeId } };
        case 'Accessibility.getPartialAXTree':
          return { nodes: partialFor(Number(params?.backendNodeId)) };
        case 'Accessibility.getChildAXNodes': {
          const node = byNodeId.get(String(params?.id));
          return { nodes: (node?.childIds ?? []).map((id) => byNodeId.get(id)).filter(Boolean) };
        }
        default:
          return {};
      }
    }),
    detach: vi.fn(() => Promise.resolve()),
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: vi.fn(async () => ''),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
  return { page, client, calls };
}

/** How many times the whole-document fetch was made. */
const fullFetches = (calls: string[]) =>
  calls.filter((c) => c === 'Accessibility.getFullAXTree').length;

describe('generateSnapshot q — search-scoped fetch (#1356)', () => {
  it('returns the tree the full fetch returns, without making it', async () => {
    const searched = makePage({ hits: { korea: [4] } });
    const fast = await generateSnapshot(searched.page as never, { format: 'ai', q: 'korea' });

    // No hits for this query ⇒ the search route abstains and the full tree
    // answers. Same question, same page, the route that exists today.
    const whole = makePage();
    const slow = await generateSnapshot(whole.page as never, { format: 'ai', q: 'korea' });

    expect(fast).toBe(slow);
    // The thing the issue is about: the big fetch did not happen.
    expect(fullFetches(searched.calls)).toBe(0);
    expect(fullFetches(whole.calls)).toBeGreaterThan(0);
  });

  it('keeps the ancestors and the matched node’s own subtree', async () => {
    const { page } = makePage({ hits: { korea: [4] } });
    const out = await generateSnapshot(page as never, { format: 'ai', q: 'korea' });

    expect(out).toContain('listbox "Country"');
    expect(out).toContain('option "Republic of Korea"');
    expect(out).not.toContain('Germany');
    expect(out).not.toContain('United States');
  });

  it('mints the same ref numbers as the full fetch', async () => {
    const refsOf = (text: string) => text.match(/ref="\d+"/g) ?? [];

    const fast = await generateSnapshot(makePage({ hits: { Germany: [3] } }).page as never, {
      format: 'ai',
      q: 'Germany',
    });
    const slow = await generateSnapshot(makePage().page as never, {
      format: 'ai',
      q: 'Germany',
    });

    expect(refsOf(fast)).toEqual(refsOf(slow));
    expect(refsOf(fast).length).toBeGreaterThan(0);
  });

  it('falls back to the full fetch for a /regex/ query, which DOM search cannot take', async () => {
    const { page, calls } = makePage({ hits: { korea: [4] } });
    const out = await generateSnapshot(page as never, { format: 'ai', q: '/Republic of Korea/' });

    expect(out).toContain('option "Republic of Korea"');
    expect(fullFetches(calls)).toBeGreaterThan(0);
  });

  it('falls back when the document has a frame, whose nodes only the graft reaches', async () => {
    const { page, calls } = makePage({ hits: { korea: [4] }, frames: 1 });
    const out = await generateSnapshot(page as never, { format: 'ai', q: 'korea' });

    expect(out).toContain('option "Republic of Korea"');
    expect(fullFetches(calls)).toBeGreaterThan(0);
  });

  // A `q` naming a ROLE ("button", "listbox") is invisible to a text search, and
  // that is exactly the query whose answer must not silently shrink.
  it('falls back when the text search finds nothing, so a role query still answers', async () => {
    const { page, calls } = makePage({ hits: {} });
    const out = await generateSnapshot(page as never, { format: 'ai', q: 'listbox' });

    expect(out).toContain('listbox "Country"');
    expect(fullFetches(calls)).toBeGreaterThan(0);
  });

  it('still says nothing matched, rather than returning the page', async () => {
    const { page } = makePage({ hits: { Andorra: [] } });
    const out = await generateSnapshot(page as never, { format: 'ai', q: 'Andorra' });

    expect(out).toBe('(no nodes match q="Andorra")');
  });
});
