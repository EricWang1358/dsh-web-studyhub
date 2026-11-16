/* global window, document, getComputedStyle */
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
      call: async (action) => (action === 'coach.debrief' ? debrief : {}), // the debrief asks the app's services (useStudy)
      coachProps: { debrief, autopilot: true, onPractice: noop, onContinue: () => { window.goes++; },
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
  await library.page.getByText(/自动跳下一步：\d 秒后执行/).waitFor({ timeout: 5000 });
  assert.equal(await book.page.getByText(/自动跳下一步/).count(), 0, 'no countdown on a book round');
  assert.equal(await reader.page.getByText(/自动跳下一步/).count(), 0, 'no countdown on a reader round');
  await library.page.waitForFunction(() => window.goes === 1, null, { timeout: 10000 });
  await book.page.waitForTimeout(1500);
  assert.equal(await book.page.evaluate(() => window.goes), 0, 'the book round stays where it is: the learner chooses the way back');
  assert.equal(await reader.page.evaluate(() => window.goes), 0, 'and so does the reader round');
  for (const { errors } of [library, book, reader]) assert.deepEqual(errors, []);
});

const hookBundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { useReviewSession } from './ui/review/useReviewSession.js';
  import QuestionRun from './ui/review/QuestionRun.jsx';
  import ReviewNavigator from './ui/ReviewNavigator.jsx';
  import { StudyServicesContext } from './ui/study-context.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');

  const mkRun = (id = 'r1', index = 0, answered = [false, false, false], kind = 'quiz') => ({
    id, mode: kind === 'flashcard' ? 'flashcard' : 'path', index, total: 3, complete: false, revealed: false, feedback: null, solution: null, queueVersion: 0, revision: 0,
    position: { last: index === 2 },
    navigation: answered.map((done, i) => ({ index: i, answered: done, correct: done ? true : null, level: 'new', kind, prompt: 'Q' + (i + 1) })),
    card: kind === 'flashcard'
      ? { id: id + '-c' + index, kind: 'flashcard', topic: 'T', prompt: 'Flashcard front ' + (index + 1) }
      : {
        id: id + '-c' + index, kind: 'quiz', topic: 'T', prompt: 'Stem text for selection test ' + (index + 1),
        options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }],
      },
  });

  function Harness() {
    const rootRef = React.useRef(null);
    const dataRef = React.useRef({ root: 'root', settings: { practice: { autopilot: true } }, decks: [], sources: [] });
    const bindingRoot = React.useRef('root');
    const [tick, setTick] = React.useState(0);
    const [busy] = React.useState(false);
    const call = async (action, args = {}) => {
      window.__calls.push([action, args]);
      if (action === 'review.move') {
        const nextIdx = args.index ?? (window.__state.run.index + (args.direction || 1));
        if (nextIdx >= 3) {
          window.__state.run = { ...window.__state.run, complete: true };
          return window.__state.run;
        }
        window.__state.run = mkRun(window.__state.run.id, nextIdx, window.__state.answered, window.__state.kind || 'quiz');
        return window.__state.run;
      }
      if (action === 'review.reveal') {
        window.__state.run = {
          ...window.__state.run,
          revealed: true,
          intervals: [0, 1, 1, 2, 4, 7],
          solution: { answer: 'Flashcard back answer', explanation: 'Detailed flashcard explanation.' },
        };
        return window.__state.run;
      }
      if (action === 'review.answer') {
        const idx = window.__state.run.index;
        window.__state.answered[idx] = true;
        const grade = args.grade;
        window.__state.run = {
          ...mkRun(window.__state.run.id, idx, window.__state.answered, window.__state.kind || 'quiz'),
          revealed: true,
          feedback: grade !== undefined ? { correct: grade >= 3, grade, level: 'learning' } : { correct: true, details: [] },
          solution: { answer: 'Yes', explanation: 'Because Yes is right and long enough to hover easily.' },
        };
        return window.__state.run;
      }
      return {};
    };
    const act = async (action, args, onDone) => {
      const res = await call(action, args);
      onDone?.(res);
      return res;
    };
    const core = React.useMemo(() => ({
      call, act, notify() {}, setError() {}, busy,
      refs: { dataRef, bindingRoot },
      askInChat() {}, refresh: async () => {},
    }), [busy]);
    const nav = React.useMemo(() => ({ page: 'review', setPage() {}, show: { exam() {} } }), []);
    const late = React.useRef({ resume() {} });
    const session = useReviewSession({ core, nav, modalOpen: false, host: {}, rootRef, late });
    window.__session = session;
    window.__setState = (nextRun) => {
      window.__state = { run: nextRun, answered: nextRun.navigation.map((n) => n.answered), kind: nextRun.card?.kind || 'quiz' };
      session.enterRun(nextRun);
      setTick((t) => t + 1);
    };
    React.useEffect(() => {
      const initial = mkRun('r1', 0, [false, false, false]);
      window.__state = { run: initial, answered: [false, false, false] };
      session.enterRun(initial);
    }, []);
    const services = React.useMemo(() => ({
      call, act, busy, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {},
    }), [busy]);
    return (
      <StudyServicesContext.Provider value={services}>
        <div ref={rootRef} className="study-app" data-tick={tick}>
          {session.run && (
            <>
              <ReviewNavigator run={session.run} skippedIndices={session.skippedIndices} onJump={(index) => session.actions.reviewAct('review.move', { index })} />
              <QuestionRun
                session={session}
                data={dataRef.current}
                shellTitle="练习"
                feedback={null}
                coachProps={{ ...session.coach, autopilot: session.autopilot }}
                links={{}}
                context={{}}
              />
            </>
          )}
        </div>
      </StudyServicesContext.Provider>
    );
  }
  window.__calls = [];
  createRoot(document.getElementById('root')).render(<Harness />);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

test('useReviewSession autopilot bar, hover/selection pause, freeze/resume >= 450ms, reduced motion, and skippedIndices (#2, #5)', { timeout: 60000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: hookBundle.outputFiles[0].text });
  await page.locator('.question-card').waitFor();

  // #5: skip Q1 -> skippedIndices contains 0 -> tick 0 has data-skipped="true"; answering Q1 clears it; new run.id resets it.
  await page.evaluate(() => window.__session.actions.skipQuestion());
  await page.waitForFunction(() => window.__session.run?.index === 1 && window.__session.skippedIndices.has(0));
  assert.equal(await page.locator('.review-tick[data-skipped="true"]').count(), 1);
  await page.locator('.review-tick').first().click();
  await page.waitForFunction(() => window.__session.run?.index === 0);
  await page.locator('.option', { hasText: 'Yes' }).click();
  await page.waitForFunction(() => !window.__session.skippedIndices.has(0) && window.__session.autoAdvanceActive === true);
  assert.equal(await page.locator('.review-tick[data-skipped="true"]').count(), 0, 'answered clears skipped marker');

  // #2: bar present on card & next button; hovering .explanation pauses and blocks advance past 1500ms; leaving resumes.
  await page.locator('.question-card__autopilot-fill').waitFor();
  await page.locator('.next-question.is-autopilot .next-question__bar').waitFor();
  await page.locator('.explanation').hover();
  await page.locator('.next-question.is-autopilot.is-paused').waitFor();
  await page.locator('.review-autopilot-note').waitFor();
  const callsBeforeHoverWait = await page.evaluate(() => window.__calls.length);
  await page.waitForTimeout(1650);
  assert.equal(await page.evaluate(() => window.__session.run?.index), 0, 'hover holds autopilot indefinitely');
  assert.equal(await page.evaluate(() => window.__calls.length), callsBeforeHoverWait);

  // Move pointer away -> resumes and advances.
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => window.__session.run?.index === 1, null, { timeout: 5000 });

  // Verify reduced-motion disables animations on countdown bars, and text selection inside .review-body pauses.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.option', { hasText: 'Yes' }).click();
  await page.waitForFunction(() => window.__session.autoAdvanceActive === true);
  assert.deepEqual(await page.evaluate(() => ({
    cardBar: getComputedStyle(document.querySelector('.question-card__autopilot-fill')).animationName,
    nextBar: getComputedStyle(document.querySelector('.next-question__bar')).animationName,
  })), { cardBar: 'none', nextBar: 'none' }, 'prefers-reduced-motion disables bar animations');

  await page.evaluate(() => {
    const el = document.querySelector('.review-body .question');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.locator('.next-question.is-paused').waitFor();
  await page.waitForTimeout(1650);
  assert.equal(await page.evaluate(() => window.__session.run?.index), 1, 'text selection holds autopilot');

  // Verify setAutoAdvancePaused resume floor >= 450ms: run clock down ~1200ms (~300ms left), pause, wait 400ms, unpause -> still on same index at 250ms, advances after ~600ms.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.waitForFunction(() => window.__session.run?.index === 2, null, { timeout: 5000 });
  await page.locator('.option', { hasText: 'Yes' }).click();
  await page.waitForFunction(() => window.__session.autoAdvanceActive === true);
  await page.waitForTimeout(1150);
  await page.evaluate(() => window.__session.setAutoAdvancePaused(true));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__session.run?.complete), false, 'paused freezes timer');
  await page.evaluate(() => window.__session.setAutoAdvancePaused(false));
  await page.waitForTimeout(220);
  assert.equal(await page.evaluate(() => window.__session.run?.complete), false, 'resume enforces >= 450ms floor');
  await page.waitForFunction(() => window.__session.run?.complete === true, null, { timeout: 5000 });

  // #5: new run.id resets skippedIndices even if non-empty.
  await page.evaluate(() => {
    window.__session.actions.skipQuestion();
    const next = {
      id: 'r2', mode: 'path', index: 0, total: 3, complete: false, revealed: false, feedback: null, solution: null, queueVersion: 0, revision: 0,
      position: { last: false },
      navigation: [0, 1, 2].map((i) => ({ index: i, answered: false, correct: null, level: 'new', kind: 'quiz', prompt: 'N' + i })),
      card: { id: 'r2-c0', kind: 'quiz', topic: 'T', prompt: 'New run stem', options: [{ id: 'a', text: 'Yes' }] },
    };
    window.__setState(next);
  });
  await page.waitForFunction(() => window.__session.run?.id === 'r2' && window.__session.skippedIndices.size === 0);

  // Flashcard auto-advance renders only one full-width card countdown bar (no duplicate legacy .autopilot-bar), and clears cleanly on the next card.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__setState({
      id: 'rf', mode: 'flashcard', index: 0, total: 3, complete: false, revealed: false, feedback: null, solution: null, queueVersion: 0, revision: 0,
      position: { last: false },
      navigation: [0, 1, 2].map((i) => ({ index: i, answered: false, correct: null, level: 'new', kind: 'flashcard', prompt: 'F' + i })),
      card: { id: 'rf-c0', kind: 'flashcard', topic: 'T', prompt: 'Flashcard front 1' },
    });
  });
  await page.locator('.flashcard .flip-control').click();
  await page.locator('[data-usage="review.grade"]').nth(4).click();
  await page.waitForFunction(() => window.__session.autoAdvanceActive === true);
  assert.equal(await page.locator('.question-card__autopilot').count(), 1, 'single full-width countdown bar on flashcard');
  assert.equal(await page.locator('.autopilot-bar').count(), 0, 'legacy duplicate .autopilot-bar is gone');
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => window.__session.run?.index === 1, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__session.showBack), false, 'next unrevealed flashcard mounts front-side-up synchronously');
  assert.equal(await page.locator('.flashcard.flipped').count(), 0, 'next unrevealed flashcard never mounts upside-down');
  assert.equal(await page.locator('.question-card__autopilot').count(), 0, 'countdown bar cleared on next ungraded flashcard');
  assert.equal(await page.locator('.autopilot-bar').count(), 0);
  assert.deepEqual(errors, []);
});
