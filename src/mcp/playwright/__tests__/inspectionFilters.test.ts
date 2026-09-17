import { describe, expect, it } from 'vitest';
import {
  attachFailedResourceUrls,
  collapseRepeats,
  filterNetwork,
  matchesStatus,
  resolveNthIndex,
} from '../inspectionFilters';

// The pure half of the #1360 inspection papercuts: the tool-level behaviour is
// covered in inspection.capture.test.ts, these pin the rules themselves.

describe('attachFailedResourceUrls', () => {
  it('leaves a line that already names a URL untouched', () => {
    const entries = [{ level: 'error', text: 'Failed to load resource https://x.test/a' }];
    expect(attachFailedResourceUrls(entries, [{ url: 'https://x.test/b', method: 'GET', status: 404 }]))
      .toEqual(entries);
  });

  it('consumes each candidate once', () => {
    const out = attachFailedResourceUrls(
      [
        { level: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
        { level: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' },
      ],
      [
        { url: 'https://x.test/one', method: 'GET', status: 404 },
        { url: 'https://x.test/two', method: 'GET', status: 404 },
      ],
    );
    expect(out[0].text).toContain('/one');
    expect(out[1].text).toContain('/two');
  });

  it('says nothing rather than guessing when no candidate is left', () => {
    const line = { level: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()' };
    expect(attachFailedResourceUrls([line], [])).toEqual([line]);
  });

  it('treats an unsettled request as a candidate (a blocked load has no status)', () => {
    const out = attachFailedResourceUrls(
      [{ level: 'error', text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT' }],
      [{ url: 'https://x.test/ads.js', method: 'GET' }],
    );
    expect(out[0].text).toContain('ads.js');
  });
});

describe('matchesStatus', () => {
  it('matches an exact code and a class, and never matches a pending row', () => {
    expect(matchesStatus(404, '404')).toBe(true);
    expect(matchesStatus(404, '4xx')).toBe(true);
    expect(matchesStatus(500, '4xx')).toBe(false);
    expect(matchesStatus(undefined, '4xx')).toBe(false);
    expect(matchesStatus(200, 'nonsense')).toBe(false);
  });
});

describe('filterNetwork', () => {
  const entries = [
    { url: 'https://x.test/api/a', method: 'GET', status: 200 },
    { url: 'https://x.test/api/poll', method: 'GET', status: 200 },
    { url: 'https://x.test/api/b', method: 'POST', status: 500 },
  ];

  it('applies exclude after filter and is case-insensitive on method', () => {
    expect(filterNetwork(entries, { filter: '*api*', exclude: '*poll*' }).map((e) => e.url)).toEqual([
      'https://x.test/api/a',
      'https://x.test/api/b',
    ]);
    expect(filterNetwork(entries, { method: 'post' })).toHaveLength(1);
  });
});

describe('collapseRepeats', () => {
  it('folds identical rows, counts them, and keeps the newest id', () => {
    const out = collapseRepeats([
      { id: 1, url: 'u', method: 'GET', status: 200 },
      { id: 2, url: 'v', method: 'GET', status: 200 },
      { id: 3, url: 'u', method: 'GET', status: 200 },
    ]);
    expect(out).toEqual([
      { id: 3, url: 'u', method: 'GET', status: 200, count: 2 },
      { id: 2, url: 'v', method: 'GET', status: 200 },
    ]);
  });

  it('keeps rows that differ only in status apart', () => {
    const out = collapseRepeats([
      { id: 1, url: 'u', method: 'GET', status: 200 },
      { id: 2, url: 'u', method: 'GET', status: 500 },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('resolveNthIndex', () => {
  it('defaults to the last match and counts negatives from the end', () => {
    expect(resolveNthIndex(3, undefined)).toBe(2);
    expect(resolveNthIndex(3, 1)).toBe(0);
    expect(resolveNthIndex(3, -2)).toBe(1);
  });

  it('reports out-of-range and empty as -1', () => {
    expect(resolveNthIndex(0, undefined)).toBe(-1);
    expect(resolveNthIndex(2, 5)).toBe(-1);
    expect(resolveNthIndex(2, -5)).toBe(-1);
  });
});
