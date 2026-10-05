import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { coverageOf, sectionKey, PLANNED_FAILED, NEVER_PLANNED, COVERED } from '../lib/coverage.js';
import { planRound, roundRequest, ROUND_LIMIT } from '../lib/coverage-round.js';
import { chunkSources, planGeneration } from '../lib/batch.js';
import { sliceRangeOf } from '../lib/sections.js';
import { estimateRun, createTextMeasure } from '../lib/token-estimate.js';
import { transcriptFixture, sectionedModel } from './helpers/coverage-fixture.mjs';

/* 为没覆盖的部分补题: ONE top-up for the sections of a material that have no question. It targets exactly those sections (planned-and-failed first, then never planned,
   in reading order, up to the generation limit of questions), writes the planned targets that failed again as they were instead of planning them again, plans only the uncovered
   text for the rest, keeps the approved questions, and costs about what it covers. The ground truth of every case is a checklist of sections written here. */

const fx = transcriptFixture();
const planOf = (part, targets, ranges, extra = {}) => ({ part, sourceIds: [...new Set(ranges.map(range => range.sourceId))], ranges, targets, status: 'failed', reason: 'review-protocol', attempts: 1, ...extra });
const rangeOf = section => ({ sourceId: section.sourceId, start: section.start, end: section.end });
const failedTarget = (section, n = 1) => ({ targetId: `t${n}`, objective: `Objective of ${section.id} #${n}`, knowledge: `Knowledge of ${section.id}`, sourceId: section.sourceId, quote: fx.quoteIn(section).slice(0, 60),
  start: fx.textOf(section.sourceId).indexOf(fx.quoteIn(section), section.start), end: fx.textOf(section.sourceId).indexOf(fx.quoteIn(section), section.start) + fx.quoteIn(section).length, status: 'failed', reason: 'review-protocol' });
const coverageWith = ({ failed = [], covered = [] } = {}) => coverageOf({ sources: fx.sources, cards: covered.map(section => fx.card(section)), targets: true,
  partPlans: failed.length ? [planOf(1, failed.flatMap(entry => entry.targets), failed.map(entry => rangeOf(entry.section)))] : [] });

/* ---------- the round ---------- */

test('the default round: planned-failed sections first, then never-planned ones in reading order, a question each; a failed section with planned targets costs its targets', () => {
  const [a, b, c] = [fx.leaf(3, 4), fx.leaf(1, 9), fx.leaf(2, 2)];
  const coverage = coverageWith({ failed: [{ section: a, targets: [failedTarget(a, 1), failedTarget(a, 2)] }, { section: b, targets: [{ ...failedTarget(b, 1), start: undefined, end: undefined }] }], covered: [c] });
  assert.deepEqual([coverage.covered, coverage.plannedFailed, coverage.neverPlanned], [1, 2, 78]);
  const round = planRound(coverage);
  assert.deepEqual(round.picks.slice(0, 2).map(pick => [pick.id, pick.state, pick.questions, pick.reuse]), [[b.id, PLANNED_FAILED, 1, 0], [a.id, PLANNED_FAILED, 2, 2]].sort((x, y) => fx.ids.indexOf(x[0]) - fx.ids.indexOf(y[0])),
    'planned-failed first, in reading order; the one with located targets is written again from both, the one without offsets is planned from its text');
  const never = round.picks.slice(2);
  assert.ok(never.every(pick => pick.state === NEVER_PLANNED && pick.questions === 1 && pick.reuse === 0));
  assert.deepEqual(never.map(pick => pick.id), fx.ids.filter(id => ![a.id, b.id, c.id].includes(id)).slice(0, never.length), 'reading order');
  assert.equal(round.questions, ROUND_LIMIT, 'up to the generation limit');
  assert.equal(round.sections, 2 + never.length);
  assert.equal(round.reused, 2);
  assert.equal(round.fresh, round.questions - 2);
  assert.equal(round.uncovered, 80);
  assert.equal(round.left, 80 - round.sections);
  assert.equal(round.rounds, 3, '80 sections at 30 questions a round, two of which cost a little more: said honestly');
  assert.equal(round.complete, false);
  assert.equal(round.limit, 30);
});

test('a round that fits everything says it is complete; nothing uncovered is no round', () => {
  const small = coverageOf({ sources: fx.sources.slice(0, 1), cards: [], partPlans: [] });
  const round = planRound({ ...small, sections: small.sections.slice(0, 5) });
  assert.equal(round.sections, 5);
  assert.equal(round.complete, true);
  assert.equal(round.rounds, 1);
  const all = coverageOf({ sources: fx.sources, cards: fx.leaves.map((section, index) => ({ ...fx.card(section), id: `all-${index}` })) });
  assert.equal(all.covered, 81);
  const none = planRound(all);
  assert.deepEqual([none.sections, none.questions, none.rounds, none.complete], [0, 0, 0, true]);
});

test('a round for chosen section keys is exactly those sections, or says why it cannot be', () => {
  const coverage = coverageWith({ covered: [fx.leaf(1, 1)] });
  const keys = [fx.leaf(2, 3), fx.leaf(1, 5)].map(section => sectionKey(section.sourceId, section.id));
  const round = planRound(coverage, { keys });
  assert.deepEqual(round.picks.map(pick => pick.id), ['r1.p5', 'r2.p3'], 'in reading order whatever order the keys come in');
  assert.equal(round.questions, 2);
  assert.equal(planRound(coverage, { keys: ['nowhere#r1.p1'] }).error, 'unknown');
  assert.equal(planRound(coverage, { keys: [sectionKey(fx.leaf(1, 1).sourceId, 'r1.p1')] }).error, 'covered');
  assert.equal(planRound(coverage, { keys: fx.leaves.slice(10, 50).map(section => sectionKey(section.sourceId, section.id)) }).error, 'too-many');
  assert.equal(planRound(coverage, { keys: [] }).error, 'too-many');
});

test('the request of a round: the text of exactly the chosen sections, each piece remembering where it was cut, planned targets as targets', () => {
  const [a, b, c, d] = [fx.leaf(1, 3), fx.leaf(1, 4), fx.leaf(2, 7), fx.leaf(3, 2)];
  const coverage = coverageWith({ failed: [{ section: d, targets: [failedTarget(d, 1), failedTarget(d, 2)] }] });
  const round = planRound(coverage, { keys: [a, b, c, d].map(section => sectionKey(section.sourceId, section.id)) });
  const request = roundRequest(round, coverage, fx.sources, { batchSize: 5 });
  assert.equal(request.count, 3, 'planned from the text: a, b and c');
  assert.equal(request.questions, 5);
  assert.deepEqual(request.sectionKeys.length, 4);
  const pieces = request.sources.map(piece => ({ ...sliceRangeOf(piece), id: piece.id, text: piece.text }));
  assert.equal(pieces.length, 2, 'two neighbouring sections of one recording are one piece; the third is another');
  assert.deepEqual(pieces.map(piece => [piece.start, piece.end]), [[a.start, b.end], [c.start, c.end]]);
  for (const piece of pieces) assert.equal(fx.textOf(piece.id).slice(piece.start, piece.end), piece.text, 'the piece is the stored text between its offsets');
  assert.equal(request.reuse.length, 1);
  const [group] = request.reuse;
  assert.equal(group.targets.length, 2);
  for (const target of group.targets) {
    assert.match(target.targetId, /^reuse-\d+$/);
    const piece = group.sources.find(item => item.id === target.citations[0].sourceId);
    assert.ok(piece.text.includes(target.citations[0].quote), 'the quote of a target to write again is verbatim in the pieces it will be checked against');
  }
  assert.deepEqual(group.targets.map(target => target.objective), ['Objective of ' + d.id + ' #1', 'Objective of ' + d.id + ' #2']);
});

test('planGeneration of a round: parts planned from the text first, then one part per group of targets to write again, none planned; the question counts add up', () => {
  const [a, b, c] = [fx.leaf(1, 3), fx.leaf(1, 4), fx.leaf(2, 7)], failed = Array.from({ length: 7 }, (_, index) => fx.leaf(4, index + 1));
  const coverage = coverageWith({ failed: failed.map(section => ({ section, targets: [failedTarget(section)] })) });
  const round = planRound(coverage, { keys: [a, b, c, ...failed].map(section => sectionKey(section.sourceId, section.id)) });
  const request = roundRequest(round, coverage, fx.sources, { batchSize: 5 });
  const planned = planGeneration({ sources: request.sources, count: request.count, kind: 'quiz', performance: { batchSize: 5 }, reuse: request.reuse });
  assert.deepEqual(planned.filter(part => !part.preplan).reduce((sum, part) => sum + part.count, 0), 3);
  const again = planned.filter(part => part.preplan);
  assert.deepEqual(again.map(part => part.count), [5, 2], 'seven targets in groups of the batch size');
  assert.deepEqual(again.map(part => part.preplan.length), [5, 2]);
  assert.equal(planned.reduce((sum, part) => sum + part.count, 0), round.questions);
  assert.ok(planned.indexOf(again[0]) > planned.findIndex(part => !part.preplan), 'planned parts first');
  // only the parts planned from the text are in a group that is planned
  const mixed = planGeneration({ sources: request.sources, count: request.count, kind: 'mixed', performance: { batchSize: 5 }, reuse: request.reuse });
  assert.deepEqual(mixed.filter(part => part.preplan).map(part => part.kind), ['quiz', 'flashcard']);
  // nothing to plan from the text: only parts that write again
  const only = planGeneration({ sources: [], count: 0, kind: 'quiz', performance: { batchSize: 5 }, reuse: request.reuse });
  assert.ok(only.length === 2 && only.every(part => part.preplan));
  assert.deepEqual(planGeneration({ sources: [], count: 0, kind: 'quiz', performance: { batchSize: 5 } }), []);
});

test('a piece of a source keeps absolute offsets when it is cut again', () => {
  const [piece] = roundRequest(planRound(coverageWith()), coverageWith(), fx.sources).sources;
  const again = chunkSources([piece], 2000).flat();
  assert.ok(again.length > 1);
  let at = sliceRangeOf(piece).start;
  for (const part of again) { const { start, end } = sliceRangeOf(part); assert.equal(start, at); assert.equal(fx.textOf(part.id).slice(start, end), part.text); at = end; }
  assert.equal(at, sliceRangeOf(piece).end);
});

/* ---------- the estimate: it costs about what it covers ---------- */

test('the estimate of a round is for the text of its sections, and writing again costs no planning', () => {
  const coverage = coverageWith({ failed: Array.from({ length: 4 }, (_, index) => fx.leaf(5, index + 1)).map(section => ({ section, targets: [failedTarget(section)] })) });
  const measure = createTextMeasure();
  const make = keys => { const round = planRound(coverage, { keys }), request = roundRequest(round, coverage, fx.sources, { batchSize: 5 });
    return estimateRun('generate', { sources: request.sources, count: request.count, reuse: request.reuse, coverageSections: request.titles, kind: 'quiz', performance: { batchSize: 5 } }, { measure }); };
  const keyOf = section => sectionKey(section.sourceId, section.id);
  const rewrite = make([1, 2, 3, 4].map(n => keyOf(fx.leaf(5, n))));
  const stages = Object.fromEntries(rewrite.stages.map(stage => [stage.id, stage.calls]));
  assert.equal(stages.plan, undefined, 'four planned targets to write again: not one planning call');
  assert.deepEqual([stages.blueprint, stages.author, stages.review], [1, 1, 1]);
  assert.equal(rewrite.calls.low, 3);
  assert.ok(rewrite.notes.includes('rewrite'));
  const fresh = make([keyOf(fx.leaf(1, 3)), keyOf(fx.leaf(1, 4))]);
  assert.equal(fresh.calls.low, 4, 'two uncovered sections: one planning call and the three stages of one part');
  const whole = estimateRun('generate', { sources: fx.sources, count: 5, kind: 'quiz', performance: { batchSize: 5 } }, { measure });
  assert.ok(fresh.inputTokens.high < whole.inputTokens.high / 4, `two sections cost ${fresh.inputTokens.high}, the whole material ${whole.inputTokens.high}`);
  assert.ok(rewrite.inputTokens.high < whole.inputTokens.high / 4);
  assert.equal(estimateRun('generate', { sources: [], count: 0, reuse: [], kind: 'quiz' }, { measure }).calls.high, 0);
});

/* ---------- a real run ---------- */

const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const small = transcriptFixture({ recordings: 3, parts: 8, paragraphs: 3 });

async function library(t, model) {
  const root = await mkdtemp(join(tmpdir(), 'study-topup-')), previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const service = new StudyService(root, { complete: model.complete, coach: false, language: 'zh' });
  t.after(async () => {
    await service.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const ids = [];
  for (const source of small.sources) ids.push((await service.call('source.add', { title: source.title, text: source.text })).id);
  const performance = { concurrency: 1, batchSize: 5, jobTimeoutMinutes: 5, fillRounds: 0, ...EFFORTS };
  return { service, ids, performance, root };
}

test('a real top-up: the failed part is written again from its plan, the rest of the uncovered text is planned once, the approved questions stay, and the numbers change', async (t) => {
  let failing = true;
  const model = sectionedModel({ failReview: (part, nth, ordinal) => failing && ordinal === 2 });
  const { service, ids, performance } = await library(t, model);
  const first = await service.call('generate', { sourceIds: ids, count: 10, kind: 'quiz', title: 'Covered', ...performance, performance });
  const job = await service.call('job.wait', { jobId: first.jobId, timeoutSeconds: 60 });
  assert.equal(job.status, 'complete', job.stage);
  const draftId = job.draftId;
  const draft = await service.call('draft.get', { id: draftId }), kept = draft.cards.length;
  // The ground truth: the log of the fake model says which section every planned quote is in; the part whose review it damaged is the one that failed.
  const sectionOfQuote = quote => { const match = /Recording (\d+), part (\d+), point/.exec(quote); return `r${match[1]}.p${match[2]}`; };
  const keptSections = new Set(draft.cards.map(card => sectionOfQuote(card.citations[0].quote)));
  const failedTargets = draft.editorial.partPlans.flatMap(plan => plan.targets).filter(target => target.status === 'failed');
  const failedSections = new Set(failedTargets.map(target => sectionOfQuote(model.log.quoteOf.get([...model.log.quoteOf.keys()].find(objective => objective.startsWith(target.objective.slice(0, 30)) && objective.length === target.objective.length) ?? '') ?? target.quote)));
  assert.ok(kept >= 5 && failedTargets.length >= 3, `a real mix: ${kept} kept, ${failedTargets.length} planned and failed`);
  const before = await service.call('coverage.get', { draftId });
  assert.equal(before.status, 'ok');
  assert.deepEqual(before.coverage.sections.filter(section => section.state === COVERED).map(section => section.id).sort(), [...keptSections].sort());
  assert.deepEqual(before.coverage.sections.filter(section => section.state === PLANNED_FAILED).map(section => section.id).sort(), [...failedSections].filter(id => !keptSections.has(id)).sort(), 'what was planned and did not come out');
  assert.equal(before.coverage.neverPlanned, before.coverage.leaves - keptSections.size - failedSections.size);
  assert.equal(before.coverage.recorded, true);
  assert.equal(before.canTopUp, true);
  const round = before.round;
  assert.equal(round.reused, failedTargets.length, 'written again from the plan');
  assert.equal(round.fresh, round.sections - failedSections.size);
  assert.equal(round.questions, round.reused + round.fresh);
  assert.equal(round.complete, true, 'the whole of this small material fits in a round');
  const sectionIds = round.picks.map(pick => pick.key);
  const goodIds = new Set(draft.cards.map(card => card.id));
  const failedObjectives = (await service.call('draft.get', { id: draftId })).editorial.partPlans.find(plan => plan.status === 'failed').targets.map(target => target.objective);

  // The estimate of exactly this request, before it starts: it plans only the uncovered text and writes the failed targets again.
  const estimate = await service.call('usage.estimate', { feature: 'generate', resumeDraftId: draftId, draftVersion: draft.draftVersion, coverage: { sectionIds } });
  const stage = Object.fromEntries(estimate.stages.map(item => [item.id, item.calls]));
  assert.ok(stage.plan >= 1 && stage.plan <= Math.ceil(round.fresh / 10), `planning only the fresh text: ${stage.plan}`);
  const old = await service.call('usage.estimate', { feature: 'generate', resumeDraftId: draftId, draftVersion: draft.draftVersion });
  assert.ok(estimate.calls.low >= 4);
  assert.ok(old.calls.low > 0);

  failing = false;
  const plansBefore = model.log.plans.length;
  const started = await service.call('generate', { resumeDraftId: draftId, draftVersion: draft.draftVersion, coverage: { sectionIds }, performance });
  assert.equal(started.coverage.sections, round.sections);
  assert.equal(started.coverage.left, 0);
  const second = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 60 });
  assert.equal(second.status, 'complete', second.stage);
  assert.equal(second.count, round.questions);
  assert.equal(second.requestedTotal, kept + round.questions);
  const planCalls = model.log.plans.length - plansBefore;
  assert.ok(planCalls >= 1 && planCalls <= stage.plan, `plan calls: ${planCalls}, estimated ${stage.plan}`);
  assert.deepEqual(model.log.plans.slice(plansBefore).reduce((sum, plan) => sum + plan.count, 0) >= round.fresh, true);
  // the failed targets were written again as they were: the author was given exactly their objectives, and none of them was planned again
  const rewritten = model.log.authors.slice(-5).flatMap(entry => entry.objectives);
  assert.ok(failedObjectives.every(objective => model.log.authors.some(entry => entry.objectives.includes(objective))));
  assert.ok(rewritten.length >= 1);
  const after = await service.call('draft.get', { id: draftId });
  assert.ok([...goodIds].every(id => after.cards.some(card => card.id === id)), 'the approved questions are kept');
  assert.equal(after.cards.length, kept + round.questions);
  assert.equal(after.editorial.requested, 10, 'what the draft was asked for did not change: it holds more now, and says so by holding it');
  const now = await service.call('coverage.get', { draftId });
  assert.equal(now.coverage.covered, before.coverage.leaves, 'every section has a question now');
  assert.equal(now.coverage.plannedFailed, 0);
  assert.equal(now.coverage.neverPlanned, 0);
  assert.equal(now.round.sections, 0);
  assert.equal(now.round.complete, true);
});

test('what is asked for is checked: sections that already have questions, unknown sections and a draft that cannot be topped up are refused plainly', async (t) => {
  const model = sectionedModel();
  const { service, ids, performance } = await library(t, model);
  const first = await service.call('generate', { sourceIds: ids, count: 6, kind: 'quiz', title: 'Checked', ...performance, performance });
  const job = await service.call('job.wait', { jobId: first.jobId, timeoutSeconds: 60 });
  assert.equal(job.status, 'complete', job.stage);
  const draft = await service.call('draft.get', { id: job.draftId }), view = await service.call('coverage.get', { draftId: job.draftId });
  const coveredKey = view.coverage.sections.find(section => section.state === COVERED).key;
  const base = { resumeDraftId: draft.id, draftVersion: draft.draftVersion, performance };
  await assert.rejects(() => service.call('generate', { ...base, coverage: { sectionIds: [coveredKey] } }), /已经有题|already have/);
  await assert.rejects(() => service.call('generate', { ...base, coverage: { sectionIds: ['nowhere#x'] } }), /找不到|cannot be found/);
  await assert.rejects(() => service.call('generate', { ...base, coverage: { sectionIds: 'all' } }), /sectionIds/);
  await assert.rejects(() => service.call('generate', { sourceIds: ids, count: 3, coverage: { sectionIds: [] } }), /resumeDraftId/);
  await assert.rejects(() => service.call('generate', { ...base, extraSourceIds: [ids[0]], count: 2, coverage: {} }), /extraSourceIds/);
  await assert.rejects(() => service.call('generate', { ...base, draftVersion: draft.draftVersion + 5, coverage: {} }), /草稿已更新|updated/);
  // the default round (no keys) is what the screen offers: a section list in reading order
  const started = await service.call('generate', { ...base, coverage: {} });
  assert.equal(started.coverage.sections, Math.min(30, view.round.sections));
  await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 60 });
});

test('the old two controls are gone from the request path that the screens use, and the plain continuation of an agent still works', async (t) => {
  const model = sectionedModel();
  const { service, ids, performance } = await library(t, model);
  const first = await service.call('generate', { sourceIds: ids, count: 10, kind: 'quiz', title: 'Plain', ...performance, performance });
  const job = await service.call('job.wait', { jobId: first.jobId, timeoutSeconds: 60 });
  const draft = await service.call('draft.get', { id: job.draftId });
  assert.equal(draft.cards.length, 10);
  assert.equal(draft.editorial.requested, 10);
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, 10);
  // a top-up never lowers or silently raises what was asked for while it adds nothing beyond it
  const sectionIds = view.round.picks.slice(0, 2).map(pick => pick.key);
  const started = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds }, performance });
  const done = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 60 });
  assert.equal(done.status, 'complete', done.stage);
  const after = await service.call('draft.get', { id: draft.id });
  assert.equal(after.cards.length, 12);
  assert.equal(after.editorial.requested, 10, 'the number asked for does not grow behind the learner\'s back (the audit found 10/15 become 10/17)');
});
