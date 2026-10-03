import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRun, createTextMeasure, dshSystemTokens, dshUserTokens, estimateFromState } from '../lib/token-estimate.js';
import { planGeneration, generateBatched, MAX_SELECTED_CHARS } from '../lib/batch.js';
import { planPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

// WP27: estimates before a run. They are built from the prompt builders the
// pipeline itself uses, priced with DSH's heuristic (low) and DeepSeek's
// documented per-character rates (high), with output sizes measured from the
// bundled sample course. No model call, no network, no money.
const SENTENCE = 'A bridge separates an abstraction from its implementation so that both can vary independently of each other. ';
const filler = (chars) => SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars);
const page = (n, chars = 3000) => ({ id: `book-p${n}`, title: `book.pdf · p.${n}`, text: filler(chars), document: { id: 'book', page: n }, courses: [] });
const pdf = (pages, chars) => Array.from({ length: pages }, (_, index) => page(index + 1, chars));
const note = { id: 'note-1', title: 'notes.md', text: filler(1800), courses: [] };
const base = { count: 10, kind: 'mixed', difficulty: 'mixed', language: 'English', focus: '', existing: [] };
const range = (value) => `${value.low}–${value.high}`;
const monotone = (smaller, larger, label) => {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'])
    assert.ok(larger[key].low >= smaller[key].low && larger[key].high >= smaller[key].high, `${label}: ${key} ${range(smaller[key])} -> ${range(larger[key])}`);
  assert.ok(larger.calls.low >= smaller.calls.low, `${label}: calls`);
};

test('an estimate has the DSH fields as ranges and never a price', () => {
  const result = estimateRun('generate', { ...base, sources: [note] });
  for (const key of ['uncachedInputTokens', 'cacheReadTokens', 'outputTokens', 'inputTokens', 'totalTokens', 'calls'])
    assert.ok(Number.isInteger(result[key].low) && Number.isInteger(result[key].high) && result[key].low <= result[key].high, key);
  assert.equal(result.cacheReadTokens.low, 0, 'a first run may hit no cache at all');
  assert.equal(result.totalTokens.low, result.inputTokens.low + result.outputTokens.low, 'Token 用量 is the prompt side plus the output');
  assert.equal(result.totalTokens.high, result.inputTokens.high + result.outputTokens.high);
  assert.ok(result.uncachedInputTokens.high <= result.inputTokens.high);
  assert.ok(result.stages.length > 0 && result.stages.every((stage) => stage.calls >= 1));
  assert.ok(Array.isArray(result.notes));
  assert.doesNotMatch(JSON.stringify(result), /price|cost|usd|cny|rmb|currency|\$|¥|元/i);
});

test('mixed generation estimates keep explicit kind counts and the configured batch size', () => {
  const args = { ...base, sourceIds: [note.id], count: 6, kindCounts: { quiz: 0, flashcard: 6 }, performance: { batchSize: 2 } };
  const state = { sources: [note], decks: [], drafts: [], settings: { generation: { batchSize: 5 } } };
  const publicEstimate = estimateFromState('generate', args, state);
  const direct = estimateRun('generate', { ...args, sources: [note], existing: [] });
  assert.deepEqual(publicEstimate.calls, direct.calls);
  assert.deepEqual(publicEstimate.totalTokens, direct.totalTokens);
  assert.equal(publicEstimate.calls.low, 10, 'one evidence call plus three stages for each of three flashcard batches');
});

test('question generation prices evidence per group and answer design, authoring and review per batch', () => {
  const sources = pdf(30);
  const result = estimateRun('generate', { ...base, sources });
  const planned = planGeneration({ sources, count: 10, kind: 'mixed' });
  const groups = new Set(planned.map((part) => part.sources)).size;
  assert.equal(groups, 2, '90 000 characters make two chunks of at most 60 000');
  assert.equal(result.calls.low, groups + 3 * planned.length, 'evidence per group, answer design, author and review per batch');
  const quiz = estimateRun('generate', { ...base, kind: 'quiz', sources });
  assert.equal(quiz.calls.low, 11, 'two evidence groups and three batches with answer design, authoring and review');
  assert.equal(result.calls.high, result.calls.low + groups + planned.length, 'evidence and answer design may each receive one correction');
  const ids = result.stages.map((stage) => stage.id);
  assert.deepEqual([...new Set(ids)].sort(), ['author', 'blueprint', 'plan', 'review']);
  assert.equal(result.stages.find((stage) => stage.id === 'plan').calls, groups);
});

test('the estimate prices the very strings the pipeline sends', async () => {
  const sources = pdf(30);
  const sent = [];
  const model = createFakeModel({ latencyMs: 0 });
  await generateBatched(async (system, prompt, context = {}) => { sent.push({ system, prompt, stage: context.stage }); return model(system, prompt); },
    { ...base, sources, count: 10, kind: 'quiz', existing: [] }, () => {}, async () => {});
  const request = { ...base, kind: 'quiz', sources };
  const estimate = estimateRun('generate', request);
  assert.equal(sent.length, estimate.calls.low, 'the number of calls is the pipeline\'s');
  const priced = (call) => dshSystemTokens(call.system) + dshUserTokens(call.prompt);
  const actual = sent.reduce((sum, call) => sum + priced(call), 0);
  assert.ok(actual >= estimate.inputTokens.low && actual <= estimate.inputTokens.high, `sent ${actual} outside ${range(estimate.inputTokens)}`);
  // The planning call of the first chunk is built by the same function the estimate uses.
  const first = planGeneration({ sources, count: 10, kind: 'quiz' })[0];
  const plan = planPrompts({ ...request, sources: first.sources, count: 7, kind: 'quiz', existing: [] });
  const recorded = sent.find((call) => call.system === plan.system && call.prompt === plan.prompt);
  assert.ok(recorded, 'planPrompts is what generateBatched sends');
  assert.ok(typeof authorPrompts === 'function' && typeof reviewPrompts === 'function');
});

test('the estimate grows with the material and with the number of questions', () => {
  const small = estimateRun('generate', { ...base, sources: [note] });
  const pdf30 = estimateRun('generate', { ...base, sources: pdf(30) });
  const pdf150 = estimateRun('generate', { ...base, sources: pdf(150) });
  monotone(small, pdf30, 'note -> 30 pages');
  monotone(pdf30, pdf150, '30 -> 150 pages');
  let previous;
  for (const count of [5, 10, 20, 30]) {
    const current = estimateRun('generate', { ...base, count, sources: pdf(30) });
    if (previous) monotone(previous, current, `${count} questions`);
    previous = current;
  }
  assert.ok(pdf30.outputTokens.low >= 10 * 100, 'ten questions are not a few tokens');
  assert.ok(pdf30.outputTokens.high <= 10 * 1500);
});

test('output tokens come from the bundled sample, per kind and language', () => {
  const choice = estimateRun('generate', { ...base, kind: 'quiz', sources: pdf(10) });
  const plain = estimateRun('generate', { ...base, kind: 'flashcard', sources: pdf(10) });
  assert.ok(choice.outputTokens.low > plain.outputTokens.low, 'questions with options are longer than flashcards');
  const zh = estimateRun('generate', { ...base, language: '中文', kind: 'quiz', sources: pdf(10) });
  assert.ok(zh.outputTokens.high / zh.outputTokens.low > choice.outputTokens.high / choice.outputTokens.low, 'Chinese output is where the heuristic differs most');
});

test('a prompt repeated across calls is the only part a provider cache can serve', () => {
  const single = estimateRun('suggest', { system: 's'.repeat(400), prompt: JSON.stringify({ sources: [{ title: 'a' }] }) });
  assert.equal(single.calls.low, 1);
  assert.equal(single.cacheReadTokens.high, 0, 'one call cannot read its own cache');
  const many = estimateRun('generate', { ...base, sources: pdf(30) });
  assert.ok(many.cacheReadTokens.high > 0 && many.cacheReadTokens.high < many.inputTokens.high);
  assert.ok(many.notes.includes('cache-depends'));
});

test('a selection beyond the limit says so and prices what would fit', () => {
  const book = pdf(400, 3000);
  const result = estimateRun('generate', { ...base, sources: book });
  assert.ok(book.reduce((sum, source) => sum + source.text.length, 0) > MAX_SELECTED_CHARS);
  assert.equal(result.blocked.code, 'over-limit');
  assert.equal(result.blocked.limit, MAX_SELECTED_CHARS);
  assert.ok(result.blocked.chars > MAX_SELECTED_CHARS);
  assert.ok(result.blocked.fitSources > 0 && result.blocked.fitSources < 400);
  assert.ok(result.notes.includes('over-limit'));
  assert.ok(result.calls.low >= 10, 'ten chunks are planned');
  const within = estimateRun('generate', { ...base, sources: book.slice(0, result.blocked.fitSources) });
  assert.equal(within.blocked, undefined);
  assert.deepEqual(within.totalTokens, result.totalTokens, 'the capped estimate is what the largest allowed selection costs');
});

test('a large selection explains what is sent where', () => {
  const result = estimateRun('generate', { ...base, sources: pdf(60) });
  assert.ok(result.notes.includes('large-selection'));
  assert.ok(!estimateRun('generate', { ...base, sources: [note] }).notes.includes('large-selection'));
});

test('a high reasoning level is noted without inventing reasoning numbers', () => {
  const normal = estimateRun('generate', { ...base, sources: [note], reasoningEffort: 'low' });
  const high = estimateRun('generate', { ...base, sources: [note], reasoningEffort: 'high' });
  assert.ok(!normal.notes.includes('effort-high'));
  assert.ok(high.notes.includes('effort-high'));
  assert.deepEqual(high.totalTokens, normal.totalTokens, 'there is nothing measured to add');
});

test('Chinese material is flagged as likely above the lower bound', () => {
  const chinese = { id: 'zh-1', title: '讲义.md', text: '设计模式讲义：让对象在不暴露内部细节的前提下保存和恢复自身状态。'.repeat(120), courses: [] };
  const result = estimateRun('generate', { ...base, language: '中文', sources: [chinese] });
  assert.ok(result.notes.includes('cjk-higher'));
  assert.ok(result.inputTokens.high > result.inputTokens.low * 1.5);
  assert.ok(!estimateRun('generate', { ...base, sources: [note] }).notes.includes('cjk-higher'));
});

test('a case paper is an author call and an independent review; its size follows questions and marks', () => {
  const small = estimateRun('case', { language: 'English', questions: 2, totalMarks: 10, sources: [note] });
  const large = estimateRun('case', { language: 'English', questions: 5, totalMarks: 40, sources: [note, page(1, 40000)] });
  assert.equal(small.calls.low, 2);
  assert.equal(small.calls.high, 3, 'a structural problem is written once more');
  assert.deepEqual([...new Set(small.stages.map((stage) => stage.id))].sort(), ['author', 'review']);
  monotone(small, large, 'case size');
  assert.ok(large.inputTokens.high > small.inputTokens.high, 'bounded course materials are priced');
  const imported = estimateRun('case', { language: 'English', scenario: filler(5000), items: [{ prompt: 'Why bridge?', marks: 6 }], sources: [] });
  assert.ok(imported.calls.low >= 1 && imported.totalTokens.low > 0);
});

test('grading prices the case, the rubric and the learner answer; output follows the criteria', () => {
  const paper = { title: 'Case', paragraphs: filler(3000).match(/.{1,400}/g), cues: [{ id: 'cue1', paragraph: 2, quote: 'x', implies: 'y' }],
    questions: [{ cardId: 'c1', prompt: 'Explain', marks: 6, answer: filler(300),
      criteria: [1, 2, 3].map((n) => ({ id: `c${n}`, label: 'label', marks: 2, descriptor: filler(120), keyPoints: ['a point', 'another point'] })) }] };
  const short = estimateRun('grade', { language: 'English', paper, answers: { c1: filler(200) } });
  const long = estimateRun('grade', { language: 'English', paper, answers: { c1: filler(4000) } });
  assert.equal(short.calls.low, 1);
  monotone(short, long, 'longer answer');
  assert.ok(long.inputTokens.low > short.inputTokens.low);
  assert.equal(short.outputTokens.low, long.outputTokens.low, 'the reply does not grow with the answer');
  const more = estimateRun('grade', { language: 'English', paper: { ...paper, questions: [paper.questions[0], { ...paper.questions[0], cardId: 'c2' }] }, answers: { c1: filler(200), c2: filler(200) } });
  assert.ok(more.outputTokens.low > short.outputTokens.low, 'every graded question has its own criteria feedback');
  assert.equal(estimateRun('grade', { language: 'English', paper, answers: {} }).calls.low, 0, 'nothing answered, nothing sent');
});

test('帮我想想 is one small call priced from its real prompt', () => {
  const result = estimateRun('suggest', { system: 'x'.repeat(1500), prompt: JSON.stringify({ sources: [{ title: 'Week 1', headings: ['Memento', 'Bridge'] }] }) });
  assert.equal(result.calls.low, 1);
  assert.ok(result.totalTokens.high < 3000, `tiny: ${range(result.totalTokens)}`);
  assert.ok(result.outputTokens.low > 0);
});

test('a lesson is an article and its review; both carry the lesson input', () => {
  const input = { topic: 'Bridge', mode: 'lesson', instructions: 'Teach it', existingMaterial: '', cards: [{ prompt: filler(300), answer: filler(100) }], evidence: [{ sourceId: 's', text: filler(4000) }] };
  const lesson = estimateRun('flow', { system: 'article system '.repeat(80), reviewSystem: 'review system '.repeat(40), input, mode: 'lesson' });
  assert.equal(lesson.calls.low, 2);
  assert.equal(lesson.calls.high, 4, 'a failed check writes the article once more');
  assert.ok(lesson.outputTokens.low >= 600 * 0.25, 'an article of at least 600 characters');
  const remedy = estimateRun('flow', { system: 'article system '.repeat(80), reviewSystem: 'review system '.repeat(40), input: { ...input, mode: 'remedy' }, mode: 'remedy' });
  assert.ok(remedy.outputTokens.high < lesson.outputTokens.high, 'a remedy is shorter than a lesson');
});

test('audio text steps follow the proofreading and translation windows', () => {
  const hour = estimateRun('audio', { minutes: 60, language: 'en' });
  const half = estimateRun('audio', { minutes: 30, language: 'en' });
  monotone(half, hour, 'minutes');
  assert.ok(hour.notes.includes('transcript-estimated'));
  assert.ok(hour.notes.includes('transcribe-separate'));
  const chars = estimateRun('audio', { transcriptChars: 54000, language: 'en' });
  assert.ok(!chars.notes.includes('transcript-estimated'));
  // 54 000 characters: ceil(54000 / 6000) proofreading windows, ceil(54000 / 3500) translation windows and one title.
  assert.equal(chars.calls.low, 9 + 16 + 1);
  assert.equal(chars.stages.find((stage) => stage.id === 'proofread').calls, 9);
  assert.equal(chars.stages.find((stage) => stage.id === 'translate').calls, 16);
  const chinese = estimateRun('audio', { transcriptChars: 54000, language: 'zh' });
  assert.ok(chinese.inputTokens.high / chinese.inputTokens.low > chars.inputTokens.high / chars.inputTokens.low);
  assert.equal(estimateRun('audio', { minutes: 0, language: 'en' }).calls.low, 0);
});

test('estimates are pure: no network, no model, and bad input does not throw', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the estimate must not touch the network'); };
  try {
    assert.doesNotThrow(() => estimateRun('generate', { ...base, sources: [note] }));
    assert.doesNotThrow(() => estimateRun('generate', {}));
    assert.doesNotThrow(() => estimateRun('generate', { count: 'many', sources: [{ id: 1 }, null, { text: 5 }] }));
    assert.doesNotThrow(() => estimateRun('nonsense', {}));
  } finally { globalThis.fetch = original; }
  assert.equal(estimateRun('generate', {}).calls.low, 0, 'no material, no calls');
  assert.equal(estimateRun('nonsense', {}).calls.low, 0);
});

test('a host token meter prices the same text when given', () => {
  const counting = { calls: 0, estimateMessage(message) { this.calls++; return message.content[0]?.text.length ?? 0; } };
  const result = estimateRun('generate', { ...base, sources: [note] }, { measure: createTextMeasure({ tokenMeter: counting }) });
  assert.ok(counting.calls > 0, 'the host estimator was asked');
  assert.ok(result.inputTokens.low > 0);
});

test('estimateFromState resolves materials and existing objectives like the generate action does', () => {
  const state = { sources: [note, ...pdf(3)], decks: [{ id: 'd', cards: [{ objective: 'one' }, { objective: 'two' }] }], drafts: [{ id: 'dr', cards: [{ objective: 'three' }] }],
    courses: [], settings: {}, attempts: [], runs: [] };
  const result = estimateFromState('generate', { sourceIds: ['note-1', 'book-p1'], count: 5, kind: 'quiz', language: 'English' }, state, {});
  assert.equal(result.feature, 'generate');
  assert.ok(result.calls.low >= 3);
  const missing = estimateFromState('generate', { sourceIds: ['nope'], count: 5 }, state, {});
  assert.equal(missing.calls.low, 0);
  const more = estimateFromState('generate', { sourceIds: ['note-1', 'book-p1', 'book-p2', 'book-p3'], count: 5, kind: 'quiz', language: 'English' }, state, {});
  assert.ok(more.inputTokens.low > result.inputTokens.low);
  const suggest = estimateFromState('suggest', { sourceIds: ['note-1'], course: '' }, state, {});
  assert.equal(suggest.calls.low, 1);
  const audio = estimateFromState('audio', { minutes: 60, language: 'en' }, state, {});
  assert.ok(audio.calls.low > 20);
  assert.throws(() => estimateFromState('generate', { sourceIds: 'x' }, state, {}), /sourceIds/);
});
