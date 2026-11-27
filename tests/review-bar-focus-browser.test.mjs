/* global document, window, getComputedStyle */
/* The answer bar sticks to the bottom of the page once a question is answered, and what takes the keyboard focus under it must come out from under it
   (WCAG 2.4.11 Focus Not Obscured). That room used to be a scroll-padding-bottom on the page's scroller, switched by the answer; a change of scroll-padding
   on that box makes Chrome restyle every element of the page (200 ms on each answer with a material open beside the question, a reader's report of
   2026-11-19), so the question area now gives its own focusable elements a scroll-margin-bottom while the bar is stuck (ui/review/review.css).
   In a real browser, the whole QuestionRun with a fake study context, no network: a control lying under the stuck bar comes clear of it when it is
   focused; without the mark on the question area it stays covered (so the rule is what does it); and before the answer nothing carries the mark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import QuestionRun from './ui/review/QuestionRun.jsx';
  import { StudyServicesContext } from './ui/study-context.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import { reviewParts } from './tests/helpers/review-render.mjs';
  import css from './ui/styles.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const call = async () => ({});
  // A question longer than the window: the bar's own place is below the fold, so it sticks to the bottom edge over the end of the card.
  const long = Array.from({ length: 14 }, (_, n) => 'Paragraph ' + (n + 1) + ': the scheduler picks the next process to run from the ready queue.').join('\\n\\n');
  const card = { id: 'q', kind: 'quiz', topic: 'Context', prompt: long + ' Who schedules processes?', options: [{ id: 'a', text: 'Scheduler' }, { id: 'b', text: 'Clerk' }] };
  const solution = { answer: 'Scheduler', explanation: long, misconception: 'Not the clerk.', citations: [],
    options: [{ id: 'a', correct: true, explanation: 'yes' }, { id: 'b', correct: false, explanation: 'no' }] };
  const root = createRoot(document.getElementById('root'));
  window.showQuestion = (answered) => {
    const run = { id: 'run', index: 0, total: 2, mode: 'path', card, ...(answered ? { revealed: true, feedback: { correct: true, selected: ['a'], level: 'learning' }, solution } : {}) };
    const { services, props } = reviewParts({ run, data: { sources: [] }, call });
    root.render(<StudyServicesContext.Provider value={services}><div className="study-app"><QuestionRun {...props} /></div></StudyServicesContext.Provider>);
  };
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  plugins: [{ name: 'stub-pdfjs', setup(builder) {
    builder.onResolve({ filter: /^pdfjs-dist\// }, args => ({ path: args.path, namespace: 'stub-pdfjs' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub-pdfjs' }, () => ({ contents: 'export const getDocument = () => ({}); export const WorkerMessageHandler = {}; export class TextLayer {}', loader: 'js' }));
  } }],
  loader: { '.css': 'text' }, logLevel: 'silent' });

/** Put the lowest thing of the question area that can take the focus and can go there right under the stuck bar, focus it, and say where it and the bar are
 *  before and after. After an answer that is the verdict and the next-review line, which the page focuses itself (tabindex -1). */
const focusUnderBar = page => page.evaluate(() => {
  const app = document.querySelector('.study-app'), bar = document.querySelector('.review-sticky-bar'), area = document.querySelector('.question-area');
  const controls = [...area.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')]
    .filter(node => !bar.contains(node) && !node.disabled && node.getClientRects().length && node.getBoundingClientRect().height < 200);
  const box = node => node.getBoundingClientRect();
  for (const control of controls.reverse()) {
    document.activeElement?.blur?.();
    // Its bottom edge two pixels above the bottom of the scroller: inside the scroller's box, so nothing has to scroll for it, and behind the bar.
    app.scrollTop += box(control).bottom - (box(app).bottom - 2);
    const before = { bottom: box(control).bottom, top: box(control).top, bar: box(bar).top };
    // Covered: its box meets the bar's. A control after the bar never is (the bar is back in the flow by then), nor one the page cannot scroll that far.
    if (!(before.bottom > before.bar + 1 && before.top < box(bar).bottom && box(bar).bottom <= box(app).bottom + 1)) continue;
    control.focus();
    return { found: true, name: control.className || control.tagName, focused: document.activeElement === control, before, after: { bottom: box(control).bottom, bar: box(bar).top } };
  }
  return { found: false, controls: controls.length };
});

test('a control under the stuck answer bar comes clear of the bar when it takes the focus', { timeout: 180000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 460 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://bar-focus.test/') return route.fulfill({ contentType: 'text/html', body: '<main id="root" style="height:460px"></main>' });
    return route.abort();
  });
  await page.goto('http://bar-focus.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  await page.evaluate(() => window.showQuestion(false));
  await page.locator('.question-area').waitFor();
  assert.equal(await page.locator('.question-area[data-bar-stuck]').count(), 0, 'before the answer the bar is in the flow: nothing is marked');
  assert.equal(await page.locator('.study-app').evaluate(node => getComputedStyle(node).scrollPaddingBottom), 'auto', 'and the page scroller keeps no room at its bottom');

  await page.evaluate(() => window.showQuestion(true));
  await page.locator('.question-area[data-bar-stuck="true"]').waitFor();
  const stuck = await page.evaluate(() => {
    const bar = document.querySelector('.review-sticky-bar'), app = document.querySelector('.study-app');
    return { position: getComputedStyle(bar).position, gap: Math.abs(bar.getBoundingClientRect().bottom - app.getBoundingClientRect().bottom), scrolls: app.scrollHeight > app.clientHeight + 100,
      padding: getComputedStyle(app).scrollPaddingBottom };
  });
  assert.equal(stuck.position, 'sticky');
  assert.ok(stuck.gap <= 1, `the bar sits on the bottom edge of the page (${stuck.gap})`);
  assert.ok(stuck.scrolls, 'the answered question is longer than the window');
  assert.equal(stuck.padding, 'auto', 'the answer did not change the page scroller\'s scroll-padding (that restyled the whole page)');

  const kept = await focusUnderBar(page);
  assert.ok(kept.found, `a control can be put under the bar (${JSON.stringify(kept)})`);
  assert.ok(kept.focused, 'it took the focus');
  assert.ok(kept.before.bottom > kept.before.bar, 'it was covered by the bar');
  assert.ok(kept.after.bottom <= kept.after.bar + 1, `focused, it is above the bar (${JSON.stringify(kept)})`);

  // The toolbar wraps on a narrow screen. The same question updates its clearance when the viewport changes.
  await page.setViewportSize({ width: 420, height: 460 });
  await page.waitForFunction(() => {
    const area = document.querySelector('.question-area'), bar = area.querySelector('.review-sticky-bar');
    return parseFloat(area.style.getPropertyValue('--review-bar-room')) === bar.offsetHeight;
  });
  const narrow = await focusUnderBar(page);
  assert.ok(narrow.found && narrow.focused && narrow.after.bottom <= narrow.after.bar + 1, `focused, it clears the wrapped toolbar (${JSON.stringify(narrow)})`);

  // The same control without the mark on the question area: it keeps the focus under the bar. The rule is what brought it out.
  await page.evaluate(() => document.querySelector('.question-area').removeAttribute('data-bar-stuck'));
  const bare = await focusUnderBar(page);
  assert.ok(bare.found && bare.focused);
  assert.ok(bare.after.bottom > bare.after.bar, `without the mark it stays covered (${JSON.stringify(bare)})`);

  // The bar's own buttons are not pushed away from the bar: focusing one does not scroll the page.
  await page.evaluate(() => document.querySelector('.question-area').setAttribute('data-bar-stuck', 'true'));
  const own = await page.evaluate(() => {
    const app = document.querySelector('.study-app'), button = document.querySelector('.review-sticky-bar button:not(:disabled)');
    app.scrollTop = 40;
    const before = app.scrollTop;
    button.focus();
    return { before, after: app.scrollTop, focused: document.activeElement === button };
  });
  assert.ok(own.focused);
  assert.equal(own.after, own.before, 'focusing a button of the bar leaves the page where it is');
  assert.deepEqual(errors, []);
});
