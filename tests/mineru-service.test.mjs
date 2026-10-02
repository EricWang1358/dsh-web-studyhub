import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { convertHome, convertPdf, prepareJob } from '../lib/mineru-job.js';
import { createMineruClient } from '../lib/mineru-api.js';
import { NO_MINERU_ACK, NO_MINERU_TOKEN } from '../lib/mineru-settings.js';
import { FAKE_TOKEN, startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* Cloud PDF conversion through the real service: the mineru.* operations, the shared job list, the inbox, the document import. */

const han = /[㐀-鿿]/;
async function harness(t, { serverOptions = {}, contexts, mineru = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-mineru-service-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-mineru-service-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY;
  const fake = await startFakeMineru(serverOptions);
  const clock = { time: 5_000_000 };
  const options = { mineru: { baseUrl: fake.baseUrl, sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); }, now: () => clock.time, ...mineru } };
  const open = () => new StudyService(root, { ...options, ...(contexts ? { contexts } : {}) });
  let service = open();
  const h = {
    home, root, fake, clock,
    get service() { return service; },
    restart() { service.dispose(); service = open(); return service; },
    call: (action, args) => service.call(action, args),
    configure: async () => { await service.call('mineru.settings.set', { token: fake.token, acknowledge: true }); },
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert'),
    until: async (condition, what = 'condition') => {
      for (let i = 0; i < 1500; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error(`Timed out waiting for ${what}`);
    },
    upload: async (bytes, name = 'Book.pdf') => {
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes)
        await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
  };
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  return h;
}
async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path)); else found.push(path);
  }
  return found;
}

test('nothing is uploaded or called until a token is set and the privacy note is confirmed', async t => {
  const h = await harness(t);
  const bytes = await makePdf({ pages: 3 });
  const uploadId = await h.upload(bytes);
  await assert.rejects(h.call('mineru.import', { uploadId }), error => error.message === NO_MINERU_TOKEN);
  await h.call('mineru.settings.set', { token: h.fake.token });
  await assert.rejects(h.call('mineru.import', { uploadId }), error => error.message === NO_MINERU_ACK);
  assert.equal(h.fake.requests.length, 0, 'MinerU was not contacted');
  assert.deepEqual(await h.jobs(), []);
  // The upload was not consumed by the refusals: confirming makes the same one work.
  await h.call('mineru.settings.set', { acknowledge: true });
  const started = await h.call('mineru.import', { uploadId });
  assert.ok(started.jobId);
});

test('the token settings: saved, tested, shown only as its last four characters', async t => {
  const h = await harness(t);
  let view = await h.call('mineru.settings.get');
  assert.deepEqual([view.token.set, view.acknowledged], [false, false]);
  assert.equal((await h.call('mineru.test')).state, 'missing');
  view = await h.call('mineru.settings.set', { token: h.fake.token });
  assert.equal(view.token.hint, `••••${FAKE_TOKEN.slice(-4)}`);
  assert.ok(!JSON.stringify(view).includes(FAKE_TOKEN));
  const ok = await h.call('mineru.test');
  assert.deepEqual([ok.ok, ok.state], [true, 'valid']);
  assert.equal(h.fake.batches.size, 0, 'the check creates and uploads nothing');
  await h.call('mineru.settings.set', { token: 'eyJ0eXBlIjoiSldUIn0.WRONG_wrong_wrong_0000000000000.sig' });
  assert.equal((await h.call('mineru.test')).state, 'invalid');
  const en = await h.call('mineru.test', { uiLanguage: 'en' });
  assert.doesNotMatch(en.message, han);
  assert.equal((await h.call('mineru.settings.set', { token: '' })).token.set, false);
});

test('an unreachable MinerU is reported as unreachable, an expired token as expired', async t => {
  const h = await harness(t, { mineru: { baseUrl: 'http://127.0.0.1:9/api/v4' } });
  await h.call('mineru.settings.set', { token: FAKE_TOKEN });
  assert.equal((await h.call('mineru.test')).state, 'unreachable');
  const e = await harness(t, { serverOptions: { expired: true } });
  await e.call('mineru.settings.set', { token: 'eyJ0eXBlIjoiSldUIn0.WRONG_wrong_wrong_0000000000000.sig' });
  assert.equal((await e.call('mineru.test')).state, 'expired');
});

test('the plan says how many pieces a book makes, without sending or keeping anything', async t => {
  const h = await harness(t);
  const uploadId = await h.upload(await makePdf({ pages: 450 }));
  const plan = await h.call('mineru.plan', { uploadId });
  assert.equal(plan.pages, 450);
  assert.deepEqual(plan.pieces.map(piece => [piece.startPage, piece.endPage]), [[1, 200], [201, 400], [401, 450]]);
  assert.deepEqual([plan.tokenSet, plan.acknowledged], [false, false]);
  assert.equal(h.fake.requests.length, 0);
  assert.deepEqual(await h.jobs(), []);
  await assert.rejects(h.call('mineru.plan', { uploadId: 'does-not-exist' }), /上传|失效|uploads?/i);
});

test('a 450-page PDF is converted in three pieces as one job, saved as one 450-page converted document, and every temporary file is gone', async t => {
  const h = await harness(t, { serverOptions: { steps: 3 } });
  await h.configure();
  await h.call('course.save', { name: 'Databases' }).catch(() => {});
  const uploadId = await h.upload(await makePdf({ pages: 450 }));
  const started = await h.call('mineru.import', { uploadId, courses: ['Databases'] });
  assert.equal(started.chunks.length, 3);
  assert.equal(started.pages, 450);
  const seen = [];
  const finished = await h.until(async () => {
    const [job] = await h.jobs();
    if (job) seen.push({ done: job.done, phase: job.phase, chunk: job.chunk?.index, count: job.chunk?.count, status: job.status, stage: job.stage });
    return job?.status === 'complete' ? job : null;
  }, 'the conversion to finish');
  await h.call('job.wait', { jobId: finished.id, timeoutSeconds: 10 }); // the inbox letter is the last bookkeeping
  assert.equal(finished.type, 'pdf-convert');
  assert.equal(finished.total, 450);
  assert.equal(finished.done, 450);
  assert.equal(finished.sourceIds.length, 450);
  const dones = seen.map(entry => entry.done);
  for (let i = 1; i < dones.length; i++) assert.ok(dones[i] >= dones[i - 1], 'progress never goes back');
  assert.ok(seen.some(entry => entry.phase === 'parse' && entry.count === 3 && entry.chunk >= 1));
  assert.ok(seen.every(entry => !entry.stage || !entry.stage.includes(FAKE_TOKEN)));

  const state = await h.call('snapshot');
  const sources = state.sources.filter(source => source.document?.converter === 'mineru');
  assert.equal(sources.length, 450);
  assert.equal(sources[0].document.totalPages, 450);
  assert.deepEqual(sources[0].courses, ['Databases']);
  assert.equal(new Set(sources.map(source => source.document.materialId)).size, 1, 'one document');
  const letters = state.inbox.items.filter(item => item.kind === 'pdf-result');
  assert.equal(letters.length, 1);
  assert.equal(letters[0].label, 'PDF 转换完成');
  assert.equal(letters[0].deckTitle, 'PDF 转换');
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'jobs')), []);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'results')), []);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'uploads')), []);
});

test('the token is in no snapshot, no export and no file of the library', async t => {
  const h = await harness(t);
  await h.configure();
  const uploadId = await h.upload(await makePdf({ pages: 3 }));
  await h.call('mineru.import', { uploadId });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the conversion');
  const snapshot = JSON.stringify(await h.call('snapshot'));
  assert.ok(!snapshot.includes(FAKE_TOKEN));
  const exported = JSON.stringify(await h.call('export', {}).catch(() => ({})));
  assert.ok(!exported.includes(FAKE_TOKEN));
  for (const file of await filesUnder(h.root)) assert.ok(!(await readFile(file)).includes(FAKE_TOKEN), file);
  assert.ok((await readFile(join(h.home, 'study', 'mineru.json'), 'utf8')).includes(FAKE_TOKEN), 'only the DSH home file holds it');
  // The same text appears in no request body either: only the Authorization header carries it.
  assert.ok(h.fake.requests.every(request => !(request.body || '').includes(FAKE_TOKEN)));
});

test('a piece that fails in the cloud: the job fails with a plain reason, keeps what finished, and "接着做" redoes only that piece', async t => {
  let healthy = false;
  const h = await harness(t, { serverOptions: { failWhen: file => (/-2-/.test(file.data_id) && !healthy ? 'internal error' : undefined) } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 450 })) });
  const failed = await h.until(async () => { const [job] = await h.jobs(); return job?.status === 'failed' ? job : null; }, 'the failure');
  await h.call('job.wait', { jobId: failed.id, timeoutSeconds: 10 });
  assert.equal(failed.retryable, true);
  assert.match(failed.stage, /MinerU/);
  assert.equal(failed.done >= 200, true, 'the finished piece still counts');
  assert.equal(failed.chunks[0].state, 'done');
  let state = await h.call('snapshot');
  assert.equal(state.inbox.items.filter(item => item.kind === 'pdf-failed').length, 1);
  healthy = true;
  const uploadsBefore = h.fake.uploads.length;
  await h.call('mineru.retry', { jobId: failed.id });
  const done = await h.until(async () => { const [job] = await h.jobs(); return job?.status === 'complete' ? job : null; }, 'the retry');
  await h.call('job.wait', { jobId: done.id, timeoutSeconds: 10 });
  assert.equal(done.id, failed.id);
  assert.equal(h.fake.uploads.length - uploadsBefore, 2, 'pieces 2 and 3 were uploaded; piece 1 was not');
  state = await h.call('snapshot');
  assert.equal(state.inbox.items.filter(item => item.kind === 'pdf-failed').length, 0, 'the letter about the failure is withdrawn');
  assert.equal(state.inbox.items.filter(item => item.kind === 'pdf-result').length, 1);
  assert.equal(state.sources.filter(source => source.document?.converter === 'mineru').length, 450);
});

test('cancel stops at once, sends nothing more, cleans the temporary files and leaves no inbox letter', async t => {
  const h = await harness(t, { serverOptions: { holdWhen: () => true } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 450 })) });
  const running = await h.until(async () => { const [job] = await h.jobs(); return job?.phase === 'parse' ? job : null; }, 'the first piece to be parsed');
  const cancelled = await h.call('job.cancel', { jobId: running.id });
  assert.equal(cancelled.jobs[0].status, 'cancelling');
  const after = await h.until(async () => { const [job] = await h.jobs(); return job?.status === 'cancelled' ? job : null; }, 'the cancel');
  assert.match(after.stage, /已取消/);
  const requests = h.fake.requests.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.fake.requests.length, requests, 'nothing is sent after the cancel');
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'jobs')), []);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'uploads')), []);
  const state = await h.call('snapshot');
  assert.equal(state.inbox.items.filter(item => item.kind.startsWith('pdf-')).length, 0);
  assert.equal(state.sources.filter(source => source.document?.converter === 'mineru').length, 0);
  const english = (await h.call('snapshot', { uiLanguage: 'en' })).jobs.find(job => job.id === running.id);
  assert.doesNotMatch(english.stage, han);
  await h.call('job.dismiss', { jobId: running.id });
  assert.deepEqual(await h.jobs(), []);
});

test('the learner can follow it in English: stages and notes have no Chinese while it runs', async t => {
  const h = await harness(t, { serverOptions: { holdWhen: (_file, poll) => poll < 70 } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  const texts = new Set();
  await h.until(async () => {
    const job = (await h.call('snapshot', { uiLanguage: 'en' })).jobs.find(entry => entry.type === 'pdf-convert');
    if (job) { texts.add(job.stage); if (job.note) texts.add(job.note); }
    return job?.status === 'complete';
  }, 'the conversion');
  assert.ok([...texts].length >= 2);
  for (const text of texts) assert.doesNotMatch(text, han, text);
  assert.ok([...texts].some(text => /queuing/.test(text)), 'the honest slowdown note was shown');
});

test('a conversion a crash interrupted comes back as a retryable job, and finishing it reuses what was converted', async t => {
  const h = await harness(t);
  await h.configure();
  // A first run that stops after piece 1 (as if the app died), leaving its manifest and finished piece behind.
  const source = join(h.root, 'Book.pdf');
  await writeFile(source, await makePdf({ pages: 450 }));
  const prepared = await prepareJob({ root: h.root, source, filename: 'Book.pdf', courses: [] });
  const controller = new AbortController();
  const base = createMineruClient({ token: h.fake.token, baseUrl: h.fake.baseUrl });
  const client = { ...base, requestUploads: async (...args) => { if (h.fake.batches.size >= 1) controller.abort(new Error('crash')); return base.requestUploads(...args); } };
  await assert.rejects(convertPdf({ dir: prepared.dir, manifest: prepared.manifest, root: h.root, client, signal: controller.signal, sleep: async () => {}, importMerged: async () => ({}) }), /crash/);
  const [job] = await h.jobs();
  assert.equal(job.status, 'failed');
  assert.equal(job.retryable, true);
  assert.equal(job.done, 200);
  assert.match(job.stage, /中断/);
  const uploadsBefore = h.fake.uploads.length;
  await h.call('mineru.retry', { jobId: job.id });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the resumed conversion');
  assert.equal(h.fake.uploads.length - uploadsBefore, 2);
  assert.equal((await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru').length, 450);
});

test('the same book cannot be converted twice at once', async t => {
  const h = await harness(t, { serverOptions: { holdWhen: () => true } });
  await h.configure();
  const bytes = await makePdf({ pages: 3 });
  await h.call('mineru.import', { uploadId: await h.upload(bytes) });
  await assert.rejects(h.call('mineru.import', { uploadId: await h.upload(bytes, 'Copy.pdf') }), /已经在转换/);
});

test('a PDF that cannot be read is refused in plain words and no upload is started', async t => {
  const h = await harness(t);
  await h.configure();
  const uploadId = await h.upload(Buffer.from('this is not a pdf at all'));
  await assert.rejects(h.call('mineru.import', { uploadId }), error => /PDF/.test(error.message));
  assert.equal(h.fake.requests.length, 0);
  assert.deepEqual(await h.jobs(), []);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'jobs')), []);
});

test('without the materials component there is nowhere to save the result, so nothing is uploaded', async t => {
  const h = await harness(t, { contexts: ['audio'] });
  await h.configure();
  const uploadId = await h.upload(await makePdf({ pages: 3 }));
  await assert.rejects(h.call('mineru.import', { uploadId }), /资料组件/);
  assert.equal(h.fake.requests.length, 0);
});

test('PDF uploads wait in the DSH home, never in the study library, and only PDFs are accepted', async t => {
  const h = await harness(t);
  const bytes = await makePdf({ pages: 3 });
  const { uploadId } = await h.service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
  assert.deepEqual(await filesUnder(join(h.root, 'audio-uploads')), []);
  assert.equal((await filesUnder(join(convertHome(h.root), 'uploads'))).length, 1);
  assert.ok((await h.service.call('mineru.upload.cancel', { uploadId })).cancelled);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'uploads')), []);
  await assert.rejects(h.service.call('mineru.upload.start', { name: 'song.mp3', size: 10 }), /PDF/);
  await assert.rejects(h.service.call('mineru.upload.start', { name: 'huge.pdf', size: 900 * 1024 * 1024 }), /800 MB/);
  void stat;
});
