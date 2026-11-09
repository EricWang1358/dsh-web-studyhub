/* global window */
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
    window.pageBreaks = true;
    PAGE_VIEWS.library = function Breaks() {
      if (window.pageBreaks) throw new TypeError('Cannot read properties of undefined (reading "map") in C:\\\\Users\\\\student\\\\Documents\\\\midterm-notes.docx');
      return <p id="page-ok">the library page</p>;
    };
    PAGE_VIEWS.review = function Fine() { return <p id="review-ok">the review page</p>; };
    function Harness() {
      const [page, setPage] = useState('library');
      const app = { language: 'zh', nav: { page }, data: { sources: [{}, {}], decks: [{ count: 5 }], jobs: [{ type: 'generation', status: 'failed' }] } };
      return <AppContext.Provider value={app}>
        <div className="study-app">
          <nav id="sidebar"><button id="go-library" onClick={() => setPage('library')}>library</button><button id="go-review" onClick={() => setPage('review')}>review</button></nav>
          <main><PageView page={page} feedback={null} /></main>
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

  await page.getByRole('button', { name: '复制诊断信息' }).click();
  const text = await page.evaluate(() => window.copied.at(-1));
  assert.match(text, /Page: library/);
  assert.match(text, /Cannot read properties of undefined/);
  assert.match(text, /sources 2, decks 1, questions 5/);
  assert.doesNotMatch(text, /midterm-notes|student|C:\\/, 'no path or file name in the text');

  await page.locator('#go-review').click();
  await page.locator('#review-ok').waitFor();
  assert.equal(await page.locator('.sh-crash').count(), 0, 'another page opens in place of the crashed one');

  await page.locator('#go-library').click();
  await page.locator('.sh-crash').waitFor();
  await page.evaluate(() => { window.pageBreaks = false; });
  await page.getByRole('button', { name: '重试' }).click();
  await page.locator('#page-ok').waitFor();
});
