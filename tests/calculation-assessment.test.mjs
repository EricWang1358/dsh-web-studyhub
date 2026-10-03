import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blueprintAssessment } from '../lib/assessment-quality.js';
import { generateDeck, reviewPrompts } from '../lib/generation.js';
import { publicCard } from '../lib/domain.js';
import { StudyService } from '../lib/service.js';
import { authored, qualityPlan, qualityBlueprint, qualityReview } from './helpers/assessment.mjs';

const source = { id: 'motion', title: 'Uniform motion', text: 'For constant speed, distance equals speed multiplied by elapsed time.' };
const request = { count: 1, kind: 'flashcard', sources: [source] };
const card = { id: 'distance', kind: 'flashcard', targetId: 'target-1', topic: 'Uniform motion', objective: 'Calculate distance at constant speed',
  prompt: 'A constructed example has a constant speed of 3 m/s for 4 s. What distance is travelled?', answer: '12 m',
  hint: 'Use the constant-speed relationship and check the units.', explanation: 'In this constructed example, distance is speed times elapsed time: 3 m/s times 4 s gives 12 m. Seconds cancel, leaving metres.',
  misconception: 'Adding speed and elapsed time mixes unlike dimensions.', citations: [{ sourceId: source.id, quote: source.text }] };
const calculation = { variables: { speed: { value: 3, unit: 'm/s' }, time: { value: 4, unit: 's' } }, expression: 'speed*time', result: { value: 12, unit: 'm' },
  steps: [{ name: 'distance', expression: 'speed*time', value: 12, unit: 'm' }] };
const plan = qualityPlan(request);
const blueprint = () => ({ ...qualityBlueprint(request, plan, { cards: [card] }), items: [{ ...qualityBlueprint(request, plan, { cards: [card] }).items[0], calculation: structuredClone(calculation) }] });

test('deterministic result defects receive the existing single blueprint correction', async () => {
  const wrong = blueprint(); wrong.items[0].calculation.result.value = 13;
  const replies = [wrong, blueprint()], prompts = [];
  const corrected = await blueprintAssessment(async (_system, prompt) => { prompts.push(prompt); return replies.shift(); }, request, plan);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /calculation.*mismatch.*12.*13/i);
  assert.equal(corrected.items[0].calculation.result.value, 12);
  let calls = 0;
  await assert.rejects(blueprintAssessment(async () => { calls++; return wrong; }, request, plan), /calculation.*mismatch/i);
  assert.equal(calls, 2);
});

test('review gets recomputed diagnostic statuses for absent, unsupported and supported evidence', () => {
  const items = [blueprint().items[0], { ...blueprint().items[0], targetId: 'target-2', calculation: { ...calculation, expression: 'sqrt(speed)' } },
    { ...blueprint().items[0], targetId: 'target-3', calculation: undefined }];
  const payload = JSON.parse(reviewPrompts({ sources: [source], deck: { cards: [card] }, answerBlueprint: { items } }).payload);
  assert.deepEqual(payload.calculationChecks.map(check => check.status), ['agreement', 'not_checked', 'not_checked']);
  assert.match(payload.task, /arithmetic agreement.*semantic|semantic.*arithmetic agreement/i);
});

test('numeric generation retains exact source and answer binding, uses no new model call, and saves privately', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-calculation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = new StudyService(home);
  await service.call('source.add', source);
  const calls = [];
  const deck = await generateDeck(async (system, prompt) => {
    if (system.startsWith('Plan')) { calls.push('evidence'); return JSON.stringify(plan); }
    if (system.startsWith('Prepare supported answers')) { calls.push('blueprint'); return JSON.stringify(blueprint()); }
    if (system.startsWith('You author')) {
      calls.push('author');
      return JSON.stringify(authored({ title: 'Motion', cards: [{ ...card, answer: '999 m', citations: [{ sourceId: source.id, quote: 'An invented formula.' }] }] }));
    }
    calls.push('review');
    const payload = JSON.parse(prompt);
    assert.equal(payload.calculationChecks[0].status, 'agreement');
    assert.equal(payload.candidate.cards[0].answer, '12 m');
    assert.deepEqual(payload.candidate.cards[0].citations, plan.targets[0].citations);
    return JSON.stringify(qualityReview(payload.candidate));
  }, request);
  assert.deepEqual(calls, ['evidence', 'blueprint', 'author', 'review']);
  const saved = await service.call('draft.save', { deck });
  assert.equal(saved.editorial.evidenceWorkflow.answers[0].calculation.expression, 'speed*time');
  const visible = publicCard(saved.cards[0]);
  for (const field of ['answer', 'explanation', 'calculation', 'editorial', 'citations']) assert.equal(field in visible, false, field);
  assert.equal(JSON.stringify(visible).includes('12 m'), false);
});

test('unsupported and legacy items do not incur a blanket calculation correction or approval', async () => {
  for (const data of [undefined, { ...calculation, expression: 'sqrt(speed)' }]) {
    const reply = blueprint();
    if (data === undefined) delete reply.items[0].calculation;
    else reply.items[0].calculation = data;
    let calls = 0;
    const result = await blueprintAssessment(async () => { calls++; return reply; }, request, plan);
    assert.equal(calls, 1);
    assert.deepEqual(result.items, reply.items);
    const payload = JSON.parse(reviewPrompts({ sources: [source], deck: { cards: [card] }, answerBlueprint: result }).payload);
    assert.equal(payload.calculationChecks[0].status, 'not_checked');
  }
});

test('arithmetic agreement cannot approve an unsupported semantic interpretation', async () => {
  await assert.rejects(generateDeck(async (system, prompt) => {
    if (system.startsWith('Plan')) return JSON.stringify(plan);
    if (system.startsWith('Prepare supported answers')) return JSON.stringify(blueprint());
    if (system.startsWith('You author')) return JSON.stringify(authored({ title: 'Motion', cards: [{ ...card, prompt: 'What kinetic energy does this motion imply?' }] }));
    const payload = JSON.parse(prompt);
    assert.equal(payload.calculationChecks[0].status, 'agreement');
    const review = qualityReview(payload.candidate);
    review.checks[0].sourceSupport = 'fail';
    review.checks[0].explanation = 'Distance arithmetic does not support kinetic energy; the formula does not answer this stem.';
    return JSON.stringify(review);
  }, request), /Quality gate failed|sourceSupport/);
});

test('a correction cannot evade an established mismatch by removing calculation evidence', async () => {
  const wrong = blueprint(); wrong.items[0].calculation.result.value = 13;
  for (const data of [undefined, { ...calculation, expression: 'sqrt(speed)' }]) {
    const second = blueprint(); second.items[0].calculation = data;
    const replies = [wrong, second];
    await assert.rejects(blueprintAssessment(async () => replies.shift(), request, plan), /prior calculation mismatch must be corrected/);
  }
});

test('a persistent mismatch omits only its bound target and preserves a sound numerical answer', async () => {
  const req = { ...request, count: 2 }, selected = qualityPlan(req), reply = blueprint();
  reply.items.push({ ...structuredClone(reply.items[0]), targetId: 'target-2' });
  reply.items[1].calculation.result.value = 13;
  let calls = 0;
  const result = await blueprintAssessment(async () => { calls++; return reply; }, req, selected);
  assert.equal(calls, 2);
  assert.deepEqual(result.items, [reply.items[0]]);
  assert.equal(result.omitted[0].targetId, 'target-2');
  assert.match(result.omitted[0].reason, /calculation mismatch/);
});
