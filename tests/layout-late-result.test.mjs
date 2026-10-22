import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { resultScenario, seedResultLibrary, startLateServer } from '../scripts/qa/layout-late.mjs';

/* 3.6: every round's result page says 「这组题掌握度 a% → b%」. The numbers come with the run itself (lib/run-mastery.js), so the line is in the result page
   when it is put in the document, not drawn a moment later; and the 点评 and the recap, which do arrive later, are below it and move neither it nor the score. */

test('the result page has its mastery line from the first draw, and late content moves nothing above it (a deck round, 1280 and 390 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-late-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedResultLibrary(root) });
  try {
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      const { first, before, after, cls, shifts, errors } = await resultScenario({ browser, running, width, height });
      t.diagnostic(`result ${width}px: first draw ${JSON.stringify(first)}, line y ${before.line?.y} → ${after.line?.y}, score y ${before.hero?.y} → ${after.hero?.y}, CLS ${cls}`);
      assert.deepEqual(errors, []);
      assert.equal(first?.line, true, `${width}px: the line was in the result page when it was put in the document`);
      // The same library for both widths: the first round starts from three new questions (0%), the second from where the first left them.
      const [, from, to] = /^这组题掌握度 (\d+)% → (\d+)%$/.exec(first.text) || [];
      assert.ok(from !== undefined && Number(to) > Number(from), `${width}px: answered well, the mastery rose: ${first.text}`);
      if (width === 1280) assert.equal(from, '0', 'three new questions start at 0%');
      assert.equal(after.text, first.text, `${width}px: the words do not change after the first draw`);
      assert.ok(before.line && before.hero && before.line.y < before.hero.y, `${width}px: the line is above the score`);
      assert.equal(Math.round(before.hero.y - before.line.y), first.heroBelowLine, `${width}px: the score stands where it stood in the first draw`);
      assert.ok(Math.abs(after.line.y - before.line.y) <= 1, `${width}px: the line moved from ${before.line.y} to ${after.line.y}`);
      assert.ok(Math.abs(after.hero.y - before.hero.y) <= 1, `${width}px: the score moved from ${before.hero.y} to ${after.hero.y}`);
      assert.ok(cls <= 0.05, `${width}px: CLS ${cls}: ${JSON.stringify(shifts.map((shift) => shift.sources.map((source) => source.element.slice(0, 40))))}`);
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
