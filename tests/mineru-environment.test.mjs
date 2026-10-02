import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { prepareJob } from '../lib/mineru-job.js';
import { closeRecord, historyDir, listRecords, openRecord } from '../lib/mineru-history.js';
import { LOCAL, detectLocal, readLocalEnvironment } from '../lib/mineru-local.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* The 运行环境 of a conversion: WHAT is doing the work (local: the mineru version, the tier, the model folder in use, whether its service is up, the window
   size; cloud: the model version, the language, the piece limits), captured when the conversion starts, kept in the history record without any path, and the
   service state kept honest while it runs: read-only calls before the work, then derived from the window process, never polled during a window. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const han = /[㐀-鿿]/;
const MODELS = { basic: 'MinerU-4_models_onnx', standard: 'MinerU2.5-Pro-2605-1.2B-GGUF' };

async function fakeCli(t, state = {}) {
  const work = await mkdtemp(join(tmpdir(), 'study-env-fake-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const env = { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath };
  return { work, cli: { file: process.execPath, prefix: [FAKE], env }, statePath, logPath, env,
    set: async patch => writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')), ...patch })),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

/* ---------- reading it (read-only) ---------- */

test('the local environment: version, tier, the model folder of that tier, where the models live, and no device unless the CLI says so', async t => {
  const fake = await fakeCli(t);
  await mkdir(join(fake.work, 'models', MODELS.basic), { recursive: true });
  await mkdir(join(fake.work, 'models', MODELS.standard), { recursive: true });
  const status = await detectLocal({ cli: fake.cli, home: fake.work });
  const environment = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status });
  assert.equal(environment.kind, 'local');
  assert.equal(environment.mineruVersion, '4.0.10');
  assert.equal(environment.tier, 'basic');
  assert.equal(environment.model, MODELS.basic);
  assert.equal(environment.modelsPath, join(fake.work, 'models'));
  assert.equal(environment.modelsRealPath, undefined, 'a folder that is not a link has no other place');
  assert.equal(environment.device, undefined, 'no GPU or CPU label unless the CLI reports one');
  await fake.set({ tier: 'standard' });
  const standard = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status: await detectLocal({ cli: fake.cli, home: fake.work }) });
  assert.equal(standard.model, MODELS.standard);
  assert.equal(standard.tier, 'standard');
});

test('a device is shown only when `server status` or `config show` exposes one', async t => {
  const fake = await fakeCli(t, { device: 'cuda' });
  const environment = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status: await detectLocal({ cli: fake.cli, home: fake.work }) });
  assert.equal(environment.device, 'cuda');
  const calls = (await fake.log()).map(entry => entry.argv.slice(0, 2).join(' '));
  assert.ok(calls.every(call => ['--version', 'server status', 'config get', 'config show'].includes(call)), `only read-only calls: ${calls}`);
});

test('where the models live: a folder that is a link says where it really is; a missing folder is no model, not an error', async t => {
  const fake = await fakeCli(t);
  const status = await detectLocal({ cli: fake.cli, home: fake.work });
  const none = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status });
  assert.equal(none.model, undefined);
  assert.equal(none.tier, 'basic');
  await mkdir(join(fake.work, 'models', MODELS.basic), { recursive: true });
  const linked = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status, realpath: async () => 'E:\\mineru-models\\models' });
  assert.equal(linked.modelsRealPath, 'E:\\mineru-models\\models');
  const same = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status, realpath: async path => path });
  assert.equal(same.modelsRealPath, undefined);
  const broken = await readLocalEnvironment({ cli: fake.cli, home: fake.work, status, realpath: async () => { throw new Error('EPERM'); } });
  assert.equal(broken.modelsRealPath, undefined);
});

test('without a command line there is still an environment: the route, and nothing invented', async () => {
  const environment = await readLocalEnvironment({ cli: null, home: '/nowhere', status: { state: 'not-installed' } });
  assert.deepEqual(environment, { kind: 'local' });
  assert.equal(LOCAL.windowPages, 50);
});

/* ---------- through the service ---------- */

async function harness(t, { state = {}, cloud = true, pages = 120, limits = {}, models = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-env-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-env-lib-'));
  const fake = await fakeCli(t, { total: pages, ...state });
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  if (models) await mkdir(join(fake.work, 'models', MODELS.basic), { recursive: true });
  const server = cloud ? await startFakeMineru() : null;
  const clock = { time: 9_000_000 };
  const options = { mineru: { ...(server ? { baseUrl: server.baseUrl } : {}), now: () => clock.time, limits,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); },
    local: { cli: fake.cli, home: fake.work, modelsCli: { file: process.execPath, prefix: [FAKE], env: fake.env } } } };
  const open = () => new StudyService(root, options);
  let service = open();
  const h = { home, root, fake, server, get service() { return service; },
    restart() { service.dispose(); service = open(); return service; },
    call: (action, args) => service.call(action, args),
    jobs: async (args = {}) => (await service.call('snapshot', args)).jobs.filter(job => job.type === 'pdf-convert'),
    history: async (args = {}) => service.call('mineru.history.list', args),
    until: async (condition, what) => { for (let i = 0; i < 1500; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Timed out waiting for ${what}`); },
    upload: async (bytes, name = 'Book.pdf') => {
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
    finished: async status => { const job = await h.until(async () => { const [entry] = await h.jobs(); return entry && (status ? entry.status === status : ['complete', 'failed', 'cancelled'].includes(entry.status)) ? entry : null; }, 'the end of the conversion'); await service.call('job.wait', { jobId: job.id, timeoutSeconds: 10 }); return job; } };
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    service.dispose(); await server?.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  return h;
}

test('a local conversion starts with its environment: what runs it, which model, that the service was up, and how it works on pages', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 }, state: { delayMs: 400 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const [job] = await h.jobs();
  assert.equal(job.env.kind, 'local');
  assert.equal(job.env.mineruVersion, '4.0.10');
  assert.equal(job.env.tier, 'basic');
  assert.equal(job.env.model, MODELS.basic);
  assert.equal(job.env.modelsPath, join(h.fake.work, 'models'));
  assert.deepEqual(job.env.windows, { kind: 'fixed', pages: 50 }, 'the window size, read from where the plan is made');
  assert.equal(job.service.state, 'running');
  assert.equal(job.service.basis, 'check');
  assert.ok(Date.parse(job.service.at) > 0);
  await h.finished();
});

test('the service state follows the work: confirmed up when a window finishes, and nothing is asked of the CLI while a window runs', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const done = await h.finished();
  assert.equal(done.service.state, 'running');
  assert.equal(done.service.basis, 'window', 'the last evidence is a finished window');
  const calls = (await h.fake.log()).map(entry => entry.argv[0]);
  const first = calls.indexOf('parse'), last = calls.lastIndexOf('parse');
  assert.equal(calls.filter(call => call === 'parse').length, 3);
  assert.deepEqual(calls.slice(first, last + 1), ['parse', 'parse', 'parse'], 'between the windows the CLI is not asked anything else: no polling');
});

test('a conversion never starts, stops or reconfigures the local service on its own', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  await h.finished();
  const calls = (await h.fake.log()).map(entry => entry.argv.slice(0, 3).join(' '));
  assert.ok(!calls.some(call => /^server (start|stop|restart)/.test(call) || /^config set/.test(call) || call.startsWith('--tier')), `read-only and parse only: ${calls}`);
});

test('a window that finds the service stopped is a stopped service, and the row says what ran it', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 }, state: { dieOnFirst: 51 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const failed = await h.finished('failed');
  assert.equal(failed.errorCode, 'server-stopped');
  assert.equal(failed.service.state, 'stopped');
  assert.equal(failed.service.basis, 'window');
  assert.equal(failed.env.tier, 'basic', 'the environment stays on the failed card');
  const [row] = (await h.history()).records;
  assert.equal(row.failure.code, 'server-stopped');
  assert.equal(row.env.model, MODELS.basic);
  assert.equal(row.env.mineruVersion, '4.0.10');
});

test('after a restart the service state of an unfinished conversion is unknown, until "接着做" reads it again (read-only)', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 } });
  const source = join(h.root, 'Crashed.pdf');
  await writeFile(source, await makePdf({ pages: 120 }));
  const env = await readLocalEnvironment({ cli: h.fake.cli, home: h.fake.work, status: await detectLocal({ cli: h.fake.cli, home: h.fake.work }) });
  const prepared = await prepareJob({ root: h.root, source, filename: 'Crashed.pdf', courses: [], route: 'local', tier: 'basic', limits: { windowPages: 50 } });
  prepared.manifest.env = env;
  const { saveManifest } = await import('../lib/mineru-job.js');
  await saveManifest(prepared.dir, prepared.manifest);
  await openRecord(h.root, { id: prepared.manifest.id, filename: 'Crashed.pdf', bytes: prepared.manifest.sourceBytes, pages: 120, pieces: 3, route: 'local', tier: 'basic', env });
  h.restart();
  const [job] = await h.jobs();
  assert.equal(job.id, prepared.manifest.id);
  assert.equal(job.env.model, MODELS.basic, 'the environment captured at the start survives the restart');
  assert.equal(job.service.state, 'unknown');
  await h.call('mineru.retry', { jobId: job.id });
  const after = await h.finished();
  assert.equal(after.service.state, 'running');
  assert.equal(after.service.basis, 'window');
});

test('the history record keeps what ran the conversion, and no path, however the environment was read', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 }, state: { device: 'cuda' } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  await h.finished();
  const [row] = (await h.history()).records;
  assert.deepEqual({ ...row.env }, { kind: 'local', mineruVersion: '4.0.10', tier: 'basic', model: MODELS.basic, device: 'cuda', windows: { kind: 'fixed', pages: 50 } });
  const raw = await readFile(join(historyDir(h.root), (await readdir(historyDir(h.root)))[0]), 'utf8');
  for (const forbidden of [h.fake.work, h.home, 'modelsPath', 'modelsRealPath', 'models\\', 'models/']) assert.ok(!raw.includes(forbidden), `the record holds ${forbidden}`);
  assert.deepEqual((await listRecords(h.root))[0].plan, { kind: 'fixed', windowPages: 50 });
});

test('the record reserves the windows and the plan: every piece of the book with its pages and state, and how it was planned', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  await h.finished();
  const [row] = (await h.history()).records;
  assert.deepEqual(row.windows.map(({ start, end, pages, state }) => [start, end, pages, state]), [[1, 50, 50, 'done'], [51, 100, 50, 'done'], [101, 120, 20, 'done']]);
  assert.equal(row.pieces, 3);
  assert.deepEqual(row.plan, { kind: 'fixed', windowPages: 50 });
});

test('a cloud conversion has its own environment: the model version, the language, the piece limits and the size of the book, never the token', async t => {
  const h = await harness(t);
  await h.call('mineru.settings.set', { token: h.server.token, acknowledge: true });
  const bytes = await makePdf({ pages: 3 });
  await h.call('mineru.import', { uploadId: await h.upload(bytes), route: 'cloud' });
  const [job] = await h.jobs();
  assert.deepEqual({ ...job.env }, { kind: 'cloud', modelVersion: 'vlm', language: 'ch', maxPages: 200, maxBytes: 180 * 1024 * 1024, bookBytes: bytes.length });
  assert.equal(job.service, undefined, 'the cloud has no local service');
  assert.ok(!JSON.stringify(job).includes(h.server.token));
  await h.finished();
  const [row] = (await h.history()).records;
  assert.equal(row.env.modelVersion, 'vlm');
  assert.equal(row.env.language, 'ch');
  assert.deepEqual(row.plan, { kind: 'chunks', maxPages: 200, maxBytes: 180 * 1024 * 1024 });
  assert.ok(!JSON.stringify(row).includes(h.server.token));
});

test('English: the environment and the service state have no Chinese outside file names and folder names', async t => {
  const h = await harness(t, { cloud: false, limits: { windowPages: 50 }, state: { dieOnFirst: 51 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 }), 'Book.pdf'), route: 'local' });
  await h.finished('failed');
  const job = (await h.jobs({ uiLanguage: 'en' }))[0];
  assert.doesNotMatch(JSON.stringify({ env: job.env, service: job.service, stage: job.stage }), han);
  assert.doesNotMatch(JSON.stringify(await h.history({ uiLanguage: 'en' })), han);
});

test('the record whitelist: environment, windows and plan are stored as plain facts and nothing else', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-env-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await openRecord(root, { id: 'job-0001', filename: 'Book.pdf', bytes: 5, pages: 50, pieces: 2, route: 'local', tier: 'basic',
    env: { kind: 'local', mineruVersion: '4.0.10', tier: 'basic', model: 'MinerU-4_models_onnx', modelsPath: 'C:\\Users\\a\\.mineru\\models', modelsRealPath: 'E:\\x', device: 'cuda', windows: { kind: 'fixed', pages: 50 }, secret: 's', token: 'T' },
    plan: { kind: 'fixed', windowPages: 50, path: 'C:\\x', text: 'THE BOOK' } });
  await closeRecord(root, 'job-0001', { status: 'complete', documentId: 'd', windows: [{ start: 1, end: 25, pages: 25, seconds: 61.5, state: 'done', text: 'SECRET', path: 'C:\\x' }, { start: 26, end: 50, pages: 25, state: 'weird' }, { start: 'x' }] });
  const raw = await readFile(join(historyDir(root), 'job-0001.json'), 'utf8');
  assert.doesNotMatch(raw, /modelsPath|modelsRealPath|secret|"token"|SECRET|THE BOOK|C:\\\\/);
  const record = JSON.parse(raw);
  assert.deepEqual(record.env, { kind: 'local', mineruVersion: '4.0.10', tier: 'basic', model: 'MinerU-4_models_onnx', device: 'cuda', windows: { kind: 'fixed', pages: 50 } });
  assert.deepEqual(record.plan, { kind: 'fixed', windowPages: 50 });
  assert.deepEqual(record.windows, [{ start: 1, end: 25, pages: 25, seconds: 61.5, state: 'done' }, { start: 26, end: 50, pages: 25 }]);
  assert.ok(Buffer.byteLength(raw) < 4096, 'a record stays small');
});
