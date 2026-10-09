import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList } from '../lib/coverage-run.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* The retry accounting of a coverage run counts the sections a round was really ASKED for, not the sections its plan holds (lib/coverage-run.js askedKeys / triedKeys).
   A round of the plan may be asked for part of its sections only: the button 为没覆盖的部分补题 pressed for some of them (`coverage.sectionIds`, lib/coverage-run.js roundOfKeys lands it in
   that round), or the round cut to what fits in one round (lib/coverage-state.js topUpRound fit: true). The sections it was not asked for were not tried: they get no failed attempt (their
   counters lead to REPLAN_AFTER and REPEAT_LIMIT, after which a run stops trying a section by itself), the round is not done while one of them is owed, and its row counts what it asked. */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });

async function open(t, root, coverage) {
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  service.complete = clusteringModel().complete;
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  return service;
}

/** A manual run (自动补到完整 off) of a standard plan: round 1 is done, the others wait for the learner. */
async function waitingRun(t, coverage = { roundLimit: 8 }) {
  const root = await mkdtemp(join(tmpdir(), 'study-asked-keys-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = await open(t, root, coverage);
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const started = await service.call('generate', { sourceIds: world.sources.map(source => source.id), coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  assert.deepEqual(roundList(draft.editorial.coverageSpec).map(round => round.status), ['done', 'pending', 'pending']);
  return { root, service, draft };
}

const draftOf = async service => (await service.call('export')).drafts[0];
const contractOf = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;
const eventsOf = (contract, code) => contract.events.filter(event => event.code === code);
const uncoveredOf = async (service, draft) => new Set((await service.call('coverage.get', { draftId: draft.id })).coverage.sections.filter(section => section.state !== 'covered').map(section => section.key));

test('a planned round cut to what fits: the sections it was not asked for get no failed attempt, and the round is not done while they are owed', async (t) => {
  const { root, service, draft } = await waitingRun(t);
  const spec = draft.editorial.coverageSpec, planned = spec.rounds[1].sectionIds, quota = new Map(spec.quotas.map(item => [item.sectionId, item.quota]));
  const limit = Math.max(...planned.map(key => quota.get(key)));
  assert.ok(planned.length >= 2 && planned.reduce((sum, key) => sum + quota.get(key), 0) > limit, 'round 2 holds more than one round of the smaller size');
  // The size of a round was made smaller after the plan (設置 › 每轮题数): 接着做 cuts round 2 to what fits.
  await service.dispose();
  const smaller = await open(t, root, { roundLimit: limit });
  const job = await smaller.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: false } });
  assert.equal((await settleJob(smaller, job.jobId)).status, 'complete');
  const after = await draftOf(smaller), left = await uncoveredOf(smaller, after), next = after.editorial.coverageSpec;
  const asked = planned.filter(key => !left.has(key)), cut = planned.filter(key => left.has(key));
  assert.ok(asked.length >= 1 && cut.length >= 1, `fit asked ${asked.length} section(s) of round 2 and cut ${cut.length}`);
  assert.deepEqual(cut.filter(key => next.attempts?.[key]), [], 'a section the round was not asked for has not failed: no attempt is counted for it');
  assert.deepEqual(next.rounds[1].askedKeys, asked, 'the round keeps what it was asked for');
  assert.equal(next.rounds[1].status, 'pending', 'round 2 still owes the sections it was not asked for');
  const contract = await contractOf(smaller, job.jobId), end = eventsOf(contract, 'round-end')[0], start = eventsOf(contract, 'round-start')[0];
  assert.deepEqual([start.args.sections, end.args.tried, end.args.covered, end.args.lostCount], [asked.length, asked.length, asked.length, undefined], 'the log counts the sections it asked for');
  const view = await smaller.call('coverage.get', { draftId: after.id });
  assert.ok(view.round.picks.length >= 1 && view.round.picks.every(pick => cut.includes(pick.key)), 'the button goes on with the sections round 2 still owes');
});

test('the button pressed for one section of a planned round: the other sections keep their counters, the round goes on with them, and its rows count what each press asked', async (t) => {
  const { service, draft } = await waitingRun(t);
  const planned = draft.editorial.coverageSpec.rounds[1].sectionIds, [chosen, ...rest] = planned;
  assert.ok(rest.length >= 1);
  const one = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [chosen] } });
  assert.equal((await settleJob(service, one.jobId)).status, 'complete');
  let after = await draftOf(service), spec = after.editorial.coverageSpec;
  assert.equal((await uncoveredOf(service, after)).has(chosen), false, 'the chosen section has a question');
  assert.deepEqual(rest.filter(key => spec.attempts?.[key]), [], 'the sections the learner did not choose were not tried: no failed attempt');
  assert.notEqual(spec.rounds[1].status, 'done', 'round 2 is not done: most of its sections were never asked for');
  assert.deepEqual(spec.rounds[1].askedKeys, [chosen]);
  let contract = await contractOf(service, one.jobId);
  const end = eventsOf(contract, 'round-end')[0];
  assert.deepEqual([end.args.tried, end.args.covered], [1, 1], '「新覆盖 1/1」, not 1 of the whole round');
  assert.equal(contract.detail.run.list[1].sections, rest.length, 'the row of round 2 says what it still owes');
  const view = await service.call('coverage.get', { draftId: after.id });
  assert.deepEqual(view.round.picks.map(pick => pick.key).sort(), [...rest].sort(), 'the next press is the rest of round 2');

  const two = await service.call('generate', { resumeDraftId: after.id, draftVersion: after.draftVersion, coverage: { sectionIds: view.round.picks.map(pick => pick.key) } });
  assert.equal((await settleJob(service, two.jobId)).status, 'complete');
  after = await draftOf(service); spec = after.editorial.coverageSpec;
  assert.equal(spec.rounds[1].status, 'done', 'every section of round 2 has been asked for: the round is done');
  assert.deepEqual(roundList(spec).map(round => round.status), ['done', 'done', 'pending']);
  contract = await contractOf(service, two.jobId);
  const row = contract.detail.run.list[1];
  assert.deepEqual([row.sections, row.covered], [rest.length, rest.length], `the row of round 2 says 新覆盖 ${rest.length}/${rest.length}: what the press asked for`);
  assert.equal(Object.keys(spec.attempts || {}).length, 0, 'nothing failed, nothing is counted');
});

test('a run that goes on by itself after a press for one section: round 2 itself asks the rest (no retry round for sections never tried), and the job counts both passes', async (t) => {
  const { service, draft } = await waitingRun(t);
  const [chosen] = draft.editorial.coverageSpec.rounds[1].sectionIds;
  const job = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [chosen], autoComplete: true } });
  assert.equal((await settleJob(service, job.jobId)).status, 'complete');
  const after = await draftOf(service), spec = after.editorial.coverageSpec;
  assert.deepEqual(roundList(spec).map(round => `${round.fill ? 'fill:' : ''}${round.status}`), ['done', 'done', 'done'], 'no fill round: the rest of round 2 was never tried, it is not retried');
  assert.equal(Object.keys(spec.attempts || {}).length, 0, 'nothing failed, nothing is counted');
  assert.equal(after.editorial.coverageRun.state, 'complete');
  const contract = await contractOf(service, job.jobId);
  assert.equal(eventsOf(contract, 'round-start').filter(event => event.args.round === 2).length, 2, 'round 2 ran twice: the chosen section, then the rest');
  assert.equal(eventsOf(contract, 'round-rerun').length, 0, 'a second pass is not a re-run of an interrupted round');
  assert.equal(contract.detail.own.made, contract.detail.own.asked, `the job made what it was asked for (${contract.detail.own.made}), both passes of round 2 counted`);
});
