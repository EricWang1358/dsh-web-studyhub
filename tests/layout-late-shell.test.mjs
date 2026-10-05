import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { shellScenario, startLateServer } from '../scripts/qa/layout-late.mjs';

/* Found by the journey at 420 px (#208): the app was drawn with the sidebar open and, one frame later, folded it into the icon rail because the
   narrow-window rule was only measured after the first paint. The whole page moved 128 px. The rule is measured before the first paint now. */

test('a narrow window never draws the open sidebar first', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-late-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist });
  try {
    for (const width of [420, 1280]) {
      const result = await shellScenario({ browser, running, width });
      t.diagnostic(`first paint ${width}px: CLS ${result.cls}, main x ${result.main?.y}`);
      assert.deepEqual(result.errors, []);
      assert.ok(result.cls <= 0.02, `${width}px: the first paint shifted (CLS ${result.cls}): ${JSON.stringify(result.shifts.map((shift) => shift.sources.map((source) => `${source.element.slice(0, 30)} ${source.from.x}→${source.to.x}`)))}`);
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
