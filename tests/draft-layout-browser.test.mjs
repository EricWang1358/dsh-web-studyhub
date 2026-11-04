import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runDraftQa } from '../scripts/qa/draft-coverage.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* #662 #663 #668 #669 #670 measured in a real page: scripts/qa/draft-coverage.mjs (npm run qa:draft-coverage -- --check) seeds a five-part recording, runs a 精简 question run with the fake model
   (its plan is met, two sections are not in it) and asserts, on the draft page and in the 任务 console: the coverage figure is written once, nothing says every section has a question next to
   the ones that have none, the first question is on the first screen, the action bar is in view at the middle and the end of the page, it has no 删除草稿 button (it is in the ⋯ menu, in the
   danger colour), every closed question row has the same structure and is at most 72px high (at 420px: two lines and the kind under them), and nothing scrolls sideways. */
for (const [theme, width] of [['light', 1440], ['dark', 420]]) {
  test(`the draft page and the console at ${width}px (${theme}): one coverage figure, questions first, the bar in view, rows alike`, { timeout: 240000 }, async (t) => {
    try { await (await launchChromium()).close(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
    const out = await mkdtemp(join(tmpdir(), 'draft-layout-'));
    try {
      const options = parseArgs(['--lang', 'zh', '--theme', theme, '--width', String(width), '--check', '--out', out]);
      const summary = await runDraftQa(options);
      assert.deepEqual(summary.steps.filter((step) => step.status !== 'ok').map((step) => `${step.name}: ${step.error}`), []);
      assert.equal(summary.pageErrors.length + summary.consoleErrors.length + summary.apiErrors.length, 0, JSON.stringify([summary.pageErrors, summary.consoleErrors, summary.apiErrors]));
    } finally { await rm(out, { recursive: true, force: true }); }
  });
}
