import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { convertHome } from '../lib/mineru-job.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { makePdf } from './helpers/pdf.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { PDF_KIND, filesUnder, harness, localHarness } from './helpers/pdf-convert-harness.mjs';

/* S5-2: PDF conversion (cloud MinerU here; the local routes are in mineru-local-service and marker-service, which also run on this switch) as a runtime job
   (runtime.pilot.pdfConvert). The fake MinerU is a loopback server; nothing leaves the machine. */

const KIND = PDF_KIND;
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
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
  for (const text of [CONVERT_TEXT.needsSession, JOB_TEXT.createUnknown, JOB_TEXT.cannotVerify, JOB_TEXT.orphanBatch, JOB_TEXT.inputChanged]) assert.notEqual(localizeAppMessage(text), text, text);
});

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
