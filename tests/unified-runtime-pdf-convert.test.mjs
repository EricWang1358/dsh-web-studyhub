import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { convertHome } from '../lib/mineru-job.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { patientCli, until } from './helpers/wait.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* S5-2: PDF conversion (cloud MinerU here; the local routes are in mineru-local-service and marker-service, which also run on this switch) as a runtime job
   (runtime.pilot.pdfConvert). The fake MinerU is a loopback server; nothing leaves the machine. */

const KIND = 'pdf-convert';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
const filesUnder = async directory => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path)); else found.push(path);
  }
  return found;
};

async function harness(t, { serverOptions = {}, runtime = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-pdf-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-pdf-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY;
  const fake = await startFakeMineru(serverOptions), clock = { time: 5_000_000 };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: runtime ? ['pdfConvert'] : [] });
  const service = new StudyService(root, { ...(runtime ? managed : {}), mineru: { baseUrl: fake.baseUrl, now: () => clock.time,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); } } });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  const upload = async (bytes, name = 'Book.pdf') => {
    const { uploadId, chunkBytes } = await call('mineru.upload.start', { name, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  const jobs = async () => (await call('snapshot')).jobs.filter(job => job.type === KIND);
  await call('mineru.settings.set', { token: fake.token, acknowledge: true });
  return { home, root, fake, service, call, upload, jobs, settled: id => until(async () => { const job = (await jobs()).find(item => item.id === id); return job && !['queued', 'running', 'cancelling'].includes(job.status) && job; }, 'the job to settle'),
    start: async (pages = 450, args = {}) => call('mineru.import', { uploadId: await upload(await makePdf({ pages })), ...args }) };
}

test('a conversion is one job: titled, observed (a Call for every create, upload and download), no tokens invented, and the same document as the original path makes', async t => {
  const runtime = await harness(t), original = await harness(t, { runtime: false });
  const result = [];
  for (const h of [runtime, original]) {
    const started = await h.start(450, { title: 'Book', courses: ['Databases'] });
    assert.equal(started.chunks.length, 3);
    const job = await h.settled(started.jobId);
    assert.equal(job.status, 'complete', job.stage);
    const state = await h.call('snapshot');
    result.push({ job, sources: state.sources.filter(source => source.document?.converter === 'mineru').map(source => [source.document.page, source.text, source.courses]) });
    assert.equal(h.fake.uploads.length, 3);
  }
  assert.equal(result[0].sources.length, 450);
  assert.deepEqual(result[0].sources, result[1].sources, 'same pages, same text, same courses');
  const { contract } = result[0].job;
  assert.deepEqual([contract.contractVersion, contract.kind, contract.status], [2, KIND, 'complete']);
  const calls = contract.calls.map(call => [call.kind, call.observation.boundary, call.observation.requestCount]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'create'), Array(3).fill(['create', 'external-request', 1]));
  assert.equal(calls.filter(([kind]) => kind === 'upload').length, 3); assert.equal(calls.filter(([kind]) => kind === 'download').length, 3);
  assert.deepEqual(contract.usage, { tokens: null, tokenUsage: null, calls: 0 });
  assert.equal(contract.execution.mode, null);
  assert.deepEqual([contract.capabilities.retry, contract.capabilities.recoveryMode], [true, 'none']);
});

test('a piece that fails keeps what finished; the retry redoes only that piece and continues the same Job under the same id', async t => {
  let healthy = false;
  const h = await harness(t, { serverOptions: { failWhen: file => (/-2-/.test(file.data_id) && !healthy ? 'internal error' : undefined) } });
  const started = await h.start(450);
  const failed = await h.settled(started.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.chunks[0].state, 'done');
  assert.equal((await h.call('snapshot')).inbox.items.filter(item => item.kind === 'pdf-failed').length, 1);
  healthy = true;
  const before = h.fake.uploads.length;
  const retried = await h.call('mineru.retry', { jobId: failed.id });
  const done = await h.settled(retried.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.id, failed.id); assert.equal(done.contract.jobId, failed.contract.jobId);
  assert.equal(h.fake.uploads.length - before, 2, 'pieces 2 and 3 were uploaded; piece 1 was not');
  const state = await h.call('snapshot');
  assert.equal(state.sources.filter(source => source.document?.converter === 'mineru').length, 450);
});

for (const runtime of [true, false]) {
  test(`${runtime ? 'a Job' : 'the original run'} is cancelled only after its job folder is dealt with: the first state anyone reads as ended already has nothing left on disk, and no letter`, async t => {
    const h = await harness(t, { serverOptions: { holdWhen: () => true }, runtime });
    const started = await h.start(450);
    await until(async () => (await h.jobs()).find(job => job.phase === 'parse'), 'the first piece to be parsed');
    await h.call('job.cancel', { jobId: started.jobId });
    const ended = await until(async () => {
      const [job] = await h.jobs();
      if (!job || ['queued', 'running', 'cancelling'].includes(job.status)) return null;
      return { job, files: await filesUnder(join(convertHome(h.root), 'jobs')) };
    }, 'the cancel');
    assert.equal(ended.job.status, 'cancelled');
    assert.deepEqual(ended.files, [], 'not cancelled while the folder is still there');
    assert.equal((await h.call('snapshot')).inbox.items.filter(item => item.kind.startsWith('pdf-')).length, 0);
    assert.equal((await h.call('mineru.history.list')).records[0].status, 'cancelled');
  });
}

test('a second conversion waits behind the first (one at a time per library); stopping it while it waits takes it out of the line and the first goes on', async t => {
  let release = false;
  const h = await harness(t, { serverOptions: { holdWhen: () => !release } });
  const first = await h.start(3), second = await h.start(5, {});
  assert.equal(second.queuedBehind, 1);
  await until(async () => (await h.jobs()).find(job => job.id === first.jobId)?.phase === 'parse', 'the first to run');
  const waiting = (await h.jobs()).find(job => job.id === second.jobId);
  assert.equal(waiting.status, 'queued');
  assert.equal(consoleCode.taskSummary(waiting).state, 'queued');
  await h.call('job.cancel', { jobId: second.jobId });
  const stopped = await h.settled(second.jobId);
  assert.equal(stopped.status, 'cancelled');
  assert.equal((await h.call('mineru.history.list')).records.find(record => record.id === second.jobId).status, 'cancelled');
  release = true;
  assert.equal((await h.settled(first.jobId)).status, 'complete');
  assert.equal(h.fake.batches.size, 1, 'only the first book ever reached MinerU');
});

test('the letters of a conversion are written once, with the Job\'s id: a result, or a failure that says the finished part is kept; none for a stop', async t => {
  let healthy = false;
  const h = await harness(t, { serverOptions: { failWhen: file => (/-2-/.test(file.data_id) && !healthy ? 'internal error' : undefined) } });
  const started = await h.start(450);
  const failed = await h.settled(started.jobId);
  const letters = (await h.call('snapshot')).inbox.items.filter(item => item.kind.startsWith('pdf-'));
  assert.deepEqual(letters.map(item => [item.kind, item.jobId]), [['pdf-failed', failed.id]]);
  assert.match(letters[0].detail, new RegExp(CONVERT_TEXT.resumeHint));
  healthy = true;
  await h.call('mineru.retry', { jobId: failed.id });
  const done = await h.settled(failed.id);
  const after = (await h.call('snapshot')).inbox.items.filter(item => item.kind.startsWith('pdf-'));
  assert.deepEqual(after.map(item => [item.kind, item.jobId]), [['pdf-result', done.id]]);
  assert.equal(after[0].sourceIds.length, 450);
});

test('the 任务 console lists the conversion as a PDF task with its own stage words, counts it while it runs and shows it done', async t => {
  let release = false;
  const h = await harness(t, { serverOptions: { holdWhen: () => !release } });
  const started = await h.start(3);
  await until(async () => (await h.jobs()).find(job => job.phase === 'parse'), 'the parse phase');
  const data = await h.call('snapshot');
  assert.equal(consoleCode.runningTaskCount(data), 1);
  const running = consoleCode.taskSummary(consoleCode.tasksOf(data)[0]);
  assert.deepEqual([running.kind, running.state], ['pdf', 'run']);
  assert.match(running.line, /解析/);
  release = true;
  await h.settled(started.jobId);
  assert.equal(consoleCode.taskSummary(consoleCode.tasksOf(await h.call('snapshot'))[0]).state, 'done');
});

test('without a session to run in the import is refused in words, and nothing is left behind: no job, no folder, no request', async t => {
  const gone = { assertAvailable() { throw Object.assign(new Error('no agent'), { code: 'executor-unavailable' }); } };
  const h = await harness(t, {});
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: ['pdfConvert'] });
  const service = new StudyService(h.root, { ...managed, jobExecutor: gone, mineru: { baseUrl: h.fake.baseUrl } });
  t.after(() => service.dispose());
  const bytes = await makePdf({ pages: 3 });
  const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
  await service.call('mineru.upload.finish', { uploadId });
  await assert.rejects(service.call('mineru.import', { uploadId }), { code: 'convert-needs-session', message: CONVERT_TEXT.needsSession });
  assert.deepEqual([(await service.call('snapshot')).jobs.filter(job => job.type === KIND), await filesUnder(join(convertHome(h.root), 'jobs')), h.fake.requests.length], [[], [], 0]);
});

test('a create whose answer is lost is not made again by the job: it stops with its reason and the resume says what may be left behind (D-1)', async t => {
  const h = await harness(t, { serverOptions: { loseCreateAnswers: 1 } });
  const started = await h.start(3);
  const failed = await h.settled(started.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'create-unknown');
  assert.equal([...h.fake.requests].filter(request => request.method === 'POST').length, 1, 'no second create');
  assert.equal(failed.retryable, true);
  const retried = await h.call('mineru.retry', { jobId: failed.id });
  const done = await h.settled(retried.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(h.fake.batches.size, 2, 'the lost one and the second');
  assert.ok(done.warnings.some(text => text.includes('空批次')), 'the learner is told');
});

test('every new sentence of the conversion has its English form', async () => {
  const { localizeAppMessage } = await import('../lib/application-messages.js');
  const { JOB_TEXT } = await import('../lib/mineru-job.js');
  for (const text of [CONVERT_TEXT.needsSession, JOB_TEXT.createUnknown, JOB_TEXT.cannotVerify, JOB_TEXT.orphanBatch]) assert.notEqual(localizeAppMessage(text), text, text);
});

async function localHarness(t, state = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-pdf-local-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-pdf-local-lib-')), work = await mkdtemp(join(tmpdir(), 'runtime-pdf-local-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const fake = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url)), cli = patientCli({ file: process.execPath, prefix: [fake], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: ['pdfConvert'] });
  const service = new StudyService(root, { ...managed, mineru: { limits: { windowPages: 50 }, local: { cli, home: work } } });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const log = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const jobs = async () => (await service.call('snapshot')).jobs.filter(job => job.type === KIND);
  const bytes = await makePdf({ pages: 120 }), { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
  await service.call('mineru.upload.finish', { uploadId });
  return { service, jobs, parses: async () => (await log()).filter(entry => entry.argv[0] === 'parse'),
    start: () => service.call('mineru.import', { uploadId, route: 'local' }) };
}

test('a local conversion runs each window as one observed local-process Call; stopping it ends the Job only after the window\'s process is gone, and the folder is dealt with', async t => {
  const done = await localHarness(t);
  const started = await done.start();
  const finished = await until(async () => { const job = (await done.jobs())[0]; return job && job.status === 'complete' && job; }, 'the conversion');
  assert.equal(started.chunks.length, 3);
  assert.deepEqual(finished.contract.calls.map(call => [call.kind, call.status, call.observation.boundary, call.observation.requestCount]),
    Array(3).fill(['window', 'ok', 'local-process', null]));
  const slow = await localHarness(t, { delayMs: 60_000 });
  const second = await slow.start();
  await until(async () => (await slow.parses()).length, 'the first window to start');
  const pid = (await slow.parses())[0].pid;
  await slow.service.call('job.cancel', { jobId: second.jobId });
  const ended = await until(async () => { const job = (await slow.jobs())[0]; return job && !['queued', 'running', 'cancelling'].includes(job.status) && job; }, 'the stop');
  assert.equal(ended.status, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the window\'s process was gone when the Job ended');
  assert.deepEqual(ended.contract.calls.map(call => call.status), ['cancelled']);
});
