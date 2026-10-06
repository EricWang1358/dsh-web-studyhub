import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INDEX_TOOLS, readManifest, retrievalHome, sourceKey } from '../lib/retrieval-index.js';
import { INDEX_TEXT } from '../lib/retrieval-messages.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { fakeIndexPort, untilAborted } from './helpers/index-port.mjs';
import { INDEX_KIND, PAGES, library } from './helpers/index-library.mjs';
import { until } from './helpers/wait.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* S5-5: the search-index build as a runtime job (runtime.pilot.retrievalIndex). The extension is a fake that replaces an entry
   when its key is written again; nothing is indexed anywhere. Behaviour the legacy build already has is pinned by
   wp28b-index and nonmodel-baseline-index, which also run on this switch (*.runtime.test.mjs). */

const KIND = INDEX_KIND;
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
test('a build is one job in the shared list: titled, with progress, one observed local call, no invented usage and no retry button', async t => {
  const fake = fakeIndexPort(), lib = await library(t, fake);
  assert.deepEqual(await lib.jobs(), []);
  const started = await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.deepEqual([started.status, started.stage, started.total, started.course, started.firstRun], ['running', 'preparing', PAGES, 'OS', true]);
  assert.equal((await lib.finished('the build')).status, 'complete');
  const [job] = await lib.jobs(), { contract } = job;
  assert.equal(job.id, started.runId);
  assert.equal(contract.contractVersion, 2); assert.equal(contract.kind, KIND);
  assert.match(contract.title, /OS/);
  assert.deepEqual([contract.progress.done, contract.progress.total, contract.progress.percent], [PAGES, PAGES, 100]);
  assert.deepEqual(contract.calls.map(call => [call.kind, call.status, call.observation]), [['index', 'ok', { boundary: 'local-process', requestCount: null }]]);
  assert.deepEqual(contract.usage, { tokens: null, tokenUsage: null, calls: 0 });
  assert.equal(contract.execution.mode, null);
  assert.deepEqual([contract.capabilities.retry, contract.capabilities.recoveryMode, contract.capabilities.pauseMode], [false, 'none', 'unsupported']);
  assert.equal(contract.actions.retry.available, false);
  assert.equal(fake.ingested().length, PAGES);
});

test('the build of a course asked twice is one job; the second course is reported as ignored, never silently', async t => {
  const fake = fakeIndexPort({ onIngest: untilAborted }), lib = await library(t, fake);
  const first = await lib.service.call('retrieval.index.start', { course: 'OS' });
  const second = await lib.service.call('retrieval.index.start', { course: 'DB' });
  assert.equal(second.runId, first.runId); assert.equal(second.course, 'OS'); assert.equal(second.requestedCourse, 'DB');
  assert.equal((await lib.service.call('retrieval.index.start', { course: 'OS' })).requestedCourse, undefined);
  assert.equal((await lib.jobs()).length, 1);
  await lib.service.call('retrieval.index.cancel', {}); await lib.finished('the stopped build');
});

test('without the extension, or without a registered session to run in, the refusal comes first: no job, no write', async t => {
  const none = fakeIndexPort({ present: false }), lib = await library(t, none);
  await assert.rejects(lib.service.call('retrieval.index.start', { course: 'OS' }), { code: 'retrieval-index-unavailable' });
  assert.deepEqual(await lib.jobs(), []);
  const fake = fakeIndexPort(), gone = { assertAvailable() { throw Object.assign(new Error('no agent'), { code: 'executor-unavailable' }); } };
  const panel = await library(t, fake, { runtime: { jobExecutor: gone } });
  await assert.rejects(panel.service.call('retrieval.index.start', { course: 'OS' }), { code: 'retrieval-index-needs-session' });
  assert.deepEqual(await panel.jobs(), []); assert.equal(fake.calls.length, 0);
});

test('unchanged pages are reused, an edited page is written again under its own key, and only a page that left the library is deleted', async t => {
  const fake = fakeIndexPort(), lib = await library(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' }); await lib.finished('the first build');
  const keys = [...fake.index.keys()];
  assert.equal(keys.length, PAGES);
  fake.calls.length = 0;
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  const again = await lib.finished('the second build');
  assert.deepEqual([again.added, again.unchanged, fake.calls.length], [0, PAGES, 0], 'same content hash and key: nothing is sent');
  const [edited, removed] = (await lib.service.call('snapshot')).sources.map(source => source.id);
  await lib.service.store.update(state => {
    state.sources.find(source => source.id === edited).text += ' 改过的内容。';
    state.sources.splice(state.sources.findIndex(source => source.id === removed), 1);
  });
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  const next = await lib.finished('the third build');
  assert.deepEqual([next.added, next.removed, next.unchanged], [1, 1, PAGES - 2]);
  assert.deepEqual(fake.ingested(), [sourceKey(edited)]); assert.deepEqual(fake.deleted(), [sourceKey(removed)]);
  assert.equal(fake.index.size, PAGES - 1);
});

test('cancel stops further writes and says which page was in flight: its outcome is unknown, so it is neither recorded nor called unwritten', async t => {
  let stuck = false;
  const fake = fakeIndexPort({ onIngest: (args, count, options) => { if (count === 2 && !stuck) { stuck = true; return untilAborted(args, count, options); } } }), lib = await library(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => fake.ingested().length === 2, 'the second ingest');
  const receipt = await lib.service.call('retrieval.index.cancel', {});
  assert.equal(receipt.status, 'running', 'the receipt is not the end: the write in flight is still being stopped');
  const stopped = await lib.finished('the stop');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(fake.ingested().length, 2, 'no write after the cancel');
  assert.equal(stopped.unconfirmed.length, 1);
  assert.equal(sourceKey(stopped.unconfirmed[0]), fake.ingested()[1]);
  assert.equal(Object.keys((await readManifest(lib.root)).sources).length, 1, 'only the finished page is recorded');
  const [{ contract }] = await lib.jobs();
  assert.equal(contract.status, 'cancelled'); assert.equal(contract.calls[0].status, 'cancelled');
  // The next build writes the unknown page again under the same key: it replaces, it does not add.
  fake.calls.length = 0;
  await lib.service.call('retrieval.index.start', { course: 'OS' }); await lib.finished('the next build');
  assert.equal(fake.ingested().length, PAGES - 1); assert.equal(fake.index.size, PAGES);
});

test('pages the extension took but the local record could not keep end the job as failed, and the next build replaces them instead of duplicating', async t => {
  const fake = fakeIndexPort(), lib = await library(t, fake);
  await mkdir(retrievalHome(), { recursive: true }); await writeFile(join(retrievalHome(), 'manifests'), 'a file where the folder should be');
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  const failed = await lib.finished('the build');
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'retrieval-manifest-unsaved');
  assert.equal(fake.index.size, PAGES, 'the extension holds the pages');
  await rm(join(retrievalHome(), 'manifests'), { force: true });
  fake.calls.length = 0;
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.equal((await lib.finished('the second build')).status, 'complete');
  assert.equal(fake.index.size, PAGES, 'the same keys were written again: replaced, not duplicated');
  assert.deepEqual(new Set(fake.ingested()).size, PAGES);
});

test('searching and previewing stay instant calls while a build runs: they start nothing and wait for nothing', async t => {
  const fake = fakeIndexPort({ onIngest: untilAborted }), lib = await library(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => fake.ingested().length === 1, 'the first ingest');
  assert.equal((await lib.service.call('retrieval.preview', { query: '进程' })).provider, 'builtin');
  assert.equal((await lib.service.call('retrieval.index.plan', { course: 'OS' })).pages, PAGES);
  const coverage = await lib.service.call('retrieval.index.coverage', {});
  assert.deepEqual([coverage.building.course, coverage.building.total], ['OS', PAGES]);
  assert.equal((await lib.jobs()).length, 1);
  await lib.service.call('retrieval.index.cancel', {}); await lib.finished('the stopped build');
  assert.equal((await lib.service.call('retrieval.index.coverage', {})).building, null);
});

test('the console cannot restart a finished build: the start button is the one entry, so one library never has two builds', async t => {
  const fake = fakeIndexPort({ onIngest: (_args, count) => { if (count === 1) throw new Error('parse failed'); } }), lib = await library(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  const done = await lib.finished('the build');
  assert.equal(done.status, 'complete'); assert.equal(done.failedCount, 1);
  const [job] = await lib.jobs();
  await assert.rejects(lib.service.call('job.control', { jobId: job.id, action: 'retry' }), { code: 'capability-unsupported' });
  assert.equal(fake.calls.filter(call => call.name === INDEX_TOOLS.ingest).length, PAGES);
});

test('every sentence of the build, in the console and in the refusals, has its English form', () => {
  const stages = ['preparing', 'model', 'indexing', 'done', 'cancelled', 'failed'].map(phase => INDEX_TEXT.stage(phase, { done: 3, total: 9 }));
  for (const text of [INDEX_TEXT.needsSession, INDEX_TEXT.manifestUnsaved, INDEX_TEXT.title('OS'), INDEX_TEXT.title(), ...stages]) assert.notEqual(localizeAppMessage(text), text, text);
  assert.equal(localizeAppMessage(INDEX_TEXT.stage('indexing', { done: 3, total: 9 })), 'Indexing 3 / 9 pages');
});

test('the 任务 console lists the build with its own words, counts it while it runs and shows it stopped afterwards (baseline D-8)', async t => {
  let seen = 0;
  const fake = fakeIndexPort({ onIngest: (args, count, options) => { seen = count; return count === 2 ? untilAborted(args, count, options) : undefined; } }), lib = await library(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => seen === 2, 'the second ingest');
  const data = await lib.service.call('snapshot');
  assert.equal(consoleCode.runningTaskCount(data), 1);
  const [job] = consoleCode.tasksOf(data), running = consoleCode.taskSummary(job);
  assert.deepEqual([running.kind, running.state, running.title], ['extension', 'run', INDEX_TEXT.title('OS')]);
  assert.equal(running.line, INDEX_TEXT.stage('indexing', { done: 1, total: PAGES }));
  assert.equal(running.percent, 25);
  await lib.service.call('retrieval.index.cancel', {}); await lib.finished('the stop');
  const after = await lib.service.call('snapshot');
  assert.equal(consoleCode.runningTaskCount(after), 0);
  assert.equal(consoleCode.taskSummary(consoleCode.tasksOf(after)[0]).state, 'stopped');
});
