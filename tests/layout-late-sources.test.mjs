import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { seedPickerLibrary, sourcesScenario, startLateServer } from '../scripts/qa/layout-late.mjs';

/* #229: the 资料 page with 132 materials. The index coverage arrives after the rows are drawn (#205 fixed the picker; this is the page that lists the
   same materials): no row may change height, the page asking again with an answer of the same content redraws no row, and an answer that
   changes one material redraws only that row. */

test('index coverage arriving late changes no row height on the 资料 page, and redraws only the rows that changed (132 materials)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-late-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedPickerLibrary(root, { documents: 132 }) });
  try {
    for (const width of [1280, 420]) {
      const result = await sourcesScenario({ browser, running, width });
      t.diagnostic(`sources ${width}px: ${result.documents} rows, longest task ${result.longestTaskMs} ms (polls ${result.pollLongestTaskMs} ms), CLS ${result.cls}, row 5 y ${result.before[4].y} → ${result.after[4].y}, `
        + `rows redrawn: arrival ${result.arrivalRowsTouched}, equal answer ${result.pollRowsTouched}, one changed ${result.changeRowsTouched}`);
      assert.ok(result.documents >= 100, 'a long list');
      assert.ok(result.badges > 0, 'the badges arrived');
      assert.deepEqual(result.errors, []);
      assert.ok(Math.abs(result.after[4].y - result.before[4].y) <= 1, `${width}px: the 5th row moved from ${result.before[4].y} to ${result.after[4].y}`);
      for (let i = 0; i < result.before.length; i++) assert.ok(Math.abs(result.after[i].height - result.before[i].height) <= 0.5, `${width}px: row ${i + 1} changed height ${result.before[i].height} → ${result.after[i].height}`);
      assert.equal(result.rowResizes, 0, `${width}px: no row changes height when coverage arrives`);
      assert.ok(result.cls <= 0.05, `${width}px: CLS ${result.cls}`);
      assert.equal(result.pollRowsTouched, 0, `${width}px: an answer of the same content redraws no row`);
      assert.ok(result.changeRowsTouched >= 1 && result.changeRowsTouched <= 2, `${width}px: one changed material redraws its own row, not ${result.changeRowsTouched} rows`);
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
