import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { makePdf } from './helpers/pdf.mjs';

/* What a running local window says about itself, through the real service and a fake CLI that really takes its time: the job card gets one honest state from READ-ONLY questions to
   the service (never from polling the parse itself), and nothing is asked while no window runs. The fake CLI keeps a record of every call. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));

async function harness(t, { cliState = {}, limits = {}, pages = 10, holdFinish = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-live-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-live-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-live-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  await mkdir(join(work, 'models', 'MinerU-4_models_onnx'), { recursive: true });
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl'), finishSignal = join(work, 'finish.signal');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: pages, modelsReady: true,
    ...(holdFinish ? { finishSignal } : {}), ...cliState })); await writeFile(logPath, '');
  const cli = { file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } };
  const service = new StudyService(root, { mineru: { limits, local: { cli, home: work, modelsCli: { ...cli } } } });
  const h = {
    service, work, root,
    call: (action, args) => service.call(action, args),
    set: async patch => writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')), ...patch })),
    release: () => writeFile(finishSignal, 'ready'),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).argv.join(' ')),
    job: async () => (await service.call('snapshot')).jobs.find(job => job.type === 'pdf-convert'),
    /** Watch the card until the job ends: every liveness state it showed, in order, and the job as it ended. */
    watch: async (also = () => {}, { timeoutMs } = {}) => {
      const seen = [];
      const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
      let job;
      for (let i = 0; i < 1000 && Date.now() < deadline; i++) {
        job = await h.job();
        const state = job?.liveness?.state;
        if (state && seen.at(-1) !== state) { seen.push(state); await also(state, job); }
        if (job && ['complete', 'failed', 'cancelled'].includes(job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return { seen, job };
    },
    start: async () => {
      const bytes = await makePdf({ pages });
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: 'Scan.pdf', size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return service.call('mineru.import', { uploadId, route: 'local' });
    },
  };
  t.after(async () => {
    if (holdFinish) await h.release();
    await new Promise(resolve => setTimeout(resolve, 30));
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return h;
}
const quick = { livenessMs: 80, livenessFirstMs: 20 };
const isProbe = call => call === 'server status --json' || call.startsWith('list parses');

test('a window waiting in the service queue is "queued", then "converting", and the card forgets the state when the window ends', async t => {
  const h = await harness(t, { cliState: { trackParses: true, queueMs: 2200, delayMs: 5000 }, limits: quick }); // (a probe is three processes: on a loaded machine it needs room to land in the queue phase)
  await h.start();
  const { seen, job } = await h.watch();
  assert.ok(seen.includes('queued'), seen.join());
  assert.ok(seen.includes('parsing'), seen.join());
  assert.ok(seen.indexOf('queued') < seen.indexOf('parsing'));
  assert.equal(job.status, 'complete');
  assert.equal(job.liveness, undefined, 'a finished job does not keep claiming something is converting');
});

for (const probeDelayMs of [0, 1100]) {
  test(`while the service reports a window, the card has when it last heard from it${probeDelayMs ? ', even with delayed probes' : ''}`, async t => {
    // A complete probe takes three CLI processes. Hold the fake parse until the public snapshot actually reports it,
    // rather than assuming that this machine can ask and sample it within the parse's old two-second window.
    const h = await harness(t, { cliState: { trackParses: true, probeDelayMs }, limits: quick, holdFinish: true });
    await h.start();
    let heard;
    try {
      const { seen, job } = await h.watch(async (state, job) => {
        if (state !== 'parsing' || heard) return;
        heard = job.liveness;
        assert.ok(Date.parse(heard.lastSignalAt) > 0 && Date.parse(heard.at) > 0);
        assert.ok(Date.parse(heard.at) <= Date.now());
        await h.release();
      }, { timeoutMs: 30_000 });
      assert.ok(heard, `No parsing signal before the job ended or the deadline. States: ${seen.join(', ')}; CLI: ${(await h.log()).join('; ')}`);
      assert.equal(job.status, 'complete');
      assert.equal(job.liveness, undefined, 'the released window finishes without retaining liveness');
    } finally { await h.release(); }
  });
}

test('a service that reports nothing for a window that runs is "no response" only after several quiet answers and the threshold; the job is not failed and goes on', async t => {
  const h = await harness(t, { cliState: { idleParses: true, delayMs: 2800 }, limits: { ...quick, silentMs: 400, idleProbes: 2 } });
  await h.start();
  const { seen, job } = await h.watch();
  assert.ok(seen.includes('quiet'), 'it is quiet first, and says only that');
  assert.ok(seen.includes('silent'), seen.join());
  assert.ok(seen.indexOf('quiet') < seen.indexOf('silent'));
  assert.equal(job.status, 'complete', 'the card tells, it never stops a window by itself');
});

test('when the service cannot be asked (every probe fails) the state is "unknown", never "no response", and the job completes', async t => {
  const h = await harness(t, { cliState: { statusJsonFails: true, listFails: true, trackParses: true, delayMs: 2000 }, limits: { ...quick, silentMs: 200, idleProbes: 1 } });
  await h.start();
  const { seen, job } = await h.watch();
  assert.ok(seen.includes('unknown'), seen.join());
  assert.ok(!seen.includes('silent'), seen.join());
  assert.equal(job.status, 'complete');
});

test('when only the list fails, the status still says a parse is running', async t => {
  const h = await harness(t, { cliState: { trackParses: true, listFails: true, delayMs: 2000 }, limits: quick });
  await h.start();
  const { seen } = await h.watch();
  assert.ok(seen.includes('parsing'), seen.join());
});

test('a service stopped under a running window is said to be stopped', async t => {
  const h = await harness(t, { cliState: { delayMs: 2600 }, limits: quick });
  await h.start();
  let stopped = false;
  const { seen, job } = await h.watch(async () => {
    if (stopped) return;
    stopped = true;
    // once the parse process is really running (it logs after reading its state), the service goes away under it
    for (let i = 0; i < 200 && !(await h.log()).some(call => call.startsWith('parse ')); i++) await new Promise(resolve => setTimeout(resolve, 25));
    await h.set({ running: false });
  });
  assert.ok(seen.includes('stopped'), seen.join());
  assert.ok(job.status);
});

test('nothing is asked while no window runs: not before the job, not after it, and not at all when the question is switched off', async t => {
  const idle = await harness(t, { cliState: { delayMs: 50 }, limits: quick });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual((await idle.log()).filter(isProbe), [], 'nothing before the job');
  await idle.start();
  await idle.watch();
  const after = (await idle.log()).filter(isProbe).length;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await idle.log()).filter(isProbe).length, after, 'nothing after the window ended');
  const off = await harness(t, { cliState: { trackParses: true, delayMs: 1200 }, limits: { ...quick, livenessMs: 0 } });
  await off.start();
  const { seen } = await off.watch();
  assert.deepEqual(seen, [], 'switched off: the card has no state to show');
  assert.deepEqual((await off.log()).filter(isProbe), []);
});

test('by default a window that ends within a few seconds is never asked about', async t => {
  const h = await harness(t, { cliState: { delayMs: 300 } });
  await h.start();
  await h.watch();
  assert.deepEqual((await h.log()).filter(isProbe), []);
});

test('the questions are read-only: never a parse, a start, a stop or a setting', async t => {
  const h = await harness(t, { cliState: { trackParses: true, queueMs: 400, delayMs: 2000 }, limits: quick });
  await h.start();
  await h.watch();
  const calls = await h.log();
  const probes = calls.filter(isProbe);
  assert.ok(probes.length >= 3, `${probes.length} questions`);
  for (const call of probes) assert.match(call, /^(server status --json|list parses --status (pending|parsing) --json)$/);
  assert.equal(calls.filter(call => call.startsWith('parse ')).length, 1);
  assert.ok(!calls.some(call => /^(server (start|stop|restart)|config set)/.test(call)));
});
