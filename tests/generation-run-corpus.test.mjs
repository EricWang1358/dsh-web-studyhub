/* The runs on learners' disks must keep working (issue #608). tests/fixtures/generation-run-corpus.json holds drafts and a run manifest written by real runs of v4.1.0, in every state a draft can be left
   in (tests/helpers/record-run-corpus.mjs). Whatever the code of a run becomes, a new process over those files does what v4.1.0 did: the same runs come back, the same 接着做 does the same rounds, and what
   is written has no field v4.1.0 would not know. generation-run-corpus-expected.json was recorded from v4.1.0's run code; STUDY_RECORD_GOLDEN=1 records it again, and the diff of that file is the review. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList, resetRunning } from '../lib/coverage-run.js';
import { interruptedRuns } from '../lib/contexts/generation/coverage-runs.js';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';
import { corpusWorld, CORPUS_ROUND_LIMIT, weighing } from './helpers/record-run-corpus.mjs';

const corpus = JSON.parse(await readFile(new URL('./fixtures/generation-run-corpus.json', import.meta.url), 'utf8'));
const EXPECTED = new URL('./fixtures/generation-run-corpus-expected.json', import.meta.url);
const recording = process.env.STUDY_RECORD_GOLDEN === '1';
const expected = recording ? {} : JSON.parse(await readFile(EXPECTED, 'utf8'));
if (recording) after(() => writeFile(EXPECTED, `${JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`));
const pinned = (name, actual) => {
  const value = JSON.parse(JSON.stringify(actual));
  if (recording) { expected[name] = value; return; }
  assert.ok(Object.hasOwn(expected, name), `no recording for "${name}"`);
  assert.deepEqual(value, expected[name], name);
};

const world = corpusWorld(), names = Object.keys(corpus.drafts);
const stageOf = system => system.startsWith('Plan a source-grounded') ? 'plan' : system.startsWith('Prepare supported answers') ? 'blueprint' : system.startsWith('Act as a strict') ? 'review' : 'other';

/** A library folder holding the materials and these drafts, as a new process finds it. */
async function libraryWith(t, drafts, { manifests = {}, options = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-run-corpus-'));
  const seed = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT } });
  for (const source of world.sources) await seed.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  await seed.store.update(state => { state.drafts.push(...structuredClone(drafts)); });
  await seed.dispose();
  if (Object.keys(manifests).length) {
    await mkdir(join(root, 'generation-runs'), { recursive: true });
    for (const [name, manifest] of Object.entries(manifests)) await writeFile(join(root, 'generation-runs', name), JSON.stringify(manifest));
  }
  const model = clusteringModel(), calls = {};
  const complete = async (system, prompt, context = {}) => { calls[stageOf(system)] = (calls[stageOf(system)] || 0) + 1; return model.complete(system, prompt, context); };
  const service = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT }, ...options });
  service.light = weighing;
  service.complete = complete;
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { service, calls, complete };
}
const statuses = spec => roundList(spec).map(round => round.status);
const restoredView = job => job && ({ id: job.id, status: job.contract.status, retry: job.contract.actions.retry.available, round: job.contract.detail.run?.round, rounds: job.contract.detail.run?.rounds,
  percent: job.contract.detail.run?.percent, state: job.contract.detail.run?.state, stage: job.stage, events: job.contract.events.map(event => [event.code, event.args]), savedCount: job.savedCount, requestedTotal: job.requestedTotal, count: job.count });

test('the reading of each draft: which come back as interrupted, at which round, and what is run again', () => {
  for (const name of names) {
    const draft = corpus.drafts[name], [found] = interruptedRuns([draft]);
    pinned(`read.${name}`, { found: found ? { round: found.round, inflight: found.inflight } : null, reset: statuses(resetRunning(draft.editorial.coverageSpec)),
      tried: resetRunning(draft.editorial.coverageSpec).rounds.map(round => round.triedKeys ?? null) });
  }
});

test('a new process over all of them: the same runs come back, once, and nothing asks a model', async t => {
  // Several shapes were derived from one draft: in one library each is a draft and a run of its own.
  const own = names.map(name => { const draft = structuredClone(corpus.drafts[name]); return { ...draft, id: `draft-${name}`, editorial: { ...draft.editorial, ...(draft.editorial.coverageRun ? { coverageRun: { ...draft.editorial.coverageRun, jobId: `job-${name}` } } : {}) } }; });
  const { service, calls } = await libraryWith(t, own);
  const jobs = (await service.call('snapshot')).jobs;
  for (const name of names) pinned(`restored.${name}`, restoredView(jobs.find(job => job.draftId === `draft-${name}`)) ?? null);
  pinned('restored.count', jobs.length);
  assert.deepEqual(await service.call('coverage.recover'), { recovered: 0 }, 'a second look finds nothing new');
  assert.equal((await service.call('snapshot')).jobs.length, jobs.length);
  assert.deepEqual(calls, {});
});

for (const name of names) test(`接着做 of "${name}": the same rounds, the same questions, the same model calls`, async t => {
  const draft = corpus.drafts[name], { service, calls } = await libraryWith(t, [draft]);
  await service.call('snapshot');
  let reply;
  try { reply = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } }); }
  catch (error) { pinned(`resume.${name}`, { refused: error.message }); return; }
  const job = await settleJob(service, reply.jobId), { contract } = (await service.call('snapshot')).jobs.find(item => item.id === reply.jobId), [after] = (await service.call('export')).drafts, spec = after.editorial.coverageSpec, marker = after.editorial.coverageRun;
  pinned(`resume.${name}`, { status: job.status, stage: job.stage, plan: reply.plan, rounds: statuses(spec), kept: spec.rounds.map(round => round.kept ?? null), cards: after.cards.length, ids: new Set(after.cards.map(card => card.id)).size,
    state: marker.state, stop: marker.stop?.reason ?? null, calls, events: contract.events.map(event => event.code).filter(code => /^(round|run)-/.test(code)),
    kept0: draft.cards.every(card => after.cards.some(item => item.id === card.id)) });
  // No field a release that is rolled back to would not know.
  const known = expected['fields'];
  const fields = { marker: Object.keys(marker).sort(), round: [...new Set(spec.rounds.flatMap(Object.keys))].sort(), spec: Object.keys(spec).sort() };
  if (recording) { expected.fields ||= { marker: [], round: [], spec: [] }; for (const key of Object.keys(fields)) expected.fields[key] = [...new Set([...expected.fields[key], ...fields[key]])].sort(); }
  else for (const key of Object.keys(fields)) assert.deepEqual(fields[key].filter(field => !known[key].includes(field)), [], `new ${key} fields`);
});

test('a run kept on disk (generationRestart): the same logical job comes back once, interrupted; its retry continues the draft', async t => {
  const complete = (...args) => library.complete(...args);
  const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: ['generation', 'generationRestart'] });
  const library = await libraryWith(t, [corpus.managed.draft], { manifests: corpus.managed.manifests, options });
  const [manifest] = Object.values(corpus.managed.manifests);
  const jobs = (await library.service.call('snapshot')).jobs;
  pinned('managed.restored', jobs.map(job => ({ logical: job.contract.jobId === manifest.runtimeJob.contract.jobId, status: job.contract.status, retry: job.contract.actions.retry.available, draft: job.draftId === corpus.managed.draft.id })));
  const reply = await library.service.call('job.control', { jobId: jobs[0].id, action: 'retry' });
  const done = await settleJob(library.service, reply.attemptId ?? reply.jobId), [after] = (await library.service.call('export')).drafts;
  pinned('managed.resumed', { status: done.status, rounds: statuses(after.editorial.coverageSpec), cards: after.cards.length, state: after.editorial.coverageRun.state, stop: after.editorial.coverageRun.stop?.reason ?? null, calls: library.calls });
});
