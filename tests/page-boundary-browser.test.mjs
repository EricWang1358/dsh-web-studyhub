/* global window, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* #893 S1/S3: a page that throws while it renders is caught by the one boundary inside PageView, so the sidebar and the way to the other pages
   stay; the learner can retry, and copy the diagnostic text. The harness is the real PageView with two pages of its own put in its registry, beside
   a stand-in for the sidebar (App.jsx draws <AppSidebar/> and <main> as siblings; the source check at the end pins that). */

test('a page that throws keeps the sidebar, offers retry and a copyable diagnostic text, and navigation still works', { timeout: 90000 }, async t => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppContext } from './ui/app/app-context.js';
    import { PAGE_VIEWS, PageView } from './ui/app/page-views.jsx';
    import { deferredView } from './ui/deferred-view.jsx';
    import { markPageSwitch, useSessionPerformance } from './ui/use-session-performance.js';
    import { sessionPerformance } from './ui/session-performance.js';
    window.sessionPerformance = sessionPerformance;
    window.pageBreaks = true;
    PAGE_VIEWS.library = function Breaks() {
      if (window.pageBreaks) throw new TypeError('Cannot read properties of undefined (reading "map") in C:\\\\Users\\\\student\\\\Documents\\\\midterm-notes.docx');
      return <p id="page-ok">the library page</p>;
    };
    // 13 of the 21 pages are made with deferredView, which has a boundary of its own: its notice must offer the button too.
    PAGE_VIEWS.exam = deferredView(async () => ({ default: function LazyBreaks() { throw new TypeError("Cannot read properties of null (reading 'cards')"); } }));
    PAGE_VIEWS.review = function Fine() { return <p id="review-ok">the review page</p>; };
    function Harness() {
      const [page, setPage] = useState('library');
      useSessionPerformance(page); // as App.jsx does: in the shell, above the board / PageView choice
      const app = { language: 'zh', nav: { page }, data: { sources: [{}, {}], decks: [{ count: 5 }], jobs: [{ type: 'generation', status: 'failed' }] } };
      return <AppContext.Provider value={app}>
        <div className="study-app">
          <nav id="sidebar"><button id="go-library" onClick={() => { markPageSwitch('library'); setPage('library'); }}>library</button><button id="go-review" onClick={() => { markPageSwitch('review'); setPage('review'); }}>review</button><button id="go-exam" onClick={() => { markPageSwitch('exam'); setPage('exam'); }}>exam</button><button id="go-board" onClick={() => { markPageSwitch('board'); setPage('board'); }}>board</button></nav>
          <main>{page === 'board' ? <p id="board-ok">the board</p> : <PageView page={page} feedback={null} />}</main>
        </div>
      </AppContext.Provider>;
    }
    window.copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied.push(text); } }, configurable: true });
    createRoot(document.getElementById('root')).render(<Harness />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const crash = page.locator('.sh-crash');
  await crash.waitFor();
  assert.equal(await page.locator('#sidebar').count(), 1, 'the sidebar is still drawn beside the crashed page');
  assert.match(await crash.innerText(), /这个页面没能显示/);

  // The text can be read before it is copied.
  await page.getByText('看看会复制什么').click();
  const shown = await page.locator('.sh-diagnostic-copy__text').inputValue();
  assert.match(shown, /Page: library/);
  assert.match(shown, /Message: \(not copied: \d+ characters; see 技术详情\)/, 'a message that is not an engine one is withheld');
  await page.getByRole('button', { name: '复制诊断信息' }).click();
  const text = await page.evaluate(() => window.copied.at(-1));
  assert.match(text, /Page: library/);
  assert.equal(text, shown, 'what is copied is what was shown');
  assert.match(text, /sources 2, decks 1, questions 5/);
  assert.doesNotMatch(text, /midterm-notes|student|C:\\/, 'no path or file name in the text');

  await page.locator('#go-exam').click();
  await page.locator('.sh-crash').waitFor();
  assert.equal(await page.locator('#sidebar').count(), 1);
  await page.getByRole('button', { name: '复制诊断信息' }).click();
  const lazy = await page.evaluate(() => window.copied.at(-1));
  assert.match(lazy, /Page: exam/);
  assert.match(lazy, /Message: Cannot read properties of null \(reading 'cards'\)/, 'an engine message is copied whole');

  // #893 S4: the switch to exam was timed to its first frame and a task over 50 ms is counted; both are in the text, which still holds nothing private.
  // (The text is built when the button draws: opening the fold draws it again, with the numbers that arrived since.)
  await page.evaluate(() => { const end = performance.now() + 120; while (performance.now() < end); });
  await page.waitForFunction(() => window.sessionPerformance.summary().switches.all.count >= 1 && window.sessionPerformance.summary().longTasks?.count >= 1);
  await page.getByText('看看会复制什么').click();
  const withSession = await page.locator('.sh-diagnostic-copy__text').inputValue();
  assert.match(withSession, /^Page switches .*: exam 1x \d+\/\d+$/m);
  assert.match(withSession, /^Long tasks .*\(over 50 ms\): [1-9]\d*, total \d+ ms, worst \d+ ms$/m);
  assert.doesNotMatch(withSession, /midterm-notes|student|C:\\/);

  await page.locator('#go-review').click();
  await page.locator('#review-ok').waitFor();
  assert.equal(await page.locator('.sh-crash').count(), 0, 'another page opens in place of the crashed one');

  // The board is drawn beside PageView, not inside it: its switch is timed too, and the long-task observer is not torn down on the way.
  const observed = await page.evaluate(() => window.sessionPerformance.summary().longTasks?.count);
  await page.locator('#go-board').click();
  await page.locator('#board-ok').waitFor();
  await page.waitForFunction(() => window.sessionPerformance.summary().switches.byPage.some(entry => entry.page === 'board'));
  assert.ok((await page.evaluate(() => window.sessionPerformance.summary().longTasks?.count)) >= observed, 'the observer kept counting: the count did not start over');

  // A frame that waits for the learner to come back would say the switch took as long as they were away: a switch that spans a visibility change is not recorded.
  const reviewSwitches = () => page.evaluate(() => window.sessionPerformance.summary().switches.byPage.find(entry => entry.page === 'review')?.count ?? 0);
  const timed = await reviewSwitches();
  await page.evaluate(async () => { document.querySelector('#go-review').click(); await Promise.resolve(); document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('#review-ok').waitFor();
  await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => setTimeout(resolve, 50)))));
  assert.equal(await reviewSwitches(), timed, 'the switch the visibility change cut short has no time');

  await page.locator('#go-library').click();
  await page.locator('.sh-crash').waitFor();
  // The clipboard refuses: the note says so and the text is in front of the learner, selected by hand.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('refused'); }; });
  await page.getByRole('button', { name: '复制诊断信息' }).click();
  await page.locator('.sh-diagnostic-copy__refused[role="status"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'sh-diagnostic-copy__text');
  await page.evaluate(() => { window.pageBreaks = false; });
  await page.getByRole('button', { name: '重试' }).click();
  await page.locator('#page-ok').waitFor();
});
