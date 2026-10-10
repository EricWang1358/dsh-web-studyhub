/* 复习全书 M5 · what an answer card is written from (lib/answer-card-materials.js): materials that fit are sent whole as their visible text; when they do not,
   the passages that share the most terms with the question come first (rare terms weigh more), then the rest in reading order, within the budget, each
   material's passages in reading order with […] for what was left out. Deterministic; Chinese terms count too. The plan of the job uses it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { passagesOf, selectMaterials, termsOf } from '../lib/answer-card-materials.js';
import { planAnswerCard } from '../lib/contexts/generation/answer-card/plan.js';
import { caseLibrary } from './helpers/answer-card-library.mjs';

const filler = (n, word) => Array.from({ length: n }, (_, at) => `Paragraph ${at + 1} about ${word} and the history of the organisation, its offices and its staff. `.repeat(6)).join('\n\n');

test('terms: Latin words without common ones, Chinese pairs', () => {
  assert.deepEqual([...termsOf('The availability of the booking service: MTBF and MTTR')], ['availability', 'booking', 'service', 'mtbf', 'mttr']);
  assert.deepEqual([...termsOf('系统可用性')], ['系统', '统可', '可用', '用性']);
  assert.deepEqual(passagesOf('a\n\n\nb').map(item => item.text), ['a', 'b']);
  assert.ok(passagesOf('x'.repeat(3000)).every(item => item.text.length <= 1200));
});

test('materials that fit go whole, as their visible text; refs follow the material order', () => {
  const out = selectMaterials([{ id: 'a', title: 'A', text: '<p>Availability is the <b>share</b> of uptime.</p>' }, { id: 'b', title: 'B', text: '' }, { id: 'c', title: 'C', text: 'Redundancy.' }],
    { query: ['availability'], budget: 1000 });
  assert.deepEqual(out, [{ ref: 'M1', title: 'A', text: 'Availability is the share of uptime. ' }, { ref: 'M3', title: 'C', text: 'Redundancy.' }]);
});

test('over the budget: the passages that match the question come first, in reading order, with […]; the same input gives the same output', () => {
  const definition = 'Availability is the proportion of time a system is able to perform its required function; with MTBF and MTTR, A = MTBF / (MTBF + MTTR).';
  const sources = [
    { id: 'l1', title: 'Lecture 1 · History', text: filler(30, 'history') },
    { id: 'l4', title: 'Lecture 4 · Reliability', text: `${filler(25, 'reliability planning')}\n\n${definition}\n\n${filler(5, 'staffing')}` },
  ];
  const query = ['Does the booking service meet its availability target? Show the calculation with MTBF and MTTR.'];
  const out = selectMaterials(sources, { query, budget: 6000 });
  assert.deepEqual(out, selectMaterials(sources, { query, budget: 6000 }), 'deterministic');
  const l4 = out.find(item => item.ref === 'M2');
  assert.ok(l4 && l4.text.includes(definition), 'the definition deep in the second lecture is sent');
  assert.equal(l4.excerpt, true);
  assert.match(l4.text, /^\[…\]\n\n/, 'something before it was left out');
  assert.ok(out.reduce((sum, item) => sum + item.text.replace(/\[…\]\n\n|\n\n\[…\]/g, '').length, 0) <= 6000 + 200, 'within the budget');
  // The plain old cut (the first characters of each source) would have missed it.
  assert.equal(sources[1].text.slice(0, 3000).includes(definition), false);
  const zh = selectMaterials([{ id: 'z', title: '讲义', text: `${'公司的历史和办公室。'.repeat(200)}\n\n可用性是系统能够执行规定功能的时间比例。\n\n${'员工和组织。'.repeat(200)}` }],
    { query: ['这个系统的可用性达到目标了吗？'], budget: 1500 });
  assert.match(zh[0].text, /可用性是系统能够执行规定功能的时间比例。/, 'Chinese terms rank too');
});

test('the job\'s plan sends the matching passages of a long material, and keeps the whole materials for checking the quotes', () => {
  const { sources, deck } = caseLibrary();
  const long = `${filler(60, 'company history')}\n\n${sources[1].text}\n\n${filler(20, 'staff')}`;
  sources[1] = { ...sources[1], text: long };
  const plan = planAnswerCard({ sources, decks: [deck], runs: [], courses: [] }, { deckId: 'case1', cardId: 'q1' });
  assert.ok(long.length > 24000);
  assert.ok(plan.bounded[0].text.includes('Availability is the proportion of time a system is able to perform its required function'));
  assert.ok(plan.bounded[0].text.length <= 24000 + 20);
  assert.equal(plan.materials[0].text, long, 'quotes are checked against the whole material');
});
