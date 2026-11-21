import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getStroke } from 'perfect-freehand';
import rough from 'roughjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export * from './ui/desk-play/lucky-card.js';
      export * from './ui/desk-play/desk-play-storage.js';
      export * from './ui/desk-play/ink-engine.js';
      export { default as OrigamiMark } from './ui/desk-play/OrigamiMark.jsx';
      export { default as DeskPlayStrip } from './ui/desk-play/DeskPlayStrip.jsx';
      export { default as InkScratchpadDialog } from './ui/desk-play/InkScratchpadDialog.jsx';
      export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
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
  external: ['react', 'react-dom', 'perfect-freehand', 'roughjs'],
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

test('desk-play storage persists hide preference and sanitizes session scratchpad strokes safely', () => {
  const local = memoryStorage();
  assert.equal(dp.readDeskPlayPrefs(local).hidden, false);
  dp.writeDeskPlayPrefs({ hidden: true }, local);
  assert.equal(dp.readDeskPlayPrefs(local).hidden, true);
  local.setItem(dp.DESK_PLAY_STORAGE_KEY, '{bad-json');
  assert.equal(dp.readDeskPlayPrefs(local).hidden, false);

  const session = memoryStorage();
  dp.writeScratchpadSession({
    tool: 'arrow',
    ink: 'cinnabar',
    weight: 'broad',
    paper: 'grid',
    strokes: [
      { id: 'b1', kind: 'brush', ink: 'ink', weight: 'medium', points: [[10.25, 20.75, 0.7], ['bad']] },
      { id: 'a1', kind: 'arrow', ink: 'cinnabar', weight: 'fine', seed: 9, x1: 12, y1: 14, x2: 120, y2: 88 },
      { id: 'bad', kind: 'unknown' },
    ],
  }, session);

  const loaded = dp.readScratchpadSession(session);
  assert.equal(loaded.tool, 'arrow');
  assert.equal(loaded.ink, 'cinnabar');
  assert.equal(loaded.paper, 'grid');
  assert.equal(loaded.strokes.length, 2);
  assert.deepEqual(loaded.strokes[0].points, [[10.3, 20.8, 0.7]]);

  const cleared = dp.clearScratchpadSession(session);
  assert.deepEqual(cleared.strokes, []);
  assert.equal(cleared.paper, 'grid');
});

test('ink-engine builds perfect-freehand brush paths, roughjs shapes, snapped endpoints, and standalone SVG export', () => {
  const strokeD = dp.strokePathData(getStroke, [[20, 20, 0.5], [60, 45, 0.7], [110, 80, 0.4]], 'medium');
  assert.match(strokeD, /^M\s[\d.-]+\s[\d.-]+.*Z$/);

  const dotD = dp.strokePathData(getStroke, [[50, 50, 0.6]], 'fine');
  assert.match(dotD, /^M\s.*Z$/);

  const roughGenerator = rough.generator();
  const box = dp.shapePaths(roughGenerator, { kind: 'box', weight: 'medium', seed: 42, x1: 20, y1: 30, x2: 140, y2: 90 }, '#201b15');
  assert.ok(box.length >= 1 && box[0].d.length > 10);

  const circle = dp.shapePaths(roughGenerator, { kind: 'circle', weight: 'fine', seed: 7, x1: 50, y1: 50, x2: 150, y2: 120 }, '#1c613f');
  assert.ok(circle.length >= 1 && circle[0].d.length > 10);

  const arrow = dp.shapePaths(roughGenerator, { kind: 'arrow', weight: 'broad', seed: 13, x1: 30, y1: 40, x2: 200, y2: 160 }, '#c03a1f');
  assert.equal(arrow.length, 3, 'arrow renders shaft plus 2 arrowhead barbs');

  assert.deepEqual(dp.snapShapeEnd('box', 10, 10, 40, 90, true), { x2: 90, y2: 90 });
  const snappedArrow = dp.snapShapeEnd('arrow', 0, 0, 100, 12, true);
  assert.ok(Math.abs(snappedArrow.y2) < 1e-6, 'near-horizontal arrow snaps cleanly to 0 deg');

  // Pointer mapping handles both getScreenCTM().inverse() and letterboxed fallback accurately.
  const ctmSvg = {
    getScreenCTM: () => ({ inverse: () => ({ a: 2, d: 2, e: -20, f: -10 }) }),
    createSVGPoint: () => ({
      x: 0,
      y: 0,
      matrixTransform(m) { return { x: this.x * m.a + m.e, y: this.y * m.d + m.f }; },
    }),
  };
  assert.deepEqual(dp.clientToCanvasPoint(ctmSvg, 60, 45), [100, 80]);

  // Letterboxed 4:3 container (480x360) holding a 960x560 viewBox: drawn height is 280 centered at y=40.
  const letterboxSvg = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 480, height: 360 }) };
  assert.deepEqual(dp.clientToCanvasPoint(letterboxSvg, 250, 200), [480, 280]);
  assert.deepEqual(dp.clientToCanvasPoint(letterboxSvg, 10, 60), [0, 0]);

  const strokes = [
    { id: 's1', kind: 'brush', ink: 'ink', weight: 'medium', points: [[20, 20, 0.5], [80, 60, 0.6], [140, 40, 0.4]] },
    { id: 's2', kind: 'arrow', ink: 'cinnabar', weight: 'fine', seed: 5, x1: 100, y1: 100, x2: 260, y2: 180 },
  ];
  for (const paper of ['blank', 'grid', 'ruled']) {
    const svg = dp.buildExportSvg({ paper, strokes, getStrokeFn: getStroke, roughGenerator });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 960 560"/);
    assert.match(svg, /<\/svg>$/);
    assert.ok((svg.match(/<path /g) || []).length >= 4, `${paper}: includes brush and roughjs paths`);
    if (paper === 'grid') assert.match(svg, /id="sh-export-grid"/);
    if (paper === 'ruled') assert.match(svg, /id="sh-export-ruled"/);
  }
});

test('OrigamiMark, DeskPlayStrip, InkScratchpadDialog, and ReviewToolbar render cleanly in zh and en without Han leaks', () => {
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
  assert.match(stripZh, /毛笔草稿纸/);
  assert.doesNotMatch(stripZh, /<h1\b/, 'strip never adds a competing h1');
  assert.doesNotMatch(stripZh, /sh-btn--primary/, 'strip never competes with TodayCard primary CTA');

  const emptyStripZh = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { call: async () => null } },
    h(dp.DeskPlayStrip, { data: { ...sampleData, decks: [] }, onPracticeDeck: noop })));
  assert.match(emptyStripZh, /发布第一组题后/);

  const dialogZh = renderToStaticMarkup(h(dp.InkScratchpadDialog, { onClose: noop, contextLabel: 'Thermodynamics' }));
  assert.match(dialogZh, /毛笔草稿纸/);
  assert.match(dialogZh, /导出 SVG/);
  assert.match(dialogZh, /导出 PNG/);

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
    assert.match(stripEn, /Ink scratchpad/);
    assert.doesNotMatch(stripEn, HAN, 'zero Han in English DeskPlayStrip');

    const dialogEn = renderToStaticMarkup(h(dp.InkScratchpadDialog, { onClose: noop, contextLabel: 'Thermodynamics' }));
    assert.match(dialogEn, /Ink scratchpad/);
    assert.match(dialogEn, /Export SVG/);
    assert.match(dialogEn, /Export PNG/);
    assert.doesNotMatch(dialogEn, HAN, 'zero Han in English InkScratchpadDialog');

    const toolbarEn = renderToStaticMarkup(h(dp.StudyServicesContext.Provider, { value: { busy: false } },
      h(dp.ReviewToolbar, {
        run: { id: 'r1', index: 0, total: 2, mode: 'path', card: { id: 'q1', kind: 'quiz', topic: 'Kinetics', prompt: 'P?', options: [] }, feedback: null },
        onToggleHelp: noop, onAsk: noop, onImprove: noop, onSlay: noop, onNote: noop, onReviewAction: noop,
      })));
    assert.match(toolbarEn, />Scratchpad</);
    assert.match(toolbarEn, /aria-keyshortcuts="Alt\+Shift\+D"/);
    assert.doesNotMatch(toolbarEn.replace(/data-usage="[^"]*"/g, ''), HAN, 'zero Han in English ReviewToolbar');
  } finally {
    dp.setUiLanguage('zh');
  }
});

test('Wave 3 studio polish: ShortcutHelp documents Alt+Shift+A/D, hosts guard Alt+Shift+D, and origami/pigment CSS tokens hold', () => {
  const noop = () => {};

  dp.setUiLanguage('zh');
  for (const page of ['home', 'review']) {
    const helpZh = renderToStaticMarkup(h(dp.ShortcutHelp, { page, onClose: noop }));
    assert.match(helpZh, /<kbd>Alt\+Shift\+A<\/kbd><\/dt><dd>打开 \/ 关闭书房声景与光影<\/dd>/);
    assert.match(helpZh, /<kbd>Alt\+Shift\+D<\/kbd><\/dt><dd>学习库 \/ 练习 \/ 阅读资料时：打开毛笔草稿纸<\/dd>/);
  }

  dp.setUiLanguage('en');
  try {
    for (const page of ['home', 'review']) {
      const helpEn = renderToStaticMarkup(h(dp.ShortcutHelp, { page, onClose: noop }));
      assert.match(helpEn, /<kbd>Alt\+Shift\+A<\/kbd><\/dt><dd>Toggle desk soundscape &amp; lighting<\/dd>/);
      assert.match(helpEn, /<kbd>Alt\+Shift\+D<\/kbd><\/dt><dd>Home \/ practice \/ reader: toggle ink scratchpad<\/dd>/);
      assert.doesNotMatch(helpEn, HAN, `zero Han in English ShortcutHelp (${page})`);
    }
  } finally {
    dp.setUiLanguage('zh');
  }

  const stripSrc = readFileSync(new URL('../ui/desk-play/DeskPlayStrip.jsx', import.meta.url), 'utf8');
  assert.match(stripSrc, /event\.code !== 'KeyD'/, 'DeskPlayStrip listens for Alt+Shift+D');
  assert.match(stripSrc, /dialog\[open\]/, 'DeskPlayStrip yields when another modal dialog is open');
  assert.match(stripSrc, /aria-keyshortcuts="Alt\+Shift\+D"/, 'DeskPlayStrip exposes shortcut metadata');
  const collapsedStart = stripSrc.indexOf('if (hidden)');
  const collapsedEnd = stripSrc.indexOf('return (\n    <section className="desk-play"');
  assert.ok(collapsedStart > 0 && collapsedEnd > collapsedStart);
  assert.match(stripSrc.slice(collapsedStart, collapsedEnd), /scratchpadDialog/, 'collapsed DeskPlayStrip still renders scratchpad dialog on Alt+Shift+D');

  const toolbarSrc = readFileSync(new URL('../ui/ReviewToolbar.jsx', import.meta.url), 'utf8');
  assert.match(toolbarSrc, /event\.code !== "KeyD"/, 'ReviewToolbar listens for Alt+Shift+D');
  assert.match(toolbarSrc, /dialog\[open\]/, 'ReviewToolbar yields when another modal dialog is open');
  assert.match(toolbarSrc, /\.study-document-viewer/, 'ReviewToolbar yields to docked reader when focus is inside reader');

  const deskCss = readFileSync(new URL('../ui/desk-play/desk-play.css', import.meta.url), 'utf8');
  assert.match(deskCss, /\.desk-play-origami__accent-fold\s*\{[\s\S]*stroke:\s*var\(--accent\)/);

  const padCss = readFileSync(new URL('../ui/desk-play/desk-play-scratchpad.css', import.meta.url), 'utf8');
  assert.match(padCss, /\.desk-play-ink-btn\s*\{[\s\S]*padding-inline:\s*var\(--space-3\)/);
});
