import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { convertHome } from '../lib/mineru-job.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';
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
