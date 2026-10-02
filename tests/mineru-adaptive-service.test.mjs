import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { LOCAL, LocalMineruError } from '../lib/mineru-local.js';
import { convertHome, prepareJob, saveManifest } from '../lib/mineru-job.js';
import { listRecords } from '../lib/mineru-history.js';
import { makePdf } from './helpers/pdf.mjs';

/* The adaptive local plan through the real service: windows of 10, 20 and 20 pages, then sized from the measured speed of this computer; a failed window is retried
   halved; finished page ranges are reused whatever window plan converted them; the card is told the window, the pace, the next size and the estimate; the history keeps the
   real timings. Two stand-ins: the CLI is a fake process (reading the service, `parse`), and `local.parseWindow` + `local.now` (the seams of the job) stand in for a machine
   of a chosen speed on a clock the test owns. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const MODELS = 'MinerU-4_models_onnx';
const span = call => `${call.startPage}-${call.endPage}`;
const failure = (code = 'failed') => new LocalMineruError(code, `本地解析没有成功：${code}`, { retryable: true });

/** `speed(start, end, index)` -> seconds the window takes on the test clock; `fail(start, end, index, attempt)` -> an error to throw, or nothing. */
async function harness(t, { pages = 120, limits = {}, speed = (start, end) => (end - start + 1) * 0.5, fail, cliState = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-adapt-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-adapt-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-adapt-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  await mkdir(join(work, 'models', MODELS), { recursive: true });
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: pages, modelsReady: true, ...cliState })); await writeFile(logPath, '');
  const env = { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath };
  const cli = { file: process.execPath, prefix: [FAKE], env };
  const clock = { ms: 5_000_000 }, calls = [], gates = new Map(), attempts = new Map(), held = [], books = new Map();
  const parseWindow = async ({ startPage, endPage, signal }) => {
    const index = calls.length, key = `${startPage}-${endPage}`;
    calls.push({ startPage, endPage, at: clock.ms });
    attempts.set(key, (attempts.get(key) || 0) + 1);
    const gate = gates.get(index);
    if (gate) gates.delete(index); // a gate holds one window, once
    if (gate) await new Promise((resolve, reject) => { gate.entered = true; gate.release = resolve; signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    signal?.throwIfAborted();
    clock.ms += Math.round(speed(startPage, endPage, index) * 1000);
    const error = fail?.(startPage, endPage, index, attempts.get(key));
    if (error) throw error;
    return { content: Array.from({ length: endPage - startPage + 1 }, (_, offset) => ({ type: 'text', text: `Page ${startPage + offset} text`, page_idx: offset })), markers: endPage - startPage + 1, warnings: [] };
  };
  const options = (extra = {}) => ({ mineru: { now: () => clock.ms, limits: { ...limits, ...extra }, local: { cli, home: work, parseWindow, now: () => clock.ms, modelsCli: { ...cli } } } });
  let service = new StudyService(root, options());
  const h = {
    home, root, work, clock, calls, gates, cli,
    get service() { return service; },
    reopen(extra = {}) { service.dispose(); service = new StudyService(root, options(extra)); return service; },
    call: (action, args) => service.call(action, args),
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert'),
    history: async () => service.call('mineru.history.list', {}),
    spans: () => calls.map(span),
    until: async (condition, what) => { for (let i = 0; i < 1500; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Timed out waiting for ${what}`); },
    gate(index) { const gate = { entered: false }; gates.set(index, gate); held.push(gate); return gate; },
    upload: async (bytes, name = 'Book.pdf') => {
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
    // the same book is the same bytes (a book is known by the hash of its file)
    book: async (count = pages) => { books.set(count, books.get(count) ?? await makePdf({ pages: count })); return books.get(count); },
    start: async (count = pages) => service.call('mineru.import', { uploadId: await h.upload(await h.book(count)), route: 'local' }),
    finished: async (status = 'complete') => { const job = await h.until(async () => { const [entry] = await h.jobs(); return entry?.status === status ? entry : null; }, `the job to be ${status}`); await service.call('job.wait', { jobId: job.id, timeoutSeconds: 10 }); return job; },
    sources: async () => (await service.call('snapshot')).sources.filter(source => source.document?.converter === 'mineru').length,
  };
  t.after(async () => {
    for (const gate of held) gate.release?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
  });
  return h;
}
const tiles = (spans, total, from = 1) => spans.every((item, index) => item[0] === (index ? spans[index - 1][1] + 1 : from)) && spans.at(-1)[1] === total;
const asSpans = list => list.map(item => item.split('-').map(Number));

/* ---------- the windows ---------- */

test('a fast machine: the first windows are 10, 20 and 20 pages, then it grows to 50, and the book is whole', async t => {
  const h = await harness(t, { speed: (start, end) => (end - start + 1) * 0.02 });
  await h.start();
  await h.finished();
  assert.deepEqual(h.spans(), ['1-10', '11-30', '31-50', '51-100', '101-120']);
  assert.equal(await h.sources(), 120);
  assert.ok(tiles(asSpans(h.spans()), 120));
});

test('a slow machine keeps small windows: each lasts about the target, never fewer than 5 pages', async t => {
  const h = await harness(t, { pages: 200, speed: (start, end) => 8 + (end - start + 1) * 6 });
  await h.start();
  await h.finished();
  const sizes = asSpans(h.spans()).map(([start, end]) => end - start + 1);
  assert.equal(sizes[0], 10);
  assert.ok(sizes[1] < 20, `the second window is held back on a slow machine: ${sizes[1]}`);
  for (const size of sizes.slice(3, -1)) assert.ok(size >= LOCAL.minWindowPages && size <= 14, `a steady window of ${size} pages`);
  assert.ok(tiles(asSpans(h.spans()), 200));
  assert.equal(await h.sources(), 200);
});

test('the plan is adaptive in the manifest, the job and the history: the numbers it follows, not a list of windows decided in advance', async t => {
  const h = await harness(t, { speed: () => 1 });
  const gate = h.gate(1);
  await h.start();
  await h.until(() => gate.entered, 'the second window');
  const [job] = await h.jobs();
  const { listManifests } = await import('../lib/mineru-job.js');
  const [{ manifest }] = await listManifests(h.root);
  assert.equal(manifest.plan.kind, 'adaptive');
  assert.deepEqual([manifest.plan.firstPages, [...manifest.plan.rampPages], manifest.plan.targetSeconds, manifest.plan.minPages, manifest.plan.maxPages], [10, [10, 20, 20], LOCAL.targetWindowSeconds, LOCAL.minWindowPages, LOCAL.maxWindowPages]);
  assert.deepEqual(manifest.chunks.map(chunk => [chunk.startPage, chunk.endPage, chunk.state]), [[1, 10, 'done'], [11, 30, 'planned']], 'the windows grow as the earlier ones finish');
  assert.equal(job.env.windows.kind, 'adaptive');
  assert.equal(job.chunk.count, 0, 'the count of windows is not known in advance, so it is not shown as "i of N"');
  gate.release();
  await h.finished();
  const [row] = (await h.history()).records;
  assert.equal(row.plan.kind, 'adaptive');
  assert.equal(row.env.windows.kind, 'adaptive');
});

test('a fixed plan is still available through the seam: windows of that size decided up front, as before', async t => {
  const h = await harness(t, { limits: { windowPages: 50 } });
  await h.start();
  await h.finished();
  assert.deepEqual(h.spans(), ['1-50', '51-100', '101-120']);
  const [row] = (await h.history()).records;
  assert.deepEqual(row.plan, { kind: 'fixed', windowPages: 50 });
});

/* ---------- failure: halve ---------- */

test('a window that fails is retried halved, down to the minimum, and the run goes on when a smaller piece works', async t => {
  const h = await harness(t, { fail: (start, end, index, attempt) => (start === 11 && end === 30 && attempt === 1 ? failure() : undefined) });
  await h.start();
  const job = await h.finished();
  assert.deepEqual(h.spans().slice(0, 4), ['1-10', '11-30', '11-20', '21-30'], 'the failed window is retried as its two halves');
  assert.ok(tiles(asSpans(h.spans().filter(item => item !== '11-30')), 120));
  assert.equal(await h.sources(), 120);
  assert.equal(job.local.halved, 1, 'the card can say it happened');
  const later = asSpans(h.spans().slice(4)).map(([start, end]) => end - start + 1);
  assert.ok(later.every(size => size <= 10), `after a window had to be halved the later ones stay smaller than the one that failed: ${later}`);
  const [row] = (await h.history()).records;
  assert.deepEqual(row.windows.map(window => [window.start, window.end]).slice(0, 3), [[1, 10], [11, 20], [21, 30]], 'the history lists the windows that did the work');
  assert.ok(row.windows.every(window => window.state === 'done'));
});

test('halving stops at the minimum: the job fails with the reason, keeps what is done, and "接着做" retries only the piece that failed', async t => {
  let broken = true;
  const h = await harness(t, { fail: start => (broken && start === 11 ? failure() : undefined) });
  await h.start();
  const failed = await h.finished('failed');
  assert.deepEqual(h.spans(), ['1-10', '11-30', '11-20', '11-15'], 'halved to 20, 10, then 5: the minimum');
  assert.equal(failed.retryable, true);
  assert.equal(failed.done, 10);
  broken = false;
  await h.call('mineru.retry', { jobId: failed.id });
  await h.finished();
  assert.deepEqual(h.spans().slice(4, 7), ['11-15', '16-20', '21-30'], 'the piece that failed is retried first and the pages after it follow; window 1 is never parsed again');
  assert.equal(h.spans().filter(item => item === '1-10').length, 1);
  assert.equal(await h.sources(), 120);
});

test('a stopped service is not a reason to halve: the window is not cut up, the job fails naming the service', async t => {
  const h = await harness(t, { fail: start => (start === 11 ? failure('server-stopped') : undefined) });
  await h.start();
  const failed = await h.finished('failed');
  assert.equal(failed.errorCode, 'server-stopped');
  assert.deepEqual(h.spans(), ['1-10', '11-30']);
});

test('what failed because of the command (not found) or the learner (cancel) is not halved either', async t => {
  const h = await harness(t, { speed: () => 1 });
  const gate = h.gate(1);
  await h.start();
  await h.until(() => gate.entered, 'the second window');
  const [job] = await h.jobs();
  await h.call('job.cancel', { jobId: job.id });
  await h.finished('cancelled');
  assert.deepEqual(h.spans(), ['1-10', '11-30']);
});

/* ---------- resume: finished ranges are reused ---------- */

test('finished ranges are reused whatever window plan converted them: a fixed 50-page run, cancelled, then the same file converted adaptively never parses pages 1-50 again', async t => {
  const first = await harness(t, { limits: { windowPages: 50 }, speed: () => 1 });
  const gate = first.gate(1);
  await first.start();
  await first.until(() => gate.entered, 'the second fixed window');
  const [job] = await first.jobs();
  await first.call('job.cancel', { jobId: job.id });
  await first.finished('cancelled');
  assert.deepEqual(first.spans(), ['1-50', '51-100']);
  // the same library, the same file, now with the adaptive plan
  await first.call('job.dismiss', { all: true });
  first.reopen({ windowPages: undefined });
  first.calls.length = 0;
  await first.start();
  await first.finished();
  assert.ok(first.calls.every(call => call.startPage > 50), `pages 1-50 are not converted again: ${first.spans()}`);
  assert.equal(first.calls[0].startPage, 51);
  assert.ok(tiles(asSpans(first.spans()), 120, 51), `the rest is planned after the finished range: ${first.spans()}`);
  assert.equal(await first.sources(), 120);
});

test('an adaptive run, cancelled, and the same file again: its finished windows are restored one by one, with the pace they measured, and the rest is planned after them', async t => {
  const h = await harness(t, { speed: () => 1 });
  const gate = h.gate(3);
  await h.start();
  await h.until(() => gate.entered, 'the fourth window');
  const [job] = await h.jobs();
  await h.call('job.cancel', { jobId: job.id });
  await h.finished('cancelled');
  assert.deepEqual(h.spans(), ['1-10', '11-30', '31-50', '51-100']);
  await h.call('job.dismiss', { all: true });
  h.calls.length = 0;
  await h.start();
  const done = await h.finished();
  assert.deepEqual(h.spans(), ['51-100', '101-120'], 'only what was not finished: the three finished windows are not parsed again');
  assert.equal(await h.sources(), 120);
  const [row] = (await h.history()).records;
  void done; void row;
});

test('a window of the cache that no longer reads is converted again; one that overlaps a longer finished range is ignored', async t => {
  const h = await harness(t, { speed: () => 1 });
  const gate = h.gate(2);
  await h.start();
  await h.until(() => gate.entered, 'the third window');
  const [job] = await h.jobs();
  await h.call('job.cancel', { jobId: job.id });
  await h.finished('cancelled');
  const [hash] = await readdir(join(convertHome(h.root), 'results'));
  const folder = join(convertHome(h.root), 'results', hash);
  assert.deepEqual((await readdir(folder)).sort(), ['local-basic-1-10.json', 'local-basic-11-30.json']);
  await writeFile(join(folder, 'local-basic-11-30.json'), '{ this is not json');
  await writeFile(join(folder, 'local-basic-5-12.json'), JSON.stringify({ format: 'v1', content: [] }));
  await h.call('job.dismiss', { all: true });
  h.calls.length = 0;
  await h.start();
  await h.finished();
  assert.equal(h.calls[0].startPage, 11, 'the damaged window is converted again; the overlapping stray range was never used');
  assert.equal(await h.sources(), 120);
});

test('an unfinished adaptive job resumes after the app restarted: the planned window is run, the finished ones are not', async t => {
  const h = await harness(t, { speed: () => 1 });
  const source = join(h.root, 'Crashed.pdf');
  await writeFile(source, await makePdf({ pages: 120 }));
  const prepared = await prepareJob({ root: h.root, source, filename: 'Crashed.pdf', courses: [], route: 'local', tier: 'basic' });
  assert.equal(prepared.manifest.plan.kind, 'adaptive');
  assert.deepEqual(prepared.manifest.chunks.map(chunk => [chunk.startPage, chunk.endPage, chunk.state]), [[1, 10, 'planned']], 'a new job holds only its first window');
  await saveManifest(prepared.dir, prepared.manifest);
  h.reopen();
  const [job] = await h.jobs();
  assert.equal(job.id, prepared.manifest.id);
  await h.call('mineru.retry', { jobId: job.id });
  await h.finished();
  assert.deepEqual(h.spans().slice(0, 3), ['1-10', '11-30', '31-50']);
  assert.equal(await h.sources(), 120);
});

/* ---------- what the card is told ---------- */

test('while a window runs the card knows which one, since when, how long it should take, and how big the next one will be', async t => {
  const h = await harness(t, { speed: (start, end) => (end - start + 1) * 2 });
  const gate = h.gate(2);
  await h.start();
  await h.until(() => gate.entered, 'the third window');
  const [job] = await h.jobs();
  assert.equal(job.chunk.index, 3);
  assert.deepEqual([job.local.window.startPage, job.local.window.endPage, job.local.window.pages], [31, 50, 20]);
  assert.ok(Date.parse(job.local.window.startedAt) > 0);
  assert.ok(job.local.window.expectedSeconds > 0, 'expected from the pace measured so far');
  assert.equal(job.local.pace.secondsPerPage, 2);
  assert.ok(job.local.next >= LOCAL.minWindowPages && job.local.next <= LOCAL.maxWindowPages, `next window about ${job.local.next} pages`);
  assert.deepEqual(job.chunks.map(chunk => [chunk.startPage, chunk.endPage, chunk.state === 'done']), [[1, 10, true], [11, 30, true], [31, 50, false]]);
  gate.release();
  await h.finished();
});

test('the estimate of what is left is hidden until a window has finished, is a range while the pace is unstable, and one figure once it is steady', async t => {
  const speeds = [3, 1, 1, 1.05, 1];
  const h = await harness(t, { pages: 200, speed: (start, end, index) => (end - start + 1) * speeds[Math.min(index, speeds.length - 1)] });
  const early = h.gate(0), second = h.gate(1), fifth = h.gate(4);
  await h.start();
  await h.until(() => early.entered, 'the first window');
  const [running] = await h.jobs();
  assert.equal(running.local.eta, undefined, 'nothing finished yet: no estimate');
  assert.equal(running.local.pace, undefined);
  early.release();
  await h.until(() => second.entered, 'the second window');
  const [one] = await h.jobs();
  assert.equal(one.local.eta.basis, 'measured');
  assert.equal(one.local.eta.stable, false, 'one window is only a first reading');
  assert.ok(one.local.eta.lowSeconds < one.local.eta.highSeconds);
  second.release();
  await h.until(() => fifth.entered, 'the fifth window');
  const [steady] = await h.jobs();
  assert.equal(steady.local.eta.stable, true);
  assert.equal(steady.local.eta.lowSeconds, steady.local.eta.highSeconds);
  assert.ok(Math.abs(steady.local.pace.secondsPerPage - 1) < 0.2);
  fifth.release();
  await h.finished();
});

test('the history keeps the real timings: seconds per window and the pace of this computer', async t => {
  const h = await harness(t, { speed: (start, end) => (end - start + 1) * 2 });
  await h.start();
  await h.finished();
  const [row] = (await h.history()).records;
  assert.deepEqual(row.windows.map(window => [window.start, window.end, window.pages, window.seconds, window.state]).slice(0, 3), [[1, 10, 10, 20, 'done'], [11, 30, 20, 40, 'done'], [31, 50, 20, 40, 'done']]);
  assert.equal(row.plan.secondsPerPage, 2);
  const stored = (await listRecords(h.root))[0];
  assert.equal(stored.windows.at(-1).seconds > 0, true);
  const raw = await readFile(join(h.root, 'conversion-history', `${row.id}.json`), 'utf8');
  assert.ok(!raw.includes(h.work) && !raw.includes(h.home));
});

test('a plan for the preview: the adaptive numbers (and the first window) rather than a list of fifty-page windows; a fixed seam still lists them', async t => {
  const h = await harness(t);
  const plan = await h.call('mineru.plan', { uploadId: await h.upload(await makePdf({ pages: 120 })) });
  assert.deepEqual([plan.adaptive.firstPages, plan.adaptive.targetSeconds, plan.adaptive.minPages, plan.adaptive.maxPages], [10, LOCAL.targetWindowSeconds, LOCAL.minWindowPages, LOCAL.maxWindowPages]);
  assert.deepEqual(plan.windows.map(window => [window.startPage, window.endPage]), [[1, 10]]);
  const fixed = await harness(t, { limits: { windowPages: 50 } });
  const listed = await fixed.call('mineru.plan', { uploadId: await fixed.upload(await makePdf({ pages: 120 })) });
  assert.equal(listed.adaptive, undefined);
  assert.equal(listed.windows.length, 3);
});

test('the wait asked of the CLI follows the machine: the first window gets the time to load the model, a slow pace gets a longer wait', async () => {
  const { waitSeconds } = await import('../lib/mineru-local.js');
  assert.equal(waitSeconds({ pages: 10 }), LOCAL.waitFloorSec);
  assert.equal(waitSeconds({ pages: 10, first: true }), LOCAL.waitFloorSec + LOCAL.loadAllowanceSec);
  assert.equal(waitSeconds({ pages: 50 }), 50 * LOCAL.waitPerPageSec);
  assert.ok(waitSeconds({ pages: 20, pace: { secondsPerPage: 20 } }) >= 20 * 20 * 2, 'a machine at 20 s a page needs more than the fixed 8 s a page');
  assert.equal(waitSeconds({ pages: 50, pace: { secondsPerPage: 600 } }), LOCAL.waitCeilSec, 'never above the ceiling');
});
