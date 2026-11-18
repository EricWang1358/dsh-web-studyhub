import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import {
  currentCardTerms,
  extractCardTerms,
  normalizeCardTerms,
} from '../lib/contexts/study/card-terms.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

const source = {
  id: 's1',
  title: '线性代数讲义',
  text: '正交矩阵的逆等于它的转置，特征值分解与谱定理密切相关。',
};

const flashcard = () => ({
  id: 'f1',
  kind: 'flashcard',
  topic: '正交性',
  objective: '回忆正交矩阵性质',
  prompt: '什么是正交矩阵？',
  answer: '满足 Q^T Q = I 的实方阵。',
  hint: '看转置与逆矩阵的关系。',
  explanation: '正交矩阵的转置等于它的逆，这在特征值分解与谱定理中非常关键。',
  misconception: '把任意可逆矩阵当成正交矩阵。',
  citations: [{ sourceId: 's1', quote: '正交矩阵的逆等于它的转置' }],
});

const quiz = () => ({
  id: 'q1',
  kind: 'quiz',
  topic: '谱定理',
  objective: '理解对角化条件',
  prompt: '实对称矩阵为什么总能正交对角化？',
  answer: '谱定理保证存在标准正交特征基。',
  hint: '想想谱定理。',
  explanation: '不同特征值对应的特征向量彼此正交，因此可正交对角化。',
  misconception: '以为非对称实矩阵也能直接用谱定理。',
  citations: [{ sourceId: 's1', quote: '特征值分解与谱定理密切相关' }],
  options: [
    { id: 'a', text: '谱定理保证正交特征基存在', correct: true, explanation: '谱定理成立。' },
    { id: 'b', text: '行列式恒等于零', correct: false, explanation: '奇异矩阵不一定正交。' },
    { id: 'c', text: '矩阵不可逆', correct: false, explanation: '正交矩阵始终可逆。' },
  ],
});

const cloze = () => ({
  id: 'c1',
  kind: 'cloze',
  topic: '分解',
  objective: '理解特征分解',
  prompt: '对称矩阵可通过 {{b1}} 分解为正交矩阵与对角矩阵。',
  answer: '对称矩阵可通过谱定理分解为正交矩阵与对角矩阵。',
  hint: '想到对称矩阵与特征分解。',
  explanation: '谱定理给出特征值与标准正交基。',
  misconception: '把特征值分解与三角分解混淆。',
  citations: [{ sourceId: 's1', quote: '特征值分解与谱定理密切相关' }],
  cloze: { text: '对称矩阵可通过 {{b1}} 分解为正交矩阵与对角矩阵。', answers: [{ id: 'b1', value: '谱定理' }] },
});

const checkCard = () => ({
  id: 'k1',
  kind: 'flashcard',
  topic: '前置概念',
  objective: '理解转置矩阵的定义',
  prompt: '什么是转置矩阵？',
  answer: '把矩阵行列互换得到的新矩阵。',
  hint: '交换行和列的位置。',
  explanation: '转置操作常用于定义正交矩阵。',
  misconception: '把转置和求逆当成同一种操作。',
  citations: [{ sourceId: 's1', quote: '正交矩阵的逆等于它的转置' }],
});

async function library(t, model, { course = '线性代数' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-card-terms-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, model ? { completeLight: model } : {});
  await service.call('source.add', { ...source, course });
  await service.call('draft.save', {
    deck: { id: 'd1', title: '矩阵分解', course, cards: [flashcard(), quiz(), cloze(), checkCard()] },
  });
  await service.call('draft.publish', { id: 'd1' });
  return { service, deck: await service.call('deck.get', { id: 'd1' }) };
}

test('1. card.terms caches results (including empty list) without changing SM-2 or revisions', async (t) => {
  const calls = [];
  const { service } = await library(t, async (_system, prompt) => {
    calls.push(JSON.parse(prompt.split('\n\n')[0]));
    if (calls.length === 1) return JSON.stringify({ terms: ['正交矩阵', '谱定理'] });
    return JSON.stringify({ terms: [] });
  });
  const before = await service.store.read();
  const fBefore = before.decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'f1');

  const first = await service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  assert.equal(first.cached, false);
  assert.deepEqual(first.terms, ['正交矩阵', '谱定理']);
  assert.equal(calls.length, 1);

  const after = await service.store.read();
  const saved = after.decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'f1');
  assert.deepEqual(saved.review, fBefore.review, 'SM-2 state stays untouched');
  assert.equal(saved.revisions, undefined, 'no revision entry added');
  assert.deepEqual(after.attempts, before.attempts);

  const hit = await service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.terms, ['正交矩阵', '谱定理']);
  assert.equal(calls.length, 1, 'cache hit skips model');

  // Empty array is also valid and cached.
  const emptyFirst = await service.call('card.terms', { deckId: 'd1', cardId: 'q1' });
  assert.equal(emptyFirst.cached, false);
  assert.deepEqual(emptyFirst.terms, []);
  const emptyHit = await service.call('card.terms', { deckId: 'd1', cardId: 'q1' });
  assert.equal(emptyHit.cached, true);
  assert.deepEqual(emptyHit.terms, []);
  assert.equal(calls.length, 2, 'empty candidate array is cached');
});

test('2. card.update invalidates candidate digest and excludes derived terms from revision history', async (t) => {
  let calls = 0;
  const { service } = await library(t, async () => {
    calls++;
    return JSON.stringify({ terms: calls === 1 ? ['正交矩阵'] : ['特征值分解'] });
  });
  await service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  await service.call('card.update', {
    deckId: 'd1',
    cardId: 'f1',
    patch: { explanation: '正交矩阵常出现在特征值分解与数值稳定性分析中。' },
    reason: 'clarify',
  });

  const stateAfterEdit = await service.store.read();
  const edited = stateAfterEdit.decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'f1');
  assert.equal(edited.terms, undefined, 'stale card.terms is cleared on digest change');
  assert.equal(edited.revisions.length, 1);
  assert.equal(edited.revisions[0].content.terms, undefined, 'derived terms never enter revision snapshot');

  const second = await service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  assert.equal(second.cached, false);
  assert.deepEqual(second.terms, ['特征值分解']);
  assert.equal(calls, 2);
});

test('3. open review run syncs solution.terms non-destructively and never leaks before reveal', async (t) => {
  const { service } = await library(t, async () => JSON.stringify({ terms: ['谱定理', '特征向量'] }));
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'q1' }] });
  assert.equal(run.card.terms, undefined, 'public card never exposes terms');
  assert.equal(run.solution, undefined, 'no solution before reveal');

  await service.call('card.terms', { deckId: 'd1', cardId: 'q1' });
  const beforeReveal = await service.call('review.get', { runId: run.id });
  assert.equal(beforeReveal.queueVersion, run.queueVersion, 'card.terms is non-substantive');
  assert.equal(beforeReveal.contentUpdated, false);
  assert.equal(beforeReveal.card.terms, undefined);
  assert.equal(beforeReveal.solution, undefined, 'still gated before reveal');

  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['b'] });
  const afterWrong = await service.call('review.get', { runId: run.id });
  assert.deepEqual(afterWrong.solution.terms, ['谱定理', '特征向量']);

  await service.call('card.update', {
    deckId: 'd1',
    cardId: 'q1',
    patch: { explanation: '更新后的解析文本。' },
    reason: 'rewrite',
  });
  const afterEdit = await service.call('review.get', { runId: run.id });
  assert.equal(afterEdit.solution.terms, undefined, 'stale solution.terms cleared after edit');
});

test('4. normalization filters hallucinations, length, case duplicates, known words, and caps at 6', async (t) => {
  const richCard = {
    ...quiz(),
    prompt: 'Analyze eigenvalue decomposition, QR factorization, SVD, Schur form, Cholesky, Hermitian, and Gram-Schmidt.',
    answer: 'All seven matrix techniques appear here.',
    explanation: 'Extra note with   eigenvalue   decomposition  and SingularValueDecomposition.',
  };
  const longText = 'x'.repeat(61);
  const raw = {
    terms: [
      '',
      '   ',
      longText,
      'not in card anywhere',
      'QR factorization',
      'qr factorization',
      'eigenvalue decomposition',
      'SVD',
      'Schur form',
      'Cholesky',
      'Hermitian',
      'Gram-Schmidt',
    ],
  };
  const filtered = normalizeCardTerms(richCard, raw, ['svd', '  cholesky ']);
  assert.deepEqual(filtered, [
    'QR factorization',
    'eigenvalue decomposition',
    'Schur form',
    'Hermitian',
    'Gram-Schmidt',
  ]);

  const capped = normalizeCardTerms(
    richCard,
    {
      terms: [
        'eigenvalue decomposition',
        'QR factorization',
        'SVD',
        'Schur form',
        'Cholesky',
        'Hermitian',
        'Gram-Schmidt',
      ],
    },
    [],
  );
  assert.equal(capped.length, 6);

  // Also check integration with coursePromptTerms (course.terms.attach + mastered check card -> known).
  let sentKnown = null;
  const { service } = await library(t, async (_sys, prompt) => {
    sentKnown = JSON.parse(prompt).known;
    return JSON.stringify({ terms: ['转置', '正交矩阵', '特征值分解'] });
  });
  await service.call('course.terms.mark', { course: '线性代数', terms: ['转置'], from: { deckId: 'd1', cardId: 'f1' } });
  await service.call('course.terms.attach', {
    course: '线性代数',
    links: [{ term: '转置', card: { deckId: 'd1', cardId: 'k1' } }],
  });
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'k1' }] });
  await service.call('review.reveal', { runId: run.id, cardId: 'k1' });
  await service.call('review.answer', { runId: run.id, cardId: 'k1', grade: 5 });

  const result = await service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  assert.ok(Array.isArray(sentKnown) && sentKnown.includes('转置'), 'mastered course term passed in known');
  assert.deepEqual(result.terms, ['正交矩阵', '特征值分解']);
});

test('5. invalid JSON or element types trigger at most one corrective retry', async (t) => {
  let calls = 0;
  const { service } = await library(t, async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ terms: [123, '正交矩阵'] });
    return JSON.stringify({ terms: ['正交矩阵'] });
  });
  const ok = await service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  assert.equal(calls, 2);
  assert.deepEqual(ok.terms, ['正交矩阵']);

  let failCalls = 0;
  const { service: badService } = await library(t, async () => {
    failCalls++;
    return 'not json at all';
  });
  await assert.rejects(badService.call('card.terms', { deckId: 'd1', cardId: 'f1' }));
  assert.equal(failCalls, 2);
  const state = await badService.store.read();
  const card = state.decks.find((d) => d.id === 'd1').cards.find((c) => c.id === 'f1');
  assert.equal(card.terms, undefined);
});

test('6. concurrent card.terms calls on the same card share one in-flight model request', async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = await library(t, async () => {
    calls++;
    await gate;
    return JSON.stringify({ terms: ['正交矩阵'] });
  });
  const p1 = service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  const p2 = service.call('card.terms', { deckId: 'd1', cardId: 'f1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.deepEqual(r1.terms, ['正交矩阵']);
  assert.deepEqual(r2.terms, ['正交矩阵']);
});

test('7. refuses when light model is unavailable or card is missing', async (t) => {
  const { service: noModel } = await library(t);
  await assert.rejects(noModel.call('card.terms', { deckId: 'd1', cardId: 'f1' }), /模型/);
  const { service } = await library(t, async () => JSON.stringify({ terms: [] }));
  await assert.rejects(service.call('card.terms', { deckId: 'd1', cardId: 'missing' }), /not found|No/i);
});

test('8. normalizeCardTerms, currentCardTerms, extractCardTerms, and fake-model handler work across card kinds', async () => {
  assert.deepEqual(normalizeCardTerms(cloze(), { terms: ['对称矩阵', '谱定理', 'not here'] }), ['对称矩阵', '谱定理']);
  assert.equal(currentCardTerms(flashcard()), null);

  const q = quiz();
  const fake = createFakeModel();
  const extracted = await extractCardTerms(fake, q, ['谱定理']);
  assert.ok(Array.isArray(extracted.terms));
  assert.ok(extracted.terms.length >= 1);
  assert.ok(!extracted.terms.some((item) => item.toLowerCase() === '谱定理'));
  const quizText = [q.prompt, q.answer, q.explanation, ...q.options.flatMap((o) => [o.text, o.explanation])].join('\n');
  for (const term of extracted.terms) {
    assert.ok(quizText.includes(term), `fake-model term "${term}" must be verbatim in card text`);
  }
});
