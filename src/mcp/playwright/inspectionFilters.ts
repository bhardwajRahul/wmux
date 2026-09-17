// ---------------------------------------------------------------------------
// Pure helpers for browser_console / browser_network / browser_response_body
// (#1360 dogfood papercuts).
//
// They live here rather than in tools/inspection.ts because every one of them
// is a text transform over already-collected entries: testable without an MCP
// server, an engine, or a transport, and readable without the 300 lines of
// lane selection that surround the tools themselves.
// ---------------------------------------------------------------------------

/** A network row as both capture lanes hand it over. */
export interface NetworkSummaryLike {
  url: string;
  method: string;
  status?: number;
}

/** A console row as both capture lanes hand it over. */
export interface ConsoleEntryLike {
  level: string;
  text: string;
}

/**
 * Simple glob-like URL matching. '*' stands for any sequence of characters.
 *
 * Deliberately a copy of the matcher in tools/inspection.ts rather than an
 * import from it: this module must stay importable by a test that does not
 * pull in the whole tool registration graph.
 */
export function matchesUrlGlob(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$', 'i').test(url);
}

// ── browser_console: the URL Chrome leaves off a failed-resource line ────────

/**
 * Chrome writes "Failed to load resource: the server responded with a status
 * of 404 ()" with the URL in the message's *location*, which neither capture
 * lane records — so the agent is told a resource 404'd and never which one.
 *
 * The network buffer does know: Chrome emits exactly one such console line per
 * failed response, in response order. Pairing them in order, and preferring an
 * entry whose status matches the status the line itself states, puts the URL
 * back on the line without either lane having to grow a new field.
 *
 * An entry is consumed once, so two 404s on two URLs get one URL each. When
 * there is no unconsumed candidate the line is returned untouched: a guessed
 * URL would be worse than the missing one.
 */
const FAILED_RESOURCE_LINE = /failed to load resource/i;
const LINE_STATUS = /status of (\d{3})/i;

export function attachFailedResourceUrls(
  entries: readonly ConsoleEntryLike[],
  network: readonly NetworkSummaryLike[],
): ConsoleEntryLike[] {
  if (!entries.some(needsResourceUrl)) return [...entries];
  const consumed = new Set<number>();
  const failed = network
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status === undefined || entry.status >= 400);
  return entries.map((entry) => {
    if (!needsResourceUrl(entry)) return entry;
    const wanted = Number(LINE_STATUS.exec(entry.text)?.[1]);
    const pick =
      failed.find((c) => !consumed.has(c.index) && c.entry.status === wanted) ??
      failed.find((c) => !consumed.has(c.index));
    if (!pick) return entry;
    consumed.add(pick.index);
    return { ...entry, text: `${entry.text} ${pick.entry.url}` };
  });
}

/** A failed-resource line that does not already name a URL. */
function needsResourceUrl(entry: ConsoleEntryLike): boolean {
  return FAILED_RESOURCE_LINE.test(entry.text) && !/https?:\/\//i.test(entry.text);
}

// ── browser_network: filters and repeat collapsing ──────────────────────────

export interface NetworkFilterOptions {
  /** URL glob to keep, e.g. "*api*". */
  filter?: string;
  /** URL glob to drop, applied after `filter`. */
  exclude?: string;
  /** "404", or a class such as "4xx"/"5xx". */
  status?: string;
  /** HTTP method, case-insensitive. */
  method?: string;
}

/** Does this row's status satisfy a `status` argument? */
export function matchesStatus(status: number | undefined, wanted: string): boolean {
  const spec = wanted.trim().toLowerCase();
  const klass = /^([1-5])xx$/.exec(spec);
  if (klass) {
    return status !== undefined && Math.floor(status / 100) === Number(klass[1]);
  }
  const exact = Number(spec);
  if (!Number.isFinite(exact)) return false;
  return status === exact;
}

export function filterNetwork(
  entries: readonly NetworkSummaryLike[],
  options: NetworkFilterOptions,
): NetworkSummaryLike[] {
  return entries.filter((entry) => {
    if (options.filter && !matchesUrlGlob(entry.url, options.filter)) return false;
    if (options.exclude && matchesUrlGlob(entry.url, options.exclude)) return false;
    if (options.status && !matchesStatus(entry.status, options.status)) return false;
    if (options.method && entry.method.toUpperCase() !== options.method.toUpperCase()) return false;
    return true;
  });
}

/** One rendered row. `count` is present only when identical rows were folded. */
export interface NetworkRow {
  /** 1-based position in the capture buffer; browser_response_body takes it. */
  id: number;
  url: string;
  method: string;
  status: number | string;
  count?: number;
}

/**
 * Fold rows that are identical in url+method+status into one `xN` row.
 *
 * A page that polls one endpoint every second buries everything else in the
 * listing; the twelve identical lines carry exactly one fact ("this was called
 * twelve times") that one row states better. The id kept is the MOST RECENT
 * occurrence, because that is the one whose body a follow-up
 * browser_response_body wants.
 */
export function collapseRepeats(rows: readonly NetworkRow[]): NetworkRow[] {
  const byKey = new Map<string, NetworkRow>();
  const order: string[] = [];
  for (const row of rows) {
    const key = JSON.stringify([row.method, row.status, row.url]);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...row });
      order.push(key);
      continue;
    }
    seen.count = (seen.count ?? 1) + 1;
    seen.id = row.id;
  }
  return order.map((key) => byKey.get(key)!);
}

// ── browser_response_body: picking one of several matches ───────────────────

/**
 * Which captured entry a `nth` argument names among `matches`.
 *
 * 1-based and 1-indexed from the front; negative counts from the end, so the
 * default -1 is "the last one" — the response that reflects the filter the
 * caller just changed, which is what they asked for every time in the dogfood.
 * Returns -1 when the index falls outside the matches.
 */
export function resolveNthIndex(matchCount: number, nth: number | undefined): number {
  if (matchCount === 0) return -1;
  const wanted = nth ?? -1;
  const index = wanted < 0 ? matchCount + wanted : wanted - 1;
  return index >= 0 && index < matchCount ? index : -1;
}
