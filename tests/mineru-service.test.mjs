import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { convertHome, convertPdf, prepareJob } from '../lib/mineru-job.js';
import { makePdf } from './helpers/pdf.mjs';
import { patientCli, readJsonFile, writeJsonFile } from './helpers/wait.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

/* PDF conversion through the real service with the local mineru (a fake command line): the mineru.* operations, the shared job list, the recovery of a
   conversion a crash interrupted, and the refusals before anything runs. Nothing leaves the machine. (The cloud route was removed in 3.5.5:
   tests/mineru-cloud-legacy.test.mjs keeps what remains of it.) */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));

async function harness(t, { contexts, state = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-mineru-service-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-mineru-service-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-mineru-service-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.12', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const options = { mineru: { limits: { windowPages: 50, livenessMs: 0 }, local: { cli, home: work } } };
  const service = new StudyService(root, { ...options, ...switchOptions(SWITCH_MODE, { paths: ['pdfConvert'] }), ...(contexts ? { contexts } : {}) });
  const h = {
    home, root, service, cli,
    call: (action, args) => service.call(action, args),
    set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }),
    parses: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.argv[0] === 'parse'),
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert'),
    until: async (condition, what = 'condition') => {
      for (let i = 0; i < 6000; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
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
    service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
const pagesArg = entry => entry.argv[entry.argv.indexOf('--pages') + 1];

test('a conversion a crash interrupted comes back as a retryable job, and finishing it reuses what was converted', async t => {
  const h = await harness(t);
  // A first run that stops after window 1 (as if the app died), leaving its manifest and finished window behind.
  const source = join(h.root, 'Book.pdf');
  await writeFile(source, await makePdf({ pages: 120 }));
  const prepared = await prepareJob({ root: h.root, source, filename: 'Book.pdf', courses: [], tier: 'basic', limits: { windowPages: 50 } });
  const controller = new AbortController();
  let windows = 0;
  const parseWindow = async ({ startPage, endPage }) => {
    if (++windows > 1) { controller.abort(new Error('crash')); throw new Error('crash'); }
    return { content: Array.from({ length: endPage - startPage + 1 }, (_, offset) => ({ type: 'text', text: `p${startPage + offset}`, page_idx: offset })), markers: endPage - startPage + 1, warnings: [] };
  };
  await assert.rejects(convertPdf({ dir: prepared.dir, manifest: prepared.manifest, root: h.root, local: { cli: h.cli, parseWindow, liveness: false }, signal: controller.signal, importMerged: async () => ({}) }), /crash/);
  await h.service.dispose?.();
  const reopened = new StudyService(h.root, { mineru: { limits: { windowPages: 50, livenessMs: 0 }, local: { cli: h.cli, home: h.home } }, ...switchOptions(SWITCH_MODE, { paths: ['pdfConvert'] }) });
  t.after(() => reopened.dispose());
  const jobs = async () => (await reopened.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert');
  const [job] = await jobs();
  assert.equal(job.status, 'failed');
  assert.equal(job.retryable, true);
  assert.equal(job.done, 50);
  assert.match(job.stage, /中断/);
  await reopened.call('mineru.retry', { jobId: job.id });
  await h.until(async () => (await jobs())[0]?.status === 'complete', 'the resumed conversion');
  assert.deepEqual((await h.parses()).map(pagesArg), ['51-100', '101-120'], 'the finished window is not converted again');
  assert.equal((await reopened.call('snapshot')).sources.filter(item => item.document?.converter === 'mineru').length, 120);
});

test('the same book cannot be converted twice at once', async t => {
  const h = await harness(t, { state: { delayMs: 60_000 } });
  const bytes = await makePdf({ pages: 3 });
  await h.call('mineru.import', { uploadId: await h.upload(bytes) });
  await assert.rejects(h.call('mineru.import', { uploadId: await h.upload(bytes, 'Copy.pdf') }), /已经在转换/);
  const [job] = await h.jobs();
  await h.call('job.cancel', { jobId: job.id });
});

test('a PDF that cannot be read is refused in plain words and nothing runs', async t => {
  const h = await harness(t);
  const uploadId = await h.upload(Buffer.from('this is not a pdf at all'));
  await assert.rejects(h.call('mineru.import', { uploadId }), error => /PDF/.test(error.message));
  assert.deepEqual(await h.parses(), []);
  assert.deepEqual(await h.jobs(), []);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'jobs')), []);
});

test('without the materials component there is nowhere to save the result, so nothing runs', async t => {
  const h = await harness(t, { contexts: ['audio'] });
  const uploadId = await h.upload(await makePdf({ pages: 3 }));
  await assert.rejects(h.call('mineru.import', { uploadId }), /资料组件/);
  assert.deepEqual(await h.parses(), []);
});

test('PDF uploads wait in the DSH home, never in the study library, and only PDFs are accepted', async t => {
  const h = await harness(t);
  const bytes = await makePdf({ pages: 3 });
  const { uploadId } = await h.service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
  assert.deepEqual(await filesUnder(join(h.root, 'audio-uploads')), []);
  assert.equal((await filesUnder(join(convertHome(h.root), 'uploads'))).length, 1);
  assert.ok((await h.service.call('mineru.upload.cancel', { uploadId })).cancelled);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'uploads')), []);
  await assert.rejects(h.service.call('mineru.upload.start', { name: 'song.mp3', size: 10 }), error => error.message === '只接受 PDF 文件');
  await assert.rejects(h.service.call('mineru.upload.start', { name: 'huge.pdf', size: 900 * 1024 * 1024 }), /800 MB/);
});

test('a conversion is local whatever route is asked for, except the removed cloud, which is refused before anything is read', async t => {
  const h = await harness(t, { state: { total: 3 } });
  await assert.rejects(h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'cloud' }), error => error.code === 'cloud-removed' && /云端解析已停用/.test(error.message));
  const started = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the conversion');
  assert.equal((await h.jobs())[0].route, 'local');
  assert.ok(started.jobId);
  assert.match(started.next, /MinerU 本机/);
});
