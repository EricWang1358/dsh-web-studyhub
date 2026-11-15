import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { summarizeLinked } from '../lib/material-summary.js';

const require = createRequire(import.meta.url);
const han = /[\u3400-\u9fff]/;
const noop = () => {};

const uiMod = await loadUi(`
  export { StatsView } from './ui/Dashboard.jsx';
  export { MasteryPanel } from './ui/charts/DashboardCharts.jsx';
  export { default as TaskCardRun } from './ui/TaskCardRun.jsx';
  export { default as ReadingPractice } from './ui/document-preview/practice/ReadingPractice.jsx';
  export { MasteryChange, ReadingResult } from './ui/document-preview/practice/ReadingReturn.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

function withMemoryStorage(initialEntries, fn) {
  const map = new Map(Object.entries(initialEntries || {}));
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    },
  });
  try {
    return fn();
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  }
}

const render = (el, { call = async () => ({}) } = {}) => renderToStaticMarkup(
  React.createElement(
    uiMod.StudyServicesContext.Provider,
    { value: { call, busy: false, notify: noop } },
    el,
  ),
);

test('U43: Dashboard weak-topics cleared & MasteryPanel all-met positive feedback and honest guards (zh & en)', () => {
  const days = Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 2).padStart(2, '0')}`, count: 0, cards: [] }));
  const allMetMastery = {
    windowDays: 30,
    minAnswers: 3,
    levels: [
      { id: 'recall', n: 10, met: 9, rate: 90, enough: true },
      { id: 'concept', n: 6, met: 5, rate: 83, enough: true },
      { id: 'apply', n: 1, met: 1, rate: null, enough: false },
    ],
    kinds: [
      { id: 'quiz', n: 12, met: 10, rate: 83, enough: true },
      { id: 'flashcard', n: 4, met: 3, rate: 75, enough: true },
    ],
  };
  const partialMastery = {
    windowDays: 30,
    minAnswers: 3,
    levels: [
      { id: 'recall', n: 10, met: 9, rate: 90, enough: true },
      { id: 'apply', n: 5, met: 2, rate: 40, enough: true },
    ],
    kinds: [],
  };
  const baseStats = (patch = {}) => ({
    generatedAt: '2026-10-02T04:00:00Z',
    today: '2026-10-02',
    totals: { attempts: 25, activeDays: 4, streak: 2, due: 0, gradedRate: 84, gradedAttempts: 15, selfRate: 80, selfAttempts: 10, oralAttempts: 0, oralStrong: 0 },
    heatmap: [],
    trend: [],
    forecast: { days, later: 0 },
    mastery: allMetMastery,
    weakTopics: [],
    ...patch,
  });

  uiMod.setUiLanguage('zh');
  const clearedZh = render(React.createElement(uiMod.StatsView, {
    stats: baseStats(), course: '*', data: { decks: [], focus: {} }, busy: false,
    onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop,
  }));
  assert.match(clearedZh, /data-weak-cleared="true"/);
  assert.match(clearedZh, /data-testid="dash-weak-clear"/);
  assert.match(clearedZh, /已清零/);
  assert.match(clearedZh, /最近没有明显薄弱的主题，继续保持。/);
  assert.match(clearedZh, /data-all-met="true"/);
  assert.match(clearedZh, /data-testid="dash-mastery-all-met"/);
  assert.match(clearedZh, /已统计维度均已达标/);

  uiMod.setUiLanguage('en');
  const clearedEn = render(React.createElement(uiMod.StatsView, {
    stats: baseStats(), course: '*', data: { decks: [], focus: {} }, busy: false,
    onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop,
  }));
  assert.doesNotMatch(clearedEn, han);
  assert.match(clearedEn, /All clear/);
  assert.match(clearedEn, /All measured dimensions meet target/);

  uiMod.setUiLanguage('zh');
  const zeroAttempts = render(React.createElement(uiMod.StatsView, {
    stats: baseStats({ totals: { attempts: 0, activeDays: 0, streak: 0, due: 0, gradedRate: null, selfRate: null } }),
    course: '*', data: { decks: [], focus: {} }, busy: false,
    onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop,
  }));
  assert.doesNotMatch(zeroAttempts, /data-weak-cleared="true"/);
  assert.doesNotMatch(zeroAttempts, /data-testid="dash-weak-clear"/);
  assert.doesNotMatch(zeroAttempts, /已清零/);

  const withWeak = render(React.createElement(uiMod.StatsView, {
    stats: baseStats({ weakTopics: [{ deckId: 'd1', deckTitle: 'OS', course: 'CS', topic: 'Locks', wrong: 2, detail: '2 错' }] }),
    course: '*', data: { decks: [], focus: {} }, busy: false,
    onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop,
  }));
  assert.doesNotMatch(withWeak, /data-weak-cleared="true"/);
  assert.doesNotMatch(withWeak, /已清零/);

  const partialPanel = render(React.createElement(uiMod.MasteryPanel, { mastery: partialMastery }));
  assert.doesNotMatch(partialPanel, /data-all-met="true"/);
  assert.doesNotMatch(partialPanel, /已统计维度均已达标/);

  const thinOnlyPanel = render(React.createElement(uiMod.MasteryPanel, {
    mastery: { windowDays: 30, minAnswers: 3, levels: [{ id: 'recall', n: 2, met: 2, rate: null, enough: false }], kinds: [] },
  }));
  assert.doesNotMatch(thinOnlyPanel, /data-all-met="true"/);
  assert.doesNotMatch(thinOnlyPanel, /已统计维度均已达标/);
});

test('U44: DailyRecapPanel shows zero-mistakes recognition only when answered > 0 and zero wrong/unassessed (zh & en)', async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { querySelector: () => ({ textContent: '' }) };
  try {
    const built = await build({
      stdin: {
        contents: `export { DailyRecapPanel } from './ui/DailyRecap.jsx';
          export { StudyServicesContext } from './ui/study-context.jsx';
          export { setUiLanguage } from './ui/i18n.js';`,
        resolveDir: process.cwd(),
      },
      bundle: true, write: false, platform: 'node', format: 'cjs',
      external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent',
    });
    const load = (fn) => { const m = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(fn, m, m.exports); return m.exports; };
    let active, studyContext;
    const hook = (initial) => { const i = active.cursor++; if (!(i in active.slots)) active.slots[i] = initial(); return [i, active.slots[i]]; };
    const hooks = {
      ...React,
      useState: (initial) => {
        const owner = active, [i, val] = hook(() => (typeof initial === 'function' ? initial() : initial));
        return [val, (next) => { owner.slots[i] = typeof next === 'function' ? next(owner.slots[i]) : next; }];
      },
      useContext: (ctx) => (ctx === studyContext ? globalThis.__study ?? null : null),
      useRef: (v) => hook(() => ({ current: v }))[1],
      useId: () => hook(() => `recap-${active.cursor}`)[1],
      useInsertionEffect: () => {},
      useEffect: (cb, deps) => {
        const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
        if (!slot.deps || deps.some((v, idx) => v !== slot.deps[idx])) {
          active.effects.push(() => { slot.cleanup?.(); slot.cleanup = cb(); });
          slot.deps = deps;
        }
      },
    };
    for (const n of ['useState', 'useRef', 'useEffect']) {
      const m = hooks[n];
      hooks[n] = (...args) => (active ? m(...args) : React[n](...args));
    }
    const mods = load((name) => (name === 'react' ? hooks : require(name)));
    studyContext = mods.StudyServicesContext;
    const settle = () => new Promise((r) => setImmediate(r));
    const renderGroup = async (group) => {
      const owner = { cursor: 0, slots: [], effects: [] };
      const call = async () => ({ day: '2026-10-04', tone: 'friendly', automatic: false, groups: [group] });
      const exec = () => {
        owner.cursor = 0; active = owner; globalThis.__study = { root: 'r', call, busy: false };
        try { return mods.DailyRecapPanel({ root: 'r', call }); } finally { active = null; globalThis.__study = null; }
      };
      exec();
      owner.effects.splice(0).forEach((fn) => fn());
      await settle();
      return renderToStaticMarkup(exec());
    };

    const clean = { day: '2026-10-04', course: 'Databases', courseId: 'db', answeredCount: 10, wrongCount: 0, unassessedCount: 0, eligible: true, remaining: 0, hasContent: true, noteId: 'n1' };
    mods.setUiLanguage('zh');
    const cleanZh = await renderGroup(clean);
    assert.match(cleanZh, /data-all-clear="true"/);
    assert.match(cleanZh, /data-testid="daily-recap-clear"/);
    assert.match(cleanZh, /今日零错题/);

    mods.setUiLanguage('en');
    const cleanEn = await renderGroup(clean);
    assert.doesNotMatch(cleanEn, han);
    assert.match(cleanEn, /Zero mistakes today/);

    mods.setUiLanguage('zh');
    const pendingHtml = await renderGroup({ ...clean, unassessedCount: 2 });
    assert.doesNotMatch(pendingHtml, /data-all-clear="true"/);
    assert.doesNotMatch(pendingHtml, /今日零错题/);

    const wrongHtml = await renderGroup({ ...clean, wrongCount: 1 });
    assert.doesNotMatch(wrongHtml, /data-all-clear="true"/);
    assert.doesNotMatch(wrongHtml, /今日零错题/);

    const emptyHtml = await renderGroup({ ...clean, answeredCount: 0, eligible: false, remaining: 10, hasContent: false, noteId: null });
    assert.doesNotMatch(emptyHtml, /data-all-clear="true"/);
    assert.doesNotMatch(emptyHtml, /今日零错题/);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('U45: TaskCardRun highlights full self-check and independent static verification with honest guards (zh & en)', () => {
  const card = {
    id: 'task-1',
    kind: 'task',
    topic: 'Transactions',
    prompt: 'Implement transferable ledger post.',
    answer: '```sql\nBEGIN;\nCOMMIT;\n```',
    marks: 6,
    rubricCriteria: [
      { id: 'c1', label: 'Uses transaction lock', marks: 3, descriptor: 'Locks source row first' },
      { id: 'c2', label: 'Rejects negative amount', marks: 3, descriptor: 'Checks amount > 0' },
    ],
  };

  uiMod.setUiLanguage('zh');
  const allCheckedZh = withMemoryStorage(
    { 'study-case::task:run-1:task-1': JSON.stringify({ checked: ['c1', 'c2'] }) },
    () => render(React.createElement(uiMod.TaskCardRun, {
      run: { id: 'run-1', index: 0, deckId: 'd1', card, feedback: null },
      data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
    })),
  );
  assert.match(allCheckedZh, /data-all-checked="true"/);
  assert.match(allCheckedZh, /data-testid="task-all-checked"/);
  assert.match(allCheckedZh, /自检已完成/);
  assert.match(allCheckedZh, /已自检 2\/2 项/);

  uiMod.setUiLanguage('en');
  const allCheckedEn = withMemoryStorage(
    { 'study-case::task:run-1:task-1': JSON.stringify({ checked: ['c1', 'c2'] }) },
    () => render(React.createElement(uiMod.TaskCardRun, {
      run: { id: 'run-1', index: 0, deckId: 'd1', card, feedback: null },
      data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
    })),
  );
  assert.doesNotMatch(allCheckedEn, han);
  assert.match(allCheckedEn, /Self-check complete/);

  uiMod.setUiLanguage('zh');
  const partialChecked = withMemoryStorage(
    { 'study-case::task:run-1:task-1': JSON.stringify({ checked: ['c1'] }) },
    () => render(React.createElement(uiMod.TaskCardRun, {
      run: { id: 'run-1', index: 0, deckId: 'd1', card, feedback: null },
      data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
    })),
  );
  assert.doesNotMatch(partialChecked, /data-all-checked="true"/);
  assert.doesNotMatch(partialChecked, /自检已完成/);

  const satisfiedChecks = [
    { id: 'c1', label: 'Uses transaction lock', status: 'satisfied' },
    { id: 'c2', label: 'Rejects negative amount', status: 'satisfied' },
  ];
  const verifiedZh = render(React.createElement(uiMod.TaskCardRun, {
    run: {
      id: 'run-1', index: 0, deckId: 'd1', card,
      feedback: { grade: 5, rubric: { total: 6, max: 6 }, taskCheck: { checks: satisfiedChecks, files: ['tx.sql'] } },
    },
    data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
  }));
  assert.match(verifiedZh, /data-all-satisfied="true"/);
  assert.match(verifiedZh, /data-testid="task-independent-badge"/);
  assert.match(verifiedZh, /独立完成验收/);

  uiMod.setUiLanguage('en');
  const verifiedEn = render(React.createElement(uiMod.TaskCardRun, {
    run: {
      id: 'run-1', index: 0, deckId: 'd1', card,
      feedback: { grade: 5, rubric: { total: 6, max: 6 }, taskCheck: { checks: satisfiedChecks, files: ['tx.sql'] } },
    },
    data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
  }));
  assert.doesNotMatch(verifiedEn, han);
  assert.match(verifiedEn, /Verified independently/);

  uiMod.setUiLanguage('zh');
  const viewedFirst = render(React.createElement(uiMod.TaskCardRun, {
    run: {
      id: 'run-1', index: 0, deckId: 'd1', card,
      feedback: { grade: 4, revealedBeforeAnswer: true, rubric: { total: 6, max: 6 }, taskCheck: { checks: satisfiedChecks, files: ['tx.sql'] } },
    },
    data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
  }));
  assert.match(viewedFirst, /静态检查通过/);
  assert.doesNotMatch(viewedFirst, /data-testid="task-independent-badge"/);
  assert.doesNotMatch(viewedFirst, /独立完成验收/);

  const hasIssue = render(React.createElement(uiMod.TaskCardRun, {
    run: {
      id: 'run-1', index: 0, deckId: 'd1', card,
      feedback: {
        grade: 3,
        taskCheck: { checks: [satisfiedChecks[0], { id: 'c2', label: 'Rejects negative amount', status: 'issue', line: 3 }], files: ['tx.sql'] },
      },
    },
    data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
  }));
  assert.doesNotMatch(hasIssue, /data-all-satisfied="true"/);
  assert.doesNotMatch(hasIssue, /独立完成验收/);

  const selfRep = render(React.createElement(uiMod.TaskCardRun, {
    run: {
      id: 'run-1', index: 0, deckId: 'd1', card,
      feedback: { grade: 4, selfReported: true, assessment: 'self-report', taskCheck: { checks: satisfiedChecks } },
    },
    data: { root: '', decks: [{ id: 'd1', title: 'DB' }] },
  }));
  assert.doesNotMatch(selfRep, /data-testid="task-static-result"/);
  assert.doesNotMatch(selfRep, /独立完成验收/);
});

test('U46: ReadingResult and ReadingPractice mark all-mastered completion cleanly and preserve reading-result class (zh & en)', () => {
  const before = summarizeLinked([{ level: 'mastered' }, { level: 'learning' }]);
  const masteredAfter = summarizeLinked([{ level: 'mastered' }, { level: 'mastered' }]);
  const learningAfter = summarizeLinked([{ level: 'learning' }, { level: 'familiar' }]);

  uiMod.setUiLanguage('zh');
  const resultMastered = render(React.createElement(uiMod.ReadingResult, {
    run: {
      reading: {
        page: 12,
        sectionTitle: '2PC Protocol',
        scope: 'here',
        before,
        after: masteredAfter,
      },
    },
    onReturn: noop,
    busy: false,
  }));
  assert.match(resultMastered, /class="reading-result"/);
  assert.match(resultMastered, /data-mastered="true"/);

  const resultPartial = render(React.createElement(uiMod.ReadingResult, {
    run: { reading: { page: 12, sectionTitle: '2PC Protocol', scope: 'here', before, after: learningAfter } },
    onReturn: noop,
    busy: false,
  }));
  assert.doesNotMatch(resultPartial, /data-mastered="true"/);

  const loopOf = (summary) => {
    const selected = { kind: 'here', count: 1, ids: new Set(['p-1']), cards: [], summary };
    return { open: true, setOpen: noop, status: 'ready', options: [selected], selected, kind: 'here', setKind: noop, reload: noop, inactiveCourses: [] };
  };

  const practiceMasteredZh = render(React.createElement(uiMod.ReadingPractice, { loop: loopOf(masteredAfter), unit: 'page', onStart: noop, onGenerate: noop }));
  assert.match(practiceMasteredZh, /data-state="mastered"/);
  assert.match(practiceMasteredZh, /data-testid="practice-mastered"/);
  assert.match(practiceMasteredZh, /当前范围已全部掌握，可随时巩固或继续往下读。/);

  uiMod.setUiLanguage('en');
  const practiceMasteredEn = render(React.createElement(uiMod.ReadingPractice, { loop: loopOf(masteredAfter), unit: 'page', onStart: noop, onGenerate: noop }));
  assert.doesNotMatch(practiceMasteredEn, han);
  assert.match(practiceMasteredEn, /All questions in this range are mastered/);

  uiMod.setUiLanguage('zh');
  const practiceLearning = render(React.createElement(uiMod.ReadingPractice, { loop: loopOf(learningAfter), unit: 'page', onStart: noop, onGenerate: noop }));
  assert.doesNotMatch(practiceLearning, /data-testid="practice-mastered"/);
  assert.doesNotMatch(practiceLearning, /当前范围已全部掌握/);
});
