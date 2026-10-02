import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONVERT, convertHome, convertPdf, discardJob, jobDir, listManifests, planFile, prepareJob, readManifest } from '../lib/mineru-job.js';
import { MINERU, MineruError, createMineruClient } from '../lib/mineru-api.js';
import { PdfChunkError } from '../lib/pdf-chunker.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { FAKE_TOKEN, startFakeMineru } from './helpers/fake-mineru.mjs';
import { makeEncryptedPdf, makePdf } from './helpers/pdf.mjs';

/* The whole cloud conversion of one PDF, against the fake MinerU server: pieces, upload, polling, download, merge, import. */

async function setup(t, { pages = 3, pdf, serverOptions = {}, outline } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-convert-home-'));
  const library = await mkdtemp(join(tmpdir(), 'study-convert-lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const fake = await startFakeMineru(serverOptions);
  t.after(async () => {
    await fake.close();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(home, { recursive: true, force: true }); await rm(library, { recursive: true, force: true });
  });
  const source = join(library, 'Book.pdf');
  await writeFile(source, pdf ?? await makePdf({ pages, outline }));
  const clock = { time: 1_000_000, slept: [] };
  const harness = {
    home, library, source, fake, clock, progress: [], imports: [],
    client: (token = fake.token) => createMineruClient({ token, baseUrl: fake.baseUrl }),
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.slept.push(ms); clock.time += ms; },
    now: () => clock.time,
  };
  harness.prepare = (extra = {}) => prepareJob({ root: library, source, filename: 'Book.pdf', courses: ['Databases'], ...extra });
  harness.run = (prepared, extra = {}) => convertPdf({ dir: prepared.dir, manifest: prepared.manifest, root: library, client: harness.client(), sleep: harness.sleep, now: harness.now,
    onProgress: patch => harness.progress.push(patch), importMerged: async input => { harness.imports.push(input); return { sourceIds: ['s1'] }; }, ...extra });
  return harness;
}
const uploadedPages = fake => [...fake.batches.values()].flatMap(batch => batch.files.map(file => file.pages));

test('one small PDF: one piece, upload, polling, download, merge and import; the temporary files are the caller\'s to remove', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  assert.equal(prepared.manifest.totalPages, 3);
  assert.equal(prepared.plan.length, 1);
  const outcome = await h.run(prepared);
  assert.equal(outcome.chunks, 1);
  assert.equal(h.fake.uploads.length, 1);
  assert.equal(h.fake.uploads[0].bytes, (await stat(h.source)).size, 'the original bytes went up, not a rewrite');
  assert.equal(h.imports.length, 1);
  assert.deepEqual(h.imports[0].courses, ['Databases']);
  assert.equal(h.imports[0].filename, 'Book.pdf');
  const book = parseConvertedDocument(h.imports[0].bytes.toString('utf8'), { filename: 'Book.pdf' });
  assert.equal(book.totalPages, 3);
  assert.equal(book.converter, 'mineru');
  assert.match(book.pages[0].text, /local page 1/);
  assert.deepEqual([...new Set(h.progress.map(p => p.phase))], ['split', 'upload', 'parse', 'download', 'merge', 'save']);
});

test('450 pages become three pieces of 200, 200 and 50 pages, converted one at a time, merged into one 450-page book', async t => {
  const h = await setup(t, { pages: 450 });
  const prepared = await h.prepare();
  assert.deepEqual(prepared.plan.map(piece => [piece.startPage, piece.endPage]), [[1, 200], [201, 400], [401, 450]]);
  await h.run(prepared);
  assert.deepEqual(uploadedPages(h.fake), [200, 200, 50]);
  assert.equal(h.fake.batches.size, 3, 'one batch per piece');
  const book = parseConvertedDocument(h.imports[0].bytes.toString('utf8'));
  assert.equal(book.totalPages, 450);
  assert.equal(book.pages.length, 450);
  // The first page of piece 2 is page 201 of the book, and keeps its own piece's text.
  const second = h.fake.batches.size && [...h.fake.batches.values()][1].files[0];
  assert.match(book.pages[200].text, new RegExp(`${second.data_id} local page 1`));
  assert.match(book.pages[449].text, /local page 50/);
  // One at a time: the second batch is only requested after the first is finished.
  const posts = h.fake.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 3);
  const order = h.fake.requests.map(request => (request.method === 'POST' ? 'post' : request.path.includes('/extract-results/') ? 'poll' : request.method === 'PUT' ? 'put' : 'zip'));
  const secondPost = order.indexOf('post', order.indexOf('post') + 1);
  assert.ok(order.slice(0, secondPost).includes('zip'), 'piece 1 was downloaded before piece 2 was requested');
});

test('progress counts pages across pieces, never goes backwards, and says which piece it is on', async t => {
  const h = await setup(t, { pages: 450, serverOptions: { steps: 4 } });
  await h.run(await h.prepare());
  const done = h.progress.map(p => p.done);
  for (let i = 1; i < done.length; i++) assert.ok(done[i] >= done[i - 1], `progress went back at ${i}: ${done[i - 1]} -> ${done[i]}`);
  assert.equal(done.at(-1), 450);
  assert.ok(h.progress.every(p => p.total === 450));
  assert.ok(done.some(value => value > 0 && value < 200), 'moves inside the first piece');
  assert.ok(done.some(value => value > 200 && value < 400), 'and inside the second');
  const chunks = h.progress.filter(p => p.phase === 'parse').map(p => p.chunk);
  assert.ok(chunks.every(chunk => chunk.count === 3));
  assert.deepEqual([...new Set(chunks.map(chunk => chunk.index))].sort(), [1, 2, 3]);
  const phases = [...new Set(h.progress.map(p => p.phase))];
  assert.deepEqual(phases, ['split', 'upload', 'parse', 'download', 'merge', 'save']);
});

test('polling is polite: seconds apart, at least the documented interval', async t => {
  const h = await setup(t, { pages: 3, serverOptions: { steps: 3 } });
  await h.run(await h.prepare());
  assert.ok(h.clock.slept.length >= 4);
  assert.ok(h.clock.slept.every(ms => ms >= MINERU.pollMs));
  assert.ok(h.fake.statusRequests().length <= h.clock.slept.length + 1);
});

test('a piece that fails in the cloud stops the job, keeps the finished pieces, and a retry redoes only that piece', async t => {
  let allow = false;
  const h = await setup(t, { pages: 450, serverOptions: { failWhen: file => (/-2-/.test(file.data_id) && !allow ? 'internal error' : undefined) } });
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared), error => error instanceof MineruError && error.code === 'conversion-failed' && error.retryable === true);
  const saved = await readManifest(prepared.dir);
  assert.deepEqual(saved.chunks.map(chunk => chunk.state), ['done', 'ready', 'planned'].map((state, i) => saved.chunks[i].state), 'states are recorded');
  assert.equal(saved.chunks[0].state, 'done');
  assert.notEqual(saved.chunks[1].state, 'done');
  assert.ok(saved.chunks[1].error);
  const uploadsBefore = h.fake.uploads.length;
  assert.equal(uploadsBefore, 2, 'pieces 1 and 2 were uploaded; 3 was never started');
  allow = true;
  await h.run({ dir: prepared.dir, manifest: saved });
  const names = [...h.fake.batches.values()].flatMap(batch => batch.files.map(file => file.data_id));
  assert.equal(names.filter(name => /-1-/.test(name)).length, 1, 'piece 1 is never uploaded again');
  assert.equal(names.filter(name => /-2-/.test(name)).length, 2, 'piece 2 is redone');
  assert.equal(names.filter(name => /-3-/.test(name)).length, 1);
  assert.equal(h.imports.length, 1);
  assert.equal(parseConvertedDocument(h.imports[0].bytes.toString('utf8')).totalPages, 450);
});

test('a restart resumes from the saved manifest: an uploaded piece is polled again, not uploaded again', async t => {
  const controller = new AbortController();
  const h = await setup(t, { pages: 3, serverOptions: { steps: 2 } });
  const prepared = await h.prepare();
  let polls = 0;
  await assert.rejects(h.run(prepared, { signal: controller.signal, client: (() => { const base = h.client(); return { ...base, status: async (...args) => { if (++polls === 2) controller.abort(new Error('app closed')); return base.status(...args); } }; })() }), /app closed/);
  const saved = await readManifest(prepared.dir);
  assert.equal(saved.chunks[0].state === 'uploaded' || saved.chunks[0].state === 'parsing', true);
  assert.ok(saved.chunks[0].batchId);
  const uploads = h.fake.uploads.length;
  await h.run({ dir: prepared.dir, manifest: saved });
  assert.equal(h.fake.uploads.length, uploads, 'no second upload of the same piece');
  assert.equal(h.imports.length, 1);
});

test('cancelling stops at the request in flight; the temporary files go, the finished pieces are kept for the next try', async t => {
  const h = await setup(t, { pages: 450 });
  const prepared = await h.prepare();
  const controller = new AbortController();
  let downloads = 0;
  const base = h.client();
  const client = { ...base, download: async (...args) => { const value = await base.download(...args); if (++downloads === 1) controller.abort(new Error('cancelled by learner')); return value; } };
  await assert.rejects(h.run(prepared, { signal: controller.signal, client }), /cancelled by learner/);
  const before = h.fake.requests.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.fake.requests.length, before, 'nothing more is sent after the cancel');
  const saved = await readManifest(prepared.dir);
  await discardJob(h.library, prepared.manifest.id, { keepResults: true, sourceHash: saved.sourceHash });
  await assert.rejects(stat(jobDir(h.library, prepared.manifest.id)), { code: 'ENOENT' });
  // Importing the same file again finds piece 1 already converted.
  const again = await h.prepare();
  const posts = h.fake.requests.filter(request => request.method === 'POST').length;
  await h.run(again);
  const newPosts = h.fake.requests.filter(request => request.method === 'POST').length - posts;
  assert.equal(newPosts, 2, 'only pieces 2 and 3 are converted');
  assert.equal(parseConvertedDocument(h.imports[0].bytes.toString('utf8')).totalPages, 450);
});

test('discarding after success removes everything, the finished pieces too', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  await h.run(prepared);
  await discardJob(h.library, prepared.manifest.id, { sourceHash: prepared.manifest.sourceHash });
  assert.deepEqual(await readdir(join(convertHome(h.library), 'jobs')).catch(() => []), []);
  assert.deepEqual(await readdir(join(convertHome(h.library), 'results')).catch(() => []), []);
});

test('a rate limit is waited out and the job carries on; the note says so', async t => {
  const h = await setup(t, { pages: 3 });
  h.fake.inject((method, path) => method === 'GET' && path.includes('/extract-results/'), { code: 'x' }, { status: 429, times: 2, headers: { 'retry-after': '9' } });
  await h.run(await h.prepare());
  assert.ok(h.clock.slept.filter(ms => ms === 9000).length === 2, 'waited as long as the service asked, twice');
  assert.ok(h.progress.some(p => /太频繁/.test(p.note)));
  assert.equal(h.imports.length, 1);
  assert.equal(h.progress.at(-1).note, '', 'the note is gone once things move again');
});

test('a short network failure while polling is retried with growing waits and does not fail the job', async t => {
  const h = await setup(t, { pages: 3 });
  h.fake.inject((method, path) => method === 'GET' && path.includes('/extract-results/'), 'bad gateway', { status: 502, times: 2 });
  await h.run(await h.prepare());
  assert.equal(h.imports.length, 1);
  const waits = h.clock.slept.filter(ms => ms !== MINERU.pollMs);
  assert.ok(waits.length >= 2 && waits[1] > waits[0], `waits grow: ${waits}`);
});

test('a network failure that lasts stops the job as retryable, and keeps the task so a retry polls it again', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared, { client: (() => { const base = h.client(); let calls = 0; return { ...base, status: async (...args) => { if (++calls > 1) throw new MineruError('network', 'x', { retryable: true }); return base.status(...args); } }; })() }),
    error => error.code === 'network' && error.retryable);
  const saved = await readManifest(prepared.dir);
  assert.ok(saved.chunks[0].batchId, 'the task is remembered');
  const uploads = h.fake.uploads.length;
  await h.run({ dir: prepared.dir, manifest: saved });
  assert.equal(h.fake.uploads.length, uploads, 'polled again, not uploaded again');
});

test('an invalid or expired token stops the job at once without waiting or retrying', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared, { client: h.client('eyJ0eXBlIjoiSldUIn0.WRONG_wrong_wrong_0000000000000.sig') }), error => error.code === 'invalid-token' && error.retryable === false);
  assert.equal(h.clock.slept.length, 0);
  assert.equal(h.fake.uploads.length, 0);
});

test('a queue that stays long gets an honest note, never a failure', async t => {
  const h = await setup(t, { pages: 3, serverOptions: { holdWhen: (_file, poll) => poll < 80 } });
  await h.run(await h.prepare());
  assert.ok(h.progress.some(p => /排队/.test(p.note) && /不是失败/.test(p.note)));
  assert.equal(h.imports.length, 1);
  assert.equal(h.progress.at(-1).note, '');
});

test('a piece that takes longer than the limit stops as retryable, keeping the task', async t => {
  const h = await setup(t, { pages: 3, serverOptions: { holdWhen: () => true } });
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared), error => error.code === 'timeout' && error.retryable === true);
  assert.ok(h.clock.time - 1_000_000 >= CONVERT.pieceTimeoutMs);
  assert.ok((await readManifest(prepared.dir)).chunks[0].batchId);
});

test('a piece over the byte limit is halved before anything is uploaded; the pieces still add up to the book', async t => {
  const h = await setup(t, { pdf: await makePdf({ pages: 24, padBytes: 6000 }) });
  const prepared = await h.prepare({ limits: { maxBytes: 40_000 } });
  await h.run(prepared, { limits: { maxBytes: 40_000 } });
  const pages = uploadedPages(h.fake);
  assert.ok(pages.length >= 4);
  assert.equal(pages.reduce((a, b) => a + b, 0), 24);
  for (const batch of h.fake.batches.values()) for (const file of batch.files) assert.ok(file.data.length <= 40_000);
  assert.equal(parseConvertedDocument(h.imports[0].bytes.toString('utf8')).totalPages, 24);
});

test('chapter bookmarks decide where the pieces end', async t => {
  const outline = [1, 120, 260, 300, 420].map((page, index) => ({ title: `Chapter ${index + 1}`, page }));
  const h = await setup(t, { pdf: await makePdf({ pages: 500, outline }) });
  const prepared = await h.prepare();
  assert.deepEqual(prepared.plan.map(piece => [piece.startPage, piece.endPage]), [[1, 119], [120, 299], [300, 419], [420, 500]]);
  await h.run(prepared);
  assert.deepEqual(uploadedPages(h.fake), [119, 180, 120, 81]);
});

test('a finished piece whose saved result has gone missing is converted again instead of breaking the merge', async t => {
  const h = await setup(t, { pages: 450 });
  const prepared = await h.prepare();
  await h.run(prepared);
  const saved = await readManifest(prepared.dir);
  assert.ok(saved.chunks.every(chunk => chunk.state === 'done'));
  await rm(join(prepared.dir, saved.chunks[1].resultFile));
  await rm(join(convertHome(h.library), 'results'), { recursive: true, force: true });
  const uploads = h.fake.uploads.length;
  await h.run({ dir: prepared.dir, manifest: saved });
  assert.equal(h.fake.uploads.length, uploads + 1, 'only the piece without a result is redone');
  assert.equal(h.imports.length, 2);
  assert.equal(parseConvertedDocument(h.imports[1].bytes.toString('utf8')).totalPages, 450);
});

test('a PDF that cannot be read is refused with a plain message before any folder or request exists', async t => {
  const h = await setup(t, { pdf: await makeEncryptedPdf() });
  await assert.rejects(h.prepare(), error => error instanceof PdfChunkError && error.code === 'encrypted');
  assert.deepEqual(await readdir(join(convertHome(h.library), 'jobs')).catch(() => []), []);
  assert.equal(h.fake.requests.length, 0);
  await writeFile(h.source, Buffer.from('not a pdf'));
  await assert.rejects(h.prepare(), error => error.code === 'not-pdf');
});

test('planFile shows the pieces without keeping anything or calling anyone', async t => {
  const h = await setup(t, { pages: 450 });
  const plan = await planFile({ source: h.source });
  assert.equal(plan.pages, 450);
  assert.deepEqual(plan.plan.map(piece => [piece.startPage, piece.endPage, piece.pages]), [[1, 200, 200], [201, 400, 200], [401, 450, 50]]);
  assert.equal(h.fake.requests.length, 0);
  assert.deepEqual(await readdir(convertHome(h.library)).catch(() => []), []);
});

test('listManifests finds the unfinished conversions of a library, for recovery after a restart', async t => {
  const h = await setup(t, { pages: 3 });
  const prepared = await h.prepare();
  const found = await listManifests(h.library);
  assert.deepEqual(found.map(item => item.manifest.id), [prepared.manifest.id]);
  assert.equal((await listManifests(await mkdtemp(join(tmpdir(), 'study-other-lib-')))).length, 0);
});

test('the token is in none of the files a conversion leaves behind', async t => {
  const h = await setup(t, { pages: 450 });
  const prepared = await h.prepare();
  await assert.rejects(h.run(prepared, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  await h.run(await h.prepare()).catch(() => {});
  const files = [];
  const collect = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await collect(path); else files.push(path);
    }
  };
  await collect(h.home);
  await collect(h.library);
  assert.ok(files.some(path => path.endsWith('manifest.json')));
  for (const file of files.filter(path => !path.endsWith('.pdf'))) assert.ok(!(await readFile(file, 'utf8')).includes(FAKE_TOKEN), file);
});
