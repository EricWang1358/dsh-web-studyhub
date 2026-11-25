import test from 'node:test';
import assert from 'node:assert/strict';
import { freshCardsForDecks } from '../lib/focus.js';
import { latestOutcomes, planPath } from '../lib/mastery.js';
import { courseBatch } from '../lib/course-route.js';
import { suggestDeckOrder } from '../ui/deck-order-suggest.js';
import { loadUi } from './helpers/ui-module.mjs';

const CJK_RE = /[\u4e00-\u9fff]/;

test('#1296-1: decks imported Ch 1 -> Ch N without source positions put Ch 1 first across planPath, freshCardsForDecks, and courseBatch (never Ch N)', () => {
  const state = {
    sources: [],
    attempts: [],
    courses: [{ id: 'c-algo', name: 'Algorithms' }],
    decks: [
      {
        id: 'd-ch1',
        title: '第 1 章 复杂度基础',
        course: 'Algorithms',
        createdAt: '2026-11-01T01:00:00Z',
        publishedAt: '2026-11-01T01:00:00Z',
        cards: [{ id: 'ch1-q1', kind: 'flashcard', topic: 'Big-O', prompt: 'What is O(n)?', answer: 'Linear.', explanation: 'Linear.' }],
      },
      {
        id: 'd-ch2',
        title: '第 2 章 排序算法',
        course: 'Algorithms',
        createdAt: '2026-11-02T01:00:00Z',
        publishedAt: '2026-11-02T01:00:00Z',
        cards: [{ id: 'ch2-q1', kind: 'flashcard', topic: 'MergeSort', prompt: 'What is MergeSort complexity?', answer: 'O(n log n).', explanation: 'Divide and conquer.' }],
      },
      {
        id: 'd-ch39',
        title: '第 39 章 NP 完全性',
        course: 'Algorithms',
        createdAt: '2026-11-30T01:00:00Z',
        publishedAt: '2026-11-30T01:00:00Z',
        cards: [{ id: 'ch39-q1', kind: 'flashcard', topic: 'NP-Complete', prompt: 'What is SAT?', answer: 'First NP-complete problem.', explanation: 'Cook-Levin.' }],
      },
    ],
    focus: { mode: 'class', course: 'Algorithms' },
  };

  const outcome = latestOutcomes(state.attempts);
  const fromFresh = freshCardsForDecks(state, state.decks, 10).map(x => x.cardId);
  const fromPath = planPath(state.decks, outcome, { limit: 10, newLimit: 10, sources: state.sources }).entries.map(x => x.card.id);
  const fromBatch = courseBatch(state, { course: 'Algorithms', count: 10 }).fresh.map(x => x.card.id);

  assert.deepEqual(fromFresh, ['ch1-q1', 'ch2-q1', 'ch39-q1'], 'mode:new starts from Ch 1, not Ch 39');
  assert.deepEqual(fromPath, ['ch1-q1', 'ch2-q1', 'ch39-q1'], 'planPath matches exact same order');
  assert.deepEqual(fromBatch, ['ch1-q1', 'ch2-q1', 'ch39-q1'], 'courseBatch matches exact same order');
});

test('#1296-2: mixed JSON-imported (no source position) and cited decks follow identical chapter-first + within-chapter reading order across all 3 entries', () => {
  const state = {
    sources: [
      { id: 'src-p1', title: 'Book · p.1', text: 'Alpha fact.', document: { id: 'doc1', format: 'pdf', page: 1 } },
      { id: 'src-p20', title: 'Book · p.20', text: 'Beta fact.', document: { id: 'doc1', format: 'pdf', page: 20 } },
    ],
    attempts: [],
    courses: [{ id: 'c-db', name: 'DB' }],
    decks: [
      {
        id: 'd-json-intro',
        title: '第 1 章 筑基（JSON 导入）',
        course: 'DB',
        cards: [{ id: 'intro-1', kind: 'flashcard', topic: 'Intro', prompt: 'What is ACID?', answer: 'Atomicity etc.', explanation: 'Core properties.' }],
      },
      {
        id: 'd-cited-ch2',
        title: '第 2 章 索引与页码',
        course: 'DB',
        cards: [
          { id: 'cited-p20', kind: 'flashcard', topic: 'B+Tree', prompt: 'p.20?', answer: 'Beta.', explanation: 'Beta.', citations: [{ sourceId: 'src-p20', quote: 'Beta fact.' }] },
          { id: 'cited-p1', kind: 'flashcard', topic: 'Storage', prompt: 'p.1?', answer: 'Alpha.', explanation: 'Alpha.', citations: [{ sourceId: 'src-p1', quote: 'Alpha fact.' }] },
        ],
      },
    ],
    focus: { mode: 'class', course: 'DB' },
  };

  const outcome = latestOutcomes(state.attempts);
  const expected = ['intro-1', 'cited-p1', 'cited-p20'];
  assert.deepEqual(freshCardsForDecks(state, state.decks, 10).map(x => x.cardId), expected);
  assert.deepEqual(planPath(state.decks, outcome, { limit: 10, newLimit: 10, sources: state.sources }).entries.map(x => x.card.id), expected);
  assert.deepEqual(courseBatch(state, { course: 'DB', count: 10 }).fresh.map(x => x.card.id), expected);
});

test('#1296-3: suggestDeckOrder recommends Foundations -> Core Chapters -> Labs/Source -> Comprehensive Exams without mutating input', () => {
  const decks = [
    { id: 'd-exam', title: '综合模拟大卷' },
    { id: 'd-ch3', title: '第 3 章 事务与锁精讲' },
    { id: 'd-lab', title: '源码与并发实验' },
    { id: 'd-ch1', title: '第 1 章 存储引擎精讲' },
    { id: 'd-base', title: '前置筑基：SQL 基础' },
  ];
  const snapshot = decks.map(d => d.id);
  const suggestion = suggestDeckOrder(decks);

  assert.equal(suggestion.changed, true);
  assert.deepEqual(suggestion.ids, ['d-base', 'd-ch1', 'd-ch3', 'd-lab', 'd-exam']);
  // Input array is untouched until user explicitly confirms deck.reorder
  assert.deepEqual(decks.map(d => d.id), snapshot);
  // Already ordered input reports changed: false
  assert.equal(suggestDeckOrder(suggestion.ids.map(id => decks.find(d => d.id === id))).changed, false);
});

test('#1296-4: home-plan provides clear distinguishing tooltips for chapter route vs new cards vs page-picking, with clean EN i18n', async () => {
  const ui = await loadUi(`
    export { setUiLanguage, ui } from './ui/i18n.js';
    export { buildHomePlan } from './ui/study-map/home-plan.js';
  `);

  const route = { course: 'DB', current: 0, chapters: [{ deckId: 'd1', title: 'Ch1', total: 5, learned: 0 }], next: { label: 'Ch1', fresh: 5, reviews: 1 } };
  const data = {
    decks: [{ id: 'd1', title: 'Ch1', course: 'DB', cards: [{ id: 'c1' }] }],
    sources: [{ id: 's1', title: 'Notes', courses: ['DB'], text: 'Hello' }],
    drafts: [],
    jobs: [],
    runs: [],
    focus: { course: 'DB', courseId: 'c-db', courses: [{ id: 'c-db', name: 'DB' }], route, fresh: [{ deckId: 'd1', cardId: 'c1' }] },
    today: { course: 'DB', due: 0, weak: 0, new: 1, size: 1, scope: [{ deckId: 'd1' }] },
    settings: { practice: { roundSize: 20 } },
  };
  const home = ui.buildHomePlan({
    data,
    today: data.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: () => true,
    actions: { start: () => {}, resume: () => {}, onPickPages: () => {} },
  });
  const courseEntry = home.alternatives.find(([label]) => /课程下一批/.test(label));
  const freshEntry = home.alternatives.find(([label]) => /只学当前课程新题/.test(label));
  const pageEntry = home.alternatives.find(([label]) => /打开资料按页做题/.test(label));

  assert.ok(courseEntry?.[2] && /逐章顺推/.test(courseEntry[2]), 'course batch carries chapter-route tooltip');
  assert.ok(freshEntry?.[2] && /章序/.test(freshEntry[2]), 'fresh entry carries order tooltip');
  assert.ok(pageEntry?.[2] && /页码/.test(pageEntry[2]), 'page picking carries page-order tooltip');

  ui.setUiLanguage('en');
  try {
    for (const key of [
      '按课程路线逐章顺推：从第一个未学完的章顺次推进，并夹带最多 5 道已学章节的巩固题。',
      '只抽当前课程的新题：按题组章序与章内资料位置顺序推进，不含到期和薄弱旧题。',
      '按推荐顺序排…',
      '确认应用推荐顺序',
    ]) {
      const en = ui.ui(key);
      assert.ok(en && !CJK_RE.test(en), `EN translation missing/leaked for "${key}": ${en}`);
    }
  } finally {
    ui.setUiLanguage('zh');
  }
});
