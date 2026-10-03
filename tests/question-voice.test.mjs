import test from 'node:test';
import assert from 'node:assert/strict';
import { asksWhatTheSourceSays } from '../lib/question-voice.js';
import { learnerContextIssues } from '../lib/assessment-quality.js';

/* "资料说…" questions test memory of a document's wording, not the concept or a situation the learner must handle. The deterministic check
   catches the common shapes (the review that passed "资料用什么基本区别帮助开发者定位问题？" was a model's judgment, which is not enough). */

test('stems that ask what the source says are recognised, in Chinese and English', () => {
  for (const stem of [
    'API 返回 4xx 与 5xx 时，资料用什么基本区别帮助开发者定位问题？',
    '资料说聚合是什么？',
    '资料给出的两个主要成功维度是什么？',
    '文中提到的三种一致性模型是哪些？',
    '根据资料，熔断器有几种状态？',
    '依据课件，Saga 的补偿事务怎么触发？',
    '这份讲义把服务拆分的依据归为哪几类？',
    'What does the material say about idempotency?',
    'According to the lecture notes, which pattern is preferred?',
    'The text defines an aggregate as what?',
  ]) assert.equal(asksWhatTheSourceSays(stem), true, stem);
});

test('questions about the concept or a concrete situation are not flagged', () => {
  for (const stem of [
    '订单服务调用库存服务超时后重试，库存被重复扣减。应该在哪一层保证幂等，为什么？',
    'API 返回 4xx 与 5xx 在含义上有什么基本区别？这个区别如何帮助开发者定位问题？',
    '什么是聚合根？',
    '团队只有实体清单、没有交互关系，下一步应该做什么？',
    '资料库里有 12 份文件，其中 3 份已过期。哪一步最先处理？',
    'A retry storm amplifies load on a struggling service. What mitigates it?',
    'Which HTTP status family signals a client mistake?',
  ]) assert.equal(asksWhatTheSourceSays(stem), false, stem);
  assert.equal(asksWhatTheSourceSays(''), false);
  assert.equal(asksWhatTheSourceSays(undefined), false);
});

test('the generation check turns it into a precise, actionable issue per card', () => {
  const card = { prompt: 'API 返回 4xx 与 5xx 时，资料用什么基本区别帮助开发者定位问题？', hint: '想想谁的责任。' };
  const issues = learnerContextIssues({ cards: [{ prompt: 'ok question about a scenario?', hint: 'x' }, card] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^Card 2: .*source says/i);
  assert.match(issues[0], /concept|scenario/i, 'it says what to do instead');
});

test('all four generation stages carry the source-voice rule without making the document the learning target', async () => {
  const { QUALITY_CRITERIA } = await import('../lib/assessment-quality.js');
  assert.match(QUALITY_CRITERIA, /Source voice/);
  assert.match(QUALITY_CRITERIA, /never ask what 'the material'/i);
  const { planPrompts, blueprintPrompts } = await import('../lib/assessment-quality.js');
  const plan = planPrompts({ count: 2, sources: [], level: 'x' });
  assert.match(plan.prompt, /Source voice/, 'the plan is made under the rule');
  const blueprint = blueprintPrompts({ count: 2, sources: [], kind: 'flashcard' }, { targets: [] });
  assert.match(blueprint.prompt, /Source voice/, 'the answer and scenario stage keeps the same boundary');
  const { authorPrompts, reviewPrompts } = await import('../lib/generation.js');
  const author = authorPrompts({ count: 2, sources: [], kind: 'flashcard' }, { targets: [] }, { items: [] });
  assert.match(author.prompt, /Source voice/, 'the author keeps the same boundary');
  const review = reviewPrompts({ sources: [], deck: { title: 't', cards: [] }, kind: 'flashcard', count: 0 });
  assert.match(review.payload, /Source voice/, 'the independent review checks it');
});

test('a bare 👎 or "题目有问题" on such a stem still tells the rewrite what is wrong; a normal stem does not get the guidance', async () => {
  const { writeRewrite, FEEDBACK_TAGS, REWRITE_TAGS } = await import('../lib/coach.js');
  assert.ok(FEEDBACK_TAGS['source-recall'] && REWRITE_TAGS.has('source-recall'), 'a named reason exists and triggers a rewrite');
  const seen = [];
  const complete = async (system, payload) => { seen.push(JSON.parse(payload)); return '{"patch":{"prompt":"订单服务重试导致库存重复扣减，应在哪层保证幂等？"},"summary":"改成情景题"}'; };
  const learner = { goal: 'work', levels: {}, signals: {} };
  const bad = { id: 'c', kind: 'flashcard', topic: 'API', prompt: 'API 返回 4xx 与 5xx 时，资料用什么基本区别帮助开发者定位问题？', answer: '4xx 是客户端问题，5xx 是服务端问题。' };
  await writeRewrite(complete, { card: bad, tags: ['general-quality'], evidence: [], learner });
  assert.match(seen[0].sourceRecall, /资料怎么说/);
  assert.match(seen[0].sourceRecall, /具体情景/);
  await writeRewrite(complete, { card: { ...bad, prompt: '4xx 与 5xx 有什么基本区别？' }, tags: ['general-quality'], evidence: [], learner });
  assert.equal(seen[1].sourceRecall, undefined);
  await writeRewrite(complete, { card: { ...bad, prompt: '4xx 与 5xx 有什么基本区别？' }, tags: ['source-recall'], evidence: [], learner });
  assert.ok(seen[2].sourceRecall, 'the learner named it: guidance whatever the stem looks like');
});

test('修题 on such a stem is told what is wrong whatever the learner typed, and the instruction says to fix it first', async () => {
  const { assistInput, assistInstruction } = await import('../lib/assist-content.js');
  const state = { decks: [{ id: 'd', title: 'D', cards: [{ id: 'c', kind: 'flashcard', topic: 'API', prompt: '资料给出的两个主要成功维度是什么？', answer: 'a', explanation: 'e', citations: [] }] }], sources: [], decks_: [] };
  const input = assistInput(state, { deckId: 'd', cardId: 'c' }, { mode: 'improve', request: { question: '', choices: [], requests: [] }, assessment: null });
  assert.match(input.detected.sourceRecall, /资料怎么说/);
  state.decks[0].cards[0].prompt = '什么是聚合根？';
  assert.equal(assistInput(state, { deckId: 'd', cardId: 'c' }, { mode: 'improve', request: { question: '', choices: [], requests: [] }, assessment: null }).detected, undefined);
  assert.match(assistInstruction('improve', false), /detected\.sourceRecall/);
});

test('the 👎 tray names it as a reason (key 7), and a 👎 on such a stem picks that reason by itself', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../ui/ThumbFeedback.jsx', import.meta.url), 'utf8');
  assert.match(src, /\["source-recall", "只问资料怎么说"\]/);
  assert.match(src, /\/\^\[1-7\]\$\/\.test\(e\.key\)/, 'the digit shortcut reaches the seventh tag');
  assert.match(src, /asksWhatTheSourceSays\(run\.card\?\.prompt\)[^\n]*toggle\("source-recall"\)/, 'a 👎 on such a stem selects the reason');
});
