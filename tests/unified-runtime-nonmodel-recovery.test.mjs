import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPdf, readManifest } from '../lib/mineru-job.js';
import { createMineruClient } from '../lib/mineru-api.js';
import { StudyService } from '../lib/service.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { pdfJob } from './helpers/nonmodel-baseline.mjs';
import { until } from './helpers/wait.mjs';
import { harness as pdfService, localHarness } from './helpers/pdf-convert-harness.mjs';
import { harness as installService } from './helpers/marker-install-harness.mjs';
import { FRESH, harness as setupService } from './helpers/mineru-setup-harness.mjs';
import { library } from './helpers/index-library.mjs';
import { fakeIndexPort } from './helpers/index-port.mjs';
import { markerInstallStatePath, venvLayout } from '../lib/marker-install.js';
import { readMarkerSettings } from '../lib/marker-settings.js';
import { sourceKey } from '../lib/retrieval-index.js';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { announceEnd } from '../lib/contexts/audio/convert-card.js';
import { dirname, join } from 'node:path';

/* S5-6: the unknown-side-effect and stop/recovery matrix of the non-model paths (docs/plans/unified-job-runtime/s5-6-recovery-matrix.md).
   Rows are paths, columns are three failure points: BEFORE the side effect, COMMITTED but not yet recorded, STOP not confirmed.
   Every cell is a test against a real fake (fake MinerU server, fake CLIs, fake extension); the title starts with its cell. */

/* ---------- PDF (cloud): the import is the commit ---------- */

test('PDF cloud · committed, terminal not saved: a resume after the import happened (crash before the receipt) imports the same pages once, not twice', async t => {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const job = await pdfJob(t, { pages: 3 });
  const service = new StudyService(job.library, {});
  t.after(() => service.dispose());
  const client = createMineruClient({ token: fake.token, baseUrl: fake.baseUrl });
  const realImport = input => service.call('materials.document.import', { dataBase64: input.bytes.toString('base64'), filename: input.filename, format: input.format,
    ...(input.title ? { title: input.title } : {}), ...(input.courses ? { courses: input.courses } : {}) });
  const prepared = await job.prepare();
  let crashed = false;
  const run = (manifest, importMerged) => convertPdf({ dir: prepared.dir, manifest, root: job.library, client, sleep: job.sleep, now: job.now, importMerged });
  await assert.rejects(run(prepared.manifest, async input => { const done = await realImport(input); crashed = true; void done; throw new Error('the process died after the import'); }), /died/);
  assert.equal(crashed, true);
  const afterCrash = (await service.call('snapshot')).sources.filter(source => source.document);
  assert.equal(afterCrash.length, 3);
  const uploads = fake.uploads.length;
  await run(await readManifest(prepared.dir), realImport);
  const after = await service.call('snapshot');
  assert.equal(after.sources.filter(source => source.document).length, 3, 'the same three pages, not six');
  assert.equal(new Set(after.sources.filter(source => source.document).map(source => source.document.id)).size, 1, 'one document');
  assert.equal(fake.uploads.length, uploads, 'finished pieces are not uploaded again');
});

/* ---------- PDF (cloud): before the side effect, stop in flight, a resume that finds another input ---------- */

test('PDF cloud · before the side effect: a stop before the first create sends nothing to MinerU and leaves the pieces uncut-to-requested', async t => {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const job = await pdfJob(t, { pages: 3 }), controller = new AbortController();
  const prepared = await job.prepare();
  controller.abort(new Error('stopped first'));
  await assert.rejects(job.run(prepared, { client: createMineruClient({ token: fake.token, baseUrl: fake.baseUrl }), signal: controller.signal, verifyCreates: true }), /stopped first/);
  assert.equal(fake.requests.length, 0);
  assert.ok((await readManifest(prepared.dir)).chunks.every(chunk => !chunk.batchId && !['requested', 'creating', 'uploaded'].includes(chunk.state)));
});

test('PDF cloud · stop not confirmed: a stop while the bytes are going up never asks MinerU to delete or cancel anything, and the batch reference stays on disk', async t => {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const job = await pdfJob(t, { pages: 3 }), controller = new AbortController(), base = createMineruClient({ token: fake.token, baseUrl: fake.baseUrl });
  const client = { ...base, upload: async () => { controller.abort(new Error('stopped mid-upload')); throw new Error('the request was cut'); } };
  const prepared = await job.prepare();
  await assert.rejects(job.run(prepared, { client, signal: controller.signal, verifyCreates: true }), /stopped mid-upload/);
  assert.deepEqual([...new Set(fake.requests.map(request => request.method))].sort(), ['POST'], 'a create, and no cancel, delete or patch');
  const saved = await readManifest(prepared.dir);
  assert.deepEqual([saved.chunks[0].state, typeof saved.chunks[0].batchId], ['requested', 'string'], 'what is known about the remote batch is kept, not turned into "stopped"');
});

test('PDF cloud · a resume is refused when the saved input is not the file the manifest was made from', async t => {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const job = await pdfJob(t, { pages: 3 }), controller = new AbortController(), base = createMineruClient({ token: fake.token, baseUrl: fake.baseUrl });
  const prepared = await job.prepare();
  await assert.rejects(job.run(prepared, { client: { ...base, requestUploads: async () => { controller.abort(new Error('stop')); throw new Error('cut'); } }, signal: controller.signal }), /stop/);
  await writeFile(join(prepared.dir, 'source.pdf'), await (await import('./helpers/pdf.mjs')).makePdf({ pages: 5 }));
  const posts = fake.requests.length;
  await assert.rejects(job.run({ dir: prepared.dir, manifest: await readManifest(prepared.dir) }, { client: base }), error => error.code === 'input-changed');
  assert.equal(fake.requests.length, posts, 'nothing was sent for a file that is not the one that was planned');
});

/* ---------- PDF (local): the process is still running ---------- */

test('PDF local · stop not confirmed: while the cancelled window\'s process still runs the same book cannot be started again; once it is gone it can', async t => {
  const h = await localHarness(t, { delayMs: 60_000 });
  const started = await h.start();
  await until(async () => (await h.parses()).length, 'the first window to start');
  await h.service.call('job.cancel', { jobId: started.jobId });
  const during = (await h.jobs())[0];
  assert.equal(during.status, 'cancelling', 'the receipt is not the end');
  await assert.rejects(h.start(), /已经在转换/);
  const ended = await until(async () => { const [job] = await h.jobs(); return job && job.status === 'cancelled' && job; }, 'the stop');
  assert.equal(ended.status, 'cancelled');
  assert.ok((await h.start()).jobId, 'the process is gone: a new attempt may start');
});

/* ---------- Marker install: a crash leaves an owned folder; a stop leaves it too ---------- */

test('Marker install · committed, state not saved: a crash leaves a running state with no run behind it: it is "interrupted", the folder is still the installer\'s, and a new start continues in it', async t => {
  const h = await installService(t);
  const folder = join(h.dir, 'home', 'studyhub', 'marker');
  await mkdir(dirname(markerInstallStatePath()), { recursive: true });
  await mkdir(folder, { recursive: true });
  await writeFile(venvLayout(folder).sentinel, JSON.stringify({ createdBy: 'studyhub-marker-installer', version: 1 }));
  await writeFile(markerInstallStatePath(), JSON.stringify({ version: 1, status: 'running', stage: 'install', folder, startedAt: new Date().toISOString(), log: [] }));
  const view = await h.call('marker.install.status');
  assert.deepEqual([view.status, view.installed, view.error.code], ['interrupted', false, 'interrupted'], 'not "running", not "ready"');
  const started = await h.call('marker.install.start', { confirm: true });
  assert.equal(started.folder, folder, 'the sentinel makes the folder the installer\'s: it continues there');
  assert.equal((await h.ended('complete')).installed, true);
});

test('Marker install · stop not confirmed: a stop is "cancelled" only after the process is gone; the half-made folder stays owned, nothing is uninstalled and the program path is not touched', async t => {
  const h = await installService(t, { delayPip: true });
  const before = await readMarkerSettings();
  await h.call('marker.install.start', { confirm: true });
  await until(async () => (await h.call('marker.install.status')).log.some(line => /Collecting marker-pdf/.test(line)), 'pip to start', { timeoutMs: 240_000 });
  await h.call('marker.install.cancel');
  assert.equal((await h.call('marker.install.status')).status, 'running', 'the receipt is not the end');
  await assert.rejects(h.call('marker.install.start', { confirm: true }), { code: 'busy' });
  await assert.rejects(h.call('marker.install.uninstall', { confirm: true }), { code: 'busy' });
  const ended = await h.ended('cancelled');
  assert.equal(ended.installed, false);
  assert.equal(await stat(venvLayout(ended.folder).sentinel).then(() => true, () => false), true, 'still owned, so the learner can uninstall it');
  assert.deepEqual(await readMarkerSettings(), before, 'configure never ran');
});

/* ---------- MinerU setup: models without the mode; a stop leaves nothing configured ---------- */

test('MinerU setup · committed, not recorded: models already downloaded but the mode not switched on: the setup does not download again and finishes the configuration', async t => {
  const h = await setupService(t, { state: { ...FRESH, running: true, modelsReady: true, tier: 'basic' } });
  await mkdir(join(h.work, 'models', 'basic'), { recursive: true });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await h.ended('complete');
  const calls = await h.calls();
  assert.equal(calls.some(call => call.startsWith('--tier')), false, 'no second download');
  assert.ok(calls.some(call => call.includes('managed_tier basic')) && calls.some(call => call.includes('local.mode managed')));
  assert.equal((await h.call('mineru.local.status')).state, 'ready');
});

test('MinerU setup · stop not confirmed: after a stop in the download nothing is configured and the local mineru is not reported ready; a new setup waits until the process is gone', async t => {
  const h = await setupService(t, { state: { ...FRESH, downloadDelayMs: 60_000 } });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await until(async () => (await h.log()).some(entry => entry.argv[0] === '--tier'), 'the download to start');
  await h.call('mineru.local.setup.cancel');
  await assert.rejects(h.call('mineru.local.setup', { tier: 'basic', confirm: true }), { code: 'setup-busy' });
  await h.ended('cancelled');
  assert.equal((await h.call('mineru.local.status')).state === 'ready', false);
  assert.equal((await h.calls()).some(call => call.includes('config set')), false);
});

/* ---------- Index: a write is still in flight ---------- */

test('Index · stop not confirmed: while the write the extension has not answered is in flight the build is still "running", a second start joins it, and that page is reported unconfirmed', async t => {
  let answer;
  const gate = new Promise(resolve => { answer = resolve; });
  const fake = fakeIndexPort({ onIngest: async (_args, count) => { if (count === 2) await gate; } });
  const lib = await library(t, fake);
  await lib.service.call('retrieval.index.start', { course: 'OS' });
  await until(() => fake.ingested().length === 2, 'the second write');
  await lib.service.call('retrieval.index.cancel', {});
  const during = await lib.status();
  assert.equal(during.status, 'running', 'cancelling is not cancelled');
  const joined = await lib.service.call('retrieval.index.start', { course: 'OS' });
  assert.equal(joined.runId, during.runId);
  assert.equal(fake.ingested().length, 2, 'no write was started for the second request');
  answer();
  const stopped = await lib.finished('the stop');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(fake.ingested().length, 2, 'nothing after the stop');
  assert.equal(sourceKey(stopped.unconfirmed[0]), fake.ingested()[1], 'the page whose answer never came is not claimed written or unwritten');
});

test('PDF · terminal and notice after the checkpoint: a notice written again after a resume is still one letter for that conversion, with the same sources', async t => {
  const h = await pdfService(t);
  const started = await h.start(3);
  const done = await h.settled(started.jobId);
  const letters = async () => (await h.call('snapshot')).inbox.items.filter(item => item.kind === 'pdf-result' && item.jobId === done.id);
  assert.equal((await letters()).length, 1);
  const worker = { store: h.service.store, announceJob() {} }, card = { id: done.id, status: 'complete', filename: done.filename, sourceIds: done.sourceIds, stage: done.stage, warnings: [] };
  await announceEnd(worker, card);
  const again = await letters();
  assert.equal(again.length, 1, 'folded into the unread one, not a second letter');
  assert.deepEqual(again[0].sourceIds, done.sourceIds);
});
