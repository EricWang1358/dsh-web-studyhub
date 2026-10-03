import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { convertHome } from '../lib/mineru-job.js';
import { LOCAL_MESSAGES } from '../lib/mineru-local.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* The local mineru route through the real service: detection, the explicit start/setup steps, page windows as one job in the
   shared job list, retry of only the failed window, cancel, and the choice between local and cloud. The CLI is a fake. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const han = /[㐀-鿿]/;

async function harness(t, { state = {}, cloud = false, noCli = false, pages = 120 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-local-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-local-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-local-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: pages, modelsReady: true, ...state })); await writeFile(logPath, '');
  const env = { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath };
  const cli = { file: process.execPath, prefix: [FAKE], env };
  const fake = cloud ? await startFakeMineru() : null;
  const clock = { time: 9_000_000 };
  // (`windowPages` is the seam for fixed local windows: these tests count windows of 50 pages; the adaptive plan has its own tests, tests/mineru-adaptive-*.test.mjs.)
  const service = new StudyService(root, { mineru: { ...(fake ? { baseUrl: fake.baseUrl } : {}), now: () => clock.time, limits: { windowPages: 50 },
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); },
    local: { cli: noCli ? null : cli, home: work, modelsCli: { file: process.execPath, prefix: [FAKE], env } } } });
  const h = {
    home, root, work, fake, service,
    call: (action, args) => service.call(action, args),
    set: async patch => writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')), ...patch })),
    state: async () => JSON.parse(await readFile(statePath, 'utf8')),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    parses: async () => (await h.log()).filter(entry => entry.argv[0] === 'parse'),
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert'),
    until: async (condition, what) => { for (let i = 0; i < 1500; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Timed out waiting for ${what}`); },
    upload: async bytes => {
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
  };
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    service.dispose(); await fake?.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return h;
}
const pagesArg = entry => entry.argv[entry.argv.indexOf('--pages') + 1];
async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path)); else found.push(path);
  }
  return found;
}

/* ---------- state ---------- */

test('mineru.local.status reports one honest state with its next step, from read-only calls', async t => {
  const missing = await harness(t, { noCli: true });
  assert.deepEqual(await missing.call('mineru.local.status').then(s => [s.state, s.next]), ['not-installed', 'install']);
  const fresh = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: true, modelsReady: false } });
  const needs = await fresh.call('mineru.local.status');
  assert.deepEqual([needs.state, needs.next], ['needs-models', 'download-models']);
  assert.equal(needs.modelsMbByTier.basic, 800);
  assert.equal(needs.modelsMbByTier.standard, 1200);
  const stopped = await harness(t, { state: { running: false } });
  assert.deepEqual(await stopped.call('mineru.local.status').then(s => [s.state, s.next]), ['server-stopped', 'start-server']);
  // A stopped service cannot say how it is configured, so a never-configured one is also just "stopped" until it is started.
  const stoppedFresh = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false } });
  assert.deepEqual(await stoppedFresh.call('mineru.local.status').then(s => [s.state, s.next]), ['server-stopped', 'start-server']);
  const unread = await harness(t, { state: { running: true, configFails: true } });
  assert.deepEqual(await unread.call('mineru.local.status').then(s => [s.state, s.next]), ['unknown', 'recheck']);
  const ready = await harness(t);
  const status = await ready.call('mineru.local.status');
  assert.deepEqual([status.state, status.tier, status.version], ['ready', 'basic', '4.0.10']);
  assert.deepEqual(status.estimates, { basic: 1.6, standard: 2.5 });
  assert.equal(status.windowPages, 50);
  const argvs = (await ready.log()).map(entry => entry.argv[0]);
  assert.ok(argvs.every(name => ['--version', 'config', 'server'].includes(name)), `only read-only calls: ${argvs}`);
  assert.ok(!(await ready.log()).some(entry => entry.argv[1] === 'start'));
});

test('starting the stopped service is an explicit step; its failure is a plain message', async t => {
  const h = await harness(t, { state: { running: false } });
  assert.equal((await h.state()).running, false, 'detection did not start it');
  await h.call('mineru.local.status');
  assert.equal((await h.state()).running, false);
  const started = await h.call('mineru.local.start', {});
  assert.equal(started.state, 'ready');
  const broken = await harness(t, { state: { running: false, startFails: true } });
  await assert.rejects(broken.call('mineru.local.start', {}), /端口/);
  const fresh = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false } });
  const afterStart = await fresh.call('mineru.local.start', {});
  assert.deepEqual([afterStart.state, afterStart.next], ['needs-models', 'download-models'], 'only with the service up can its settings be read');
  const english = await harness(t, { state: { running: false, startFails: true } }).then(e => e.call('mineru.local.start', { uiLanguage: 'en' }).catch(error => error.message));
  assert.match(english, /could not start/);
});

test('setup is confirmed first, sized, runs in the background, and ends with a ready local mineru', async t => {
  const h = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false } });
  await assert.rejects(h.call('mineru.local.setup', { tier: 'basic' }), /确认.*800 MB/);
  assert.deepEqual((await h.log()).filter(entry => entry.argv[0] === '--tier'), [], 'nothing was downloaded without the confirmation');
  await assert.rejects(h.call('mineru.local.setup', { tier: 'giant', confirm: true }), /basic 或 standard/);
  const started = await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  assert.equal(started.status, 'running');
  assert.equal(started.modelsMb, 800);
  const done = await h.until(async () => { const run = await h.call('mineru.local.setup.status'); return run.status === 'complete' ? run : null; }, 'the setup');
  assert.equal(done.state.state, 'ready');
  const calls = (await h.log()).map(entry => entry.argv.join(' '));
  const start = calls.findIndex(call => call === 'server start'), download = calls.findIndex(call => call.startsWith('--tier basic')), tierSet = calls.findIndex(call => call.includes('managed_tier basic')), modeSet = calls.findIndex(call => call.includes('parse_server.local.mode managed')), restart = calls.findIndex(call => call === 'server restart');
  assert.ok(start >= 0 && start < tierSet, `settings live in the service, so a stopped one is started before any config set: ${calls.join(' | ')}`);
  assert.ok(download >= 0 && download < tierSet && tierSet < modeSet && modeSet < restart, `models, then the tier, then the mode, then the service restarts to use it: ${calls.join(' | ')}`);
  assert.equal((await h.call('mineru.local.status')).state, 'ready');
});

test('a failed model download changes nothing and says why', async t => {
  const h = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false, downloadFails: true } });
  await h.call('mineru.local.setup', { tier: 'standard', confirm: true });
  const failed = await h.until(async () => { const run = await h.call('mineru.local.setup.status'); return run.status === 'failed' ? run : null; }, 'the failure');
  assert.match(failed.error, /模型没能下载/);
  const state = await h.state();
  assert.deepEqual([state.mode, state.tier], ['disabled', 'flash'], 'nothing was configured');
});

test('the setup can be cancelled, which stops the download', async t => {
  const h = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false, downloadDelayMs: 60_000 } });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await h.until(async () => (await h.log()).some(entry => entry.argv[0] === '--tier'), 'the download to start');
  const cancelled = await h.call('mineru.local.setup.cancel');
  const done = await h.until(async () => { const run = await h.call('mineru.local.setup.status'); return run.status === 'cancelled' ? run : null; }, 'the cancel');
  assert.equal(done.status, 'cancelled');
  assert.ok(cancelled);
  assert.equal((await h.state()).mode, 'disabled');
});

/* ---------- converting ---------- */

test('a 120-page PDF is parsed locally in windows of 50 pages as one job, with nothing uploaded and no token', async t => {
  const h = await harness(t);
  const uploadId = await h.upload(await makePdf({ pages: 120 }));
  const plan = await h.call('mineru.plan', { uploadId });
  assert.deepEqual(plan.windows.map(piece => [piece.startPage, piece.endPage]), [[1, 50], [51, 100], [101, 120]]);
  assert.deepEqual(plan.localEstimateSeconds, { basic: 192, standard: 300 });
  const started = await h.call('mineru.import', { uploadId, route: 'local', courses: ['Databases'] });
  assert.equal(started.chunks.length, 3);
  const seen = [];
  const finished = await h.until(async () => {
    const [job] = await h.jobs();
    if (job) seen.push({ done: job.done, phase: job.phase, index: job.chunk?.index, count: job.chunk?.count, route: job.route });
    return job?.status === 'complete' ? job : null;
  }, 'the conversion');
  await h.call('job.wait', { jobId: finished.id, timeoutSeconds: 10 });
  assert.equal(finished.route, 'local');
  assert.equal(finished.sourceIds.length, 120);
  assert.ok(seen.some(entry => entry.phase === 'local' && entry.count === 3), 'says which piece of N it is on');
  assert.ok(seen.every(entry => [0, 50, 100, 120].includes(entry.done)), `progress is windows completed, never a fake percentage inside a window: ${[...new Set(seen.map(entry => entry.done))]}`);
  const parses = await h.parses();
  assert.deepEqual(parses.map(pagesArg), ['1-50', '51-100', '101-120'], '--pages is always given, and consecutive');
  assert.ok(parses.every(entry => !entry.argv.includes('--remote') && entry.argv[entry.argv.indexOf('--tier') + 1] === 'basic'));
  const state = await h.call('snapshot');
  const sources = state.sources.filter(source => source.document?.converter === 'mineru');
  assert.equal(sources.length, 120);
  assert.deepEqual(sources[0].courses, ['Databases']);
  // The snapshot carries lengths; the stored text comes from the export.
  const stored = new Map((await h.call('export')).sources.map(item => [item.id, item.text]));
  assert.match(stored.get(sources[50].id), /第 51 页的正文/);
  assert.ok(!sources.some(source => /doc:5008352/.test(stored.get(source.id))), 'no broken image links');
  assert.ok(finished.warnings.some(text => text === LOCAL_MESSAGES.headerFooter), 'the header/footer caveat is stated once');
  assert.equal(state.inbox.items.filter(item => item.kind === 'pdf-result').length, 1);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'jobs')), []);
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'uploads')), []);
});

test('blank pages and CRLF Markdown still give the right page count', async t => {
  const h = await harness(t, { state: { blank: [3], crlf: true }, pages: 6 });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 6 })), route: 'local' });
  const job = await h.until(async () => { const [entry] = await h.jobs(); return entry?.status === 'complete' ? entry : null; }, 'the conversion');
  assert.equal(job.total, 6);
  const sources = (await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru');
  assert.equal(sources.length, 5);
  assert.equal(sources[0].document.totalPages, 6);
  assert.deepEqual(job.skippedPages, [3]);
});

test('a window that fails stops the job; "接着做" redoes only that window and the ones after it', async t => {
  const h = await harness(t, { state: { failWindowsOnce: [51] } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const failed = await h.until(async () => { const [job] = await h.jobs(); return job?.status === 'failed' ? job : null; }, 'the failure');
  await h.call('job.wait', { jobId: failed.id, timeoutSeconds: 10 });
  assert.equal(failed.retryable, true);
  assert.match(failed.stage, /本地解析没有成功/);
  assert.equal(failed.done, 50, 'the first window still counts');
  assert.deepEqual((await h.parses()).map(pagesArg), ['1-50', '51-100']);
  await h.call('mineru.retry', { jobId: failed.id });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the retry');
  assert.deepEqual((await h.parses()).map(pagesArg), ['1-50', '51-100', '51-100', '101-120'], 'window 1 is never parsed again');
  assert.equal((await h.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru').length, 120);
});

test('the service dying mid-run is named, offers the restart, and the job resumes after it', async t => {
  const h = await harness(t, { state: { dieOnFirst: 51 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const failed = await h.until(async () => { const [job] = await h.jobs(); return job?.status === 'failed' ? job : null; }, 'the failure');
  assert.equal(failed.errorCode, 'server-stopped');
  assert.equal(failed.stage, LOCAL_MESSAGES.serverStopped);
  assert.equal((await h.call('mineru.local.status')).state, 'server-stopped');
  await h.set({ dieOnFirst: 0 });
  assert.equal((await h.call('mineru.local.start', { restart: true })).state, 'ready');
  await h.call('mineru.retry', { jobId: failed.id });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the resumed run');
  assert.deepEqual((await h.parses()).map(pagesArg), ['1-50', '51-100', '51-100', '101-120']);
});

test('cancel stops the running window promptly, kills the process and cleans the temporary files', async t => {
  const h = await harness(t, { state: { delayMs: 60_000 } });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const running = await h.until(async () => { const [job] = await h.jobs(); return job?.phase === 'local' && (await h.parses()).length ? job : null; }, 'the first window to run');
  const started = Date.now();
  await h.call('job.cancel', { jobId: running.id });
  await h.until(async () => (await h.jobs())[0]?.status === 'cancelled', 'the cancel');
  assert.ok(Date.now() - started < 10_000);
  const pid = (await h.parses())[0].pid;
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch (error) { alive = error.code !== 'ESRCH'; } }
  assert.equal(alive, false, 'the child process is gone');
  assert.deepEqual(await filesUnder(join(convertHome(h.root), 'jobs')), []);
  assert.equal((await h.call('snapshot')).inbox.items.filter(item => item.kind.startsWith('pdf-')).length, 0);
});

test('the local route is refused, before anything runs, unless it is ready', async t => {
  const stopped = await harness(t, { state: { running: false } });
  await assert.rejects(stopped.call('mineru.import', { uploadId: await stopped.upload(await makePdf({ pages: 3 })), route: 'local' }), error => error.message === LOCAL_MESSAGES.serverStopped);
  assert.deepEqual(await stopped.parses(), []);
  const none = await harness(t, { noCli: true });
  await assert.rejects(none.call('mineru.import', { uploadId: await none.upload(await makePdf({ pages: 3 })), route: 'local' }), error => error.message === LOCAL_MESSAGES.notInstalled);
  const fresh = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: true } });
  await assert.rejects(fresh.call('mineru.import', { uploadId: await fresh.upload(await makePdf({ pages: 3 })), route: 'local' }), error => error.message === LOCAL_MESSAGES.setupNeedsModels);
  const freshStopped = await harness(t, { state: { mode: 'disabled', tier: 'flash', running: false } });
  await assert.rejects(freshStopped.call('mineru.import', { uploadId: await freshStopped.upload(await makePdf({ pages: 3 })), route: 'local' }), error => error.message === LOCAL_MESSAGES.serverStopped, 'a stopped service is never reported as missing models');
  const unread = await harness(t, { state: { running: true, configFails: true } });
  await assert.rejects(unread.call('mineru.import', { uploadId: await unread.upload(await makePdf({ pages: 3 })), route: 'local' }), error => error.message === LOCAL_MESSAGES.unreadable);
  await assert.rejects(fresh.call('mineru.import', { uploadId: await fresh.upload(await makePdf({ pages: 3 })), route: 'nonsense' }), /route/);
});

test('"auto" prefers the local route when it is ready and falls back to the cloud, which still needs its token and confirmation', async t => {
  const h = await harness(t, { cloud: true, pages: 3 });
  const local = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'auto' });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the local conversion');
  assert.equal((await h.jobs())[0].route, 'local');
  assert.equal(h.fake.requests.length, 0, 'nothing went to the cloud');
  assert.ok(local.jobId);
  await h.set({ running: false });
  await h.call('job.dismiss', { all: true });
  await assert.rejects(h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'auto' }), /MinerU 令牌/);
  await h.call('mineru.settings.set', { token: h.fake.token, acknowledge: true });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'auto' });
  await h.until(async () => (await h.jobs())[0]?.status === 'complete', 'the cloud conversion');
  assert.equal((await h.jobs())[0].route, 'cloud');
  assert.ok(h.fake.uploads.length >= 1);
});

test('the local route in English: no Chinese in stages, notes or status', async t => {
  const h = await harness(t, { state: { delayMs: 40 }, pages: 120 });
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 120 })), route: 'local' });
  const texts = new Set();
  await h.until(async () => {
    const job = (await h.call('snapshot', { uiLanguage: 'en' })).jobs.find(entry => entry.type === 'pdf-convert');
    if (job) { texts.add(job.stage); for (const warning of job.warnings || []) texts.add(warning); }
    return job?.status === 'complete';
  }, 'the conversion');
  assert.ok(texts.size >= 2);
  for (const text of texts) assert.doesNotMatch(text, han, text);
  assert.ok([...texts].some(text => /converting locally/.test(text)));
});
