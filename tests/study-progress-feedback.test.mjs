/* Study progress telemetry & post-study positive feedback across Reading (读资料) and Practice (刷题) (#637):
   1. Reader passage link mastery highlights, [n] markers & PassageLinksPanel mastery marks
   2. Reader return delta badge & OutlinePanel upgraded section pulse
   3. Per-card FSRS-6 memory trajectory strip (level promotion, interval growth, stability gauge, prerequisite credit)
   4. Live in-round mastery climb, ReviewNavigator answered tick lock & post-round dual-layer delta rail. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { groupPassageLinks } from '../ui/document-preview/selection.js';
import { buildLinkModel, passageMasteryState } from '../ui/document-preview/links/link-model.js';
import { HIGHLIGHT_NAMES, MASTERY_HIGHLIGHT_NAMES, paintLinkHighlights } from '../ui/document-preview/links/link-ranges.js';
import { reviewElement } from './helpers/review-render.mjs';

const require = createRequire(import.meta.url);
const han = /[\u3400-\u9fff]/;

const compiled = await build({
  stdin: {
    contents: `
      export * from './ui/i18n.js';
      export { NextDue } from './ui/NextDue.jsx';
      export { default as Review } from './ui/Review.jsx';
      export { default as ReviewNavigator } from './ui/ReviewNavigator.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { MasteryChange, ReadingResult, masteryShiftParts } from './ui/document-preview/practice/ReadingReturn.jsx';
      export { default as PassageLinksPanel } from './ui/document-preview/links/PassageLinksPanel.jsx';
      export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiBundle = (() => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

const render = (element) => renderToStaticMarkup(element);
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('Point 1: reader passage link model & highlight painter reflect card mastery without breaking default highlights', () => {
  const baseSel = { documentId: 'doc', revision: 'r1', sourceId: 's1', prefix: '', suffix: '' };
  const rawLinks = [
    { deckId: 'd1', deckTitle: 'Deck A', cardId: 'q-mastered', kind: 'quiz', prompt: 'Mastered question?', answer: 'A', selection: { ...baseSel, quote: 'Alpha', start: 0, end: 5 }, status: 'resolved', followups: [] },
    { deckId: 'd1', deckTitle: 'Deck A', cardId: 'q-weak', kind: 'quiz', prompt: 'Weak question?', answer: 'B', selection: { ...baseSel, quote: 'Beta', start: 10, end: 14 }, status: 'resolved', followups: [] },
    { deckId: 'd1', deckTitle: 'Deck A', cardId: 'q-learning', kind: 'quiz', prompt: 'Learning question?', answer: 'C', selection: { ...baseSel, quote: 'Gamma', start: 20, end: 25 }, status: 'resolved', followups: [] },
    { deckId: 'd1', deckTitle: 'Deck A', cardId: 'qa-done', kind: 'flashcard', sourceQa: true, prompt: '> Delta\n\nSaved Q&A?', answer: 'D', selection: { ...baseSel, quote: 'Delta', start: 30, end: 35 }, status: 'resolved', followups: [] },
  ];
  const cardMastery = new Map([
    ['d1:q-mastered', { deckId: 'd1', cardId: 'q-mastered', level: 'mastered', due: false }],
    ['d1:q-weak', { deckId: 'd1', cardId: 'q-weak', level: 'weak', due: true }],
    ['d1:q-learning', { deckId: 'd1', cardId: 'q-learning', level: 'learning', due: false }],
    ['d1:qa-done', { deckId: 'd1', cardId: 'qa-done', level: 'mastered', due: false }],
  ]);

  const enriched = buildLinkModel(groupPassageLinks(rawLinks), { cardMastery });
  assert.deepEqual(enriched.groups.map((g) => g.masteryState), ['mastered', 'weak', 'learning', 'mastered']);
  assert.equal(passageMasteryState(null), null);

  const registry = new Map();
  class FakeHighlight {
    constructor(...ranges) { this.ranges = ranges; this.priority = 0; }
  }
  const entries = enriched.groups.map((group, idx) => ({ group, range: `r${idx}` }));
  const clear = paintLinkHighlights(entries, { registry, Highlight: FakeHighlight });
  assert.deepEqual(registry.get(MASTERY_HIGHLIGHT_NAMES.mastered).ranges, ['r0']);
  assert.deepEqual(registry.get(MASTERY_HIGHLIGHT_NAMES.weak).ranges, ['r1']);
  assert.deepEqual(registry.get(MASTERY_HIGHLIGHT_NAMES.learning).ranges, ['r2']);
  assert.deepEqual(registry.get(MASTERY_HIGHLIGHT_NAMES['qa-mastered']).ranges, ['r3']);
  assert.equal(registry.has(HIGHLIGHT_NAMES.question), false, 'all question ranges upgraded to mastery-specific highlights');
  assert.ok(registry.get(MASTERY_HIGHLIGHT_NAMES.weak).priority > registry.get(MASTERY_HIGHLIGHT_NAMES.mastered).priority);
  clear();
  assert.equal(registry.size, 0);

  // PassageLinksPanel renders mastery marks and state/due labels in both languages
  const { PassageLinksPanel, setUiLanguage } = uiBundle;
  setUiLanguage('zh');
  const zh = render(React.createElement(PassageLinksPanel, { model: enriched, focusedKey: enriched.groups[1].key, onFocus() {}, onOpen() {} }));
  assert.match(zh, /data-mastery="weak"/);
  assert.match(zh, /薄弱/);
  assert.match(zh, /待复习/);
  assert.match(zh, /mastery-mark/);

  setUiLanguage('en');
  try {
    const en = render(React.createElement(PassageLinksPanel, { model: enriched, focusedKey: enriched.groups[0].key, onFocus() {}, onOpen() {} }));
    assert.match(en, /data-mastery="mastered"/);
    assert.match(en, /Mastery 100%/);
    assert.match(en, /Mastered/);
    assert.doesNotMatch(en, han);
  } finally {
    setUiLanguage('zh');
  }
});

test('Point 2: OutlinePanel stamps data-upgraded only on sections whose mastery just rose', () => {
  const { OutlinePanel, setUiLanguage } = uiBundle;
  const items = [
    { id: 'sec-1', title: 'Introduction', depth: 0, children: 0, parent: null },
    { id: 'sec-2', title: 'Consensus', depth: 0, children: 0, parent: null },
  ];
  const meters = new Map([
    ['sec-1', { total: 2, percent: 45, state: 'learning', due: 0, weak: 0, fresh: 0 }],
    ['sec-2', { total: 2, percent: 100, state: 'mastered', due: 0, weak: 0, fresh: 0 }],
  ]);
  setUiLanguage('zh');
  const html = render(React.createElement(OutlinePanel, {
    items,
    activeId: 'sec-2',
    onJump() {},
    meters,
    upgradedIds: new Set(['sec-2']),
  }));
  const meterTags = html.match(/<span class="reader-outline__meter"[^>]*>/g) || [];
  assert.equal(meterTags.length, 2);
  assert.doesNotMatch(meterTags[0], /data-upgraded/);
  assert.match(meterTags[1], /data-upgraded="true"/);
});

test('Point 3 & 4 (runtime): review.answer records FSRS trajectory + credited prerequisites and liveMastery climbs mid-round', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-progress-feedback-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });

  const options = [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Wrong', correct: false }];
  await service.store.update((s) => {
    s.decks.push({
      id: 'd1',
      title: 'Raft',
      course: 'Distributed Systems',
      folder: '',
      cards: [
        { id: 'pre1', kind: 'quiz', topic: 'Basics', prompt: 'Prereq?', answer: 'a', explanation: 'E', options, citations: [],
          review: { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: new Date(Date.now() - 86400000).toISOString() } },
        { id: 'main1', kind: 'quiz', topic: 'Log', prompt: 'Main?', answer: 'a', explanation: 'E', options, citations: [], requires: [{ deckId: 'd1', cardId: 'pre1' }] },
        { id: 'second', kind: 'quiz', topic: 'Log', prompt: 'Second?', answer: 'a', explanation: 'E', options, citations: [] },
      ],
    });
  });
  await service.call('card.link', { deckId: 'd1', cardId: 'main1', requires: { deckId: 'd1', cardId: 'pre1' } });

  let run = await service.call('review.start', {
    mode: 'path',
    scope: [{ deckId: 'd1', cardId: 'second' }, { deckId: 'd1', cardId: 'main1' }],
    ordered: true,
    fresh: true,
  });
  assert.equal(run.mastery, undefined, 'run.mastery stays undefined until the round finishes');
  assert.equal(run.liveMastery.before.percent, 0);
  assert.equal(run.liveMastery.after.percent, 0);

  const feedbacks = {};
  for (let step = 0; step < 2; step++) {
    const id = run.card.id;
    run = await service.call('review.answer', { runId: run.id, cardId: id, queueVersion: run.queueVersion, selected: ['a'] });
    feedbacks[id] = run.feedback;
    assert.equal(run.complete, false);
    assert.ok(run.liveMastery.after.percent > run.liveMastery.before.percent, 'liveMastery climbs immediately mid-round');
    if (step === 0) run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(feedbacks.main1.beforeLevel, 'new');
  assert.equal(feedbacks.main1.level, 'learning');
  assert.equal(feedbacks.main1.beforeDays, 0);
  assert.ok(feedbacks.main1.afterDays >= 1, `expected positive interval, got ${feedbacks.main1.afterDays}`);
  assert.ok(feedbacks.main1.stability > 0, `expected positive stability, got ${feedbacks.main1.stability}`);
  assert.equal(feedbacks.main1.credited, 1, 'answering main1 credits its due prerequisite pre1');
});

test('Point 3 (UI): NextDue renders FSRS memory trajectory pills honestly in Chinese and English', () => {
  const { NextDue, setUiLanguage } = uiBundle;
  const due = '2026-11-10T09:00:00.000Z';

  setUiLanguage('zh');
  const firstGood = render(React.createElement(NextDue, {
    feedback: { correct: true, level: 'learning', beforeLevel: 'new', beforeDays: 0, afterDays: 3, stability: 3.2, credited: 2, nextDue: due },
  }));
  const zhText = plain(firstGood);
  assert.match(zhText, /^答对了 · 下次复习 /);
  assert.doesNotMatch(zhText, /已掌握/, 'learning card never claims 已掌握');
  assert.match(zhText, /未学 → 学习中/);
  assert.match(zhText, /首轮间隔 3 天/);
  assert.match(zhText, /稳定度 3\.2 天/);
  assert.match(zhText, /顺带推进 2 道前置题/);
  assert.equal((firstGood.match(/data-lit="true"/g) || []).length, 2, 'stability 3.2d lights 2 of 5 pips');

  setUiLanguage('en');
  try {
    const promotedMastered = render(React.createElement(NextDue, {
      feedback: { correct: true, level: 'mastered', beforeLevel: 'familiar', beforeDays: 8, afterDays: 24, stability: 24.5, credited: 1, nextDue: due },
    }));
    const enText = plain(promotedMastered);
    assert.match(enText, /^✓ Mastered · next review /);
    assert.match(enText, /Familiar → Mastered/);
    assert.match(enText, /Interval 8d → 24d/);
    assert.match(enText, /Stability 24\.5d/);
    assert.match(enText, /Credited 1 prerequisite\(s\)/);
    assert.equal((promotedMastered.match(/data-lit="true"/g) || []).length, 5, 'stability >=21d lights all 5 pips');
    assert.doesNotMatch(promotedMastered, han);
  } finally {
    setUiLanguage('zh');
  }
});

test('Point 4 (UI): QuestionRun shows liveMastery climb, ReviewNavigator marks answered ticks, and MasteryChange renders dual-layer rail & shifts', () => {
  const { Review, ReviewNavigator, StudyServicesContext, MasteryChange, ReadingResult, setUiLanguage } = uiBundle;
  const openRun = {
    id: 'run-1',
    index: 1,
    total: 3,
    mode: 'path',
    deckId: 'd1',
    card: { id: 'q2', kind: 'quiz', topic: 'Consensus', prompt: 'Leader election?', options: [{ id: 'a', text: 'Term' }] },
    navigation: [
      { index: 0, cardId: 'q1', deckId: 'd1', topic: 'Consensus', level: 'learning', answered: true },
      { index: 1, cardId: 'q2', deckId: 'd1', topic: 'Consensus', level: 'new', answered: false },
    ],
    liveMastery: {
      before: { percent: 20, total: 3, state: 'learning', due: 1, weak: 1, fresh: 2 },
      after: { percent: 45, total: 3, state: 'learning', due: 0, weak: 0, fresh: 1 },
    },
  };

  setUiLanguage('zh');
  const reviewHtml = render(reviewElement(Review, StudyServicesContext, {
    run: openRun,
    data: { sources: [], decks: [] },
    host: {},
    choice: true,
    selected: [],
    clozeValues: {},
    busy: false,
  }));
  assert.match(reviewHtml, /data-testid="live-mastery"/);
  assert.match(plain(reviewHtml), /本组 20% → 45% \+25%/);

  const navHtml = render(React.createElement(
    StudyServicesContext.Provider,
    { value: { busy: false } },
    React.createElement(ReviewNavigator, { run: openRun, onJump() {} }),
  ));
  const ticks = navHtml.match(/<button[^>]*class="review-tick"[^>]*>/g) || [];
  assert.equal(ticks.length, 2);
  assert.match(ticks[0], /data-answered="true"/);
  assert.doesNotMatch(ticks[1], /data-answered/);

  const change = {
    before: { percent: 30, total: 4, state: 'learning', due: 1, weak: 1, fresh: 2 },
    after: { percent: 85, total: 4, state: 'mastered', due: 0, weak: 0, fresh: 0 },
  };
  const changeZh = render(React.createElement(MasteryChange, { kind: 'round', change }));
  assert.doesNotMatch(changeZh, /<button\b/, 'MasteryChange never introduces buttons');
  assert.match(changeZh, /reading-result__rail/);
  assert.match(changeZh, /scaleX\(0\.85\)/);
  assert.match(changeZh, /scaleX\(0\.3\)/);
  assert.match(plain(changeZh), /\+55%/);
  assert.match(plain(changeZh), /新学 2 题 · 消除薄弱 1 题 · 完成待复习 1 题 · 整组达标/);

  setUiLanguage('en');
  try {
    const readingEn = render(React.createElement(ReadingResult, {
      run: {
        reading: {
          ...change,
          page: 4,
          sectionTitle: 'Log replication',
          scope: { kind: 'chapter', count: 3 },
        },
      },
      busy: false,
      onReturn() {},
    }));
    assert.match(plain(readingEn), /Mastery of these pages 30% → 85% \+55%/);
    assert.match(plain(readingEn), /2 new started · 1 weak cleared · 1 due reviewed · All mastered/);
    assert.doesNotMatch(readingEn, han);
  } finally {
    setUiLanguage('zh');
  }
});
