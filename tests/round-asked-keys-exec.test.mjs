import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList, owedKeys } from '../lib/coverage-run.js';
import { settleJob, until } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* The retry accounting of a coverage run counts the sections a round was really ASKED for, not the sections its plan holds (lib/coverage-run.js askedKeys / triedKeys).
   A round of the plan may be asked for part of its sections only: the button 为没覆盖的部分补题 pressed for some of them (`coverage.sectionIds`, lib/coverage-run.js roundOfKeys lands it in
   that round), or the round cut to what fits in one round (lib/coverage-state.js topUpRound fit: true). The sections it was not asked for were not tried: they get no failed attempt (their
   counters lead to REPLAN_AFTER and REPEAT_LIMIT, after which a run stops trying a section by itself), the round is not done while one of them is owed, and its row counts what it asked. */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });

const REVIEW = 'Act as a strict assessment editor';
/** The text of a section of the fixture ('…#r1.p6' is "Recording 1, part 6, point …"). */
const textOf = key => { const [, r, p] = /#r(\d+)\.p(\d+)$/.exec(key); return `Recording ${r}, part ${p}, point`; };

/** `broken`: section keys whose review never comes back usable: a pass asked for only them keeps nothing and FAILS (code 'review-protocol'). (A pass of this fixture that gains nothing always
 *  fails: an empty plan, a quality issue, a citation moved elsewhere all end 'failed' or still credit the section; the rule for a pass that ends 'done' and gains nothing is
 *  tests/round-asked-keys.test.mjs endsWithoutProgress.) */
async function open(t, root, coverage, broken = new Set()) {
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  const model = clusteringModel();
  service.complete = async (system, prompt, context = {}) => {
    if (broken.size && system.startsWith(REVIEW) && JSON.parse(prompt).candidate.cards.some(card => card.citations.some(citation => [...broken].some(key => citation.quote.startsWith(textOf(key)))))) return '{"issues":';
    return model.complete(system, prompt, context);
  };
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  return service;
}

/** A manual run (自动补到完整 off) of a standard plan: round 1 is done, the others wait for the learner. */
async function waitingRun(t, coverage = { roundLimit: 8 }, broken) {
  const root = await mkdtemp(join(tmpdir(), 'study-asked-keys-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = await open(t, root, coverage, broken);
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

/* A pass that asked for PART of its round and gained nothing is not the end of a run that goes on by itself: the next step is the same round's sections that nobody tried yet, and those are
   asked (lib/contexts/generation/operations.js, the no-progress rule). The run still ends: each such pass tries at least one section the round had not tried. */

test('a run that goes on by itself: a pass cut to fit that gains nothing goes on with what the round still owes, and the run still ends', async (t) => {
  const { root, service, draft } = await waitingRun(t);
  const spec = draft.editorial.coverageSpec, planned = spec.rounds[1].sectionIds, quota = new Map(spec.quotas.map(item => [item.sectionId, item.quota]));
  const limit = Math.max(...planned.map(key => quota.get(key)));
  await service.dispose();
  const broken = new Set(), smaller = await open(t, root, { roundLimit: limit }, broken);
  const first = (await smaller.call('coverage.get', { draftId: draft.id })).round.picks.map(pick => pick.key);
  assert.ok(first.length >= 1 && first.length < planned.length, 'the first pass is cut to what fits');
  for (const key of first) broken.add(key);
  const job = await smaller.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal((await settleJob(smaller, job.jobId)).status, 'complete');
  const after = await draftOf(smaller), left = await uncoveredOf(smaller, after), next = after.editorial.coverageSpec;
  assert.deepEqual(planned.filter(key => !first.includes(key) && left.has(key)), [], 'every section of round 2 the first pass did not ask for was asked, and came out');
  assert.deepEqual(Object.keys(next.attempts || {}).filter(key => !first.includes(key)), [], 'only the broken sections failed');
  const contract = await contractOf(smaller, job.jobId);
  assert.ok(eventsOf(contract, 'round-start').filter(event => event.args.round === 2).length >= 2, 'round 2 ran again for what it owed');
  assert.notEqual(after.editorial.coverageRun.stop?.round, 2, 'the run did not stop at the pass that gained nothing');
});

test('a press for one section with 自动补到完整 on: the section gains nothing, and round 2 still asks the rest', async (t) => {
  const broken = new Set(), { service, draft } = await waitingRun(t, { roundLimit: 8 }, broken);
  const [chosen, ...rest] = draft.editorial.coverageSpec.rounds[1].sectionIds;
  broken.add(chosen);
  const job = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [chosen], autoComplete: true } });
  assert.equal((await settleJob(service, job.jobId)).status, 'complete');
  const after = await draftOf(service), left = await uncoveredOf(service, after);
  assert.deepEqual(rest.filter(key => left.has(key)), [], 'the sections of round 2 nobody chose were asked by round 2, and came out');
  assert.equal(after.editorial.coverageSpec.rounds[1].status, 'done');
  assert.deepEqual(Object.keys(after.editorial.coverageSpec.attempts || {}), [chosen], 'only the chosen section failed');
});

test('the live numbers of a pass that asks part of its round count what the round still owes: 「还要 … 题」 and 本任务 约 n do not jump when the pass ends', async (t) => {
  const { service, draft } = await waitingRun(t);
  const spec = draft.editorial.coverageSpec, [chosen, ...rest] = spec.rounds[1].sectionIds, quota = new Map(spec.quotas.map(item => [item.sectionId, item.quota]));
  const third = spec.rounds[2].sectionIds.reduce((sum, key) => sum + quota.get(key), 0), owed = rest.reduce((sum, key) => sum + quota.get(key), 0);
  let seen = null;
  const hold = { entered: false };
  hold.promise = new Promise(resolve => { hold.open = resolve; });
  t.after(() => hold.open());
  const inner = service.complete;
  service.complete = async (system, prompt, context = {}) => {
    if (!hold.entered && system.startsWith(REVIEW)) { hold.entered = true; await hold.promise; }
    return inner(system, prompt, context);
  };
  const job = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [chosen], autoComplete: true } });
  const start = await contractOf(service, job.jobId);
  assert.equal(start.detail.own.asked, quota.get(chosen) + owed + third, 'at the start: the chosen section, what round 2 still owes after it, round 3');
  await until(() => hold.entered, 'the first pass to reach its review');
  seen = await contractOf(service, job.jobId);
  assert.equal(seen.detail.run.questionsLeft, seen.detail.run.list[1].due + third, 'what is left counts round 2 and round 3');
  assert.ok(seen.detail.run.list[1].due >= owed, `while the pass runs, round 2 still owes ${owed} besides what the pass makes (${seen.detail.run.list[1].due})`);
  assert.equal(seen.detail.own.asked, quota.get(chosen) + owed + third, '本任务 约 n is the same number while the pass runs');
  hold.open();
  assert.equal((await settleJob(service, job.jobId)).status, 'complete');
  const end = await contractOf(service, job.jobId);
  assert.equal(end.detail.own.asked, start.detail.own.asked, 'and the same at the end');
  assert.equal(end.detail.own.made, end.detail.own.asked);
});

const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };
const PLAN = 'Plan a source-grounded assessment';
/** Holds the first planning call made while `when(round 2 as the draft says it)` holds, until the gate is opened. */
function holdPlanWhen(service, when, hold) {
  const inner = service.complete;
  service.complete = async (system, prompt, context = {}) => {
    if (!hold.entered && system.startsWith(PLAN) && when((await draftOf(service))?.editorial.coverageSpec.rounds[1])) { hold.entered = true; await hold.promise; }
    return inner(system, prompt, context);
  };
}

test('a failure that repeats does not spend a pass per section: a cut round whose every review fails stops after its SECOND failed pass with the same cause; it still owes the rest, and 接着做 asks them', async (t) => {
  const { root, service, draft } = await waitingRun(t);
  const spec = draft.editorial.coverageSpec, planned = spec.rounds[1].sectionIds, quota = new Map(spec.quotas.map(item => [item.sectionId, item.quota]));
  await service.dispose();
  const broken = new Set([...planned, ...spec.rounds[2].sectionIds]), smaller = await open(t, root, { roundLimit: Math.max(...planned.map(key => quota.get(key))) }, broken);
  const job = await smaller.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal((await settleJob(smaller, job.jobId)).status, 'complete');
  const contract = await contractOf(smaller, job.jobId), ends = eventsOf(contract, 'round-end').filter(event => event.args.round === 2);
  assert.deepEqual(ends.map(event => [event.args.status, event.args.code]), [['failed', 'review-protocol'], ['failed', 'review-protocol']], 'two failed passes of round 2, then the run stops: never one per section');
  let after = await draftOf(smaller);
  assert.deepEqual([after.editorial.coverageRun.stop.reason, after.editorial.coverageRun.stop.round], ['no-progress', 2]);
  const owed = owedKeys(after.editorial.coverageSpec.rounds[1]);
  assert.equal(after.editorial.coverageSpec.rounds[1].status, 'pending', 'round 2 is not given up: it still owes what no pass asked');
  assert.ok(owed.length >= 1, `it owes ${owed.length} section(s) nobody asked for`);
  assert.deepEqual(owed.filter(key => after.editorial.coverageSpec.attempts?.[key]), [], 'and they have no failed attempt');
  broken.clear();
  const again = await smaller.call('generate', { resumeDraftId: after.id, draftVersion: after.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal((await settleJob(smaller, again.jobId)).status, 'complete');
  after = await draftOf(smaller);
  const left = await uncoveredOf(smaller, after);
  assert.deepEqual(owed.filter(key => left.has(key)), [], '接着做 asked them, and they came out');
});

test('the learner stops a SECOND pass of a round: the round is pending again, owing what nobody tried (the stopped pass tries nothing), and 接着做 asks it', async (t) => {
  const { service, draft } = await waitingRun(t);
  const [chosen, ...rest] = draft.editorial.coverageSpec.rounds[1].sectionIds;
  const hold = gate();
  t.after(() => hold.open());
  holdPlanWhen(service, round => round?.status === 'running' && round.askedKeys?.length > 1, hold);
  const job = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [chosen], autoComplete: true } });
  await until(() => hold.entered, 'the second pass of round 2 to ask its planner');
  await service.call('job.control', { jobId: job.jobId, action: 'cancel' });
  hold.open();
  assert.equal((await settleJob(service, job.jobId)).status, 'cancelled');
  let after = await draftOf(service), round = after.editorial.coverageSpec.rounds[1];
  assert.equal(after.editorial.coverageRun.stop.reason, 'learner');
  assert.equal(round.status, 'pending', 'not "failed": the sections of the stopped pass were never really asked');
  assert.deepEqual(round.triedKeys, [chosen]);
  assert.deepEqual([...owedKeys(round)].sort(), [...rest].sort());
  const again = await service.call('generate', { resumeDraftId: after.id, draftVersion: after.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal((await settleJob(service, again.jobId)).status, 'complete');
  after = await draftOf(service);
  const left = await uncoveredOf(service, after);
  assert.deepEqual(rest.filter(key => left.has(key)), [], '接着做 asked the rest of round 2');
  assert.equal(after.editorial.coverageSpec.rounds[1].status, 'done');
});

test('the learner stops the FIRST pass of a press for one section: the round owes all its sections again (nothing was tried), and 接着做 asks them', async (t) => {
  const { service, draft } = await waitingRun(t);
  const planned = draft.editorial.coverageSpec.rounds[1].sectionIds;
  const hold = gate();
  t.after(() => hold.open());
  holdPlanWhen(service, round => round?.status === 'running', hold);
  const job = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [planned[0]], autoComplete: true } });
  await until(() => hold.entered, 'the press to ask its planner');
  await service.call('job.control', { jobId: job.jobId, action: 'cancel' });
  hold.open();
  assert.equal((await settleJob(service, job.jobId)).status, 'cancelled');
  let after = await draftOf(service), round = after.editorial.coverageSpec.rounds[1];
  assert.equal(round.status, 'pending');
  assert.deepEqual(owedKeys(round), planned, 'the stopped pass counts nothing as tried');
  assert.equal(Object.keys(after.editorial.coverageSpec.attempts || {}).length, 0);
  const again = await service.call('generate', { resumeDraftId: after.id, draftVersion: after.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal((await settleJob(service, again.jobId)).status, 'complete');
  after = await draftOf(service);
  assert.deepEqual(roundList(after.editorial.coverageSpec).map(item => `${item.fill ? 'fill:' : ''}${item.status}`), ['done', 'done', 'done'], 'round 2 asked its sections itself, no retry round');
});
