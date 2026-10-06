import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_TEXT, readManifest, saveManifest } from '../lib/mineru-job.js';
import { MineruError, createMineruClient } from '../lib/mineru-api.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { pdfJob } from './helpers/nonmodel-baseline.mjs';

/* S5-2, D-1 and D-2 of the S5-0 baseline: a create whose outcome is unknown is not sent again by the job's own retries, and a piece that was created but
   not (known to be) uploaded is checked against the saved batch before anything is created. Only with `verifyCreates` (the runtime job); the original
   path keeps the behaviour the baseline tests (nonmodel-baseline-cloud) pin. MinerU can only be asked about a batch id, never about a data id. */

const isPost = (method, path) => method === 'POST' && path === '/api/v4/file-urls/batch';
const isPut = (method, path) => method === 'PUT' && path.startsWith('/upload/');
const isStatus = (method, path) => method === 'GET' && path.includes('/extract-results/');
const count = (fake, match) => fake.requests.filter(request => match(request.method, request.path)).length;

async function cloud(t) {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const job = await pdfJob(t, {});
  const client = () => createMineruClient({ token: fake.token, baseUrl: fake.baseUrl });
  return Object.assign(job, { fake, client, again: async prepared => ({ dir: prepared.dir, manifest: await readManifest(prepared.dir) }) });
}

test('a create whose answer is lost is not sent again by the job: it stops with a reason, and a resume (the learner\'s choice) creates once more and says what may be left behind', async t => {
  const h = await cloud(t), base = h.client();
  let lost = 0;
  const client = { ...base, requestUploads: async (...args) => { const value = await base.requestUploads(...args); if (!lost++) throw new MineruError('network', 'answer lost', { retryable: true }); return value; } };
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared, { client, verifyCreates: true }), error => error.code === 'create-unknown' && error.retryable && error.message === JOB_TEXT.createUnknown);
  assert.equal(count(h.fake, isPost), 1, 'no second create in the same run');
  const saved = await readManifest(prepared.dir);
  assert.deepEqual([saved.chunks[0].state, saved.chunks[0].batchId], ['creating', undefined], 'the intent is on disk before the request, and no batch is claimed');
  const resumed = await h.run(await h.again(prepared), { client: base, verifyCreates: true });
  assert.equal(count(h.fake, isPost), 2); assert.equal(count(h.fake, isPut), 1);
  assert.equal(h.imports.length, 1);
  assert.ok(resumed.notes.includes(JOB_TEXT.orphanBatch), 'the learner is told what may be left behind');
});

test('a create that failed for a reason MinerU answered (busy, down) is still retried by the job; only an answer that never came is not', async t => {
  const h = await cloud(t);
  h.fake.inject(isPost, 'bad gateway', { status: 502, times: 1 });
  await h.run(await h.prepare(), { client: h.client(), verifyCreates: true });
  assert.equal(count(h.fake, isPost), 2, 'the 502 was an answer: nothing was created, so it is created again');
  assert.equal(h.imports.length, 1);
});

test('a piece created but not marked uploaded: the saved batch is asked first; when the bytes did land it is polled, with no new create and no new upload', async t => {
  const h = await cloud(t), client = h.client();
  const prepared = await h.prepare();
  // The state a crash between the PUT and the manifest write leaves: requested, with a batch that has its bytes.
  const split = await h.run(prepared, { client: { ...client, requestUploads: async () => { throw new Error('stop after split'); } } }).catch(() => null);
  assert.equal(split, null);
  const saved = await readManifest(prepared.dir), chunk = saved.chunks[0];
  const { batchId, urls } = await client.requestUploads([{ name: 'a.pdf', dataId: 'sh-manual' }]);
  await client.upload(urls[0], Buffer.from(await (await import('node:fs/promises')).readFile(`${prepared.dir}/${chunk.file}`)));
  Object.assign(chunk, { state: 'requested', batchId, dataId: 'sh-manual' });
  await saveManifest(prepared.dir, saved);
  const posts = count(h.fake, isPost), puts = count(h.fake, isPut);
  await h.run(await h.again(prepared), { client, verifyCreates: true });
  assert.equal(count(h.fake, isPost), posts, 'no new batch');
  assert.equal(count(h.fake, isPut), puts, 'no second upload');
  assert.ok(count(h.fake, isStatus) >= 2, 'the saved batch was asked about (then polled)');
  assert.equal(h.imports.length, 1);
});

test('a piece created but the bytes never went up: the saved batch says so, and only then is a new one created; a batch MinerU no longer knows counts the same', async t => {
  for (const unknown of [false, true]) {
    const h = await cloud(t), client = h.client(), controller = new AbortController();
    const prepared = await h.prepare();
    await assert.rejects(h.run(prepared, { client: { ...client, upload: async () => { controller.abort(new Error('app closed')); throw new Error('stopped'); } }, signal: controller.signal, verifyCreates: true }), /app closed/);
    const saved = await readManifest(prepared.dir);
    assert.equal(saved.chunks[0].state, 'requested'); assert.ok(saved.chunks[0].batchId);
    if (unknown) h.fake.inject(isStatus, { code: -60012, msg: 'task not found' }, { times: 1 });
    await h.run({ dir: prepared.dir, manifest: saved }, { client, verifyCreates: true });
    assert.equal(count(h.fake, isPost), 2, 'the old batch had nothing: one new create');
    assert.equal(h.imports.length, 1);
  }
});

test('a saved batch that cannot be asked about is not guessed at: the piece stops with the reason, creates and uploads nothing, and stays resumable', async t => {
  const h = await cloud(t), client = h.client(), controller = new AbortController();
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared, { client: { ...client, upload: async () => { controller.abort(new Error('app closed')); throw new Error('stopped'); } }, signal: controller.signal, verifyCreates: true }), /app closed/);
  const saved = await readManifest(prepared.dir);
  h.fake.inject(isStatus, 'bad gateway', { status: 502, times: 20 });
  const posts = count(h.fake, isPost);
  await assert.rejects(h.run({ dir: prepared.dir, manifest: saved }, { client, verifyCreates: true }), error => error.code === 'create-unverified' && error.retryable && error.message === JOB_TEXT.cannotVerify);
  assert.equal(count(h.fake, isPost), posts, 'no create without knowing what the saved batch holds');
  assert.equal(count(h.fake, isPut), 0);
  assert.equal((await readManifest(prepared.dir)).chunks[0].batchId, saved.chunks[0].batchId, 'the reference is kept');
});

test('without verifyCreates the job behaves as it always did: a lost answer is sent again and a requested piece asks for a new address', async t => {
  const h = await cloud(t), base = h.client();
  let lost = 0;
  const client = { ...base, requestUploads: async (...args) => { const value = await base.requestUploads(...args); if (!lost++) throw new MineruError('network', 'answer lost', { retryable: true }); return value; } };
  await h.run(await h.prepare(), { client });
  assert.equal(count(h.fake, isPost), 2);
});
