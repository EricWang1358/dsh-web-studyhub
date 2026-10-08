import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { observeJob } from '../lib/job-calls.js';
import { settleJob, until, sleep } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* A real run with the fake model: the progress of a continuation is its own (0% when it starts), and the end of a run is written in the log when it happened, with the saving that follows the last
   round said as a line of its own (the owner's log showed four silent minutes between the last round and 「任务完成」: the line of the end was stamped when the console next looked, not when the job ended). */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const PLAN = 'Plan a source-grounded assessment';

async function library(t, model) {
  const root = await mkdtemp(join(tmpdir(), 'study-progress-honest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  service.complete = model.complete;
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, ids: world.sources.map(source => source.id) };
}
const contractOf = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;

test('a continuation that has just started shows its own work: 0%, 0 of what it was asked for, and the draft it started from as a second fact', async (t) => {
  const model = clusteringModel();
  let held = null, release;
  const gate = new Promise(resolve => { release = resolve; });
  // The planning call of the SECOND job holds until the test has looked: the first job makes round 1 only (manual), the second goes on by itself.
  let plans = 0;
  const { service, ids } = await library(t, { complete: async (system, prompt, context = {}) => {
    if (system.startsWith(PLAN) && held === 'armed') { plans += 1; if (plans === 1) { held = 'entered'; await gate; } }
    return model.complete(system, prompt, context);
  } });
  const first = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  assert.equal((await contractOf(service, first.jobId)).detail.own, null, 'a run that began a draft has nothing to subtract');
  held = 'armed';
  const second = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } });
  await until(() => held === 'entered', 'the continuation to reach its first planning call');
  const live = await contractOf(service, second.jobId);
  assert.equal(live.status, 'running');
  assert.equal(live.progress.percent, 0, `it has covered nothing yet (was ${draft.cards.length}/${draft.cards.length} questions of the draft)`);
  assert.deepEqual(live.detail.own, { made: 0, asked: live.detail.own.asked, base: draft.cards.length });
  assert.ok(live.detail.own.asked > 0, 'it knows how many questions it was asked for');
  assert.ok(live.detail.cover.asked > 0 && live.detail.cover.atStart === live.detail.cover.covered, `it was asked to cover ${live.detail.cover.asked} sections and has covered none of them`);
  assert.equal(live.detail.cover.atStart + live.detail.cover.asked, live.detail.cover.leaves);
  assert.ok(live.progress.percent < 100);
  release();
  const done = await settleJob(service, second.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const after = await contractOf(service, second.jobId);
  assert.equal(after.progress.percent, 100);
  assert.ok(after.detail.own.made > 0 && after.detail.own.made <= after.detail.own.asked + 8);
  assert.equal(after.detail.cover.covered, after.detail.cover.leaves, 'every section has a question');
});

test('the end of a coverage run is written in the log when it happened; the saving after the last round is a line of its own, between the stop and the end', async (t) => {
  const refuse = asked => asked.sources.length === 1 && asked.sources[0].text.includes('[Part 2: Preview Passage 2]');
  const { service, ids } = await library(t, clusteringModel({ refuse }));
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await service.call('snapshot');
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  // Nobody looks at the job for a while (a hidden console, a closed window): the first look is later than the end.
  await sleep(1500);
  const contract = await contractOf(service, started.jobId);
  const codes = contract.events.map(event => event.code);
  const stop = contract.events.find(event => event.code === 'run-stop'), closing = contract.events.find(event => event.code === 'run-closing'), closed = contract.events.find(event => event.code === 'run-closed');
  const ended = contract.events.find(event => event.code === 'status' && event.args.status === 'complete');
  assert.equal(stop.args.reason, 'sections-left');
  assert.ok(closing && closed && ended, `the saving and the end are lines of the log (${codes.join(', ')})`);
  assert.equal(closing.args.cards, job.savedCount);
  const at = event => Date.parse(event.at);
  assert.ok(at(stop) <= at(closing) && at(closing) <= at(closed) && at(closed) <= at(ended), 'in the order they happened');
  assert.equal(ended.at, contract.finishedAt, 'the end is stamped when the job ended, not when the log was first read');
  assert.ok(Date.now() - at(ended) >= 1400, 'it was read later than that');
  assert.deepEqual([...contract.events].sort((a, b) => a.at.localeCompare(b.at)).map(event => event.id), contract.events.map(event => event.id), 'the log stays in time order');
});

test('observeJob stamps the end of any job with its finishedAt (an audio import or a conversion has the same quiet minutes); a job without one is stamped when it is seen', () => {
  const finishedAt = new Date(Date.now() - 240_000).toISOString();
  const job = { id: 'a', status: 'running', stage: 'working', events: [{ id: 'e1', at: new Date(Date.now() - 300_000).toISOString(), level: 'info', code: 'phase' }] };
  observeJob(job);
  Object.assign(job, { status: 'complete', stage: 'done', finishedAt });
  observeJob(job);
  assert.equal(job.events.at(-1).code, 'status');
  assert.equal(job.events.at(-1).at, finishedAt);
  const open = { id: 'b', status: 'running', stage: 'x', events: [{ id: 'e', at: new Date().toISOString(), code: 'phase' }] };
  observeJob(open); open.status = 'failed'; observeJob(open);
  assert.ok(Date.now() - Date.parse(open.events.at(-1).at) < 5000, 'no finishedAt: the time of the look');
  const future = { id: 'c', status: 'running', stage: 'x', events: [{ id: 'e', at: new Date().toISOString(), code: 'phase' }] };
  observeJob(future); Object.assign(future, { status: 'complete', finishedAt: new Date(Date.now() + 3_600_000).toISOString() }); observeJob(future);
  assert.ok(Date.parse(future.events.at(-1).at) <= Date.now(), 'never in the future');
});
