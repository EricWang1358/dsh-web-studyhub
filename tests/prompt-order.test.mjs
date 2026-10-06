import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrompts, blueprintPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts, parseJson, generateDeck } from '../lib/generation.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { patchPrompts } from '../lib/generation-yield.js';
import { LEAD_SOURCE_CHARS, REQUEST_DATA, leadsWithSources, promptOrder, withField, dataPayload } from '../lib/prompt-order.js';
import { requestData } from './helpers/request-data.mjs';

/* Token cost (prompt cache): a provider reuses the longest IDENTICAL prefix of earlier prompts, so what varies from call to call (the count, ids, the plan so far) goes
   after what is stable (the instructions, the sources). Only the ORDER of the prompt and of the fields of its data changes; appended corrections and re-asks stay at the very end.
   The default layout keeps the instructions first (lib/prompt-order.js says why: measured, it is the better one while each stage's system text leads the request); the layout with
   the sources first is built and tested here with the switch on, so that it can be turned on when that system text no longer leads. */
const sourcesFirst = (on, run) => {
  const before = promptOrder.sourcesFirst, restore = () => { promptOrder.sourcesFirst = before; };
  promptOrder.sourcesFirst = on;
  let result;
  try { result = run(); } catch (error) { restore(); throw error; }
  if (typeof result?.then === 'function') return result.finally(restore);
  restore();
  return result;
};

const textOf = (tag, size) => Array.from({ length: Math.ceil(size / 90) }, (_, i) => `Sentence ${i} of ${tag}: the mechanism of idea ${i} holds under condition ${i % 7}.`).join(' ').slice(0, size);
const big = [{ id: 'big', title: 'Lecture notes', text: textOf('big', LEAD_SOURCE_CHARS + 4000) }];
const small = [{ id: 'small', title: 'One page', text: textOf('small', 600) }];
const target = (n) => ({ targetId: `target-${n}`, objective: `Objective ${n}`, knowledge: `Knowledge ${n}`, citations: [{ sourceId: 'x', quote: `Quote number ${n} of the source` }] });
const item = (n) => ({ targetId: `target-${n}`, answer: `Answer ${n}`, reasoning: `Reasoning ${n}`, comparisonAxis: 'axis', scenario: { kind: 'none', facts: [], decisiveConditions: [] } });
const planOf = (n) => ({ targets: Array.from({ length: n }, (_, i) => target(i + 1)) });
const blueprintOf = (n) => ({ items: Array.from({ length: n }, (_, i) => item(i + 1)) });
const deckOf = (n) => ({ title: 'D', cards: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, targetId: `target-${i + 1}`, kind: 'quiz', prompt: `Question ${i + 1}?`, answer: `Answer ${i + 1}` })) });
const common = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; };
const base = (sources, extra = {}) => ({ kind: 'quiz', difficulty: 'mixed', language: 'English', focus: 'transactions', role: '', constraints: { hintNoAnswer: true }, sources, existing: ['Old objective one', 'Old objective two'], ...extra });
/** The four calls of one part for `count` questions. */
const part = (sources, count, extra) => {
  const request = base(sources, { count, ...extra });
  return { plan: planPrompts(request).prompt, blueprint: blueprintPrompts(request, planOf(count)).prompt, author: authorPrompts(request, planOf(count), blueprintOf(count)).prompt,
    review: reviewPrompts({ sources, deck: deckOf(count), kind: 'quiz', count, structuralErrors: [], difficulty: 'mixed', focus: 'transactions', constraints: { hintNoAnswer: true }, assessmentPlan: planOf(count), answerBlueprint: blueprintOf(count), ...extra }).payload };
};
const sourceBlock = (sources) => JSON.stringify(sources);

test('the threshold: with the switch on, sources lead when their block is bigger than the biggest stage instruction block', () => {
  const lengths = Object.values(part([], 1)).map(text => text.length);
  assert.ok(LEAD_SOURCE_CHARS > Math.max(...lengths), `${LEAD_SOURCE_CHARS} is above the longest stage instruction block (${Math.max(...lengths)} characters)`);
  sourcesFirst(true, () => {
    assert.equal(leadsWithSources(big), true);
    assert.equal(leadsWithSources(small), false);
    assert.equal(leadsWithSources([]), false);
    assert.equal(leadsWithSources(undefined), false);
  });
});

test('by default the instructions lead whatever the size of the sources (the measured better layout)', () => {
  assert.equal(promptOrder.sourcesFirst, false);
  assert.equal(leadsWithSources(big), false);
  const all = part(big, 4);
  assert.ok(all.plan.startsWith('STAGE 1') && all.blueprint.startsWith('STAGE 2') && all.author.startsWith('STAGE 3'));
  assert.ok(all.review.startsWith('{"task"'));
});

test('sources first (switched on): every stage of a part starts with the same marker and source block', () => sourcesFirst(true, () => {
  const all = part(big, 4), head = `${REQUEST_DATA}{"sources":${sourceBlock(big)},`;
  for (const [stage, prompt] of Object.entries(all)) assert.ok(prompt.startsWith(head), `${stage} starts with the source block`);
  // So two different stages of the same part share a prefix that covers the whole source block.
  for (const [a, b] of [['plan', 'blueprint'], ['blueprint', 'author'], ['author', 'review'], ['plan', 'review']])
    assert.ok(common(all[a], all[b]) >= head.length, `${a} and ${b} share the source prefix`);
  // The instructions follow the data (plan, blueprint, author); the review payload is the data alone.
  assert.ok(all.plan.indexOf('STAGE 1') > head.length && all.blueprint.indexOf('STAGE 2') > head.length && all.author.indexOf('STAGE 3') > head.length);
  assert.ok(!all.review.includes('STAGE'));
}));

test('small sources keep the instructions first, as before', () => {
  const all = part(small, 4);
  assert.ok(all.plan.startsWith('STAGE 1') && all.blueprint.startsWith('STAGE 2') && all.author.startsWith('STAGE 3'));
  for (const stage of ['plan', 'blueprint', 'author']) assert.ok(all[stage].includes(`\n${REQUEST_DATA}{`), `${stage} keeps the REQUEST DATA marker before its data`);
  assert.ok(all.review.startsWith('{"task"'), 'the review payload is a JSON object, its stable text first');
});

for (const [name, sources, lead] of [['big', big, false], ['small', small, false], ['big, sources first', big, true]]) {
  test(`${name} sources: the same stage of the same part with a different count shares a prefix that covers the source block`, () => sourcesFirst(lead, () => {
    const a = part(sources, 4), b = part(sources, 7), end = (prompt) => prompt.indexOf(sourceBlock(sources)) + sourceBlock(sources).length;
    for (const stage of ['plan', 'blueprint', 'author', 'review']) {
      assert.ok(a[stage].includes(sourceBlock(sources)), `${stage} carries the source block`);
      assert.ok(common(a[stage], b[stage]) >= end(a[stage]), `${stage}: the prefix covers the source block (${common(a[stage], b[stage])} of ${end(a[stage])})`);
    }
  }));

  test(`${name} sources: the count is the last field of the data, and the instructions do not depend on it`, () => sourcesFirst(lead, () => {
    for (const count of [3, 8]) {
      const all = part(sources, count);
      for (const stage of ['plan', 'blueprint', 'author', 'review']) assert.equal(Object.keys(requestData(all[stage])).at(-1), 'count', `${stage}: count is last`);
    }
    const [a, b] = [part(sources, 3), part(sources, 8)], instructions = (prompt) => prompt.replace(/REQUEST DATA:\n\{[\s\S]*?\}\n\n(?=STAGE)/, '').split(`${REQUEST_DATA}{`)[0];
    for (const stage of ['plan', 'author']) assert.equal(instructions(a[stage]), instructions(b[stage]), `${stage}: no count in the instruction text`);
  }));
}

test('the varying parts of a stage come after the stable ones', () => {
  const keys = (stage, sources) => Object.keys(requestData(part(sources, 4)[stage]));
  const after = (list, first, second) => assert.ok(list.indexOf(first) < list.indexOf(second), `${first} before ${second} in ${list.join(',')}`);
  for (const sources of [big, small]) {
    const plan = keys('plan', sources), blueprint = keys('blueprint', sources), author = keys('author', sources), review = keys('review', sources);
    after(plan, 'focus', 'existing'); after(plan, 'sources', 'existing');
    after(blueprint, 'sources', 'assessmentPlan'); after(blueprint, 'focus', 'assessmentPlan');
    after(author, 'sources', 'assessmentPlan'); after(author, 'assessmentPlan', 'answerBlueprint');
    after(review, 'sources', 'candidate'); after(review, 'constraints', 'candidate'); after(review, 'candidate', 'count');
  }
});

test('an appended correction or re-ask stays at the very end, behind an unchanged prompt', () => {
  for (const lead of [false, true]) sourcesFirst(lead, () => {
    for (const sources of [big, small]) {
      const request = base(sources, { count: 4 }), note = '\n\nYour previous plan was rejected: fix it.';
      assert.equal(planPrompts(request, note).prompt, planPrompts(request).prompt + note);
      assert.equal(blueprintPrompts(request, planOf(4), note).prompt, blueprintPrompts(request, planOf(4)).prompt + note);
    }
  });
});

test('the patch prompt puts its cards (what varies) after the stable fields and the sources', () => {
  const { prompt } = patchPrompts({ entries: [{ card: { id: 'q1', kind: 'quiz', topic: 't', prompt: 'p', hint: 'h', explanation: 'e', misconception: 'm' }, issues: ['x'], fields: new Set(['explanation']) }], sources: small, language: 'English', constraints: { hintNoAnswer: true } });
  const keys = Object.keys(parseJson(prompt.slice(prompt.indexOf(REQUEST_DATA) + REQUEST_DATA.length)));
  assert.deepEqual(keys, ['language', 'constraints', 'sources', 'cards']);
});

test('what each stage is sent: the plan only what it needs, the answers and the questions no list of covered targets, the references only where the style is applied', () => {
  const references = [{ id: 'ref', title: 'Past paper', text: 'Q1. Which is right? (a) x (b) y' }];
  const noisy = { ...base(small, { count: 3 }), questionReferences: references, referenceFormat: 'strict', referenceLimits: { sources: 5, chars: 100 }, referenceSourceIds: ['ref'],
    control: { values: { concurrency: 3 } }, signal: new AbortController().signal, performance: { concurrency: 3 }, sourceIds: ['small'], notation: 'auto', notationResolved: 'latex', pinnedExisting: ['Pinned'],
    priorRound: { rejected: ['r'] }, title: 'T', course: 'C', coverageSections: [{ id: 's1', title: 'One' }], assignments: [{ id: 'a1', quota: 2, title: 'One' }] };
  const plan = requestData(planPrompts(noisy).prompt);
  assert.deepEqual(Object.keys(plan).sort(), ['assignments', 'constraints', 'count', 'coverageSections', 'difficulty', 'existing', 'focus', 'kind', 'language', 'role', 'sources']);
  assert.deepEqual(plan.existing, ['Old objective one', 'Old objective two'], 'the plan keeps the covered targets: it is where they are de-duplicated');
  const blueprint = requestData(blueprintPrompts(noisy, planOf(3)).prompt);
  assert.equal('alreadyCovered' in blueprint, false);
  assert.equal(JSON.stringify(blueprint).includes('Old objective one'), false, 'the blueprint works from planned targets, already de-duplicated');
  for (const key of ['referenceQuestions', 'referenceFormat', 'referenceInstruction', 'referenceFormatInstruction']) assert.equal(key in blueprint, false, `blueprint: no ${key}`);
  const author = requestData(authorPrompts(noisy, planOf(3), blueprintOf(3)).prompt);
  assert.equal('alreadyCovered' in author, false);
  assert.equal(JSON.stringify(author).includes('Old objective one'), false);
  assert.ok(author.referenceQuestions?.length, 'the author applies the style of the references');
  assert.deepEqual(author.priorRound, { rejected: ['r'] }, 'a re-ask round keeps telling the author what was rejected');
  const review = requestData(reviewPrompts({ ...noisy, deck: deckOf(3), count: 3, assessmentPlan: planOf(3), answerBlueprint: blueprintOf(3) }).payload);
  assert.ok(review.referenceQuestions?.length, 'the review checks the format against the references');
});

test('the request data of a big-source prompt reads back whole in both layouts (the reader finds the data before the instructions too)', () => {
  for (const lead of [false, true]) sourcesFirst(lead, () => {
    const all = part(big, 5, { questionReferences: [{ id: 'r', title: 'T', text: 'Q' }] });
    for (const stage of ['plan', 'blueprint', 'author', 'review']) assert.deepEqual(requestData(all[stage]).sources, big, `${stage} ${lead}`);
  });
});

test('a re-ask field goes to the end of the data and keeps the prompt a prefix, in both layouts', () => {
  for (const lead of [false, true]) sourcesFirst(lead, () => {
    const payload = dataPayload({ sources: big, before: { kind: 'quiz' }, after: { candidate: { cards: [] }, count: 0 } });
    const asked = withField(payload, 'reask', { problem: 'cut off' });
    assert.ok(asked.startsWith(payload.slice(0, -1)), 'the payload is a prefix of the re-ask, up to its closing brace');
    assert.deepEqual(Object.keys(requestData(asked)).slice(-2), ['count', 'reask']);
  });
});

test('a whole part runs through the pipeline in the sources-first layout too (the fake model reads the data before the instructions)', async () => sourcesFirst(true, async () => {
  const log = [], model = createFakeModel({ log });
  const deck = await generateDeck(model, { count: 3, kind: 'quiz', language: 'English', sources: big });
  assert.ok(deck.cards.length >= 1, 'questions came out');
  const stages = log.filter(entry => /^(Plan a source|Prepare supported|You author|Act as a strict)/.test(entry.system));
  assert.ok(stages.length >= 4);
  for (const entry of stages) assert.ok(entry.prompt.startsWith(`${REQUEST_DATA}{"sources":`), `${entry.system.slice(0, 20)} leads with its sources`);
}));
