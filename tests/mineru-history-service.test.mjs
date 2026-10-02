import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { prepareJob } from '../lib/mineru-job.js';
import { HISTORY, closeRecord, historyDir, listRecords, openRecord } from '../lib/mineru-history.js';
import { FAKE_TOKEN, startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* The conversion history through the real service: a record per conversion (cloud and local), kept while it runs and after it ends,
   resumed from the history, deleted without touching the imported documents. The cloud is the fake MinerU server, the local mineru a fake CLI. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const han = /[㐀-鿿]/;

async function harness(t, { serverOptions = {}, cliState = {}, pages = 120, cloud = true, contexts } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-hist-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-hist-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-hist-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: pages, modelsReady: true, ...cliState })); await writeFile(logPath, '');
  const cli = { file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } };
  const fake = cloud ? await startFakeMineru(serverOptions) : null;
  const clock = { time: 5_000_000 };
  const options = { mineru: { ...(fake ? { baseUrl: fake.baseUrl } : {}), now: () => clock.time,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); },
    local: { cli, home: work, modelsCli: { file: process.execPath, prefix: [FAKE], env: cli.env } } } };
  const open = () => new StudyService(root, { ...options, ...(contexts ? { contexts } : {}) });
  let service = open();
  const h = {
    home, root, fake, work,
    get service() { return service; },
    restart() { service.dispose(); service = open(); return service; },
    call: (action, args) => service.call(action, args),
    configure: () => service.call('mineru.settings.set', { token: fake.token, acknowledge: true }),
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert'),
    history: async (args = {}) => service.call('mineru.history.list', args),
    until: async (condition, what) => { for (let i = 0; i < 1500; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Timed out waiting for ${what}`); },
    upload: async (bytes, name = 'Book.pdf') => {
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
    finished: async (status = 'complete') => { const job = await h.until(async () => { const [entry] = await h.jobs(); return entry?.status === status ? entry : null; }, `a ${status} conversion`); await service.call('job.wait', { jobId: job.id, timeoutSeconds: 10 }); return job; },
  };
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    service.dispose(); await fake?.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
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

test('before any conversion the history is empty, and it works with neither route set up', async t => {
  const h = await harness(t, { cloud: false });
  const view = await h.history();
  assert.deepEqual(view.records, []);
  assert.deepEqual([view.keepLatest, view.keepDays], [50, 90]);
  assert.equal((await h.call('mineru.settings.get')).token.set, false);
});

test('a cloud conversion is on record while it runs, and complete only once the document is really imported', async t => {
  let release = false;
  const h = await harness(t, { serverOptions: { holdWhen: () => !release } });
  await h.configure();
  const bytes = await makePdf({ pages: 3 });
  const started = await h.call('mineru.import', { uploadId: await h.upload(bytes, 'Databases.pdf'), courses: ['Databases'] });
  const [running] = (await h.history()).records;
  assert.equal(running.id, started.jobId, 'the record is the job: one id');
  assert.deepEqual([running.status, running.route, running.filename, running.pages, running.pieces, running.bytes], ['running', 'cloud', 'Databases.pdf', 3, 1, bytes.length]);
  assert.equal(running.canRetry, false);
  assert.equal(running.live, true, 'a running row links to its live card');
  assert.equal(running.document, undefined, 'nothing is imported yet');
  await h.until(async () => (await h.history()).records[0].phase === 'parse', 'the parse phase to be recorded');
  release = true;
  await h.finished();
  const [done] = (await h.history()).records;
  assert.equal(done.status, 'complete');
  assert.equal(done.id, started.jobId);
  assert.equal(done.importedPages, 3);
  assert.equal(done.pagesDone, 3);
  assert.ok(done.documentId);
  assert.ok(Date.parse(done.finishedAt) >= Date.parse(done.startedAt));
  assert.equal(typeof done.elapsedMs, 'number');
  assert.ok(done.elapsedMs >= 0);
  assert.equal(done.document.exists, true);
  assert.equal(done.document.pages, 3, 'how many pages the library holds of it');
  assert.equal(done.document.sourceIds.length, 1, 'one page id is enough to open the document');
  assert.ok(done.document.title);
  assert.equal(done.live, false);
  const sources = (await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru');
  assert.ok(sources.some(source => source.id === done.document.sourceIds[0]), 'and it is one of the imported pages');
});

test('a local conversion is recorded with its tier and pieces (page windows)', async t => {
  const h = await harness(t, { cloud: false, pages: 120 });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  await h.finished();
  const [record] = (await h.history()).records;
  assert.deepEqual([record.status, record.route, record.tier, record.pages, record.pieces, record.importedPages], ['complete', 'local', 'basic', 120, 3, 120]);
});

test('the record, the exported library and every file of the library hold no token, no document text and no temporary path', async t => {
  const h = await harness(t);
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  await h.finished();
  const files = await readdir(historyDir(h.root));
  assert.equal(files.length, 1);
  const raw = await readFile(join(historyDir(h.root), files[0]), 'utf8');
  for (const forbidden of [FAKE_TOKEN, h.home, 'tmp', 'pdf-convert', 'source.pdf', 'local page 1', 'Authorization', 'Bearer']) assert.ok(!raw.includes(forbidden), `the record holds ${forbidden}`);
  const allowed = ['attemptStartedAt', 'attempts', 'bytes', 'documentId', 'elapsedMs', 'failure', 'filename', 'finishedAt', 'id', 'importedPages', 'pages', 'pagesDone', 'phase', 'piece', 'pieces', 'route', 'skippedPages', 'startedAt', 'status', 'tier', 'title', 'updatedAt', 'version'];
  assert.deepEqual(Object.keys(JSON.parse(raw)).filter(key => !allowed.includes(key)), [], 'only the whitelisted facts are stored');
  const exported = JSON.stringify(await h.call('export', {}));
  assert.ok(!exported.includes(FAKE_TOKEN) && !exported.includes(h.home));
  assert.ok(!exported.includes('conversion-history'), 'the history is a job record: it is not part of the library export');
  const listed = JSON.stringify(await h.history());
  assert.ok(!listed.includes(FAKE_TOKEN) && !listed.includes(h.home));
  for (const file of await filesUnder(h.root)) {
    const bytes = await readFile(file).catch(() => Buffer.alloc(0));
    assert.ok(!bytes.includes(FAKE_TOKEN), file);
  }
});

test('the history is not in the snapshot the panel polls, so keeping it never slows the app', async t => {
  const h = await harness(t);
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  await h.finished();
  assert.equal(JSON.stringify(await h.call('snapshot')).includes('conversion-history'), false);
  assert.equal('conversions' in (await h.call('snapshot')), false);
});

test('a piece that fails: the record says failed, at which stage, why; "接着做" from the history redoes only that piece and is the same record', async t => {
  let healthy = false;
  const h = await harness(t, { serverOptions: { failWhen: file => (/-2-/.test(file.data_id) && !healthy ? 'internal error' : undefined) } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 450 }), 'Big.pdf') });
  const failed = await h.finished('failed');
  const [row] = (await h.history()).records;
  assert.equal(row.status, 'failed');
  assert.equal(row.id, failed.id);
  assert.equal(row.failure.stage, 'parse');
  assert.equal(row.failure.piece, 2);
  assert.match(row.failure.reason, /MinerU/);
  assert.ok(row.pagesDone >= 200, 'the finished piece still counts');
  assert.equal(row.canRetry, true);
  assert.equal(row.document, undefined, 'a failed conversion imported nothing');
  const uploadsBefore = h.fake.uploads.length;
  healthy = true;
  await h.call('mineru.retry', { jobId: row.id });
  assert.ok(['running', 'complete'].includes((await h.history()).records[0].status), 'the new attempt is on record as soon as it starts');
  await h.finished();
  const after = (await h.history()).records;
  assert.equal(after.length, 1, 'a retry is the same row');
  assert.equal(after[0].status, 'complete');
  assert.equal(after[0].attempts, 2);
  assert.equal(after[0].failure, undefined);
  assert.equal(after[0].importedPages, 450);
  assert.equal(h.fake.uploads.length - uploadsBefore >= 1, true);
  assert.ok(after[0].elapsedMs >= 0);
});

test('a conversion whose import step fails is failed at the save stage, never complete', async t => {
  const h = await harness(t, { serverOptions: { contentList: file => Array.from({ length: file.pages }, (_, index) => ({ type: 'image', img_path: `images/page-${index + 1}.jpg`, page_idx: index })) } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  await h.finished('failed');
  const [row] = (await h.history()).records;
  assert.equal(row.status, 'failed');
  assert.ok(['save', 'merge'].includes(row.failure.stage), row.failure.stage);
  assert.equal(row.documentId, undefined);
  assert.equal(row.importedPages, undefined);
  assert.equal((await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru').length, 0);
});

test('a cancelled conversion is recorded as cancelled, with no retry offered', async t => {
  const h = await harness(t, { serverOptions: { holdWhen: () => true } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 450 })) });
  const running = await h.until(async () => { const [job] = await h.jobs(); return job?.phase === 'parse' ? job : null; }, 'the first piece to be parsed');
  await h.call('job.cancel', { jobId: running.id });
  await h.finished('cancelled');
  const [row] = (await h.history()).records;
  assert.equal(row.status, 'cancelled');
  assert.ok(row.finishedAt);
  assert.equal(row.canRetry, false);
  assert.equal(row.failure, undefined);
  await h.call('job.dismiss', { jobId: running.id });
  assert.equal((await h.history()).records.length, 1, 'dismissing the card keeps the history');
});

test('dismissing the card of a failed conversion keeps its row, which can no longer resume because its files are cleaned', async t => {
  const h = await harness(t, { serverOptions: { failWhen: () => 'internal error' } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  const failed = await h.finished('failed');
  assert.equal((await h.history()).records[0].canRetry, true);
  await h.call('job.dismiss', { jobId: failed.id });
  const [row] = (await h.history()).records;
  assert.equal(row.status, 'failed');
  assert.equal(row.canRetry, false);
});

/* ---------- restarts ---------- */

async function crashed(h, { pages = 450, manifest = true } = {}) {
  const source = join(h.root, 'Crashed.pdf');
  await writeFile(source, await makePdf({ pages }));
  const prepared = await prepareJob({ root: h.root, source, filename: 'Crashed.pdf', courses: [] });
  const record = await openRecord(h.root, { id: prepared.manifest.id, filename: 'Crashed.pdf', bytes: prepared.manifest.sourceBytes, pages, pieces: prepared.manifest.chunks.length, route: 'cloud' });
  if (!manifest) await rm(prepared.dir, { recursive: true, force: true });
  return { prepared, record };
}

test('a record a crash left running comes back as interrupted and can be resumed while its pieces are on disk', async t => {
  const h = await harness(t);
  await h.configure();
  const { record } = await crashed(h);
  h.restart();
  const [row] = (await h.history()).records;
  assert.equal(row.id, record.id);
  assert.equal(row.status, 'interrupted');
  assert.equal(row.finishedAt, undefined, 'no end is made up');
  assert.equal(row.elapsedMs, 0, 'and no duration');
  assert.equal(row.canRetry, true, '"接着做" is offered');
  assert.equal((await listRecords(h.root))[0].status, 'interrupted', 'and it is persisted, not only shown');
  await h.call('mineru.retry', { jobId: row.id });
  await h.finished();
  const [done] = (await h.history()).records;
  assert.equal(done.status, 'complete');
  assert.equal(done.attempts, 2);
  assert.equal(done.importedPages, 450);
});

test('a record whose files are gone is interrupted and honest about it: no resume button', async t => {
  const h = await harness(t);
  const { record } = await crashed(h, { manifest: false });
  const [row] = (await h.history()).records;
  assert.equal(row.id, record.id);
  assert.equal(row.status, 'interrupted');
  assert.equal(row.canRetry, false);
});

test('a conversion that was unfinished before the history existed gets a record on the next start', async t => {
  const h = await harness(t);
  const source = join(h.root, 'Old.pdf');
  await writeFile(source, await makePdf({ pages: 3 }));
  const prepared = await prepareJob({ root: h.root, source, filename: 'Old.pdf', courses: [] });
  assert.deepEqual(await listRecords(h.root), []);
  const [row] = (await h.history()).records;
  assert.equal(row.id, prepared.manifest.id);
  assert.equal(row.status, 'interrupted');
  assert.equal(row.filename, 'Old.pdf');
  assert.equal(row.canRetry, true);
});

/* ---------- deleting ---------- */

test('deleting a record or clearing the history never deletes an imported document', async t => {
  const h = await harness(t);
  await h.configure();
  for (const name of ['One.pdf', 'Two.pdf']) {
    await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: name === 'One.pdf' ? 3 : 4 }), name) });
    await h.until(async () => (await h.jobs()).every(job => job.status === 'complete') && (await h.jobs()).length >= 1, 'the conversion');
    await h.call('job.wait', { jobId: (await h.jobs()).at(-1).id, timeoutSeconds: 10 });
  }
  const sourcesBefore = (await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru').length;
  assert.equal(sourcesBefore, 7);
  const [first, second] = (await h.history()).records;
  assert.deepEqual((await h.call('mineru.history.remove', { id: first.id })).removed, true);
  assert.equal((await h.history()).records.length, 1);
  await assert.rejects(h.call('mineru.history.clear', {}), /confirm/);
  assert.equal((await h.history()).records.length, 1, 'nothing is cleared without a confirmation');
  assert.equal((await h.call('mineru.history.clear', { confirm: true })).removed, 1);
  assert.deepEqual((await h.history()).records, []);
  assert.equal((await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru').length, sourcesBefore);
  void second;
});

test('a conversion that is running cannot be deleted from the history, and clearing leaves it', async t => {
  const h = await harness(t, { serverOptions: { holdWhen: () => true } });
  await h.configure();
  const { jobId } = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  await assert.rejects(h.call('mineru.history.remove', { id: jobId }), /进行/);
  assert.equal((await h.call('mineru.history.clear', { confirm: true })).removed, 0);
  assert.equal((await h.history()).records.length, 1);
  await h.call('job.cancel', { jobId });
  await h.finished('cancelled');
});

test('removing an unknown record is a plain no-op, and a bad id is refused', async t => {
  const h = await harness(t, { cloud: false });
  assert.equal((await h.call('mineru.history.remove', { id: 'job-unknown-1' })).removed, false);
  await assert.rejects(h.call('mineru.history.remove', { id: '../../etc' }), /无效/);
  await assert.rejects(h.call('mineru.history.remove', {}), /id/);
});

test('a document the learner deleted later shows as deleted in the row; the row stays', async t => {
  const h = await harness(t);
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 2 })) });
  await h.finished();
  const [row] = (await h.history()).records;
  assert.equal(row.document.exists, true);
  for (const source of (await h.call('snapshot')).sources.filter(item => item.document?.converter === 'mineru')) await h.call('source.remove', { id: source.id });
  const [after] = (await h.history()).records;
  assert.equal(after.status, 'complete');
  assert.equal(after.document.exists, false);
  assert.deepEqual(after.document.sourceIds, []);
});

/* ---------- retention ---------- */

test('the latest 50 records are kept and older ones go when a new conversion is written', async t => {
  const h = await harness(t);
  await h.configure();
  const longAgo = Date.now() - 400 * 24 * 60 * 60_000;
  for (let i = 0; i < 52; i++) { await openRecord(h.root, { id: `seed-${String(i).padStart(4, '0')}`, filename: `old-${i}.pdf`, bytes: 1, pages: 1, pieces: 1, route: 'cloud' }, { now: () => longAgo + i * 1000 });
    await closeRecord(h.root, `seed-${String(i).padStart(4, '0')}`, { status: 'complete', documentId: 'd' }, { now: () => longAgo + i * 1000 + 10 }); }
  assert.equal((await listRecords(h.root)).length, 52, 'each was young when it was written');
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  await h.finished();
  const records = (await h.history()).records;
  assert.equal(records.length, 50);
  assert.equal(records[0].filename, 'Book.pdf');
});

/* ---------- other behaviours ---------- */

test('a refused import (the same book twice, no materials, unreadable PDF) leaves no record', async t => {
  const h = await harness(t, { serverOptions: { holdWhen: () => true } });
  await h.configure();
  const bytes = await makePdf({ pages: 3 });
  const { jobId } = await h.call('mineru.import', { uploadId: await h.upload(bytes) });
  await assert.rejects(h.call('mineru.import', { uploadId: await h.upload(bytes, 'Copy.pdf') }), /已经在转换/);
  await assert.rejects(h.call('mineru.import', { uploadId: await h.upload(Buffer.from('not a pdf')) }), /PDF/);
  assert.deepEqual((await h.history()).records.map(record => record.id), [jobId]);
  await h.call('job.cancel', { jobId });
  await h.finished('cancelled');
});

test('English: the history has no Chinese outside file names and titles', async t => {
  const h = await harness(t, { serverOptions: { failWhen: file => (/-2-/.test(file.data_id) ? 'internal error' : undefined) } });
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 450 }), 'Big.pdf') });
  await h.finished('failed');
  const english = await h.call('mineru.history.list', { uiLanguage: 'en' });
  assert.doesNotMatch(JSON.stringify(english), han);
  assert.match(english.records[0].failure.reason, /MinerU/);
  const chinese = await h.call('mineru.history.list', {});
  assert.match(chinese.records[0].failure.reason, /MinerU 没能转换|MinerU 服务/);
});

test('a file name in Chinese is user data and stays as it is in English', async t => {
  const h = await harness(t);
  await h.configure();
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 2 }), '数据库系统.pdf') });
  await h.finished();
  const english = await h.call('mineru.history.list', { uiLanguage: 'en' });
  assert.equal(english.records[0].filename, '数据库系统.pdf');
  assert.doesNotMatch(JSON.stringify({ ...english, records: english.records.map(({ filename, title, document, ...rest }) => rest) }), han);
});
