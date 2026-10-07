/* global document, localStorage -- page callbacks run in the browser */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreview } from "../scripts/build.mjs";
import { launchChromium } from "../scripts/qa/browser.mjs";
import { previewCall } from "../scripts/preview-server.mjs";
import { until } from "./helpers/wait.mjs";
import { startNavServer, collectStates, checkContract, compareStates, measureSidebar } from "../scripts/qa/nav-layout.mjs";

/* The sidebar in a real browser (scripts/qa/nav-layout.mjs measures every row with getBoundingClientRect): the rows must
   keep their y position and height from "no run" to "run open" and back, on every page, in both languages, wide and
   narrow, expanded and collapsed. Needs a Chromium; without one the test says so instead of passing silently. */

test("the contract checker names a row that moves, grows, or is current while disabled", () => {
  const row = (key, top, height, extra = {}) => ({ key, top, bottom: 900 - top - height, height, zone: "study", active: false, ariaCurrent: null, disabled: false, ...extra });
  const before = { rows: [row("resume-nav", 100, 38), row("library", 139, 38)], mark: null, narrow: false };
  const after = { rows: [row("resume-nav", 100, 62), row("library", 163, 38)], mark: null, narrow: false };
  assert.deepEqual(compareStates(before, after), [{ key: "resume-nav", dTop: 0, dHeight: 24 }, { key: "library", dTop: 24, dHeight: 0 }]);
  const problems = checkContract({ a: before, b: after }, "x");
  assert.ok(problems.some((p) => /library moved 24px/.test(p)));
  assert.ok(problems.some((p) => /resume-nav moved 0px, height \+24px/.test(p)));
  const off = { rows: [row("resume-nav", 100, 38, { active: true, ariaCurrent: "page", disabled: true })], mark: { top: 100, height: 38 }, narrow: false };
  assert.ok(checkContract({ a: off }, "x").some((p) => /disabled yet aria-current/.test(p)));
});

test("no sidebar row moves or changes height when a run starts, ends or the page changes", { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split("\n")[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), "study-nav-dist-"));
  await buildPreview({ outdir: dist });
  // One server per combination (a walk wipes its library at the start), so the three walks run side by side in one browser.
  const servers = [];
  try {
    const combinations = [["zh", "dark", 1440, "expanded", true], ["en", "light", 768, "expanded", true], ["en", "dark", 1440, "collapsed", false]];
    const results = await Promise.all(combinations.map(async ([lang, theme, width, mode, full]) => {
      const running = await startNavServer({ distDir: dist });
      servers.push(running);
      return collectStates({ browser, running, lang, theme, width, mode, full });
    }));
    const problems = [];
    for (const result of results) {
      problems.push(...checkContract(result.states, result.label, { insertsRows: result.insertsRows }));
      assert.deepEqual(result.errors, [], `${result.label}: the page threw`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await browser.close().catch(() => {});
    await Promise.all(servers.map((running) => running.close().catch(() => {})));
    await rm(dist, { recursive: true, force: true });
  }
});

test('the resume highlight returns when saving finishes before its snapshot arrives', { timeout: 180000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split("\n")[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-nav-busy-'));
  let running;
  try {
    await buildPreview({ outdir: dist });
    running = await startNavServer({ distDir: dist });
    const quote = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
    await previewCall(running.server, 'source.add', { id: 's', title: 'Bridge', text: quote });
    await previewCall(running.server, 'draft.save', { deck: { id: 'd', title: 'Patterns', cards: [{
      id: 'c', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'Why separate reports and renderers?',
      answer: 'Two dimensions vary independently.', hint: 'Two reasons to change.', explanation: 'Composition over inheritance.',
      misconception: 'It adapts interfaces.', citations: [{ sourceId: 's', quote }],
    }] } });
    await previewCall(running.server, 'draft.publish', { id: 'd' });
    for (const scale of [100, 200]) await t.test(`${scale}% scale`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(value => {
        localStorage.setItem('study-ui-language', 'zh');
        localStorage.setItem('study-theme', 'dark');
        localStorage.setItem('study-interface', JSON.stringify({ scale: value }));
      }, scale);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      let started = false, held = 0, release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/call', async route => {
        const { action } = route.request().postDataJSON();
        if (['review.start', 'review.get'].includes(action)) started = true;
        if (action !== 'snapshot' || !started) return route.continue();
        const response = await route.fetch();
        held++;
        await gate;
        await route.fulfill({ response }).catch(() => {});
      });
      try {
        await page.goto(running.server.url);
        await page.waitForFunction(() => document.querySelector('.resume-nav')?.disabled === false);
        await page.locator('.resume-nav').click();
        await until(() => held > 0, 'the post-action snapshot response to be held');
        // The action runner releases busy independently of the held refresh. The row must regain its highlight at that point.
        await page.waitForFunction(() => document.querySelector('.resume-nav')?.getAttribute('aria-current') === 'page');
        const state = await measureSidebar(page);
        assert.equal(state.rows.find(row => row.key === 'resume-nav').disabled, false);
        assert.deepEqual(checkContract({ ready: state }, `${scale}% after busy`), []);
        assert.deepEqual(errors, []);
      } finally {
        release();
        await context.close();
      }
    });
  } finally {
    await browser.close().catch(() => {});
    await running?.close();
    await rm(dist, { recursive: true, force: true });
  }
});
