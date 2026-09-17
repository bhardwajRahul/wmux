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
