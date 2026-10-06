import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERT, readManifest } from '../lib/mineru-job.js';
import { MINERU, MineruError, createMineruClient } from '../lib/mineru-api.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { pdfJob } from './helpers/nonmodel-baseline.mjs';

/* S5-0 baseline of the CLOUD PDF path (docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md), pinned as it is on origin/main, defects included:
   which layer retries which remote call, what a lost or half-finished create leaves behind, and that nothing ever cancels remote work.
   The fake MinerU is a loopback HTTP server; nothing leaves the machine. */

const isPost = (method, path) => method === 'POST' && path === '/api/v4/file-urls/batch';
const isPut = (method, path) => method === 'PUT' && path.startsWith('/upload/');
const isZip = (method, path) => method === 'GET' && path.startsWith('/zip/');
const isStatus = (method, path) => method === 'GET' && path.includes('/extract-results/');
const count = (fake, match) => fake.requests.filter(request => match(request.method, request.path)).length;

async function cloud(t, options = {}) {
  const fake = await startFakeMineru(options.server);
  t.after(() => fake.close());
  const job = await pdfJob(t, options);
  return Object.assign(job, { fake, client: () => createMineruClient({ token: fake.token, baseUrl: fake.baseUrl }),
    runCloud: (prepared, extra = {}) => job.run(prepared, { client: job.client(), ...extra }) });
}

test('the transport is one request per call and offers no cancel or delete: retrying belongs to the job, stopping never reaches MinerU', async t => {
  const h = await cloud(t);
  assert.deepEqual(Object.keys(h.client()).sort(), ['check', 'download', 'requestUploads', 'status', 'upload']);
  h.fake.inject(isPost, 'bad gateway', { status: 502 });
  await assert.rejects(h.client().requestUploads([{ name: 'a.pdf', dataId: 'd1' }]), error => error instanceof MineruError && error.code === 'unavailable' && error.retryable);
  assert.equal(count(h.fake, isPost), 1, 'the client did not send it again');
  h.fake.inject(isStatus, 'bad gateway', { status: 502 });
  await assert.rejects(h.client().status('any-batch'), error => error.code === 'unavailable');
  assert.equal(count(h.fake, isStatus), 1);
  assert.deepEqual([...new Set(h.fake.requests.map(request => request.method))].sort(), ['GET', 'POST'], 'no DELETE or other cancel verb exists');
});

test('create is retried by the job layer up to 3 tries, with growing waits; the third failure stops the job with nothing recorded', async t => {
  assert.equal(CONVERT.transferFailures, 3);
  const ok = await cloud(t);
  ok.fake.inject(isPost, 'bad gateway', { status: 502, times: 2 });
  await ok.runCloud(await ok.prepare());
  assert.equal(count(ok.fake, isPost), 3, 'two failed creates and the one that worked');
  assert.equal(ok.fake.batches.size, 1);
  assert.deepEqual(ok.clock.slept.slice(0, 2), [Math.min(MINERU.pollMs * 2, MINERU.pollMaxMs), Math.min(MINERU.pollMs * 4, MINERU.pollMaxMs)]);
  const stuck = await cloud(t);
  stuck.fake.inject(isPost, 'bad gateway', { status: 502, times: 5 });
  const prepared = await stuck.prepare();
  await assert.rejects(stuck.runCloud(prepared), error => error.code === 'unavailable' && error.retryable === true);
  assert.equal(count(stuck.fake, isPost), 3, 'three tries, then it gives up');
  const chunk = (await readManifest(prepared.dir)).chunks[0];
  assert.equal(chunk.batchId, undefined);
  assert.ok(chunk.error);
  assert.equal(count(stuck.fake, isPut), 0, 'nothing was uploaded');
});

test('upload and download are retried by the same layer without creating again; a failed download keeps the task and resumes at the download', async t => {
  const h = await cloud(t);
  h.fake.inject(isPut, 'down', { status: 500, times: 2 });
  await h.runCloud(await h.prepare());
  assert.equal(count(h.fake, isPut), 3);
  assert.equal(count(h.fake, isPost), 1, 'a failed upload does not ask for a new address');
  const again = await cloud(t);
  again.fake.inject(isZip, 'down', { status: 500, times: 3 });
  const prepared = await again.prepare();
  await assert.rejects(again.runCloud(prepared), error => error.code === 'download-failed' && error.retryable === true);
  assert.equal(count(again.fake, isZip), 3);
  const saved = await readManifest(prepared.dir);
  assert.ok(saved.chunks[0].batchId, 'the task reference is kept');
  const uploads = count(again.fake, isPut);
  await again.run({ dir: prepared.dir, manifest: saved }, { client: again.client() });
  assert.equal(count(again.fake, isPut), uploads, 'resumed by polling and downloading only');
  assert.equal(again.imports.length, 1);
});

test('DEFECT BASELINE: a create whose answer is lost is sent again with the same data id; the first batch is left behind and nothing checks or cancels it', async t => {
  const h = await cloud(t);
  const base = h.client();
  let lost = 0;
  const client = { ...base, requestUploads: async (...args) => { const value = await base.requestUploads(...args); if (!lost++) throw new MineruError('network', 'answer lost', { retryable: true }); return value; } };
  await h.run(await h.prepare(), { client });
  const batches = [...h.fake.batches.values()];
  assert.equal(batches.length, 2, 'MinerU accepted both creates');
  assert.equal(new Set(batches.map(batch => batch.files[0].data_id)).size, 1, 'the retry reuses the data id, the only thing that could identify it');
  assert.equal(batches.filter(batch => batch.files[0].data).length, 1, 'only the second batch got the bytes; the first is an orphan');
  assert.equal(count(h.fake, isStatus) > 0 && h.fake.requests.every(request => !['DELETE', 'PATCH'].includes(request.method)), true);
});

test('DEFECT BASELINE: a restart between create and upload does not reuse the saved batch: the piece asks for a new address', async t => {
  const h = await cloud(t);
  const controller = new AbortController(), base = h.client();
  const client = { ...base, upload: async () => { controller.abort(new Error('app closed')); throw new Error('stopped before the bytes went up'); } };
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared, { client, signal: controller.signal }), /app closed/);
  const saved = await readManifest(prepared.dir);
  assert.equal(saved.chunks[0].state, 'requested');
  assert.ok(saved.chunks[0].batchId);
  assert.equal(h.fake.batches.size, 1);
  await h.run({ dir: prepared.dir, manifest: saved }, { client: base });
  assert.equal(h.fake.batches.size, 2, 'a second create, not the saved batch');
  assert.equal([...h.fake.batches.values()].filter(batch => batch.files[0].data).length, 1);
  assert.equal(h.imports.length, 1);
});

test('a task MinerU no longer knows is created again once; that is the only automatic re-create', async t => {
  const h = await cloud(t);
  h.fake.inject(isStatus, { code: -60012, msg: 'task not found' }, { times: 1 });
  await h.runCloud(await h.prepare());
  assert.equal(h.fake.batches.size, 2);
  assert.equal(count(h.fake, isPost), 2);
  const lost = await cloud(t);
  lost.fake.inject(isStatus, { code: -60012, msg: 'task not found' }, { times: 2 });
  const prepared = await lost.prepare();
  await assert.rejects(lost.runCloud(prepared), error => error.code === 'task-not-found');
  assert.equal(count(lost.fake, isPost), 2, 'the second "not found" is not answered with a third create');
});
