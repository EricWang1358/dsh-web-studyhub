/* global window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* The autopilot countdown of the result page's 点评 must not take the learner past a way back that the page offers as its one filled button: the review book's
   (and the 总纲's) 回到复习全书 and the reader's 回到阅读. The real Review page runs in Chromium; only its services are faked. A plain library round is the control:
   there the countdown does start and does take the next step, so "no countdown" above is not just a page that never counts. */
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import Review from './ui/Review.jsx';
  import { StudyServicesContext } from './ui/study-context.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import { reviewElement } from './tests/helpers/review-render.mjs';
  setUiLanguage('zh');
  const noop = () => {};
  window.goes = 0;
  window.mountResult = (trail) => {
    const reading = { sourceId: 's1', sectionTitle: 'Hash indexes', scope: { kind: 'chapter', count: 4 }, before: { percent: 41, total: 5 }, after: { percent: 58, total: 5 } };
    const debrief = { headline: '状态不错，接着学下一批。', why: '本轮 4 题。', next: 'continue_path', insights: [], metrics: { answered: 4, gradedAnswered: 4, gradedCorrect: 2 }, status: { enabled: true, consent: false, ready: 0 } };
    const old = {
      run: { id: 'r', mode: 'path', complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 2, selfAnswered: 0, weakTopics: [], weakScopes: {}, scope: [],
        card: { id: 'q', kind: 'quiz', topic: 'Context', prompt: 'p', options: [] }, ...(trail === 'reader' ? { reading } : {}) },
      data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: '今日学习', busy: false,
      coachProps: { call: async () => debrief, debrief, autopilot: true, onPractice: noop, onContinue: () => { window.goes++; },
        destination: { kind: 'path', reason: 'continuing', label: '继续学习 →', go: () => { window.goes++; }, note: '' } },
      ...(trail === 'book' ? { contextKind: 'book', contextPlace: '1.2.2 Architect the Solution', contextReturnLabel: '回到复习全书', onReturnContext: noop } : {}),
      ...(trail === 'reader' ? { contextKind: 'library', contextReturnLabel: '返回学习库首页', onReturnContext: noop, onReturnToReading: noop } : {}),
      ...(trail === 'library' ? { contextKind: 'library', contextReturnLabel: '返回学习库首页', onReturnContext: noop } : {}),
    };
    createRoot(document.getElementById('root')).render(React.createElement('div', { className: 'study-app' }, reviewElement(Review, StudyServicesContext, old)));
  };
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

async function opened(t, trail) {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return null;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((kind) => window.mountResult(kind), trail);
  await page.locator('.coach-debrief h2').waitFor();
  return { page, errors };
}

test('the autopilot countdown: a plain round counts down and goes on; a round with the book\'s or the reader\'s way back as its main button does neither', { timeout: 60000 }, async (t) => {
  const [library, book, reader] = await Promise.all(['library', 'book', 'reader'].map((trail) => opened(t, trail)));
  if (!library) return;
  await library.page.getByText(/自动驾驶：\d 秒后执行/).waitFor({ timeout: 5000 });
  assert.equal(await book.page.getByText(/自动驾驶/).count(), 0, 'no countdown on a book round');
  assert.equal(await reader.page.getByText(/自动驾驶/).count(), 0, 'no countdown on a reader round');
  await library.page.waitForFunction(() => window.goes === 1, null, { timeout: 10000 });
  await book.page.waitForTimeout(1500);
  assert.equal(await book.page.evaluate(() => window.goes), 0, 'the book round stays where it is: the learner chooses the way back');
  assert.equal(await reader.page.evaluate(() => window.goes), 0, 'and so does the reader round');
  for (const { errors } of [library, book, reader]) assert.deepEqual(errors, []);
});
