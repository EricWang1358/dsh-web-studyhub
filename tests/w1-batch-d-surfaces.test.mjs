import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { resultOpener } from './ui/tasks/task-actions.js';
  export { keptBook } from './ui/book/model.js';
  export { default as AnswerCardSection } from './ui/AnswerCard.jsx';
  export { default as TeachingPanel } from './ui/review/TeachingPanel.jsx';
  export { default as LearningActions } from './ui/review/LearningActions.jsx';
  export { default as DeskPlayStrip } from './ui/desk-play/DeskPlayStrip.jsx';
  export { extractSlipCard } from './ui/desk-play/lucky-card.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-17: BookStep keys PointBody by step.hid & preserves session retold per hid ---------- */

test('W1-17: BookStep passes key={step.hid} to PointBody and useBookHandlers stores retold per hid', async () => {
  const stepSrc = await readFile(new URL('../ui/book/BookStep.jsx', import.meta.url), 'utf8');
  assert.match(stepSrc, /<PointBody\s+key=\{step\.hid\}/, 'BookStep must key PointBody by step.hid');
  const actionsSrc = await readFile(new URL('../ui/book/use-book-actions.js', import.meta.url), 'utf8');
  assert.match(actionsSrc, /retoldOf:/, 'useBookHandlers must expose retoldOf');
  assert.match(actionsSrc, /onRetold:/, 'useBookHandlers must expose onRetold');
  const bodySrc = await readFile(new URL('../ui/book/PointBody.jsx', import.meta.url), 'utf8');
  assert.match(bodySrc, /handlers\.retoldOf\?\.\(node\.hid\)/, 'PointBody must read per-hid retold record');
});

/* ---------- W1-34: Task center 打开复习全书 routes to book with heading & aborts on focus.set failure ---------- */

test('W1-34: resultOpener routes course-book jobs to book page with keepBook target and aborts when focus.set fails', async () => {
  m.setUiLanguage('zh');
  const went = [];
  const root = '/tmp/w1-34-root';
  const job = {
    id: 'job-book-ai',
    type: 'course-book-ai',
    status: 'complete',
    contract: {
      kind: 'course-book-ai',
      status: 'complete',
      result: { refs: [{ kind: 'course-book', id: 'b1', course: 'OS', heading: 'H4' }] },
    },
  };
  const appOk = {
    data: { root, focus: { course: 'DB' }, sources: [] },
    nav: { navigate: (page) => went.push(page) },
    core: { act: async (action, args) => { went.push(`${action}:${args.course}`); return true; } },
  };
  const opener = m.resultOpener(job, appOk);
  assert.equal(opener.label, '打开复习全书');
  await opener.run();
  assert.deepEqual(went, ['focus.set:OS', 'book']);
  const kept = m.keptBook(root, 'OS');
  assert.equal(kept?.target, 'H4');
  assert.equal(kept?.switched, true);

  // When focus.set fails (returns false / undefined), navigation must abort
  const wentFail = [];
  const appFail = {
    data: { root, focus: { course: 'DB' }, sources: [] },
    nav: { navigate: (page) => wentFail.push(page) },
    core: { act: async () => undefined },
  };
  const openerFail = m.resultOpener(job, appFail);
  await openerFail.run();
  assert.deepEqual(wentFail, [], 'must NOT navigate to book when course switch fails');

  // course-outline still routes to outline
  const outlineJob = {
    id: 'job-outline',
    type: 'course-outline',
    status: 'complete',
    contract: {
      kind: 'course-outline',
      status: 'complete',
      result: { refs: [{ kind: 'course-outline', id: 'o1', course: 'OS' }] },
    },
  };
  const wentOutline = [];
  const openerOutline = m.resultOpener(outlineJob, {
    data: { root, focus: { course: 'OS' }, sources: [] },
    nav: { navigate: (page) => wentOutline.push(page) },
    core: { act: async () => true },
  });
  assert.equal(openerOutline.label, '打开总纲');
  await openerOutline.run();
  assert.deepEqual(wentOutline, ['outline']);
});

/* ---------- W1-11: AnswerCard refreshes run immediately & scopes BookButton to card course ---------- */

test('W1-11: AnswerCardSection awaits onRefreshRun on complete and BookButton checks current course in book.courses', async () => {
  const answerSrc = await readFile(new URL('../ui/AnswerCard.jsx', import.meta.url), 'utf8');
  assert.match(answerSrc, /book\.courses\.has\(course \?\? ''\)/, 'BookButton must check course membership rather than book.courses.size');
  assert.match(answerSrc, /qaAddFailureText\(failure\)/, 'BookButton must reuse qaAddFailureText');
  assert.match(answerSrc, /await onRefreshRun\?\.\(\)/, 'AnswerCardSection must await onRefreshRun before clearing busy state');
  const caseSrc = await readFile(new URL('../ui/CaseWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(caseSrc, /onRefreshRun=\{onRefreshRun\}/, 'CaseWorkspace must forward onRefreshRun to AnswerCardSection');
  const qrSrc = await readFile(new URL('../ui/review/QuestionRun.jsx', import.meta.url), 'utf8');
  assert.match(qrSrc, /onRefreshRun=\{session\.pollNow\}/, 'QuestionRun must pass session.pollNow to RubricAnswer');
});

/* ---------- W1-16: TeachingPanel shows busy state & TeachingStatus outside collapsible details ---------- */

test('W1-16: TeachingPanel renders busy submit button and inline TeachingStatus; LearningActions hides duplicate when teaching open', () => {
  m.setUiLanguage('zh');
  const session = {
    run: { deckId: 'd1', card: { id: 'c1' }, feedback: { passed: true }, solution: { citations: [] }, mode: 'path' },
    entry: {
      teaching: { id: 't1', mode: 'understanding', index: 0, total: 3, lesson: 'Step 1', check: 'Why?', complete: false },
      teachAnswer: 'Because of invariants',
    },
    teachingBusy: true,
    teachingError: '模型超时',
    actions: { setTeachAnswer: noop, teachingAct: noop, cancelTeaching: noop, retryTeaching: noop },
  };
  const busyHtml = renderToStaticMarkup(withServices(h(m.TeachingPanel, {
    session,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
  })));
  assert.doesNotMatch(busyHtml, /sh-btn--primary/, 'TeachingPanel submit button must not use primary CTA style');
  assert.match(busyHtml, /正在检查…/, 'TeachingPanel submit button must show busy label while checking');
  assert.match(busyHtml, /teaching-status/, 'TeachingPanel must show TeachingStatus spinner while busy');

  const errorSession = { ...session, teachingBusy: false };
  const errHtml = renderToStaticMarkup(withServices(h(m.TeachingPanel, {
    session: errorSession,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
  })));
  assert.match(errHtml, /模型超时/, 'TeachingPanel must show TeachingStatus error even when PostAnswerDetails is collapsed');

  const actionsHtml = renderToStaticMarkup(withServices(h(m.LearningActions, {
    session: errorSession,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
    openModal: noop,
  })));
  assert.doesNotMatch(actionsHtml, /模型超时/, 'LearningActions should not duplicate TeachingStatus while TeachingPanel is open');
});

/* ---------- W1-24: OralExam action-scoped busy states and consistent answered count ---------- */

test('W1-24: OralExam separates pendingAction for followup/next/submit and displays effectiveAnswered', async () => {
  const src = await readFile(new URL('../ui/OralExam.jsx', import.meta.url), 'utf8');
  assert.match(src, /pendingAction === 'followup'/, 'followup button has its own busy state');
  assert.match(src, /pendingAction === 'submit'/, 'submit and early-submit share submit busy state');
  assert.match(src, /本轮已回答 \{0\} 题", \[effectiveAnswered\]/, 'top progress uses effectiveAnswered consistent with early submit dialog');
});

/* ---------- W1-31: DeskPlayStrip shows options, renders Markdown/LaTeX, and clears on deck removal / library switch ---------- */

test('W1-31: extractSlipCard keeps quiz options and formulas without truncation; DeskPlayStrip renders options, Markdown/math, and resets cleanly', async () => {
  m.setUiLanguage('zh');
  const card = {
    id: 'c-math',
    kind: 'quiz',
    topic: 'Calculus',
    prompt: '计算定积分 $\\int_0^1 x^2 \\, dx$ 的值：',
    answer: 'b',
    options: [
      { id: 'a', text: '$\\frac{1}{2}$', correct: false },
      { id: 'b', text: '$\\frac{1}{3}$', correct: true },
    ],
    explanation: '由牛顿-莱布尼茨公式，$\\left.\\frac{x^3}{3}\\right|_0^1 = \\frac{1}{3}$。',
  };
  const deck = { id: 'd1', title: '高数', course: 'Math', cards: [card], available: 1, count: 1 };
  const slip = m.extractSlipCard(card, deck);
  assert.equal(slip.options.length, 2);
  assert.equal(slip.options[0].label, 'A');
  assert.equal(slip.options[1].label, 'B');
  assert.equal(slip.options[1].correct, true);

  const html = renderToStaticMarkup(withServices(h(m.DeskPlayStrip, {
    data: { root: '/lib-a', revision: 1, decks: [deck], attempts: [] },
    onPracticeDeck: noop,
    initialSlip: slip,
    initialRevealed: true,
  })));
  assert.match(html, /desk-play-slip__options/, 'renders quiz options list on slip');
  assert.match(html, /data-correct="true"/, 'highlights correct option when revealed');
  assert.match(html, /katex|md-compact/, 'renders prompt/options/explanation via Markdown/KaTeX');

  const mapSrc = await readFile(new URL('../ui/StudyMap.jsx', import.meta.url), 'utf8');
  assert.match(mapSrc, /<LazyDeskPlayStrip\s+key=\{data\.root\}/, 'StudyMap keys LazyDeskPlayStrip by data.root');
  const stripSrc = await readFile(new URL('../ui/desk-play/DeskPlayStrip.jsx', import.meta.url), 'utf8');
  assert.match(stripSrc, /revisionKey/, 'invalidates deckCacheRef on data.revision change');
  assert.match(stripSrc, /!eligibleDecks\.some/, 'clears slip when its deck leaves active decks');
});
