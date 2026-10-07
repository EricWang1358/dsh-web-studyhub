import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { completeJson } from '../lib/generation.js';
import { planAssigned } from '../lib/assigned-plan.js';
import { generateBatched } from '../lib/batch.js';
import { shortCauseOf } from '../lib/generation-failure.js';
import { sectionKey } from '../lib/coverage.js';
import { roundList } from '../lib/coverage-run.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The numbers behind 「模型给出的考点不够数」 are recorded where the run knows them (the owner's complaint of 2026-10-07): what a section needed and got, how long it is, what the asking-again gave, why a reply could not be
   used; they ride on the part's plan (editorial.partPlans[].short), then on the plan's attempts (coverageSpec.attempts[key].short, with the rounds it was tried in) and the log (round-end `lost`, round-start `from`,
   run-stop `fills`). Additive fields only: a draft written by 3.0.0 has none of them and reads as it did. */

const fx = transcriptFixture();
const leaves = fx.leaves.map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
const assign = (list, quota) => list.map(section => ({ key: section.key, sectionId: section.key, sourceId: section.sourceId, start: section.start, end: section.end, quota, title: section.title }));
const request = (extra = {}) => ({ sources: fx.sources, kind: 'quiz', existing: [], ...extra });

test('a section that comes back short records what it needed, what it got, how long it is and what the asking-again gave', async () => {
  const assignments = assign(leaves.slice(0, 2), 3);
  // A planner that gives one point per call: the quota of three is never met, and the asking-again returns one.
  const model = clusteringModel();
  const oneAtATime = (system, prompt) => completeJson(async (s, p, c) => { const out = JSON.parse(await model.complete(s, p, c)); out.targets = out.targets.slice(0, 1); return JSON.stringify(out); }, system, prompt);
  const result = await planAssigned(oneAtATime, request({ count: 6 }), { assignments });
  assert.ok(result.short.length >= 1);
  for (const item of result.short) {
    assert.equal(item.chars, item.end - item.start, 'the length of the section is there');
    assert.ok(item.planned < item.quota && item.missing === item.quota - item.planned);
    assert.ok(Number.isInteger(item.returned) && item.returned >= 0, 'what the asking-again gave');
    assert.equal(item.outside, 0);
    assert.equal(item.why, undefined, 'the replies could be read: no reply failure is claimed');
    assert.equal(shortCauseOf(item), item.returned === 0 ? 'empty' : 'fewer');
  }
});

test('a model that refuses the section is recorded as refused (and a reply that cannot be read as such), not as a count', async () => {
  const assignments = assign(leaves.slice(0, 4), 2), target = assignments[2];
  const model = clusteringModel({ refuse: asked => asked.sources.length === 1 && asked.sources[0].text.includes(`Recording ${leaves[2].recording}, part ${leaves[2].part},`) });
  const result = await planAssigned((system, prompt) => completeJson(model.complete, system, prompt), request({ count: 8 }), { assignments });
  const short = result.short.find(item => item.key === target.key);
  assert.equal(short.why, 'refused');
  assert.equal(shortCauseOf(short), 'refused');
  assert.equal(short.returned, undefined, 'nothing was returned: nothing is said about what it returned');
  const unreadable = await planAssigned((system, prompt) => completeJson(async () => '{"targets":', system, prompt), request({ count: 2 }), { assignments: assignments.slice(0, 1) });
  assert.equal(unreadable.short[0].why, 'reply');
  assert.equal(shortCauseOf(unreadable.short[0]), 'reply');
});

test('the part that records a short section keeps the numbers on the draft (additive: a part without them is as it was)', async () => {
  const assignments = [...assign([leaves[0]], 2), ...assign([leaves.find(section => section.continued)], 2), ...assign([leaves[2]], 1)];
  const deck = await generateBatched(clusteringModel().complete, { kind: 'quiz', sources: fx.sources, assignments, count: 5, performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  const failed = deck.editorial.partPlans.find(plan => plan.reason === 'plan-short');
  assert.ok(failed.short.length >= 1);
  const row = failed.short[0];
  assert.deepEqual(Object.keys(row).sort().filter(key => ['sectionId', 'needed', 'got', 'chars'].includes(key)), ['chars', 'got', 'needed', 'sectionId']);
  assert.equal(row.needed, 2);
  assert.ok(row.got < row.needed && row.chars > 0);
  assert.equal(deck.editorial.partPlans.filter(plan => plan !== failed).every(plan => plan.short === undefined), true, 'a part that filled its sections has no record of a shortfall');
});

/* ---------- a whole run: the planned round, the retry round, the stop ---------- */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
async function library(t, model) {
  const root = await mkdtemp(join(tmpdir(), 'study-plain-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  service.complete = model.complete;
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, ids: world.sources.map(source => source.id) };
}

test('a run whose planner refuses one section: the plan keeps what it needed and got and the rounds it was tried in; the log names the section, the retry and the stop', async (t) => {
  const refuse = asked => asked.sources.length === 1 && asked.sources[0].text.includes('[Part 2: Preview Passage 2]');
  const { service, ids } = await library(t, clusteringModel({ refuse }));
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const state = await service.call('export'), draft = state.drafts[0], spec = draft.editorial.coverageSpec, run = draft.editorial.coverageRun;
  const view = await service.call('coverage.get', { draftId: draft.id });
  const open = view.coverage.sections.filter(item => item.state !== 'covered');
  assert.ok(open.length > 0 && open.every(item => /预览段落 2/.test(item.title)), 'the sections the planner refuses have no question');
  const fills = roundList(spec).filter(round => round.fill);
  assert.equal(fills.length, 1, 'one retry round');
  const tried = open.map(section => spec.attempts[section.key]);
  for (const attempt of tried) {
    assert.equal(attempt.reason, 'plan-short');
    assert.equal(attempt.n, 2);
    assert.deepEqual(attempt.rounds.map(item => !!item.fill), [false, true], 'tried in its planned round, then in the retry round');
    assert.ok(attempt.short.needed >= 1 && attempt.short.got < attempt.short.needed && attempt.short.chars > 0);
    assert.equal(attempt.short.why, 'refused', 'the model said the section does not support the points');
  }
  assert.equal(run.stop.reason, 'sections-left');
  assert.deepEqual(run.stop.fills, fills.map(round => round.round), 'the stop says which retry rounds were made');
  assert.equal(run.stop.left, open.length);
  assert.ok(run.stop.unit === 'part' && run.stop.names.length === open.length, 'and names the sections that are left');

  const contract = (await service.call('snapshot')).jobs.find(item => item.id === started.jobId).contract;
  const ends = contract.events.filter(event => event.code === 'round-end'), starts = contract.events.filter(event => event.code === 'round-start');
  const retryStart = starts.find(event => event.args.fill), retryEnd = ends.find(event => event.args.fill);
  assert.ok(retryStart.args.from.length >= 1 && retryStart.args.names.length === open.length, 'the retry says which rounds left its sections without a question, and names them');
  assert.equal(retryEnd.args.tried, open.length);
  assert.equal(retryEnd.args.lostCount, open.length);
  assert.ok(retryEnd.args.lost.every(item => item.needed >= 1 && item.got < item.needed), 'and what each needed and got');
  assert.ok(ends.every(event => event.args.unit === 'part'), 'every round end says the unit it counts in');
  assert.ok(ends.filter(event => !event.args.fill).some(event => event.args.lostCount >= 1), 'a planned round says which sections it left without a question');
  const listed = contract.detail.run.list;
  assert.ok(listed.every(round => round.unit === 'part'), 'the console\'s list of rounds carries the unit');
  assert.equal(listed.find(round => round.fill).code, 'plan-short', 'and the cause code of a round that failed');
});

test('a draft written before the numbers were kept reads as it did: no short, no rounds, nothing invented', async () => {
  const { shortfallOf } = await import('../lib/shortfall.js');
  const draft = { cards: [{ id: 'c' }], editorial: { requested: 4, coverageSpec: { version: 1, level: 'standard', goal: 4, quotas: [], rounds: [{ round: 1, questions: 4, sectionIds: ['s#a'], status: 'done' }], attempts: { 's#a': { n: 2, reason: 'plan-short', round: 2 } } } } };
  const coverage = { leaves: 1, covered: 0, percentLeaves: 0, units: 'page', sections: [{ key: 's#a', id: 'a', title: '', page: 18, state: 'planned-failed' }] };
  const found = shortfallOf({ draft, coverage });
  assert.deepEqual(found.repeating.map(item => [item.key, item.reason, item.attempts, item.short, item.rounds]), [['s#a', 'plan-short', 2, undefined, undefined]]);
});
