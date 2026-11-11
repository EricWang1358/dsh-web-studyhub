import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

function pdfPage(page, hash = 'c'.repeat(64)) {
  return {
    id: `os-pdf-p${page}`,
    title: `操作系统讲义.pdf · 第 ${page} 页`,
    text: `第 ${page} 页讲义内容：介绍核心机制_${page} 与死锁银行家算法条件_${page}。`,
    courses: ['OS'],
    document: { id: hash, materialId: `document-${hash}-pdf`, format: 'pdf', page, totalPages: 120, filename: '操作系统讲义.pdf' },
  };
}

function makeQuiz(id, page, topic, extra = {}) {
  return {
    id,
    kind: 'quiz',
    topic,
    objective: `理解第 ${page} 页 ${topic}`,
    prompt: `关于 ${topic}（第 ${page} 页知识点），下列哪项正确？`,
    options: [
      { id: 'a', text: '正确选项', correct: true, explanation: '正确。' },
      { id: 'b', text: '错误选项', correct: false, explanation: '错误。' },
    ],
    answer: '正确选项',
    hint: '回想定义',
    explanation: '解析说明',
    misconception: '常见误区',
    citations: [{ sourceId: `os-pdf-p${page}`, quote: `核心机制_${page}` }],
    ...extra,
  };
}

async function createScrambledLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-reading-practice-'));
  const service = new StudyService(root);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await service.call('course.save', { name: 'OS', focusTopics: ['银行家算法'] });
  await service.store.update((s) => {
    s.sources.push(pdfPage(1), pdfPage(12), pdfPage(62), pdfPage(94));
    // Simulate an already-published deck whose cards were saved in multi-round weight order (p.94 first, p.1 last)
    s.decks.push({
      id: 'os-lecture',
      title: '操作系统讲义',
      course: 'OS',
      publishedAt: '2026-11-10T10:00:00Z',
      cards: [
        makeQuiz('q-p94', 94, '银行家算法安全性检查'),
        makeQuiz('q-p62', 62, '页面置换Clock算法'),
        makeQuiz('q-p12', 12, '进程控制块PCB'),
        makeQuiz('q-p1', 1, '操作系统概述与内核态'),
      ],
    });
    s.focus = { mode: 'class', course: 'OS' };
  });
  return service;
}

test('existing scrambled decks default to p.1 -> p.94 reading order across daily path, deck path, mode:new, course batch, and nextTopic', async (t) => {
  const service = await createScrambledLibrary(t);

  const snap = await service.call('snapshot');
  assert.equal(snap.next.topic, '操作系统概述与内核态', 'recommended next topic starts at p.1 instead of jumping to p.94 focus');

  // 1. Home daily round ("开始今日学习")
  const daily = await service.call('review.start', { mode: 'path', course: 'OS', daily: true, fresh: true });
  assert.deepEqual(daily.navigation.map((n) => n.cardId), ['q-p1', 'q-p12', 'q-p62', 'q-p94']);
  assert.deepEqual(daily.navigation.map((n) => n.page), [1, 12, 62, 94]);
  assert.equal(daily.card.id, 'q-p1');
  assert.equal(daily.cardSource.page, 1);
  assert.equal(daily.cardSource.title, '操作系统讲义');
  assert.equal(daily.cardSource.documentSourceId, 'os-pdf-p1');
  assert.equal('quote' in daily.cardSource, false, 'answer quote never leaks before answering');

  // 2. Deck row play ("学习全部 N 题")
  const deckPath = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'os-lecture' }], fresh: true });
  assert.deepEqual(deckPath.navigation.map((n) => n.cardId), ['q-p1', 'q-p12', 'q-p62', 'q-p94']);

  // 3. Deck menu "从新题开始" (mode: 'new' on deckId without explicit ordered flag)
  const deckNew = await service.call('review.start', { mode: 'new', deckId: 'os-lecture', fresh: true });
  assert.deepEqual(deckNew.navigation.map((n) => n.cardId), ['q-p1', 'q-p12', 'q-p62', 'q-p94']);

  // 4. Home "只学当前课程新题" (mode: 'new' on currentCourse)
  const courseNew = await service.call('review.start', { mode: 'new', currentCourse: true, count: 10, fresh: true });
  assert.deepEqual(courseNew.navigation.map((n) => n.cardId), ['q-p1', 'q-p12', 'q-p62', 'q-p94']);

  // 5. Course route batch ("课程下一批")
  const courseRun = await service.call('review.start', { mode: 'course', course: 'OS', fresh: true });
  assert.deepEqual(courseRun.navigation.map((n) => n.cardId), ['q-p1', 'q-p12', 'q-p62', 'q-p94']);
});

test('flexible user decision: switching newCardOrder to focus or shuffle changes new-question ordering while preserving prerequisites and due/weak priority', async (t) => {
  const service = await createScrambledLibrary(t);

  // Switch to 'focus' (重点优先 for pre-exam cramming)
  await service.call('settings.practice.set', { patch: { newCardOrder: 'focus' } });
  const focusSnap = await service.call('snapshot');
  assert.equal(focusSnap.next.topic, '银行家算法安全性检查');

  const focusDaily = await service.call('review.start', { mode: 'path', course: 'OS', daily: true, fresh: true });
  assert.deepEqual(focusDaily.navigation.map((n) => n.cardId), ['q-p94', 'q-p1', 'q-p12', 'q-p62'], 'focus card first, remaining in reading order');

  // Add a prerequisite edge: q-p94 requires q-p12, then switch to 'shuffle'
  await service.store.update((s) => {
    const deck = s.decks.find((d) => d.id === 'os-lecture');
    const q94 = deck.cards.find((c) => c.id === 'q-p94');
    q94.requires = [{ deckId: 'os-lecture', cardId: 'q-p12' }];
  });
  await service.call('settings.practice.set', { patch: { newCardOrder: 'shuffle' } });
  const shuffledRun = await service.call('review.start', { mode: 'path', course: 'OS', daily: true, fresh: true });
  const order = shuffledRun.navigation.map((n) => n.cardId);
  assert.equal(order.length, 4);
  assert.ok(order.indexOf('q-p12') < order.indexOf('q-p94'), `prerequisite q-p12 must precede q-p94 even when shuffled (${order.join(', ')})`);
});

test('in-round unstudied-page removal (review.queue.edit allowCurrent) removes unanswered questions from page >= N including the unanswered card on screen', async (t) => {
  const service = await createScrambledLibrary(t);
  await service.call('settings.practice.set', { patch: { newCardOrder: 'focus' } });
  // Start with q-p94 on screen (index 0, unanswered), followed by q-p1, q-p12, q-p62
  const run = await service.call('review.start', { mode: 'path', course: 'OS', daily: true, fresh: true });
  assert.equal(run.card.id, 'q-p94');
  assert.equal(run.cardSource.page, 94);

  // Learner clicks "还没学到第 62 页（本轮移出第 62 页及之后）" -> removes q-p94 and q-p62 from this round
  const toRemove = run.navigation
    .filter((item) => !item.answered && item.documentKey === run.cardSource.documentKey && item.page >= 62)
    .map((item) => ({ deckId: item.deckId, cardId: item.cardId }));
  assert.equal(toRemove.length, 2);

  const edited = await service.call('review.queue.edit', {
    runId: run.id,
    queueVersion: run.queueVersion,
    allowCurrent: true,
    remove: toRemove,
  });
  assert.deepEqual(edited.navigation.map((n) => n.cardId), ['q-p1', 'q-p12']);
  assert.equal(edited.card.id, 'q-p1', 'advances immediately to the first studied-range question');
  assert.equal(edited.index, 0);

  // Library deck still keeps all 4 questions intact for when the learner reaches p.62 and p.94 later
  const exported = await service.call('export');
  assert.equal(exported.decks[0].cards.length, 4);
});
