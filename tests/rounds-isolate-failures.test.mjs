import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { generateBatched } from '../lib/batch.js';
import { parseJson } from '../lib/generation.js';
import { coverageOf, sectionKey } from '../lib/coverage.js';
import { sectionsOf } from '../lib/sections.js';
import { roundList, uncreditedOf } from '../lib/coverage-run.js';
import { planRound, roundRequest } from '../lib/coverage-round.js';
import { classifyFailure } from '../lib/generation-failure.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { sectionedModel } from './helpers/coverage-fixture.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { repeatingLecture, repeatingModel } from './helpers/repeating-lecture.mjs';

/* The owner's 3.0.1 record of a finished coverage run (2026-10-08): a retry round of 15 sections in 7 batches kept 5 questions, 「新覆盖 0/15」, and some of the sections it did not reach said 「被停止」 though nobody
   stopped anything. Three things are pinned here, each with the fake model of the other tests:
     1. a batch that fails (its review finds an issue no question owns, its reply cannot be used, the model drops the request, it cannot even start) loses ITS OWN questions and nothing else; its siblings finish and are saved;
     2. a stop is labelled by who asked for it (the learner, the time of the round); a request the model service cut off is not 「被停止」;
     3. a question that passes review is credited to the section it was written for, even when the same words stand earlier in the material; a round that keeps questions and covers nothing says so. */

const world = mergedTranscript({ recordings: 2, parts: 4, paragraphs: 3 });
const PARTS = 4, COUNT = PARTS * 5;
const run = (complete, extra = {}, hooks = {}) => {
  const decks = [];
  const request = { sources: world.sources, kind: 'quiz', count: COUNT, existing: [], performance: { concurrency: 3, batchSize: 5, fillRounds: 0 }, ...extra };
  const done = generateBatched(complete, request, () => {}, async (deck) => { decks.push(deck); hooks.onSave?.(deck); });
  return { done, decks, last: () => decks.at(-1) };
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isReview = system => system.startsWith('Act as a strict assessment editor');

/* ---------- 1. a failing batch does not take its siblings with it ---------- */

test('one batch whose review finds an issue no question owns loses only itself: the others, running at the same time, finish and are saved', async () => {
  const model = sectionedModel();
  const seen = { failedAt: 0, finishedAfter: 0 };
  const complete = async (system, prompt, context = {}) => {
    if (isReview(system)) {
      if (context.part === 2) { seen.failedAt = Date.now(); return JSON.stringify(qualityReview(parseJson(prompt).candidate, ['The deck as a whole mixes unrelated topics'])); }
      await delay(60);
      seen.finishedAfter = Math.max(seen.finishedAfter, Date.now());
    }
    return model.complete(system, prompt, context);
  };
  const { done, last } = run(complete);
  const deck = await done;
  assert.ok(seen.failedAt > 0 && seen.finishedAfter > seen.failedAt, 'the other batches were still reviewing when batch 2 failed');
  assert.equal(deck.cards.length, COUNT - 5, 'every other batch kept all its questions');
  const report = deck.editorial.partReport;
  assert.deepEqual([report.passed, report.failed, report.pending], [PARTS - 1, 1, 0]);
  assert.deepEqual(report.reasons, { quality: 1 }, 'the one failure is a quality failure of its own batch: nothing was "stopped"');
  assert.deepEqual(report.parts.filter(item => item.status !== 'passed').map(item => item.part), [2]);
  assert.equal(last().cards.length, COUNT - 5, 'and they were saved as they passed');
});

test('a batch that cannot even start (its planned target is unusable) is that batch\'s failure: its siblings and the round are not lost', async () => {
  const model = sectionedModel();
  const broken = { sources: world.sources.slice(0, 1), targets: [{ targetId: 'reuse-1', objective: 'A target with no quote' }] };
  const { done } = run(model.complete, { count: 10, reuse: [broken] });
  const deck = await done;
  assert.equal(deck.cards.length, 10, 'the two ordinary batches kept their questions');
  const report = deck.editorial.partReport;
  assert.equal(report.total, 3);
  assert.deepEqual([report.passed, report.failed], [2, 1]);
  assert.ok(deck.editorial.failures.some(line => /^Part 3:/.test(line)), 'the broken batch says it failed, with its own reason');
});

/* ---------- 2. who stopped a batch ---------- */

/** Part 2's review is cut off: `how` decides whether the round was stopped (the controller aborts, with a reason) or the model service dropped the request on its own. */
async function cutOff(how) {
  const model = sectionedModel(), controller = new AbortController();
  const complete = async (system, prompt, context = {}) => {
    if (isReview(system) && context.part === 2) {
      await delay(150);                                          // batch 1 has finished and been saved by now
      if (how === 'budget') controller.abort(Object.assign(new Error('Generation reached its 20-minute budget for this round; approved questions were retained'), { code: 'GENERATION_BUDGET' }));
      if (how === 'learner') controller.abort(new Error('Generation cancelled by the learner'));
      throw Object.assign(new Error('Model stream aborted'), { name: 'AbortError' });
    }
    return model.complete(system, prompt, context);
  };
  const { done, last } = run(complete, { count: 10, signal: controller.signal, performance: { concurrency: 3, batchSize: 5, fillRounds: 0 } });
  const outcome = await done.then(deck => ({ deck }), error => ({ error }));
  return { ...outcome, saved: last() };
}
const reasonsOf = result => (result.deck || result.saved).editorial.partReport.reasons;

test('a batch cut off because the time of the round ran out says so, not 「被停止」', async () => {
  const result = await cutOff('budget');
  assert.equal(result.error?.code, 'GENERATION_BUDGET', 'the round stopped for its time');
  assert.deepEqual(reasonsOf(result), { budget: 1 });
});

test('a batch cut off because the learner stopped the task is a stop; the questions of the batch that finished stay', async () => {
  const result = await cutOff('learner');
  assert.ok(result.error);
  assert.deepEqual(reasonsOf(result), { cancelled: 1 });
  assert.equal(result.saved.cards.length, 5);
});

test('a request the model service cut off by itself is not a stop: it is said as the service\'s, the batch is not final, and the round goes on', async () => {
  const result = await cutOff('dropped');
  assert.equal(result.error, undefined, 'nobody stopped anything: the round finished');
  assert.deepEqual(reasonsOf(result), { unavailable: 1 });
  assert.equal(result.deck.cards.length, 5, 'the other batch kept its questions');
  assert.doesNotMatch(result.deck.editorial.failures.join(' '), /abort/i, 'the failure line does not read like a stop either');
  assert.equal(classifyFailure(result.deck.editorial.failures[0].replace(/^Part \d+: /, '')).code, 'unavailable');
});

test('and a dropped request is asked again by the fill round, like any transient failure: the batch passes the second time', async () => {
  const model = sectionedModel();
  let drops = 0;
  const complete = async (system, prompt, context = {}) => {
    if (isReview(system) && context.part === 2 && drops++ === 0) throw Object.assign(new Error('Model stream aborted'), { name: 'AbortError' });
    return model.complete(system, prompt, context);
  };
  const deck = await run(complete, { count: 10, performance: { concurrency: 3, batchSize: 5, fillRounds: 1 } }).done;
  assert.equal(deck.cards.length, 10);
  assert.equal(deck.editorial.partReport.passed, 2);
});

/* ---------- 3. credit ---------- */

const lecture = repeatingLecture(12);
const leavesOf = () => sectionsOf(lecture.sources).filter(section => section.leaf);
const assignmentsOf = (leaves, quota = 1) => leaves.map(section => ({ key: sectionKey('lec', section.id), sectionId: sectionKey('lec', section.id), sourceId: 'lec', start: section.start, end: section.end, quota, title: section.title }));

test('a question written for a section is credited to it even when the same words stand earlier in the material', async () => {
  const leaves = leavesOf(), late = leaves.slice(6, 9);          // sections 7..9 open with the sentence of sections 1..3
  assert.equal(leaves.length, 12);
  const { done } = run(repeatingModel().complete, { sources: lecture.sources, count: late.length, assignments: assignmentsOf(late) });
  const deck = await done;
  assert.equal(deck.cards.length, late.length, 'the questions passed review');
  // Where the words first stand is another section: the plain reading of the citations would credit sections 1..3, which nobody asked for.
  const plain = coverageOf({ sources: lecture.sources, cards: deck.cards.map(card => ({ ...card, citations: card.citations.map(({ at: _at, ...rest }) => rest) })) });
  assert.deepEqual(plain.sections.filter(section => section.state === 'covered').map(section => section.title), ['Section 1', 'Section 2', 'Section 3']);
  const credited = coverageOf({ sources: lecture.sources, cards: deck.cards });
  assert.deepEqual(credited.sections.filter(section => section.state === 'covered').map(section => section.title), late.map(section => section.title), 'the sections the questions were written for');
  for (const card of deck.cards) assert.ok(card.citations[0].at.start < card.citations[0].at.end);
});

async function library(t, { model, coverage = { roundLimit: 8 }, sources = lecture.sources, weightOf } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-rounds-isolate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  service.complete = model.complete;
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: weightOf?.(item) ?? 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  for (const source of sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text });
  return { service, ids: sources.map(source => source.id) };
}

test('a whole run over a lecture that repeats itself covers every section it asked for (it used to keep questions, cover nothing new, and retry the same sections)', async (t) => {
  const { service, ids } = await library(t, { model: repeatingModel() });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'full', kind: 'quiz', performance: { concurrency: 3, batchSize: 5 } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = (await service.call('export')).drafts[0], rounds = roundList(draft.editorial.coverageSpec);
  for (const round of rounds) assert.equal(round.covered, round.sectionIds.length, `round ${round.round} covered the sections it was written for (kept ${round.kept})`);
  assert.equal(rounds.filter(round => round.fill).length, 0, 'no retry round was needed');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'complete');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.plannedFailed, 0, 'no section is called planned-and-failed because its question was credited elsewhere');
});

test('what a round says when it kept questions and credited none: the number is not a silent 0', () => {
  assert.equal(uncreditedOf({ kept: 5, gained: 0 }), 5);
  assert.equal(uncreditedOf({ kept: 5, gained: 2 }), 0, 'any section newly covered anywhere is credit');
  assert.equal(uncreditedOf({ kept: 0, gained: 0 }), 0);
});

/* ---------- 4. the retry that is not the same retry again ---------- */

test('a section that already failed twice is planned anew by the next retry, not written again from the target that failed', () => {
  const leaves = leavesOf(), section = leaves[8], text = lecture.text;
  const quote = text.slice(section.start, section.end).match(/Point \d+\.\d+: [^.]+\./)[0], start = text.indexOf(quote, section.start);
  const plan = { part: 1, sourceIds: ['lec'], ranges: [{ sourceId: 'lec', start: section.start, end: section.end }], status: 'failed', reason: 'quality', attempts: 1,
    targets: [{ targetId: 't1', objective: 'Objective of section 9', knowledge: 'k', sourceId: 'lec', quote, start, end: start + quote.length, status: 'failed', reason: 'quality' }] };
  const coverage = coverageOf({ sources: lecture.sources, cards: [], partPlans: [plan], targets: true });
  const key = sectionKey('lec', section.id), quotas = new Map([[key, 2]]);
  const first = planRound(coverage, { keys: [key], quotas });
  assert.deepEqual([first.reused, first.picks[0].reuse], [1, 1], 'the first retry writes the failed target again');
  const again = planRound(coverage, { keys: [key], quotas, replan: new Set([key]) });
  assert.deepEqual([again.reused, again.picks[0].reuse, again.picks[0].questions], [0, 0, 2], 'the retry after that plans the section anew, with its quota');
  const request = roundRequest(again, coverage, lecture.sources);
  assert.deepEqual([request.reuse.length, request.assignments.length, request.assignments[0].quota], [0, 1, 2]);
});

test('a retry round that covers nothing is not repeated: the run stops after the first one and says so', async (t) => {
  // A planner that refuses one section whenever it is shown it (the plan of this lecture wants sections 1, 2, 10, 11 and 12): the retry round covers nothing, whatever it keeps.
  const base = repeatingModel();
  let refused = 0;
  const model = { complete: async (system, prompt, context = {}) => {
    if (system.startsWith('Plan a source-grounded assessment') && /Point 10\./.test(prompt)) { refused++; return JSON.stringify({ error: 'insufficient evidence' }); }
    return base.complete(system, prompt, context);
  } };
  const { service, ids } = await library(t, { model });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'full', kind: 'quiz', performance: { concurrency: 1, batchSize: 5 } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = (await service.call('export')).drafts[0], rounds = roundList(draft.editorial.coverageSpec), fills = rounds.filter(round => round.fill);
  assert.equal(fills.length, 1, 'one retry round ran and covered nothing: it is not run a second time');
  assert.equal(fills[0].covered, 0);
  assert.ok(refused >= 2, 'the section was asked for in its round and again in the retry');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'sections-left');
  assert.deepEqual(Object.values(draft.editorial.coverageSpec.attempts).map(item => item.n), [2], 'the one section that failed was tried twice, not more');
});

test('the learner presses 为没覆盖的部分补题 for sections that failed again and again: the round plans them anew instead of writing the same failed targets a third time', async (t) => {
  // The review fails every batch that holds a question about section 10 (an issue no question owns): its batch is lost, in the planned round and in the retry that writes them again.
  const base = repeatingModel({ quoteNth: 1 }), counts = { plans: 0 };
  const model = { complete: async (system, prompt, context = {}) => {
    if (system.startsWith('Plan a source-grounded assessment')) counts.plans++;
    if (isReview(system) && /decision 102/.test(JSON.stringify(parseJson(prompt).candidate.cards.map(card => card.citations)))) return JSON.stringify(qualityReview(parseJson(prompt).candidate, ['The deck as a whole mixes unrelated topics']));
    return base.complete(system, prompt, context);
  } };
  const { service, ids } = await library(t, { model });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'full', kind: 'quiz', performance: { concurrency: 1, batchSize: 2, fillRounds: 0 } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  let draft = (await service.call('export')).drafts[0];
  const fills = roundList(draft.editorial.coverageSpec).filter(round => round.fill);
  assert.equal(fills.length, 1, 'one automatic retry (it wrote the failed targets again), then the run stopped');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.round.sections >= 1);
  assert.equal(view.round.reused, 0, 'the button plans them anew: no failed target is written again');
  assert.ok(view.round.picks.every(pick => pick.reuse === 0));
  const before = counts.plans;
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: view.round.picks.map(pick => pick.key) } });
  await settleJob(service, next.jobId);
  assert.ok(counts.plans > before, 'the planner was asked again for those sections');
  draft = (await service.call('export')).drafts[0];
  assert.ok(draft.editorial.coverageSpec.rounds.length >= 3);
});
