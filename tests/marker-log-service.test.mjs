import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { MARKER_TEXT } from '../lib/marker-local.js';
import { makePdf } from './helpers/pdf.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

/* The log of a Marker conversion, through the real service with a stand-in Marker (tests/helpers/fake-marker-cli.mjs): a successful run reads as a story (the program,
   one start and one end line per window with the pages done and the time, what Marker printed with its progress bars collapsed, the merge, the save, a summary), a failed
   one keeps the real cause in the log and in the failure the 转换详情 reads, and nothing in either names a folder of this computer. Runs with the switch off and on
   (marker-log-service.runtime.test.mjs). */

const fake = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
async function harness(t, state = {}, { limits = {}, timeoutMs } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'marker-log-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(folder, 'home');
  const root = join(folder, 'library'), statePath = join(folder, 'state.json'), log = join(folder, 'log.jsonl');
  await writeFile(statePath, JSON.stringify(state)); await writeFile(log, '');
  const cli = { file: process.execPath, prefix: [fake], env: { FAKE_MARKER_STATE: statePath, FAKE_MARKER_LOG: log } };
  const service = new StudyService(root, { ...switchOptions(SWITCH_MODE, { paths: ['pdfConvert'] }), marker: { limits, local: { cli, ...(timeoutMs ? { timeoutMs } : {}) } } });
  t.after(async () => { service.dispose(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const call = (name, args) => service.call(name, args);
  const job = async () => (await call('snapshot')).jobs.find(item => item.type === 'pdf-convert');
  const h = {
    folder, call, job,
    runs: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    until: async condition => { for (let i = 0; i < 3000; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out'); },
    import: async pages => {
      const bytes = await makePdf({ pages });
      const { uploadId, chunkBytes } = await call('mineru.upload.start', { name: 'Security Architecture.pdf', size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await call('mineru.upload.finish', { uploadId });
      return call('marker.import', { uploadId });
    },
  };
  h.ended = async () => { const ended = await h.until(async () => { const item = await job(); return ['complete', 'failed', 'cancelled'].includes(item?.status) && item; }); await call('job.wait', { jobId: ended.id }); return job(); };
  return h;
}
const eventsOf = item => (item.contract?.events || []).filter(event => event.code);
const codes = item => eventsOf(item).map(event => event.code);
const range = args => args[args.indexOf('--page_range') + 1].split('-').map(Number);
/** Nothing of this computer's folders: not the temporary folder, not the library, not the user's home. */
const noFolders = (text, h) => { for (const part of [h.folder, tmpdir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean)) assert.ok(!text.includes(part), `"${part}" leaked into: ${text.slice(0, 300)}`); };

test('a 198-page Marker conversion logs one start and one end per adaptive window, Marker\'s own collapsed output, the merge, the save and a summary', async t => {
  const h = await harness(t, { progress: true });
  await h.import(198);
  const done = await h.ended();
  assert.equal(done.status, 'complete', done.stage);
  const runs = await h.runs(), events = eventsOf(done);
  assert.ok(runs.length >= 3, `adaptive windows: ${runs.length}`);
  assert.deepEqual(range(runs[0]), [0, 9], 'the first window is small');
  const starts = events.filter(event => event.code === 'window-start'), ends = events.filter(event => event.code === 'window-end');
  assert.equal(starts.length, runs.length); assert.equal(ends.length, runs.length);
  assert.deepEqual(ends.map(event => [event.args.start, event.args.end]), runs.map(args => range(args).map(page => page + 1)), 'the end lines name the pages Marker was asked for');
  const done2 = ends.map(event => event.args.done);
  assert.deepEqual(done2, [...done2].sort((a, b) => a - b), 'the pages done only go up'); assert.equal(done2.at(-1), 198);
  assert.ok(ends.every(event => event.args.total === 198 && event.args.seconds >= 0));
  assert.ok(ends.slice(0, -1).some(event => Number.isFinite(event.args.etaSeconds)), 'the time left is estimated from the pace so far');
  const start = events.find(event => event.code === 'convert-start');
  assert.deepEqual([start.args.converter, start.args.route, start.args.pages, start.args.windows?.kind, start.args.origin], ['marker', 'local', 198, 'adaptive', 'test']);
  const said = events.filter(event => event.code === 'tool-output').map(event => event.text);
  assert.ok(said.some(text => /^Recognizing layout: 100% \(\d+\/\d+\)$/.test(text)), said.slice(0, 5).join(' | '));
  assert.equal(said.filter(text => text.startsWith('Recognizing layout')).length, runs.length, 'each bar is one line per window, not one per redraw');
  assert.ok(said.some(text => /Loading models from layout$/.test(text)), 'a printed path keeps only its last part');
  const order = codes(done).filter(code => ['convert-start', 'merge', 'save', 'convert-end'].includes(code));
  assert.deepEqual(order, ['convert-start', 'merge', 'save', 'convert-end']);
  const end = events.find(event => event.code === 'convert-end');
  assert.equal(end.level, 'done'); assert.equal(end.args.windows, runs.length); assert.equal(end.args.retries, 0); assert.equal(end.args.pages, 198);
  assert.ok(end.args.chars > 0 && end.args.seconds >= 0 && end.args.title);
  assert.equal(events.find(event => event.code === 'save').args.pages, 198);
  noFolders(JSON.stringify(events), h);
  assert.ok(events.length < 200, `bounded: ${events.length} lines`);
  assert.equal(done.done, 198);
});

test('a Marker 2.x without Docker: the cause in both ways out, in the stage, the window, the log and the failure the 转换详情 reads; nothing of this computer', async t => {
  const h = await harness(t, { failStart: 0, traceback: 'docker' });
  await h.import(12);
  const failed = await h.ended();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'marker-needs-docker');
  assert.equal(failed.stage, MARKER_TEXT.needsDocker(2));
  assert.equal(failed.failure.fix, 'settings', 'only a change outside the job helps: the console leads to the settings');
  assert.equal(failed.retryable, true, 'after Docker is started, 接着做 continues');
  assert.equal(failed.failure.exitCode, 1);
  assert.match(failed.failure.lines.at(-1), /^surya\.inference\.backends\.spawn\.SpawnError: docker run failed/);
  assert.ok(failed.failure.lines.some(line => /File "vllm\.py", line 195/.test(line)));
  const events = eventsOf(failed), last = events.find(event => event.code === 'convert-failed');
  assert.equal(last.level, 'error'); assert.equal(last.text, failed.stage); assert.deepEqual(last.args.lines, failed.failure.lines);
  assert.ok(events.some(event => event.code === 'window-failed' && event.args.exitCode === 1 && event.args.start === 1));
  assert.equal(failed.contract.detail.failure?.summary ?? failed.failure.summary, failed.stage);
  noFolders(JSON.stringify({ events, failure: failed.failure, stage: failed.stage, chunks: failed.chunks }), h);
  assert.doesNotMatch(JSON.stringify(failed.failure), /Learner Name|StudyHub-Marker|site-packages/);
});

test('any other crash keeps the exception (the last line of the traceback) with the exit code, not the first frames', async t => {
  const h = await harness(t, { failStart: 0, traceback: 'cuda' });
  await h.import(4);
  const failed = await h.ended();
  assert.equal(failed.status, 'failed');
  assert.match(failed.stage, /^Marker 退出码 1：torch\.OutOfMemoryError: CUDA out of memory\. Tried to allocate 2\.00 GiB/);
  assert.equal(failed.failure.fix, undefined);
  assert.match(failed.chunks.find(chunk => chunk.error)?.error || '', /torch\.OutOfMemoryError/, 'the window keeps the cause too');
  assert.doesNotMatch(JSON.stringify(failed.failure), /Learner Name|marker-env/);
});

test('a window that runs too long says so in the log', async t => {
  const h = await harness(t, { delayStart: 0 }, { timeoutMs: 400 });
  await h.import(4);
  const failed = await h.ended();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'timeout');
  const events = eventsOf(failed);
  assert.ok(events.some(event => event.code === 'window-failed' && /用时过长/.test(event.text)));
  assert.ok(events.some(event => event.code === 'convert-failed' && event.level === 'error'));
  assert.equal(failed.failure.fix, undefined, 'a timeout is retried with 接着做, not fixed in the settings');
});
