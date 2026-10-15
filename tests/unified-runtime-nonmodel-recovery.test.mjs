import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPdf, readManifest } from '../lib/mineru-job.js';
import { StudyService } from '../lib/service.js';
import { pdfJob } from './helpers/nonmodel-baseline.mjs';
import { until } from './helpers/wait.mjs';
import { harness as pdfService, localHarness } from './helpers/pdf-convert-harness.mjs';
import { harness as installService } from './helpers/marker-install-harness.mjs';
import { installHarness } from './helpers/mineru-install-harness.mjs';
import { createMineruInstaller, mineruLayout } from '../lib/mineru-install.js';
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
   Every cell is a test against a real fake (fake CLIs, a fake uv index, fake extension); the title starts with its cell. (The cloud route was removed in 3.6.) */

/* ---------- PDF (local): the import is the commit ---------- */

test('PDF local · committed, terminal not saved: a resume after the import happened (crash before the receipt) imports the same pages once, not twice', async t => {
  const job = await pdfJob(t, { pages: 3 });
  const service = new StudyService(job.library, {});
  t.after(() => service.dispose());
  const realImport = input => service.call('materials.document.import', { dataBase64: input.bytes.toString('base64'), filename: input.filename, format: input.format,
    ...(input.title ? { title: input.title } : {}), ...(input.courses ? { courses: input.courses } : {}) });
  const prepared = await job.prepare();
  let crashed = false;
  await assert.rejects(job.run(prepared, { importMerged: async input => { const done = await realImport(input); crashed = true; void done; throw new Error('the process died after the import'); } }), /died/);
  assert.equal(crashed, true);
  const afterCrash = (await service.call('snapshot')).sources.filter(source => source.document);
  assert.equal(afterCrash.length, 3);
  const windows = job.runner.windows.length;
  await job.run({ dir: prepared.dir, manifest: await readManifest(prepared.dir) }, { importMerged: realImport });
  const after = await service.call('snapshot');
  assert.equal(after.sources.filter(source => source.document).length, 3, 'the same three pages, not six');
  assert.equal(new Set(after.sources.filter(source => source.document).map(source => source.document.id)).size, 1, 'one document');
  assert.equal(job.runner.windows.length, windows, 'finished windows are not converted again');
});

test('PDF local · a resume is refused when the saved input is not the file the manifest was made from', async t => {
  const job = await pdfJob(t, { pages: 3 }), controller = new AbortController();
  const prepared = await job.prepare();
  controller.abort(new Error('stop'));
  await assert.rejects(job.run(prepared, { signal: controller.signal }), /stop/);
  await writeFile(join(prepared.dir, 'source.pdf'), await (await import('./helpers/pdf.mjs')).makePdf({ pages: 5 }));
  await assert.rejects(job.run({ dir: prepared.dir, manifest: await readManifest(prepared.dir) }), error => error.code === 'input-changed');
  assert.deepEqual(job.runner.windows, [], 'nothing was converted for a file that is not the one that was planned');
});

/* ---------- PDF (local): the process is still running ---------- */

test('PDF local · stop not confirmed: while the cancelled window\'s process still runs the same book cannot be started again; once it is gone it can', async t => {
  // A window that does not hear the stop until it is let go: the process that is still running.
  let let_go, begun;
  const gate = new Promise(resolve => { let_go = resolve; }), running = new Promise(resolve => { begun = resolve; });
  const parseWindow = async options => { begun(); await gate; options.signal.throwIfAborted(); throw new Error('not reached'); };
  const h = await localHarness(t, {}, { parseWindow });
  t.after(() => let_go());
  const started = await h.start(), again = await h.upload(), later = await h.upload();
  await running;
  await h.service.call('job.cancel', { jobId: started.jobId });
  const during = (await h.jobs())[0];
  assert.equal(during.status, 'cancelling', 'the receipt is not the end');
  await assert.rejects(h.start(again), /已经在转换/);
  let_go();
  const ended = await until(async () => { const [job] = await h.jobs(); return job && job.status === 'cancelled' && job; }, 'the stop');
  assert.equal(ended.status, 'cancelled');
  assert.ok((await h.start(later)).jobId, 'the process is gone: a new attempt may start');
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

/* ---------- MinerU install: models without the service; a stop leaves the folder owned ---------- */

test('MinerU install · committed, not recorded: the models are already there but the service was never set up: the install does not download them again and finishes the configuration', async t => {
  const h = await installHarness(t);
  const installer = createMineruInstaller(h.seams);
  // What a crash right after the download leaves: the install's own folder (its sentinel) with the models in it, and no record of either.
  await mkdir(join(mineruLayout(h.location).models, 'MinerU-4_models_onnx'), { recursive: true });
  await writeFile(mineruLayout(h.location).sentinel, JSON.stringify({ createdBy: 'studyhub-mineru-installer', version: 1 }));
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
  const calls = (await h.mineruLog()).map(entry => entry.argv.join(' '));
  assert.equal(calls.some(call => call.startsWith('models download')), false, 'no second download');
  assert.ok(calls.some(call => call.includes('managed_tier basic')) && calls.some(call => call.includes('local.mode managed')));
});

test('MinerU install · stop not confirmed: after a stop in the download nothing is configured, the folder stays owned, and a new start waits until the process is gone', async t => {
  const h = await installHarness(t, { mineru: { downloadDelayMs: 60_000 } });
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location });
  await until(async () => (await h.mineruLog()).some(entry => entry.argv[0] === 'models' && entry.argv[1] === 'download'), 'the download to start', { timeoutMs: 240_000 });
  await installer.cancel();
  await assert.rejects(installer.start({ confirm: true, location: h.location }), { code: 'busy' });
  await installer.idle();
  const ended = await installer.status();
  assert.equal(ended.status, 'cancelled');
  assert.equal((await h.mineruLog()).some(entry => entry.argv.join(' ').includes('config set')), false);
  assert.equal(await stat(mineruLayout(h.location).sentinel).then(() => true, () => false), true, 'still owned, so the learner can uninstall it');
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
