/* A generation run killed for real (issue #608): a process of its own dies at each window of a coverage run (tests/fixtures/generation-crash-worker.mjs), under each setting of the switches, and a new process
   finds the library. Fake models only. What must hold: nothing asks a model by itself; one job per draft; looking twice restores nothing more; 接着做 ends in the draft a run that was never cut short ends in. */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { roundList } from '../lib/coverage-run.js';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { settleJob } from './helpers/wait.mjs';
import { corpusWorld, CORPUS_ROUND_LIMIT, weighing } from './helpers/record-run-corpus.mjs';
import { MODES, WINDOWS, modeOptions } from './fixtures/generation-crash-worker.mjs';

const WORKER = fileURLToPath(new URL('./fixtures/generation-crash-worker.mjs', import.meta.url)), GOAL = 19, world = corpusWorld();
/** What a run asks of the model when nothing cuts it short: in round 1 (a pause during the last of those calls stands at the boundary between rounds) and in all. */
const uncut = { roundOne: null, calls: 0 };
before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-run-uncut-')), inner = clusteringModel().complete;
  const service = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT } });
  service.light = weighing;
  service.complete = async (system, prompt, context = {}) => {
    uncut.calls += 1;
    if (uncut.roundOne === null && (await draftOf(service))?.editorial.coverageSpec?.rounds[1]?.status === 'running') uncut.roundOne = uncut.calls - 1;
    return inner(system, prompt, context);
  };
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const { jobId } = await service.call('generate', { sourceIds: world.sources.map(source => source.id), coverageLevel: 'standard', kind: 'quiz' });
  await settleJob(service, jobId);
  assert.equal((await draftOf(service)).cards.length, GOAL);
  await service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function die(t, name, mode) {
  const root = await mkdtemp(join(tmpdir(), 'study-run-crash-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const child = spawn(process.execPath, [WORKER, root, name, mode, String(uncut.roundOne)], { env: { ...process.env, DSH_HOME: join(root, '.home') }, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, WINDOWS[name].code, `the process died in the window "${name}" (70: the window was never reached)`);
  return root;
}
async function reopen(t, root, mode) {
  let model = async () => { throw new Error('a restart must not call a model by itself'); };
  const log = [], complete = (system, prompt, context) => { log.push(system.slice(0, 30)); return model(system, prompt, context); };
  const service = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT }, ...modeOptions(mode, complete) });
  service.light = weighing;
  service.complete = complete;
  t.after(() => service.dispose());
  return { service, log, use: next => { model = next; } };
}
// A job killed right after the commit of its first draft, before it recorded that draft, comes back named by the run alone.
const jobsOnDraft = async (service, draft) => (await service.call('snapshot')).jobs.filter(job => job.draftId === draft?.id || job.id === draft?.editorial?.coverageRun?.jobId || job.contract.jobId === draft?.editorial?.generation?.runId);
const draftOf = async service => (await service.call('export')).drafts[0];
const attemptOf = reply => reply.attemptId ?? reply.jobId;

/** The draft a run comes to when nothing cut it short. `exact`: no pass was cut in the middle; a pass that was may have covered a section with fewer questions than its quota, and a section that has a
    question is not asked for again, so the draft can be short of the goal with every section covered. */
async function assertFinished(service, draft, before, { exact = true } = {}) {
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
async function recoverAndFinish(t, root, mode, options) {
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

for (const mode of Object.keys(MODES)) {
  test(`${mode}: killed before its first draft`, async t => {
    const root = await die(t, 'before-first-draft', mode), after = await reopen(t, root, mode);
    assert.equal(await draftOf(after.service), undefined, 'nothing was written');
    const jobs = (await after.service.call('snapshot')).jobs;
    if (mode !== 'restart') { assert.deepEqual(jobs, [], 'kept in memory only: the run is lost, and says nothing (a limit of this mode)'); return; }
    assert.equal(jobs.length, 1, 'kept on disk: the same job');
    assert.equal(jobs[0].contract.status, 'interrupted');
    assert.deepEqual(after.log, []);
    after.use(clusteringModel().complete);
    const done = await settleJob(after.service, attemptOf(await after.service.call('job.control', { jobId: jobs[0].id, action: 'retry' })));
    assert.equal(done.status, 'complete', done.stage);
    await assertFinished(after.service, await draftOf(after.service));
  });
  for (const name of ['first-part-saved', 'round-1-done-unsaved', 'round-2-running-saved', 'round-2-part-saved', 'last-question-saved', 'closing-unsaved']) test(`${mode}: killed at ${name}`, async t => {
    const { calls } = await recoverAndFinish(t, await die(t, name, mode), mode, { exact: !name.endsWith('-part-saved') });
    assert.ok(calls <= uncut.calls, `no more model calls than the whole run takes (${calls}, the run: ${uncut.calls})`);
    if (['last-question-saved', 'closing-unsaved'].includes(name)) assert.equal(calls, 0, 'everything was written: closing it asks no model');
  });
  // A run on the runtime cannot be paused (its pause is declared unsupported, S3-2), so a draft is left paused only on the legacy path.
  if (mode === 'legacy') test(`${mode}: killed while paused between rounds`, async t => {
    await recoverAndFinish(t, await die(t, 'paused', mode), mode);
  });
  test(`${mode}: killed after the closing write: nothing comes back`, async t => {
    const root = await die(t, 'closing-saved', mode), after = await reopen(t, root, mode), draft = await draftOf(after.service);
    await assertFinished(after.service, draft);
    assert.deepEqual((await jobsOnDraft(after.service, draft)).filter(job => job.contract.status === 'interrupted').map(job => job.id), []);
    assert.deepEqual(after.log, []);
  });
}
