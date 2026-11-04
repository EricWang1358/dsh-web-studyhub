/* Shared harness for generation crash recovery tests (issue #608): spawns tests/fixtures/generation-crash-worker.mjs at a chosen window
   and reopens a fresh StudyService over the directory left behind. Fake models only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { roundList } from '../../lib/coverage-run.js';
import { shortfallOf } from '../../lib/shortfall.js';
import { clusteringModel } from './clustering-model.mjs';
import { settleJob } from './wait.mjs';
import { corpusWorld, CORPUS_ROUND_LIMIT, weighing } from './record-run-corpus.mjs';
import { MODES, WINDOWS, modeOptions } from '../fixtures/generation-crash-worker.mjs';

export { MODES, WINDOWS, corpusWorld, CORPUS_ROUND_LIMIT, weighing, clusteringModel, roundList, settleJob };

const WORKER = fileURLToPath(new URL('../fixtures/generation-crash-worker.mjs', import.meta.url));
export const GOAL = 19;
export const CRASH_CONCURRENCY = Math.min(2, Math.max(1, Math.floor(availableParallelism() / 2)));

export async function die(t, name, mode, scenario = {}, root, roundOne = null) {
  if (!root) {
    root = await mkdtemp(join(tmpdir(), 'study-run-crash-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  }
  const child = spawn(process.execPath, [WORKER, root, name, mode, String(roundOne), JSON.stringify(scenario)], { env: { ...process.env, DSH_HOME: join(root, '.home') }, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, WINDOWS[name].code, `the process died in the window "${name}" (70: the window was never reached)`);
  return root;
}

export async function reopen(t, root, mode, { roundLimit = CORPUS_ROUND_LIMIT } = {}) {
  let model = async () => { throw new Error('a restart must not call a model by itself'); };
  const log = [], complete = (system, prompt, context) => { log.push(system.slice(0, 30)); return model(system, prompt, context); };
  const service = new StudyService(root, { coverage: { roundLimit }, ...modeOptions(mode, complete) });
  service.light = weighing;
  service.complete = complete;
  t.after(() => service.dispose());
  return { service, log, use: next => { model = next; } };
}

// A job killed right after the commit of its first draft, before it recorded that draft, comes back named by the run alone.
export const jobsOnDraft = async (service, draft) => (await service.call('snapshot')).jobs.filter(job => job.draftId === draft?.id || job.id === draft?.editorial?.coverageRun?.jobId || job.contract.jobId === draft?.editorial?.generation?.runId);
export const draftOf = async service => (await service.call('export')).drafts[0];
export const attemptOf = reply => reply.attemptId ?? reply.jobId;

/** The draft a run comes to when nothing cut it short. `exact`: no pass was cut in the middle; a pass that was may have covered a section with fewer questions than its quota, and a section that has a
    question is not asked for again, so the draft can be short of the goal with every section covered. (These worlds have later rounds to go through and end complete; a run cut in its last round is closed short: SHORT_WORLDS.) */
export async function assertFinished(service, draft, before, { exact = true } = {}) {
  if (exact) assert.equal(draft.cards.length, GOAL, 'every question of the plan, once');
  assert.ok(draft.cards.length <= GOAL, `never more than the plan (${draft.cards.length})`);
  assert.equal(new Set(draft.cards.map(card => card.id)).size, draft.cards.length, 'no card twice');
  assert.equal(new Set(draft.cards.map(card => card.citations?.[0]?.quote)).size, draft.cards.length, 'no point written twice');
  assert.ok((before?.cards || []).every(card => draft.cards.some(item => item.id === card.id)), 'what had passed review is kept');
  assert.ok(roundList(draft.editorial.coverageSpec).every(round => round.status !== 'running'), 'no round left in flight');
  assert.equal(draft.editorial.coverageRun.state, 'complete');
  assert.ok(['complete', 'target'].includes(draft.editorial.coverageRun.stop?.reason));
  const { coverage } = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(coverage.covered, coverage.leaves, 'every section has a question');
}

/** A new process over what the dead one left, up to the end of the run. */
export async function recoverAndFinish(t, root, mode, options) {
  const after = await reopen(t, root, mode), before = await draftOf(after.service);
  // Everything that reads the job list at once, as the first screen of a new process does.
  await Promise.all([after.service.call('snapshot'), after.service.call('coverage.recover'), after.service.call('snapshot')]);
  const jobs = await jobsOnDraft(after.service, before);
  assert.equal(jobs.length, 1, 'one job for the run');
  assert.equal(jobs[0].contract.status, 'interrupted');
  assert.equal(jobs[0].contract.actions.retry.available, true);
  assert.deepEqual((await after.service.call('coverage.recover')).recovered, 0, 'a second look restores nothing more');
  assert.equal((await jobsOnDraft(after.service, before)).length, 1);
  assert.deepEqual(after.log, [], 'nothing asks a model by itself');
  after.use(clusteringModel().complete);
  const answers = await Promise.allSettled([after.service.call('job.control', { jobId: jobs[0].id, action: 'retry' }), after.service.call('job.control', { jobId: jobs[0].id, action: 'retry' })]);
  const started = answers.filter(answer => answer.status === 'fulfilled').map(answer => attemptOf(answer.value));
  assert.equal(new Set(started).size, 1, `two presses at once start one run: ${answers.map(answer => answer.reason?.message ?? 'ok').join(' | ')}`);
  const done = await settleJob(after.service, started[0]);
  assert.equal(done.status, 'complete', done.stage);
  await assertFinished(after.service, await draftOf(after.service), before, options);
  const left = await jobsOnDraft(after.service, before);
  assert.deepEqual(left.filter(job => job.contract.status === 'interrupted').map(job => job.id), [], 'no interrupted job is left behind');
  return { calls: after.log.length };
}

/* The last round, cut once every section has its first question: nothing is left to ask a model, and questions are still owed. An uncut run of these worlds makes 30, 22 and 46. */
export const SHORT_WORLDS = [
  { name: '3 sections, 30 asked', parts: 3, count: 30, goal: 30 },
  { name: '2 sections, 30 asked', parts: 2, count: 30, goal: 24 },
  { name: '4 sections, 60 asked', parts: 4, count: 60, goal: 48 },
];
export const shortScenario = ({ parts, count }) => ({ world: { recordings: 1, parts, paragraphs: 16 }, count, roundLimit: 30 });
export const shortfallFor = async (service, draft) => shortfallOf({ draft, coverage: (await service.call('coverage.get', { draftId: draft.id })).coverage });
