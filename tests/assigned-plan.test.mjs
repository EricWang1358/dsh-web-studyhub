import test from 'node:test';
import assert from 'node:assert/strict';
import { completeJson } from '../lib/generation.js';
import { planAssigned, enforceAssignment, assignmentGroups, pieceOfAssignment, PLAN_SHORT } from '../lib/assigned-plan.js';
import { planAssessment } from '../lib/assessment-quality.js';
import { strengthPlan, assignmentsOf, roundsOf } from '../lib/coverage-strength.js';
import { classifyFailure, FAILURE_CODES } from '../lib/generation-failure.js';
import { sectionKey } from '../lib/coverage.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';
import { clusteringModel, sectionOfQuote } from './helpers/clustering-model.mjs';

/* ENFORCED PLANNING: a planning call is given an ASSIGNMENT (a few sections with their ranges and quotas) and the SERVER checks what comes back, so the spread over the material does not
   depend on the planner's goodwill. The planner here clusters on purpose (tests/helpers/clustering-model.mjs): it spends its whole count on the first text it sees. */

const fx = transcriptFixture();
const leaves = fx.leaves.map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
const idOf = key => key.split('#')[1];
const ask = model => (system, prompt) => completeJson(model.complete, system, prompt);
const assign = (list, quota = 1) => list.map(section => ({ key: sectionKey(section.sourceId, section.id), sectionId: sectionKey(section.sourceId, section.id), sourceId: section.sourceId, start: section.start, end: section.end, quota, title: section.title }));
const sectionsOfTargets = (targets, assignments) => [...new Set(targets.map(target => idOf(assignments.find(item => item.key === target.assignment).key)))];
const request = (sources, extra = {}) => ({ sources, kind: 'quiz', existing: [], ...extra });

test('contrast: asked plainly, the clustering planner covers one section of eight; asked for an assignment, the server makes it eight of eight', async () => {
  const assignments = assign(leaves.slice(0, 8));
  const plain = clusteringModel();
  const pieces = assignments.map(item => pieceOfAssignment(item, fx.sources)[0]);
  const naive = await planAssessment(ask(plain), request(pieces, { count: 8 }), { salvage: true });
  const naiveSections = new Set(naive.targets.map(target => sectionOfQuote(target.citations[0].quote)));
  assert.equal(naiveSections.size, 1, 'the planner alone clusters in the first section');
  const model = clusteringModel();
  const result = await planAssigned(ask(model), request(fx.sources, { count: 8 }), { assignments });
  assert.equal(result.targets.length, 8);
  assert.deepEqual(sectionsOfTargets(result.targets, assignments).sort(), assignments.map(item => idOf(item.key)).sort(), 'every assigned section has its target');
  assert.deepEqual(result.short, []);
  assert.deepEqual(result.targets.map(target => target.targetId), Array.from({ length: 8 }, (_, index) => `target-${index + 1}`));
  assert.ok(result.targets.every(target => Number.isInteger(target.start) && target.end > target.start), 'a target carries the offsets of its quote');
  for (const target of result.targets) { const item = assignments.find(a => a.key === target.assignment); assert.ok(target.start >= item.start && target.end <= item.end, 'inside its own section'); }
});

test('a section is asked again ONCE with the missing quota and exactly its own range', async () => {
  const assignments = assign(leaves.slice(10, 14), 2);
  const model = clusteringModel();
  const result = await planAssigned(ask(model), request(fx.sources, { count: 8 }), { assignments });
  const asks = model.log.asks;
  assert.equal(asks[0].count, 8, 'the first call is for the whole assignment');
  assert.equal(asks[0].pieces.length, 4);
  const reasks = asks.slice(1);
  assert.ok(reasks.length >= 1 && reasks.length <= 3, `${reasks.length} re-asks`);
  for (const again of reasks) {
    assert.equal(again.pieces.length, 1, 'a re-ask sees one section');
    assert.equal(again.assignments.length, 1);
    assert.equal(again.count, again.assignments[0].quota, 'it asks for the missing quota');
    assert.ok(again.count >= 1 && again.count <= 2);
  }
  assert.equal(new Set(reasks.map(item => item.pieces[0].section)).size, reasks.length, 'no section is asked twice');
  assert.equal(result.targets.length, 8);
  assert.equal(result.reasked, reasks.length);
});

test('at most `quota` per section: what a greedy planner adds beyond the quota is dropped, and counted', async () => {
  const assignments = assign(leaves.slice(0, 3), 2);
  const model = clusteringModel({ mode: 'greedy' });
  const result = await planAssigned(ask(model), request(fx.sources, { count: 6 }), { assignments });
  const per = new Map();
  for (const target of result.targets) per.set(target.assignment, (per.get(target.assignment) || 0) + 1);
  assert.deepEqual([...per.values()].sort(), [2, 2, 2], 'never more than the quota of any section');
  assert.ok(result.dropped.some(item => item.reason === 'over-quota'), 'the extra target is recorded as dropped');
});

test('targets whose quote is outside every assigned range are dropped; duplicates are dropped; the located target is kept', () => {
  const [a, b, c] = leaves;
  const assignments = assign([a, b], 2);
  const pieces = assignments.map((item, at) => pieceOfAssignment(item, fx.sources, `a${at + 1}`)[0]);
  const quoteIn = section => fx.quoteIn(section, 1);
  const target = (section, n = 1) => ({ objective: `o ${section.id} ${n}`, knowledge: 'k', citations: [{ sourceId: section.sourceId, quote: fx.quoteIn(section, n) }] });
  const { kept, dropped } = enforceAssignment([target(a, 1), target(c, 1), target(a, 1), target(b, 2), target(a, 2), target(a, 3)], pieces, assignments);
  assert.deepEqual(kept.map(item => [item.assignment, item.start > 0]), [[assignments[0].key, true], [assignments[1].key, true], [assignments[0].key, true]]);
  assert.equal(quoteIn(a).length > 12, true);
  assert.deepEqual(dropped.map(item => item.reason), ['outside', 'duplicate', 'over-quota'], 'the third section is not assigned; a repeated quote; and a third target for a quota of two');
});

test('what is still missing after the one re-ask is recorded as short with a reason, never silently dropped', async () => {
  const assignments = assign(leaves.slice(0, 4), 2);
  const target = assignments[2];
  // The planner supports no point for the third section (alone or in a group): it says so.
  const model = clusteringModel({ refuse: asked => asked.sources.length === 1 && asked.sources[0].section && asked.sources[0].text.includes(`Recording ${leaves[2].recording}, part ${leaves[2].part},`) });
  const result = await planAssigned(ask(model), request(fx.sources, { count: 8 }), { assignments });
  assert.equal(result.targets.length, 6, 'the other three sections have their two each');
  assert.equal(result.short.length, 1);
  assert.deepEqual({ key: result.short[0].key, quota: result.short[0].quota, planned: result.short[0].planned, missing: result.short[0].missing }, { key: target.key, quota: 2, planned: 0, missing: 2 });
  assert.equal(result.short[0].start, target.start);
  assert.equal(result.short[0].end, target.end);
  assert.ok(result.lost.some(line => /plan-short|short/i.test(line)), 'it is told to the run in words');
  assert.equal(PLAN_SHORT, 'plan-short');
});

test('a failure that repeating cannot fix (a refused key, a stop) is thrown, not turned into dozens of short sections', async () => {
  const assignments = assign(leaves.slice(0, 6), 1);
  let calls = 0;
  const complete = async () => { calls += 1; throw new Error('401 Unauthorized: invalid api key'); };
  await assert.rejects(planAssigned((system, prompt) => completeJson(complete, system, prompt), request(fx.sources, { count: 6 }), { assignments }), /401|api key/i);
  assert.ok(calls <= 2, `${calls} calls`);
  const controller = new AbortController();
  controller.abort(new Error('stopped by the learner'));
  await assert.rejects(planAssigned(ask(clusteringModel()), request(fx.sources, { count: 6, signal: controller.signal }), { assignments }), /stopped/);
});

test('plan-short is a failure code with one description', () => {
  assert.ok(FAILURE_CODES.includes('plan-short'));
  const error = new Error('The plan came back short for 2 section(s): 3 of 6 knowledge points (plan-short)');
  assert.equal(classifyFailure(error).code, 'plan-short');
  assert.equal(classifyFailure('Part 5: planned 0 of 2 for this section: plan-short').code, 'plan-short');
  assert.equal(classifyFailure(new Error('Assessment plan is not usable: quote "x" is not in source')).code === 'plan-short', false, 'the older codes keep their own causes');
});

test('groups: a group holds at most 60 000 characters and 10 questions, every assignment in reading order, a range longer than a call is cut', () => {
  const plan = strengthPlan(leaves, [], 'standard'), assignments = assignmentsOf(plan, leaves, []);
  const groups = assignmentGroups(assignments);
  assert.ok(groups.every(group => group.assignments.reduce((acc, item) => acc + item.quota, 0) <= 10 && group.assignments.reduce((acc, item) => acc + (item.end - item.start), 0) <= 60000));
  assert.deepEqual(groups.flatMap(group => group.assignments.map(item => item.key)), assignments.map(item => item.key), 'reading order, each once');
  const long = [{ key: 'x#h1', sectionId: 'x#h1', sourceId: 'x', start: 0, end: 150000, quota: 6 }];
  const cut = assignmentGroups(long).flatMap(group => group.assignments);
  assert.ok(cut.length >= 3 && cut.every(item => item.end - item.start <= 60000), 'a range longer than one call is cut into calls');
  assert.equal(cut.reduce((acc, item) => acc + item.quota, 0), 6, 'the quota is shared between the pieces');
  assert.deepEqual([cut[0].start, cut.at(-1).end], [0, 150000]);
  assert.ok(cut.every(item => item.sectionId === 'x#h1'), 'they are still one section');
});

// The continuation of recording 4 in the second volume starts in the middle of a sentence: the fake planner can quote nothing in it. That is a REAL short section, and the plan must say so.
const CONT = leaves.find(section => section.continued).key;

test('at scale: 81 sections, 80 parts, standard strength: one plan puts a question on EVERY must-cover section, not 7 of 29', async () => {
  const plan = strengthPlan(leaves, [], 'standard'), assignments = assignmentsOf(plan, leaves, []), groups = assignmentGroups(assignments);
  const model = clusteringModel();
  const targets = [], shorts = [];
  for (const group of groups) {
    const result = await planAssigned(ask(model), request(fx.sources, { count: group.assignments.reduce((acc, item) => acc + item.quota, 0) }), { assignments: group.assignments });
    targets.push(...result.targets);
    shorts.push(...result.short);
  }
  assert.equal(plan.mustCover, 81);
  assert.deepEqual(shorts.map(item => item.key), [CONT], 'the one section the planner could quote nothing in is reported short, with its quota');
  assert.equal(shorts[0].missing, assignments.find(item => item.key === CONT).quota);
  const planned = new Set(targets.map(target => target.assignment));
  assert.deepEqual([...planned].sort(), assignments.map(item => item.key).filter(key => key !== CONT).sort(), 'the covered sections equal the must-cover checklist (all but the short one)');
  assert.equal(planned.size, 80);
  const perSection = new Map();
  for (const target of targets) perSection.set(target.assignment, (perSection.get(target.assignment) || 0) + 1);
  for (const item of assignments.filter(entry => entry.key !== CONT)) assert.equal(perSection.get(item.key), item.quota, `section ${item.key} has its quota`);
  assert.equal(targets.length, plan.goal - shorts[0].missing);
  assert.ok(roundsOf(assignments).length >= 3);
});

test('the lean level plans exactly its chosen sections and no others', async () => {
  const plan = strengthPlan(leaves, [], 'lean'), assignments = assignmentsOf(plan, leaves, []);
  const model = clusteringModel();
  const planned = new Set();
  for (const group of assignmentGroups(assignments)) {
    const result = await planAssigned(ask(model), request(fx.sources, { count: group.assignments.reduce((acc, item) => acc + item.quota, 0) }), { assignments: group.assignments });
    for (const target of result.targets) planned.add(target.assignment);
  }
  assert.deepEqual([...planned].sort(), plan.quotas.map(item => item.sectionId).filter(key => key !== CONT).sort());
  assert.ok(planned.size < 81);
});
