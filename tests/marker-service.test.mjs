import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { prepareJob } from '../lib/mineru-job.js';
import { resultsDir } from '../lib/mineru-paths.js';
import { markerInstallStatePath, venvLayout } from '../lib/marker-install.js';
import { makePdf } from './helpers/pdf.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
const fake = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
// `seam: false` leaves out the stand-in CLI, so Marker is looked for the way the app does it (the saved path, StudyHub's own install, PATH).
async function harness(t, state = {}, limits = { windowPages: 2 }, { seam = true } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'marker-service-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(folder, 'home');
  const root = join(folder, 'library'), statePath = join(folder, 'state.json'), log = join(folder, 'log.jsonl');
  await writeFile(statePath, JSON.stringify(state)); await writeFile(log, '');
  const options = { ...switchOptions(SWITCH_MODE, { paths: ['pdfConvert'] }), marker: { limits, ...(seam ? { local: { cli: { file: process.execPath, prefix: [fake], env: { FAKE_MARKER_STATE: statePath, FAKE_MARKER_LOG: log } } } } : {}) } };
  let service = new StudyService(root, options);
  const pdfs = new Map();
  const h = {
    root, options, folder,
    call: (name, args) => service.call(name, args),
    state: patch => writeFile(statePath, JSON.stringify(patch)),
    log: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    job: async () => (await h.call('snapshot')).jobs.find(job => job.type === 'pdf-convert'),
    until: async condition => { for (let i = 0; i < 1500; i++) { const result = await condition(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out'); },
    terminal: async () => { const job = await h.until(async () => { const j = await h.job(); return ['complete', 'failed', 'cancelled'].includes(j?.status) && j; }); await h.call('job.wait', { jobId: job.id }); return job; },
    restart: async () => { service.dispose(); service = new StudyService(root, options); await h.call('snapshot'); },
    upload: async (pages = 6) => {
      if (!pdfs.has(pages)) pdfs.set(pages, await makePdf({ pages }));
      const bytes = pdfs.get(pages);
      const { uploadId, chunkBytes } = await h.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await h.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await h.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
  };
  t.after(async () => { service.dispose(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return h;
}
const range = args => args[args.indexOf('--page_range') + 1];
test('Marker runs page windows and automatically imports Marker provenance with physical blank pages', async t => {
  const h = await harness(t, { blank: [2, 5] });
  assert.equal((await h.call('marker.local.status')).state, 'ready');
  const started = await h.call('marker.import', { uploadId: await h.upload(), courses: ['Database'] });
  assert.equal(started.converter, 'marker');
  const job = await h.terminal(); assert.equal(job.status, 'complete', job.stage);
  assert.deepEqual((await h.log()).map(range), ['0-1', '2-3', '4-5']);
  const sources = (await h.call('snapshot')).sources;
  assert.equal(sources.length, 4); assert.deepEqual(job.skippedPages, [3, 6]);
  assert.ok(sources.every(s => s.document.converter === 'marker' && s.document.totalPages === 6));
  assert.deepEqual(sources[0].courses, ['Database']);
  assert.equal((await h.call('mineru.history.list')).records[0].converter, 'marker');
  const texts = (await h.call('export')).sources.map(s => s.text).join('\n');
  assert.match(texts, /Marker page 4 text/);
});
test('failed Marker windows survive restart; retry parses only unfinished ranges without partial import', async t => {
  const h = await harness(t, { failStart: 2 });
  await h.call('marker.import', { uploadId: await h.upload() });
  const failed = await h.terminal(); assert.equal(failed.status, 'failed'); assert.equal(failed.done, 2);
  assert.equal((await h.call('snapshot')).sources.length, 0);
  await h.restart(); const recovered = await h.job(); assert.equal(recovered.converter, 'marker'); assert.equal(recovered.retryable, true);
  await h.state({}); await h.call('mineru.retry', { jobId: recovered.id });
  assert.equal((await h.terminal()).status, 'complete');
  assert.deepEqual((await h.log()).map(range), ['0-1', '2-3', '2-3', '4-5']);
});
test('Marker cancellation stops the process and a fresh import reuses only completed Marker ranges', async t => {
  const h = await harness(t, { delayStart: 2 });
  await h.call('marker.import', { uploadId: await h.upload() });
  await h.until(async () => (await h.log()).length === 2);
  const running = await h.job(); await h.call('job.cancel', { jobId: running.id });
  assert.equal((await h.terminal()).status, 'cancelled');
  await h.state({}); await h.call('marker.import', { uploadId: await h.upload() });
  await h.until(async () => (await h.call('snapshot')).jobs.some(j => j.type === 'pdf-convert' && j.status === 'complete'));
  assert.deepEqual((await h.log()).map(range), ['0-1', '2-3', '2-3', '4-5']);
});
test('Marker never consumes MinerU cached results for the same PDF', async t => {
  const h = await harness(t);
  const source = join(h.folder, 'Book.pdf'); await writeFile(source, await makePdf({ pages: 6 }));
  const prepared = await prepareJob({ root: h.root, source, route: 'local', tier: 'basic', limits: { windowPages: 2 } });
  const cache = resultsDir(h.root, prepared.manifest.sourceHash); await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'local-basic-1-2.json'), JSON.stringify({ format: 'v1', content: [{ type: 'text', text: 'Wrong provider', page_idx: 0 }] }));
  await rm(prepared.dir, { recursive: true, force: true });
  await h.call('marker.import', { path: source });
  assert.equal((await h.terminal()).status, 'complete');
  assert.equal((await h.log()).length, 3);
  assert.doesNotMatch((await h.call('export')).sources.map(s => s.text).join('\n'), /Wrong provider/);
});

test('Marker default adaptive plan covers every original page and automatically imports', async t => {
  const h = await harness(t, {}, {});
  await h.call('marker.import', { uploadId: await h.upload(35) });
  const job = await h.terminal(); assert.equal(job.status, 'complete', job.stage);
  const ranges = (await h.log()).map(args => range(args).split('-').map(Number));
  assert.deepEqual(ranges[0], [0, 9]);
  assert.deepEqual(ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i)), Array.from({ length: 35 }, (_, i) => i));
  const sources = (await h.call('snapshot')).sources;
  assert.equal(sources.length, 35);
  assert.ok(sources.every(source => source.document.converter === 'marker' && source.document.totalPages === 35));
});

// 检测并保存: marker.local.status {command} checks the path in the box without saving it; without a command it checks what the app would run now.
function noMarkerOnThisMachine(t, folder) {
  const keys = ['PATH', 'Path', 'MARKER_BIN', 'HOME', 'USERPROFILE'], before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const empty = join(folder, 'nothing-here'); process.env.PATH = empty; if (before.Path !== undefined) process.env.Path = empty;
  delete process.env.MARKER_BIN; process.env.HOME = empty; process.env.USERPROFILE = empty;
  t.after(() => { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; });
}
test('marker.local.status {command} probes that path and never saves it; a missing or non-Marker program is not ready', async t => {
  const h = await harness(t);
  assert.deepEqual(await h.call('marker.settings.get'), { command: '' });
  const missing = await h.call('marker.local.status', { command: join(h.folder, 'no-such-dir', 'marker_single') });
  assert.equal(missing.state, 'not-installed', 'a path that does not exist is not installed, whatever the stand-in CLI says');
  assert.equal((await h.call('marker.local.status', { command: process.execPath })).state, 'unavailable', 'a real program that is not Marker answers --help without the Marker options');
  assert.equal((await h.call('marker.local.status', { command: process.execPath })).command, process.execPath, 'the answer names the program it asked');
  assert.equal((await h.call('marker.local.status', {})).state, 'ready', 'with no command it still asks what the app uses (here the stand-in CLI)');
  assert.equal((await h.call('marker.local.status', { command: '   ' })).state, 'ready', 'a blank command is no command');
  assert.deepEqual(await h.call('marker.settings.get'), { command: '' }, 'probing a path saved nothing');
  assert.equal((await h.log()).length, 0, 'and converted nothing');
});
test('marker.local.status {command} of a program that is Marker is ready and still saves nothing', { skip: process.platform === 'win32' && 'needs an executable script' }, async t => {
  const h = await harness(t);
  const program = join(h.folder, 'marker_single'); await writeFile(program, '#!/bin/sh\necho "--output_dir --page_range --paginate_output --output_format --disable_image_extraction"\n'); await chmod(program, 0o755);
  const ready = await h.call('marker.local.status', { command: program });
  assert.equal(ready.state, 'ready'); assert.equal(ready.command, program);
  assert.deepEqual(await h.call('marker.settings.get'), { command: '' });
});
test('marker.local.status without a command uses the saved path, else StudyHub\'s own install, and an explicit saved path never falls back', async t => {
  const h = await harness(t, {}, undefined, { seam: false });
  noMarkerOnThisMachine(t, h.folder);
  assert.equal((await h.call('marker.local.status')).state, 'not-installed', 'nothing saved, nothing installed');
  const env = venvLayout(join(h.folder, 'marker-env'));
  await mkdir(env.bin, { recursive: true }); await writeFile(env.sentinel, JSON.stringify({ createdBy: 'studyhub-marker-installer' })); await writeFile(env.marker, '');
  await mkdir(join(markerInstallStatePath(), '..'), { recursive: true });
  await writeFile(markerInstallStatePath(), JSON.stringify({ version: 1, status: 'complete', stage: 'done', folder: join(h.folder, 'marker-env'), installedFolder: join(h.folder, 'marker-env'), command: env.marker }));
  const installed = await h.call('marker.local.status', {});
  assert.equal(installed.command, env.marker, 'a blank saved path finds the Marker StudyHub installed');
  assert.notEqual(installed.state, 'not-installed');
  await h.call('marker.settings.set', { command: join(h.folder, 'elsewhere', 'marker_single') });
  assert.equal((await h.call('marker.local.status')).state, 'not-installed', 'an explicit saved path never falls back to the install');
  const probed = await h.call('marker.local.status', { command: '' });
  assert.equal(probed.state, 'not-installed', 'an empty command in the call is no command: the saved path decides');
  assert.deepEqual(await h.call('marker.settings.get'), { command: join(h.folder, 'elsewhere', 'marker_single') });
});
