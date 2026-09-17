import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { generateScopedSnapshot, generateSnapshot } from '../snapshot';

// The #1356 budget, measured against a real Chrome on a real large page.
//
// SKIPPED BY DEFAULT — it needs a Chromium binary, which CI does not install,
// and it asserts wall-clock times, which a shared runner cannot hold to.
// To run it by hand:
//
//   CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \
//     npx vitest run src/mcp/playwright/__tests__/snapshot.querybudget.test.ts
//
// The fixture is 500 rows of 7 nodes; `SNAPSHOT_BENCH_SCALE=10` grows it to
// ~35 000 accessibility nodes, which is the size the dogfood page had with a
// dropdown open. Measured there on 2026-09-17, Chrome 141:
//
//   before   q "Unobtainium"  11 079 ms   (getFullAXTree alone 9872 ms)
//   after    q "Unobtainium"      271 ms
//
// The budget below is deliberately loose — it is a regression tripwire for
// "`q` went back to fetching the whole tree", not a benchmark.

const FIXTURE = pathToFileURL(
  path.join(__dirname, 'fixtures', 'large-page.html'),
).href;

const CHROME = process.env.CHROME_PATH;
const SCALE = Number(process.env.SNAPSHOT_BENCH_SCALE ?? '1');

describe.skipIf(!CHROME)('browser_snapshot q on a large page (#1356)', () => {
  it('returns the same nodes as the equivalent selector scope, in a fraction of the time', async () => {
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const page = await browser.newPage();
      await page.goto(FIXTURE);
      if (SCALE > 1) {
        await page.evaluate((n: number) => {
          const rows = document.getElementById('rows')!;
          const html: string[] = [];
          for (let i = 500; i < 500 * n; i++) {
            html.push(
              `<section role="group" aria-label="Row ${i}"><span>Widget ${i}</span>` +
                `<span>value ${i}</span><button type="button">Open Widget ${i}</button>` +
                `<a href="#r${i}">Details ${i}</a></section>`,
            );
          }
          rows.insertAdjacentHTML('beforeend', html.join(''));
        }, SCALE);
      }

      // Correctness: the query and the selector that means the same thing list
      // the same elements with the same ref numbers. `q` also keeps the
      // ancestor chain above the row, which the scope does not have, so the
      // comparison is over the lines inside the row.
      const searched = await generateSnapshot(page, { q: 'Unobtainium' });
      const scoped = await generateScopedSnapshot(page, '#needle-row', {
        q: 'Unobtainium',
      });
      const rowLines = (text: string) =>
        text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('- ') && !line.startsWith('- main'));
      expect(rowLines(searched)).toEqual(rowLines(scoped ?? ''));

      // Budget: a text query must not cost the whole-page fetch any more.
      const whole0 = performance.now();
      await generateSnapshot(page, {});
      const whole = performance.now() - whole0;

      const query0 = performance.now();
      await generateSnapshot(page, { q: 'Unobtainium' });
      const query = performance.now() - query0;

      expect(query).toBeLessThan(whole / 2);
    } finally {
      await browser.close();
    }
  }, 300_000);
});

// The same budget for `selector`, which kept paying the whole-page fetch until
// #1371. Measured on the same fixture at SNAPSHOT_BENCH_SCALE=10, Chrome 141,
// with the a11y tree already computed (see the warm-up below):
//
//   getFullAXTree alone                 3178 ms
//   before   selector "#needle-row"     3352 ms
//   after    selector "#needle-row"      291 ms
//
// The warm-up is not a thumb on the scale: Chrome computes a page's
// accessibility tree once, on the first query of any kind, and BOTH paths pay
// that (~3.4 s here) when they are that first query. What #1371 removes is the
// per-snapshot cost of marshalling all 35 000 nodes to fetch ten of them, which
// is what every snapshot after the first was paying.
describe.skipIf(!CHROME)('browser_snapshot selector scope on a large page (#1371)', () => {
  it('fetches the matched subtree instead of the whole tree', async () => {
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const page = await browser.newPage();
      await page.goto(FIXTURE);
      if (SCALE > 1) {
        await page.evaluate((n: number) => {
          const rows = document.getElementById('rows')!;
          const html: string[] = [];
          for (let i = 500; i < 500 * n; i++) {
            html.push(
              `<section role="group" aria-label="Row ${i}"><span>Widget ${i}</span>` +
                `<span>value ${i}</span><button type="button">Open Widget ${i}</button>` +
                `<a href="#r${i}">Details ${i}</a></section>`,
            );
          }
          rows.insertAdjacentHTML('beforeend', html.join(''));
        }, SCALE);
      }

      // One whole-page snapshot first: it is the measurement AND the warm-up,
      // so the scope below is timed against a tree Chrome has already computed.
      const whole0 = performance.now();
      await generateSnapshot(page, {});
      const whole = performance.now() - whole0;

      const scoped0 = performance.now();
      const scoped = await generateScopedSnapshot(page, '#needle-row', { format: 'ai' });
      const scopedMs = performance.now() - scoped0;

      // The scope still says what it always said — the row, whole.
      expect(scoped).toContain('Unobtainium 250');
      expect(scoped).toContain('Details 250');
      expect(scoped).not.toContain('Widget 249');
      expect(scopedMs).toBeLessThan(whole / 2);
    } finally {
      await browser.close();
    }
  }, 300_000);
});
