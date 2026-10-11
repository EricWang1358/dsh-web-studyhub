import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { indexShortcutScenario } from '../scripts/qa/index-shortcut.mjs';

/* Owner report: the badge 「索引建了一部分」 was a passive label and nobody could find where the index is built. In a real browser, at 1280 and 420 px:
   the 资料 page and the picker of 创建题组 show 「建立索引」 on the partly built material and one line above the list; before the extension is installed
   the action says 安装扩展 and lands on the install step; installed, a click (or Enter on the action) opens 设置 › 检索扩展 with the course of THAT
   material chosen, builds nothing, opens no reader and ticks no row; with everything indexed there is no line and no action.
   The steps and their assertions are in scripts/qa/index-shortcut.mjs (it also writes the screenshots when run on its own). */

test('the badge leads to where the index is built, at 1280 and 420 px', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to run the pages in: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-index-shortcut-dist-'));
  try {
    await buildPreview({ outdir: dist });
    for (const width of [1280, 420]) {
      const { errors, facts } = await indexShortcutScenario({ browser, dist, width });
      t.diagnostic(`${width}px: ${JSON.stringify(facts)}`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      assert.equal(facts.actions, 1);
      assert.ok(facts.chosenCourse.includes('操作系统') && !facts.chosenCourse.includes(facts.focusCourse), `${width}px: the book's course is chosen, not the current one`);
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
