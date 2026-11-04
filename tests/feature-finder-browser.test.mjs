/* 找功能 (#653) in a real browser: the sidebar row (wide and in the rail), Ctrl K, the arrow keys, Esc and the focus it gives back, 「带我去」 onto a
   settings control and onto one folded away on another page (the folds opened, the control focused, the ring around it, gone by itself and on input), and the
   toast for a control the finder cannot open for the learner. The walk is scripts/qa/finder.mjs (which also writes the screenshots); this test runs it
   without them in both languages and both widths. Needs a Chromium; without one the test says so instead of passing silently. */
import test from "node:test";
import assert from "node:assert/strict";
import { launchChromium } from "../scripts/qa/browser.mjs";
import { startNavServer } from "../scripts/qa/nav-layout.mjs";
import { walkFinder } from "../scripts/qa/finder.mjs";
import { buildPreview } from "../scripts/build.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the finder in a browser: open, search, arrows, Esc, 带我去 onto a setting and a folded control, the ring, the toast; Chinese and English, 1440 and 420", { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to run the finder in: ${String(error.message).split("\n")[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), "study-finder-dist-"));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  const problems = [];
  try {
    for (const [lang, theme, width] of [["zh", "light", 1440], ["zh", "dark", 420], ["en", "light", 1440], ["en", "dark", 420]]) {
      const result = await walkFinder({ browser, running, lang, theme, width, shots: false });
      problems.push(...result.problems);
    }
  } finally {
    await browser.close();
    await running.close();
  }
  assert.deepEqual(problems, []);
});
