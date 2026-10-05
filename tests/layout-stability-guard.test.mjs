/* global document, requestAnimationFrame -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { DEFAULT_CLS_MAX, drainLayoutStability, installLayoutObserver, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { parseJourneyArgs } from '../scripts/qa/journey.mjs';
import { until } from './helpers/wait.mjs';

/* WP-LS (#208): the journey measures layout shift and long tasks per step and fails a step whose late content moved what was already shown.
   The rule lives in ui/DESIGN.md; this file proves the measuring tool itself: it names a deliberate late insertion, stays quiet for a reserved
   slot and for a shift the learner caused, and the verdict and the command line behave. */

const shift = (value, element, extra = {}) => ({ value, startTime: 100, sources: [{ element, from: { x: 0, y: 40, width: 300, height: 20 }, to: { x: 0, y: 60, width: 300, height: 20 } }], ...extra });

test('the verdict fails a step over the threshold and names the elements that moved', () => {
  assert.equal(DEFAULT_CLS_MAX, 0.05);
  const bad = judgeLayoutStability({ shifts: [shift(0.04, '.source-row "Intro"'), shift(0.03, '.source-row "Indexes"')], longTasks: [{ duration: 180, startTime: 10 }, { duration: 60, startTime: 400 }] });
  assert.equal(bad.ok, false);
  assert.ok(Math.abs(bad.cls - 0.07) < 1e-9);
  assert.equal(bad.longestTask, 180);
  assert.match(bad.message, /CLS 0\.070 > 0\.05/);
  assert.match(bad.message, /\.source-row "Intro"/);
  assert.match(bad.message, /20px down/, 'the message says how far the element moved');
  const fine = judgeLayoutStability({ shifts: [shift(0.01, '.row')], longTasks: [] });
  assert.equal(fine.ok, true);
  assert.equal(fine.message, '');
  const strict = judgeLayoutStability({ shifts: [shift(0.01, '.row')], longTasks: [] }, { maxCls: 0 });
  assert.equal(strict.ok, false);
  const slow = judgeLayoutStability({ shifts: [], longTasks: [{ duration: 400, startTime: 5 }] }, { maxLongTask: 300 });
  assert.equal(slow.ok, false);
  assert.match(slow.message, /long task 400 ms > 300 ms/);
  assert.equal(judgeLayoutStability({ shifts: [], longTasks: [{ duration: 400, startTime: 5 }] }).ok, true, 'long tasks are reported, not judged, unless a limit is given');
  assert.equal(judgeLayoutStability({ shifts: [shift(0.5, '.row', { hadRecentInput: true })], longTasks: [] }).ok, true, 'a shift after the learner\'s own input is not counted');
});

test('the journey takes --cls-max and --longtask-max', () => {
  assert.equal(parseJourneyArgs([]).clsMax, 0.05);
  assert.equal(parseJourneyArgs([]).longTaskMax, 0);
  assert.equal(parseJourneyArgs(['--cls-max', '0.1', '--longtask-max=250']).clsMax, 0.1);
  assert.equal(parseJourneyArgs(['--cls-max', '0.1', '--longtask-max=250']).longTaskMax, 250);
  assert.throws(() => parseJourneyArgs(['--cls-max', 'lots']), /--cls-max/);
});

const PAGE = (late) => `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif"><main style="padding:20px">
  <h1>Pick material</h1>${late === 'reserved' ? '<div id="slot" style="height:120px"></div>' : ''}
  <ul id="list" style="margin:0;padding:0;list-style:none">${Array.from({ length: 12 }, (_, i) => `<li class="row" style="height:32px">Row ${i}</li>`).join('')}</ul>
  <button id="go" style="margin-top:12px">Add</button></main></body>`;

const frames = (page, count = 3) => page.evaluate((n) => new Promise((done) => { let left = n; const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), count);

async function withPage(t, late, body) {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.addInitScript(installLayoutObserver);
    await context.route('http://guard.test/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE(late) }));
    const page = await context.newPage();
    await page.goto('http://guard.test/');
    await page.waitForSelector('#list');
    await frames(page);
    await drainLayoutStability(page); // the first paint is not a shift
    await body(page);
  } finally { await browser.close(); }
}

test('a deliberate late insertion above visible content is caught and named', { timeout: 120000 }, async (t) => {
  await withPage(t, 'none', async (page) => {
    await page.evaluate(() => {
      const banner = document.createElement('div');
      banner.className = 'late-banner';
      banner.textContent = 'Recommended for you';
      banner.style.cssText = 'height:120px;background:#eee';
      document.getElementById('list').before(banner);
    });
    let log = { shifts: [], longTasks: [] };
    await until(async () => { const next = await drainLayoutStability(page); log = { shifts: [...log.shifts, ...next.shifts], longTasks: [...log.longTasks, ...next.longTasks] }; return log.shifts.length; }, 'the layout shift to be observed');
    const verdict = judgeLayoutStability(log);
    assert.equal(verdict.ok, false, `CLS ${verdict.cls} should fail the step`);
    assert.ok(verdict.cls > DEFAULT_CLS_MAX);
    assert.match(verdict.message, /#list|\.row|button|\bli\b/, 'the shifted elements are named');
    assert.match(verdict.message, /120px down/);
  });
});

test('content that fills a reserved slot, or that the learner asked for, moves nothing', { timeout: 120000 }, async (t) => {
  await withPage(t, 'reserved', async (page) => {
    await page.evaluate(() => { document.getElementById('slot').textContent = 'Recommended for you'; });
    await frames(page, 4);
    const filled = await drainLayoutStability(page);
    assert.equal(judgeLayoutStability(filled).ok, true, 'replacing in place is not a shift');
    assert.equal(filled.shifts.reduce((sum, item) => sum + item.value, 0), 0);
    // A click's own consequence (a row added under the pointer) is the learner's doing: hadRecentInput.
    await page.evaluate(() => {
      document.getElementById('go').addEventListener('click', () => {
        const row = document.createElement('li');
        row.style.height = '32px';
        row.textContent = 'Added';
        document.getElementById('list').prepend(row);
      });
    });
    await page.click('#go');
    await frames(page, 4);
    const clicked = await drainLayoutStability(page);
    assert.equal(clicked.shifts.length, 0, 'a shift within 500 ms of input is dropped at the source');
  });
});
