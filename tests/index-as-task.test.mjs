import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { RuntimeConfig, MIGRATION_SWITCHES } from '../lib/runtime-config.js';
import { readManifest } from '../lib/retrieval-index.js';
import { INDEX_TEXT } from '../lib/retrieval-messages.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { fakeIndexPort, untilAborted } from './helpers/index-port.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';

/* The search-index build is a job of the 任务 console by default (owner, 2026-11-06: a 513-page build was only visible in Settings).
   With no host config, a host that can run jobs builds the index as a `retrieval-index` job; `runtime.pilot.retrievalIndex: false` keeps
   the original background run. Whichever path is asked, one library never has two builds, and the manifest stays the checkpoint. */

const PAGES = 4, KIND = 'retrieval-index';

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'index-task-home-')), before = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
}

async function newRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'index-task-lib-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

/** A service on `root` whose host can run jobs (DSH gives every request an executor), with `pilot` as the host's runtime.pilot. */
async function open(t, root, fake, pilot, { importBook = true } = {}) {
  const { starts: _starts, runtimePilot: _on, ...host } = managedRuntimeOptions({ paths: [] });
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: fake.port, ...host, ...(pilot ? { runtimePilot: pilot } : {}) });
  t.after(() => service.dispose());
  if (importBook) {
    const book = Array.from({ length: PAGES }, (_, index) => `<!-- page: ${index + 1} -->\nOS 第 ${index + 1} 页讲进程。`).join('\n\n');
    await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });
  }
  const jobs = async () => (await service.call('snapshot')).jobs.filter(job => job.type === KIND);
  const status = () => service.call('retrieval.index.status', {});
  const finished = what => until(async () => { const run = await status(); return ['complete', 'failed', 'cancelled'].includes(run.status) ? run : null; }, what);
  return { service, jobs, status, finished };
}

test('the host config turns the job path on by default; an explicit false is still the way back, and no other switch moved', () => {
  const defaults = RuntimeConfig({}).pilot;
  assert.equal(defaults.retrievalIndex, true);
  assert.equal(RuntimeConfig({ pilot: { retrievalIndex: false } }).pilot.retrievalIndex, false);
  for (const key of Object.keys(MIGRATION_SWITCHES).filter(key => key !== 'retrievalIndex')) assert.equal(defaults[key], false, key);
});

test('with no host config the build is a job of the 任务 console: titled for the course, counted in pages, run locally', async t => {
  await home(t);
  const fake = fakeIndexPort(), lib = await open(t, await newRoot(t), fake);
  const started = await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.equal(started.status, 'running');
  assert.equal(started.taskId, (await lib.jobs())[0]?.contract.jobId, 'the receipt names the task the panel can open');
  const done = await lib.finished('the build');
  assert.equal(done.status, 'complete');
  const [job] = await lib.jobs();
  assert.ok(job, 'the build is listed in the shared job list');
  assert.equal(job.contract.title, '建立检索索引 · OS');
  assert.equal(localizeAppMessage(job.contract.title), 'Search index · OS');
  assert.deepEqual([job.contract.progress.done, job.contract.progress.total, job.contract.progress.unit], [PAGES, PAGES, 'pages']);
  assert.deepEqual(job.contract.usage, { tokens: null, tokenUsage: null, calls: 0 }, 'no model, no tokens');
  assert.equal(fake.index.size, PAGES);
});

test('the same build fed with the same host config written by hand (the schema default) is a job as well', async t => {
  await home(t);
  const fake = fakeIndexPort(), lib = await open(t, await newRoot(t), fake, RuntimeConfig({}).pilot);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.equal((await lib.finished('the build')).status, 'complete');
  assert.equal((await lib.jobs()).length, 1);
});

test('runtime.pilot.retrievalIndex: false keeps the original background run (not a job)', async t => {
  await home(t);
  const fake = fakeIndexPort(), lib = await open(t, await newRoot(t), fake, { retrievalIndex: false });
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.equal((await lib.finished('the build')).status, 'complete');
  assert.deepEqual(await lib.jobs(), []);
  assert.equal(fake.index.size, PAGES);
});

test('a host that cannot run jobs at all (no executor) keeps the original background run', async t => {
  await home(t);
  const fake = fakeIndexPort(), root = await newRoot(t);
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: fake.port });
  t.after(() => service.dispose());
  const book = Array.from({ length: PAGES }, (_, index) => `<!-- page: ${index + 1} -->\nOS 第 ${index + 1} 页。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });
  await service.call('retrieval.index.start', { course: 'OS' });
  const done = await until(async () => { const run = await service.call('retrieval.index.status', {}); return run.status === 'complete' ? run : null; }, 'the build');
  assert.equal(done.added, PAGES);
});

test('with no host config and no live session to own a job (a preview), the build still runs, as the original background run', async t => {
  await home(t);
  const fake = fakeIndexPort(), root = await newRoot(t);
  const gone = { assertAvailable() { throw Object.assign(new Error('no agent'), { code: 'executor-unavailable' }); }, start() { throw new Error('not admitted'); } };
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: fake.port, jobExecutor: gone });
  t.after(() => service.dispose());
  const book = Array.from({ length: PAGES }, (_, index) => `<!-- page: ${index + 1} -->\nOS 第 ${index + 1} 页。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });
  await service.call('retrieval.index.start', { course: 'OS' });
  const done = await until(async () => { const run = await service.call('retrieval.index.status', {}); return run.status === 'complete' ? run : null; }, 'the build');
  assert.equal(done.added, PAGES);
  assert.deepEqual((await service.call('snapshot')).jobs.filter(job => job.type === KIND), []);
});

test('a build the original path started is the one build of the library: the job path joins it, stops it, and then writes only the pages it did not record', async t => {
  await home(t);
  let stuck = false;
  const fake = fakeIndexPort({ onIngest: (args, count, options) => { if (count === 3 && !stuck) { stuck = true; return untilAborted(args, count, options); } } });
  const root = await newRoot(t);
  // Before the upgrade: the original run, two pages written, the third in flight.
  const before = await open(t, root, fake, { retrievalIndex: false });
  const legacy = await before.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => fake.ingested().length === 3, 'the third ingest');
  // After: the same library on the job path (the default) asks for a build, reads the status, sees the coverage.
  const after = await open(t, root, fake, undefined, { importBook: false });
  const joined = await after.service.call('retrieval.index.start', { course: 'OS' });
  assert.deepEqual([joined.status, joined.runId], ['running', legacy.runId], 'the running build is reported, no second one starts');
  assert.deepEqual(await after.jobs(), [], 'no job was submitted beside it');
  assert.equal((await after.status()).runId, legacy.runId);
  assert.equal((await after.service.call('retrieval.index.coverage', {})).building?.course, 'OS');
  assert.equal(fake.ingested().length, 3, 'nothing was written twice');
  // Its stop button stops that build after the write in flight; the manifest keeps what was written.
  await after.service.call('retrieval.index.cancel', {});
  assert.equal((await after.finished('the stop')).status, 'cancelled');
  assert.equal(Object.keys((await readManifest(root)).sources).length, 2);
  // The next build is a job and writes only the pages the manifest does not have.
  fake.calls.length = 0;
  const next = await after.service.call('retrieval.index.start', { course: 'OS' });
  assert.notEqual(next.runId, legacy.runId);
  const done = await after.finished('the job');
  assert.deepEqual([done.status, done.added, done.unchanged], ['complete', PAGES - 2, 2]);
  assert.equal(fake.ingested().length, PAGES - 2);
  assert.equal((await after.jobs()).length, 1);
});

test('a job running makes a second start (of either course) return that job, never a second build', async t => {
  await home(t);
  const fake = fakeIndexPort({ onIngest: untilAborted }), lib = await open(t, await newRoot(t), fake);
  const first = await lib.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => fake.ingested().length === 1, 'the first ingest');
  const second = await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.equal(second.runId, first.runId);
  assert.equal(fake.ingested().length, 1);
  await lib.service.call('retrieval.index.cancel', {});
  assert.equal((await lib.finished('the stop')).status, 'cancelled');
});

test('the consecutive-failures stop is the job\'s failure, with its real cause, and the panel status says the same', async t => {
  await home(t);
  const fake = fakeIndexPort({ onIngest: () => { throw new Error('embedding server refused the page'); } });
  const root = await newRoot(t);
  const { starts: _starts, runtimePilot: _on, ...host } = managedRuntimeOptions({ paths: [] });
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: fake.port, ...host });
  t.after(() => service.dispose());
  const book = Array.from({ length: 6 }, (_, index) => `<!-- page: ${index + 1} -->\nOS 第 ${index + 1} 页。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });
  // The first page fails with a network-looking cause only when it says so; this one does not, so the build goes on to the limit.
  await service.call('retrieval.index.start', { course: 'OS' });
  const failed = await until(async () => { const run = await service.call('retrieval.index.status', {}); return run.status === 'failed' ? run : null; }, 'the stop');
  assert.match(failed.error, /连续 5 页没能写入索引，已停止：embedding server refused the page/);
  const [job] = (await service.call('snapshot')).jobs.filter(item => item.type === KIND);
  assert.equal(job.contract.status, 'failed');
  assert.match(job.contract.error.message, /连续 5 页没能写入索引，已停止：embedding server refused the page/);
  assert.equal(job.contract.stage.text, job.contract.error.message, 'the stage the console lists is the real cause, not a generic "did not finish"');
  assert.equal(job.contract.detail.index.failedCount, 5);
});

test('the build\'s title has its English form', () => {
  assert.equal(INDEX_TEXT.title('OS'), '建立检索索引 · OS');
  assert.equal(localizeAppMessage(INDEX_TEXT.title()), 'Search index');
  assert.equal(localizeAppMessage(INDEX_TEXT.title('OS')), 'Search index · OS');
});
