import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export * from './ui/desk-play/lucky-card.js';
      export * from './ui/desk-play/desk-play-storage.js';
      export { default as OrigamiMark } from './ui/desk-play/OrigamiMark.jsx';
      export { default as DeskPlayStrip } from './ui/desk-play/DeskPlayStrip.jsx';
      export { default as StudyMap } from './ui/StudyMap.jsx';
      export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const dp = mod.exports;
const h = React.createElement;
const HAN = /[\u3400-\u9fff]/;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

test('computeTodayOrigami steps cleanly through all 5 stages and ignores retries or older days', () => {
  const now = new Date(2026, 9, 15, 14, 30, 0);
  const todayIso = new Date(2026, 9, 15, 9, 0, 0).toISOString();
  const yesterdayIso = new Date(2026, 9, 14, 21, 0, 0).toISOString();
  const mkAttempts = (count) => [
    ...Array.from({ length: count }, () => ({ timestamp: todayIso })),
    { timestamp: todayIso, retry: true },
    { timestamp: yesterdayIso },
  ];

  const base = (count, extra = {}) => dp.computeTodayOrigami({
    attempts: mkAttempts(count),
    settings: { practice: { roundSize: 10 } },
    today: { ahead: false },
    ...extra,
  }, now);

  assert.equal(base(0).stage, 0);
  assert.equal(base(0).done, 0);
  assert.equal(base(0).goal, 10);

  assert.equal(base(2).stage, 1);
  assert.equal(base(4).stage, 2);
  assert.equal(base(7).stage, 3);
  assert.equal(base(10).stage, 4);
  assert.equal(base(14).ratio, 1);

  // Completing today's planned round early (today.ahead) with at least 1 attempt reaches stage 4.
  const finishedEarly = base(3, { today: { ahead: true } });
  assert.equal(finishedEarly.stage, 4);
  assert.equal(finishedEarly.ratio, 1);
});

test('eligibleDecksForSlip and pickDeckId skip archived/inactive/empty decks and prefer learner decks', () => {
  const decks = [
    { id: 'archived', archived: true, available: 5 },
    { id: 'parked', inactive: true, available: 5 },
    { id: 'empty', available: 0 },
    { id: 'sys', systemKind: 'slain', available: 8 },
    { id: 'own-a', title: 'Calculus', available: 4 },
    { id: 'own-b', title: 'Organic Chem', available: 6 },
  ];
  const eligible = dp.eligibleDecksForSlip(decks);
  assert.deepEqual(eligible.map((d) => d.id), ['own-a', 'own-b']);
  assert.equal(dp.pickDeckId(decks, ['own-a'], () => 0), 'own-b');
  assert.equal(dp.pickDeckId([decks[3]], [], () => 0), 'sys', 'falls back to system deck when no own decks exist');
  assert.equal(dp.pickDeckId([], [], () => 0), null);
});

test('pickRandomCard skips suspended cards and avoids immediate repeat; extractSlipCard handles every card kind', () => {
  const cards = [
    { id: 'c0', suspended: true, prompt: 'Hidden' },
    { id: 'c1', kind: 'flashcard', topic: 'Thermodynamics', prompt: 'State the first law.', answer: 'dU = dQ - dW', explanation: 'Energy is conserved.' },
    {
      id: 'c2',
      kind: 'quiz',
      topic: 'Kinetics',
      prompt: 'What does a catalyst change?',
      answer: 'b',
      options: [
        { id: 'a', text: 'Equilibrium constant', correct: false },
        { id: 'b', text: 'Activation energy', correct: true },
      ],
      explanation: 'It lowers the transition state barrier.',
    },
    {
      id: 'c3',
      kind: 'cloze',
      topic: 'Linear Algebra',
      prompt: 'A matrix is invertible iff its {{b1}} is non-zero.',
      answer: '',
      cloze: { text: '...', answers: [{ id: 'b1', value: 'determinant' }] },
      explanation: '',
    },
  ];
  const deck = { id: 'd1', title: 'Chemistry & Math', course: 'STEM 101', cards };

  const picked = dp.pickRandomCard(cards, 'c1', () => 0);
  assert.equal(picked.id, 'c2');

  const quizSlip = dp.extractSlipCard(cards[2], deck);
  assert.equal(quizSlip.answer, 'Activation energy');
  assert.equal(quizSlip.deckTitle, 'Chemistry & Math');
  assert.equal(quizSlip.topic, 'Kinetics');

  const clozeSlip = dp.extractSlipCard(cards[3], deck);
  assert.equal(clozeSlip.prompt, 'A matrix is invertible iff its ＿＿ is non-zero.');
  assert.equal(clozeSlip.answer, 'determinant');
});

test('desk-play storage persists hide preference safely and recovers from malformed JSON', () => {
  const local = memoryStorage();
  assert.equal(dp.readDeskPlayPrefs(local).hidden, false);
  dp.writeDeskPlayPrefs({ hidden: true }, local);
  assert.equal(dp.readDeskPlayPrefs(local).hidden, true);
  local.setItem(dp.DESK_PLAY_STORAGE_KEY, '{bad-json');
  assert.equal(dp.readDeskPlayPrefs(local).hidden, false);
});

test('OrigamiMark, DeskPlayStrip, and StudyMap render cleanly in zh and en without Han leaks', () => {
  const sampleDeck = { id: 'd1', title: 'Patterns', folder: 'CS3219', course: 'CS3219', topics: ['Memento'], available: 5, count: 5, quizCount: 3, createdAt: '2026-09-01T00:00:00Z' };
  const sampleData = {
    root: '/tmp/lib',
    decks: [sampleDeck],
    progress: { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active', topics: [] } },
    sources: [{ id: 's1' }],
    drafts: [],
    jobs: [],
    runs: [],
    attempts: [],
    today: { due: 1, weak: 1, new: 1, size: 3 },
    focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] },
  };
  const noop = () => {};

  dp.setUiLanguage('zh');
  for (let stage = 0; stage <= 4; stage += 1) {
    const mark = renderToStaticMarkup(h(dp.OrigamiMark, { stage, done: stage * 5, goal: 20, label: dp.ORIGAMI_STAGES[stage].label, caption: dp.ORIGAMI_STAGES[stage].caption }));
    assert.match(mark, new RegExp(`data-stage="${stage}"`));
    assert.match(mark, /<svg[^>]*aria-hidden="true"/);
    if (stage <= 2) {
      assert.match(mark, /<path class="desk-play-origami__accent-fold"/, `stage ${stage} includes cinnabar SVG fold accent`);
    } else {
      assert.match(mark, /<circle class="desk-play-origami__seal"/, `stage ${stage} includes cinnabar seal`);
    }
  }

  const stripZh = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { call: async () => sampleDeck } },
    h(dp.DeskPlayStrip, { data: sampleData, onPracticeDeck: noop })));
  assert.match(stripZh, /随手抽一签/);
  assert.match(stripZh, /今日折纸/);
  assert.doesNotMatch(stripZh, /草稿纸/, 'scratchpad launcher is removed from DeskPlayStrip');
  assert.doesNotMatch(stripZh, /<h1\b/, 'strip never adds a competing h1');
  assert.doesNotMatch(stripZh, /sh-btn--primary/, 'strip never competes with TodayCard primary CTA');

  const emptyStripZh = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { call: async () => null } },
    h(dp.DeskPlayStrip, { data: { ...sampleData, decks: [] }, onPracticeDeck: noop })));
  assert.match(emptyStripZh, /发布第一组题后/);

  // Deterministic SSR on StudyMap with DeskPlayStrip mounted
  const mapA = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { call: async () => sampleDeck, act: async () => {}, host: {}, openModal: noop } },
    h(dp.StudyMap, { data: sampleData, actions: { start: noop, resume: noop, manage: noop, removeDeck: noop, openDraft: noop, topUpDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, generateFromSources: noop } })));
  const mapB = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { call: async () => sampleDeck, act: async () => {}, host: {}, openModal: noop } },
    h(dp.StudyMap, { data: sampleData, actions: { start: noop, resume: noop, manage: noop, removeDeck: noop, openDraft: noop, topUpDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, generateFromSources: noop } })));
  assert.equal(mapA, mapB, 'StudyMap SSR stays deterministic with DeskPlayStrip');

  dp.setUiLanguage('en');
  try {
    const stripEn = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { call: async () => sampleDeck } },
      h(dp.DeskPlayStrip, { data: sampleData, onPracticeDeck: noop })));
    assert.match(stripEn, /Serendipity slip/);
    assert.match(stripEn, /Daily origami/);
    assert.doesNotMatch(stripEn, /scratchpad/i);
    assert.doesNotMatch(stripEn, HAN, 'zero Han in English DeskPlayStrip');
  } finally {
    dp.setUiLanguage('zh');
  }
});

test('ShortcutHelp keeps Alt+Shift+A in zh and en without Han leaks, and origami accent CSS holds', () => {
  const noop = () => {};

  dp.setUiLanguage('zh');
  for (const page of ['home', 'review']) {
    const helpZh = renderToStaticMarkup(h(dp.ShortcutHelp, { page, onClose: noop }));
    assert.match(helpZh, /<kbd>Alt\+Shift\+A<\/kbd><\/dt><dd>打开 \/ 关闭书房声景与光影<\/dd>/);
    assert.doesNotMatch(helpZh, /Alt\+Shift\+D|毛笔草稿纸/);
  }

  dp.setUiLanguage('en');
  try {
    for (const page of ['home', 'review']) {
      const helpEn = renderToStaticMarkup(h(dp.ShortcutHelp, { page, onClose: noop }));
      assert.match(helpEn, /<kbd>Alt\+Shift\+A<\/kbd><\/dt><dd>Toggle desk soundscape &amp; lighting<\/dd>/);
      assert.doesNotMatch(helpEn, /Alt\+Shift\+D|scratchpad/i);
      assert.doesNotMatch(helpEn, HAN, `zero Han in English ShortcutHelp (${page})`);
    }
  } finally {
    dp.setUiLanguage('zh');
  }

  const { declarations } = parseCss(readFileSync(new URL('../ui/desk-play/desk-play.css', import.meta.url), 'utf8'));
  const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());
  const accentFoldDecls = declarations.filter(
    (d) => splitSelectors(d.ctx.at(-1) || '').includes('.desk-play-origami__accent-fold'),
  );
  assert.equal(
    accentFoldDecls.some((d) => d.prop === 'stroke' && d.value === 'var(--accent)'),
    true,
    '.desk-play-origami__accent-fold paints its stroke with var(--accent)',
  );
});
