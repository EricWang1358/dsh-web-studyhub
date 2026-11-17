import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewElement } from './helpers/review-render.mjs';

const m = await loadUi(`
  export { NextDue } from './ui/NextDue.jsx';
  export { default as TodayView } from './ui/board/TodayView.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { default as ResultBreakdown } from './ui/ResultBreakdown.jsx';
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const noop = () => {};
const CJK = /[\u4e00-\u9fff]/;
const textOfHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function makeTodayBoard({ openAm = 0, doneToday = 0 } = {}) {
  const today = '2026-11-15';
  const cards = {};
  const todoIds = [];
  const doneIds = [];
  for (let i = 0; i < openAm; i += 1) {
    const id = `open-${i + 1}`;
    todoIds.push(id);
    cards[id] = { id, title: `Task ${i + 1}`, plannedDate: today, slot: 'am', slotDate: today };
  }
  for (let i = 0; i < doneToday; i += 1) {
    const id = `done-${i + 1}`;
    doneIds.push(id);
    cards[id] = { id, title: `Completed ${i + 1}`, plannedDate: today };
  }
  return {
    today,
    board: {
      version: 1,
      revision: 1,
      columns: [
        { id: 'todo', title: 'Todo', done: false, cardIds: todoIds },
        { id: 'done', title: 'Done', done: true, cardIds: doneIds },
      ],
      cards,
      archived: [],
      todayOrder: {},
      timeLog: [],
      timer: null,
      timerPrefs: { workMinutes: 25, breakMinutes: 5, sound: false, notify: false },
    },
  };
}

function renderResult(runOverrides = {}) {
  const card = { id: 'q1', kind: 'quiz', topic: 'Locks', prompt: 'What prevents lost updates?', options: [] };
  return renderToStaticMarkup(reviewElement(m.Review, m.StudyServicesContext, {
    run: {
      id: 'r-w7',
      mode: 'path',
      complete: true,
      index: 5,
      total: 5,
      questions: 5,
      answered: 5,
      correct: 5,
      objectiveAnswered: 5,
      selfAnswered: 0,
      mastery: { before: { total: 5, percent: 45, state: 'learning' }, after: { total: 5, percent: 65, state: 'familiar' } },
      scope: [],
      card,
      ...runOverrides,
    },
    data: { sources: [], decks: [], features: {} },
    shellTitle: 'Distributed Locks',
    choice: true,
    coachProps: {
      debrief: {
        headline: 'Solid progress.',
        why: 'Round complete.',
        next: 'continue_path',
        insights: [],
        metrics: { answered: 5, gradedAnswered: 5, gradedCorrect: 5 },
        status: { enabled: true, consent: false, ready: 0 },
      },
      autopilot: false,
      onPractice: noop,
      onContinue: noop,
      onReviewWeak: noop,
      destination: { kind: 'path', reason: 'continuing', label: 'Continue →', go: noop, note: '' },
    },
  }));
}

function wrongBookProps(overrides = {}) {
  return {
    data: { decks: [{ id: 'd1', course: 'Systems', title: 'Week 1' }], sources: [], attempts: [{ deckId: 'd1', cardId: 'c1' }] },
    course: '',
    onCourse: noop,
    showInactive: false,
    onShowInactive: noop,
    items: [],
    counts: { total: 0, graded: 0, self: 0, oral: 0, rubric: 0 },
    view: 'weak',
    onView: noop,
    viewCounts: { weak: 0, history: 4 },
    onPractice: noop,
    ...overrides,
  };
}

function walkTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return; }
  if (node.props) {
    visit(node);
    walkTree(node.props.children, visit);
  }
}

function mountWrongBookOnce(props) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  let cursor = 0;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const prev = internals.H;
  internals.H = {
    useContext: (ctx) => (ctx === m.StudyServicesContext ? { busy: false, openModal: noop } : ctx._currentValue),
    useState: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, noop]; return hooks[i]; },
    useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
    useEffect: () => { cursor++; },
    useLayoutEffect: () => { cursor++; },
    useInsertionEffect: () => { cursor++; },
    useId: () => `:w7-${cursor++}:`,
    useDeferredValue: (v) => v,
  };
  try {
    return m.WrongBookView(props);
  } finally {
    internals.H = prev;
  }
}

test('Wave 7 U31: NextDue surfaces top-level climb badge for weak->learning and learning->familiar, not new->learning', () => {
  const due = '2026-11-20T00:00:00.000Z';
  m.setUiLanguage('zh');
  try {
    const outOfWeak = renderToStaticMarkup(React.createElement(m.NextDue, {
      feedback: { correct: true, level: 'learning', nextDue: due },
      telemetry: { beforeLevel: 'weak', beforeDays: 0, afterDays: 1, deltaDays: 1 },
    }));
    const badgePos = outOfWeak.indexOf('data-testid="next-due-climb"');
    const detailsPos = outOfWeak.indexOf('<details');
    assert.ok(badgePos > -1, 'renders top-level climb badge');
    assert.ok(detailsPos === -1 || badgePos < detailsPos, 'climb badge stays outside the FSRS disclosure');
    assert.match(textOfHtml(outOfWeak), /脱离薄弱 · 薄弱 → 学习中/);

    const levelUp = renderToStaticMarkup(React.createElement(m.NextDue, {
      feedback: { correct: true, level: 'familiar', nextDue: due },
      telemetry: { beforeLevel: 'learning', beforeDays: 1, afterDays: 3, deltaDays: 2 },
    }));
    assert.match(levelUp, /data-testid="next-due-climb"/);
    assert.match(textOfHtml(levelUp), /熟练度进阶 · 学习中 → 熟悉/);

    const fromNew = renderToStaticMarkup(React.createElement(m.NextDue, {
      feedback: { correct: true, level: 'learning', nextDue: due },
      telemetry: { beforeLevel: 'new', beforeDays: 0, afterDays: 1, deltaDays: 1 },
    }));
    assert.doesNotMatch(fromNew, /data-testid="next-due-climb"/, 'first-seen new -> learning does not over-celebrate');

    m.setUiLanguage('en');
    const enWeak = renderToStaticMarkup(React.createElement(m.NextDue, {
      feedback: { correct: true, level: 'learning', nextDue: due },
      telemetry: { beforeLevel: 'weak', beforeDays: 0, afterDays: 1, deltaDays: 1 },
    }));
    const enClimb = /<span[^>]*data-testid="next-due-climb"[^>]*>([\s\S]*?)<\/span>/.exec(enWeak)?.[1] || '';
    assert.match(textOfHtml(enClimb), /Out of weak · Needs practice → Learning/);
    assert.doesNotMatch(textOfHtml(enClimb), CJK);

    const enUp = renderToStaticMarkup(React.createElement(m.NextDue, {
      feedback: { correct: true, level: 'familiar', nextDue: due },
      telemetry: { beforeLevel: 'learning', beforeDays: 1, afterDays: 3, deltaDays: 2 },
    }));
    const enUpClimb = /<span[^>]*data-testid="next-due-climb"[^>]*>([\s\S]*?)<\/span>/.exec(enUp)?.[1] || '';
    assert.match(textOfHtml(enUpClimb), /Level up · Learning → Familiar/);
    assert.doesNotMatch(textOfHtml(enUpClimb), CJK);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Wave 7 U32: TodayView shows all-done milestone when open=0 && done>0 and collapses empty lane noise', () => {
  m.setUiLanguage('zh');
  try {
    const doneData = makeTodayBoard({ openAm: 0, doneToday: 3 });
    const doneHtml = renderToStaticMarkup(React.createElement(m.TodayView, {
      board: doneData.board,
      today: doneData.today,
      library: { focus: { course: 'Systems' }, courses: [{ name: 'Systems', active: true }] },
      planAnswer: { status: 'no-plan', course: 'Systems' },
      onToggleDone: noop,
      onEdit: noop,
      onAction: noop,
      onOpenPlan: noop,
    }));
    assert.match(doneHtml, /data-testid="board-today-complete"/);
    assert.match(textOfHtml(doneHtml), /今日排程已全部完成/);
    assert.match(textOfHtml(doneHtml), /已完成 3 项任务/);
    assert.doesNotMatch(doneHtml, /board-today__lane-empty/, 'all-done suppresses redundant empty-lane hints');

    const partialData = makeTodayBoard({ openAm: 1, doneToday: 2 });
    const partialHtml = renderToStaticMarkup(React.createElement(m.TodayView, {
      board: partialData.board,
      today: partialData.today,
      library: { focus: { course: 'Systems' }, courses: [{ name: 'Systems', active: true }] },
      planAnswer: { status: 'no-plan', course: 'Systems' },
      onToggleDone: noop,
      onEdit: noop,
      onAction: noop,
      onOpenPlan: noop,
    }));
    assert.doesNotMatch(partialHtml, /data-testid="board-today-complete"/);
    assert.match(partialHtml, /board-today__lane-empty/, 'empty PM lane shows single hint when AM has open tasks');

    m.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(React.createElement(m.TodayView, {
      board: doneData.board,
      today: doneData.today,
      library: { focus: { course: 'Systems' }, courses: [{ name: 'Systems', active: true }] },
      planAnswer: { status: 'no-plan', course: 'Systems' },
      onToggleDone: noop,
      onEdit: noop,
      onAction: noop,
      onOpenPlan: noop,
    }));
    const bannerStart = enHtml.indexOf('data-testid="board-today-complete"');
    assert.ok(bannerStart > -1, 'EN TodayView renders completion banner');
    const bannerEnd = enHtml.indexOf('</div>', bannerStart);
    assert.ok(bannerEnd > bannerStart, 'EN completion banner has closing div');
    const banner = enHtml.slice(bannerStart, bannerEnd);
    assert.match(textOfHtml(banner), /All scheduled tasks completed/);
    assert.match(textOfHtml(banner), /3 tasks finished today/);
    assert.doesNotMatch(textOfHtml(banner), CJK);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Wave 7 U33: Review highlights all-correct rounds without extra buttons and ResultBreakdown displays attainment rate', () => {
  m.setUiLanguage('zh');
  try {
    const perfectHtml = renderResult();
    const imperfectHtml = renderResult({ correct: 4 });
    assert.match(perfectHtml, /result-mastery/);
    assert.match(perfectHtml, /data-all-correct="true"/);
    assert.match(perfectHtml, /data-testid="result-all-correct"[^>]*>本轮全部答对<\/span>/);
    assert.doesNotMatch(imperfectHtml, /data-all-correct="true"/);
    assert.doesNotMatch(imperfectHtml, /data-testid="result-all-correct"/);

    const selfHtml = renderResult({ selfAnswered: 2, objectiveAnswered: 3 });
    assert.match(selfHtml, /data-testid="result-all-correct"[^>]*>本轮全部达标<\/span>/);

    const actionButtons = (html) => ((/<div class="result-next">([\s\S]*?)<\/div>/.exec(html)?.[1] || '').match(/<button\b/g) || []).length;
    assert.equal(actionButtons(perfectHtml), actionButtons(imperfectHtml), 'perfect round adds zero extra action buttons');

    const bdZh = renderToStaticMarkup(React.createElement(m.ResultBreakdown, { total: 5, answered: 5, correct: 4 }));
    assert.match(bdZh, /<span class="result-breakdown-rate">达标率 80%<\/span>/);

    m.setUiLanguage('en');
    const enPerfect = renderResult();
    const enBadge = /<span[^>]*data-testid="result-all-correct"[^>]*>([\s\S]*?)<\/span>/.exec(enPerfect)?.[1] || '';
    assert.equal(textOfHtml(enBadge), 'All answered right this round');
    assert.doesNotMatch(enBadge, CJK);

    const bdEn = renderToStaticMarkup(React.createElement(m.ResultBreakdown, { total: 5, answered: 5, correct: 4 }));
    const enRate = /<span class="result-breakdown-rate">([\s\S]*?)<\/span>/.exec(bdEn)?.[1] || '';
    assert.equal(enRate, 'Attainment 80%');
    assert.doesNotMatch(enRate, CJK);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Wave 7 U34: WrongBook celebrates cleared active list when history exists and navigates to history', () => {
  m.setUiLanguage('zh');
  try {
    const htmlZh = renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: { busy: false, openModal: noop } },
      React.createElement(m.WrongBookView, wrongBookProps())));
    assert.match(htmlZh, /wb-cleared-milestone/);
    assert.match(htmlZh, /data-tone="success"/);
    assert.match(textOfHtml(htmlZh), /待巩固已清零 · 目前没有待巩固的题/);
    assert.match(textOfHtml(htmlZh), /已累计攻克并订正 4 道错题/);
    assert.match(textOfHtml(htmlZh), /查看已订正记录 \(4\)/);

    const viewed = [];
    const tree = mountWrongBookOnce(wrongBookProps({ onView: (next) => viewed.push(next) }));
    let historyWrap = null;
    walkTree(tree, (el) => { if (!historyWrap && el.props?.className === 'wb-cleared-history') historyWrap = el; });
    let historyBtn = null;
    walkTree(historyWrap, (el) => { if (!historyBtn && typeof el.props?.onClick === 'function') historyBtn = el; });
    assert.ok(historyBtn, 'renders history trigger inside wb-cleared-history');
    historyBtn.props.onClick();
    assert.deepEqual(viewed, ['history']);

    m.setUiLanguage('en');
    const htmlEn = renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: { busy: false, openModal: noop } },
      React.createElement(m.WrongBookView, wrongBookProps())));
    const clearedStart = htmlEn.indexOf('wb-cleared-milestone');
    const clearedSlice = htmlEn.slice(Math.max(0, clearedStart - 80), htmlEn.length);
    assert.match(textOfHtml(clearedSlice), /All caught up · No questions waiting for review/);
    assert.match(textOfHtml(clearedSlice), /You have corrected 4 mistakes so far/);
    assert.match(textOfHtml(clearedSlice), /View corrected history \(4\)/);
    assert.doesNotMatch(textOfHtml(clearedSlice), CJK);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Wave 7 U31-U34 CSS polish guardrails remain owned and cleanly scoped', async () => {
  const [resultsCss, practiceCss, boardCss, componentsCss] = await Promise.all([
    readFile('ui/review-results.css', 'utf8'),
    readFile('ui/document-preview/practice/practice.css', 'utf8'),
    readFile('ui/board/board.css', 'utf8'),
    readFile('ui/components/components.css', 'utf8'),
  ]);
  assert.match(resultsCss, /\.result-page \.result-mastery\s*\{[^}]*border:\s*1px solid var\(--line\);[^}]*background:\s*var\(--bg-raised\);/s);
  assert.match(practiceCss, /\.result-mastery \.reading-result__rail\s*\{\s*max-width:\s*none;\s*\}/);
  assert.match(boardCss, /\.board-today__lane-cards:empty\s*\{\s*min-height:\s*0;\s*\}/);
  assert.match(componentsCss, /\.sh-empty\[data-tone="success"\] \.sh-empty__icon\s*\{/);
});
