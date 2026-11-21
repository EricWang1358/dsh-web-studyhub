import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { LOCAL_MESSAGES, LocalMineruError, detectLocal, startServer } from '../lib/mineru-local.js';
import { jobDir, readManifest } from '../lib/mineru-job.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { makePdf } from './helpers/pdf.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { patientCli, readJsonFile, sleep, until, writeJsonFile } from './helpers/wait.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const MODELS = 'MinerU-4_models_onnx';
const HAN = /[㐀-鿿]/;

async function fakeCli(t, state = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'study-parse-server-cli-'));
  const statePath = join(dir, 'state.json'), logPath = join(dir, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.12', mode: 'managed', tier: 'basic', running: true, total: 10, modelsReady: true, ...state }));
  await writeFile(logPath, '');
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  return {
    dir,
    cli,
    state: () => readJsonFile(statePath),
    set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }),
  };
}

async function serviceHarness(t, { mode = 'legacy', pages = 10, cliState = {}, limits = {}, parseWindow, probeService, startServer: customStartServer } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-recovery-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-recovery-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-recovery-work-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  await mkdir(join(work, 'models', MODELS), { recursive: true });
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.12', mode: 'managed', tier: 'basic', running: true, total: pages, modelsReady: true, ...cliState }));
  await writeFile(logPath, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const service = new StudyService(root, {
    ...switchOptions(mode, { paths: ['pdfConvert'] }),
    mineru: {
      limits: { engineBusyRetries: 2, engineBusyWaitMs: 5, livenessMs: 0, ...limits },
      local: {
        cli,
        home: work,
        modelsCli: { ...cli },
        ...(parseWindow ? { parseWindow } : {}),
        ...(probeService ? { probeService } : {}),
        ...(customStartServer ? { startServer: customStartServer } : {}),
      },
    },
  });
  t.after(async () => {
    await sleep(20);
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const importPdf = async (name = 'Doc.pdf', pageCount = pages) => {
    const file = join(work, name);
    await writeFile(file, await makePdf({ pages: pageCount }));
    return service.call('mineru.import', { path: file, route: 'local' });
  };
  const settled = jobId => until(async () => {
    const job = (await service.call('snapshot')).jobs.find(item => item.id === jobId);
    return job && ['complete', 'failed', 'cancelled'].includes(job.status) ? job : false;
  }, `job ${jobId} to settle`, { timeoutMs: 30_000, intervalMs: 25 });
  return {
    service, root, work, cli, importPdf, settled,
    set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }),
    log: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }),
  };
}

/* ---------- 1. detectLocal & startServer parse-server health awareness ---------- */

test('detectLocal reports server-stopped + unhealthy + needsRestart when doclib is running but parse-server is unhealthy', async t => {
  const fake = await fakeCli(t, { running: true, unhealthy: true, mode: 'managed', tier: 'basic' });
  const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.equal(detected.state, 'server-stopped');
  assert.equal(detected.next, 'start-server');
  assert.equal(detected.running, false);
  assert.equal(detected.unhealthy, true);
  assert.equal(detected.needsRestart, true);
  assert.equal(detected.tier, 'basic');
  assert.equal(detected.mode, 'managed');

  // When mode is disabled (not configured for managed parse-server), unhealthy is not misreported as server-stopped.
  await fake.set({ mode: 'disabled' });
  const disabled = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.equal(disabled.state, 'needs-models');
  assert.equal(disabled.unhealthy, undefined);
});

test('detectLocal treats parse_server.local.starting === true as starting and startServer waits until parse-server finishes starting', async t => {
  const fake = await fakeCli(t, { running: true, starting: true, mode: 'managed', tier: 'basic' });
  const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.equal(detected.state, 'server-stopped');
  assert.equal(detected.running, false);
  assert.equal(detected.starting, true);

  await fake.set({ running: false, starting: true, startingPolls: 2 });
  const after = await startServer({ cli: fake.cli, home: fake.dir, pollPauseMs: 15, pollTries: 5 });
  assert.equal(after.state, 'ready');
  assert.equal(after.running, true);
});

test('detectLocal falls back to plain server status when server status --json fails', async t => {
  const fake = await fakeCli(t, { running: true, statusJsonFails: true, mode: 'managed', tier: 'basic' });
  const detected = await detectLocal({ cli: fake.cli, home: fake.dir });
  assert.equal(detected.state, 'ready');
  assert.equal(detected.running, true);
  const calls = (await fake.log()).map(entry => entry.argv.join(' '));
  assert.ok(calls.includes('server status --json'));
  assert.ok(calls.includes('server status'));
});

test('startServer without explicit restart automatically stops and restarts when doclib is alive with a dead parse-server', async t => {
  const fake = await fakeCli(t, { running: true, unhealthy: true, mode: 'managed', tier: 'basic' });
  const after = await startServer({ cli: fake.cli, home: fake.dir, restart: false });
  assert.equal(after.state, 'ready');
  assert.equal(after.running, true);
  const calls = (await fake.log()).map(entry => entry.argv.join(' '));
  assert.ok(calls.includes('server stop'), `expected server stop in ${calls.join(', ')}`);
  assert.ok(calls.filter(call => call === 'server start').length >= 2, `expected restart after no-op start: ${calls.join(', ')}`);
});

/* ---------- 2. Import when parse-server is already unhealthy ---------- */

test('mineru.import detects unhealthy parse-server up front, restarts the service before window 1, and completes', async t => {
  const h = await serviceHarness(t, { pages: 3, cliState: { running: true, unhealthy: true } });
  const status = await h.service.call('mineru.local.status', { fresh: true });
  assert.equal(status.state, 'server-stopped');
  assert.equal(status.needsRestart, true);

  const { jobId } = await h.importPdf('UnhealthyStart.pdf', 3);
  const done = await h.settled(jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.service.state, 'running');
  const calls = (await h.log()).map(entry => entry.argv.slice(0, 2).join(' '));
  const stopIdx = calls.indexOf('server stop');
  const startIdx = calls.indexOf('server start');
  const parseIdx = calls.findIndex(call => call.startsWith('parse'));
  assert.ok(stopIdx >= 0 && startIdx > stopIdx && parseIdx > startIdx, `expected stop -> start -> parse, got: ${calls.join(' | ')}`);
  const codes = (done.contract?.events || []).map(entry => entry.code);
  assert.ok(codes.includes('service-restart') && codes.includes('service-restarted'), `expected restart log codes: ${codes.join(',')}`);
});

/* ---------- 3. Automatic mid-window recovery on dead parse-server ---------- */

for (const mode of ['legacy', 'runtime']) {
  test(`mid-window dead parse-server (${mode}): auto-restarts once on engine-busy when idle & unhealthy, logs restart events, and completes`, async t => {
    const orig = await import('../lib/mineru-local.js');
    const stateRef = { killed: false };
    const hRun = await serviceHarness(t, {
      mode,
      pages: 4,
      parseWindow: async options => {
        if (!stateRef.killed) {
          stateRef.killed = true;
          await hRun.set({ unhealthy: true });
        }
        return orig.parseWindow(options);
      },
    });
    const { jobId } = await hRun.importPdf('DeadMidRun.pdf', 4);
    const done = await hRun.settled(jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.equal(done.service.state, 'running');
    const calls = (await hRun.log()).map(entry => entry.argv.slice(0, 2).join(' '));
    assert.equal(calls.filter(call => call === 'server stop').length, 1, `restarted exactly once: ${calls.join(' | ')}`);
    assert.equal(calls.filter(call => call === 'server start').length, 1, `started exactly once: ${calls.join(' | ')}`);
    const codes = (done.contract?.events || []).map(entry => entry.code);
    assert.ok(codes.includes('service-restart') && codes.includes('service-restarted'), `expected restart codes: ${codes.join(',')}`);
  });
}

/* ---------- 4. Warm-up patience when parse_server.local.starting === true ---------- */

test('warm-up starting: true gets extended retry patience without prematurely failing or restarting', async t => {
  let parseAttempts = 0;
  let restarts = 0;
  const h = await serviceHarness(t, {
    pages: 3,
    limits: { engineBusyRetries: 2, engineBusyWaitMs: 5 },
    probeService: async () => ({ at: Date.now(), server: 'running', parseRunning: 0, queued: 0, healthy: false, starting: true, mine: 'unknown' }),
    startServer: async () => { restarts += 1; return { state: 'ready', tier: 'basic', running: true }; },
    parseWindow: async ({ startPage, endPage }) => {
      parseAttempts += 1;
      // Fails 4 times (exceeding normal engineBusyRetries=2) while starting: true, succeeds on 5th attempt.
      if (parseAttempts <= 4) throw new LocalMineruError('engine-busy', LOCAL_MESSAGES.engineBusy, { retryable: true });
      return {
        content: Array.from({ length: endPage - startPage + 1 }, (_, i) => ({ type: 'text', text: `Page ${startPage + i}`, page_idx: i })),
        markers: endPage - startPage + 1,
        warnings: [],
      };
    },
  });
  const { jobId } = await h.importPdf('ColdModelLoad.pdf', 3);
  const done = await h.settled(jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(parseAttempts, 5);
  assert.equal(restarts, 0, 'never restarts while parse-server is still starting');
  const busyLogs = (done.contract?.events || []).filter(entry => entry.code === 'engine-busy-wait');
  assert.equal(busyLogs.length, 4);
  assert.ok(busyLogs.every(entry => entry.args?.starting === true && entry.args?.maxAttempts >= 6));
});

/* ---------- 5. Occupied by another active parse: never restart, never falsely mark stopped ---------- */

test('when another parse is active (parseRunning > 0), engine-busy never auto-restarts or marks the service stopped', async t => {
  let restarts = 0;
  const h = await serviceHarness(t, {
    pages: 3,
    limits: { engineBusyRetries: 1, engineBusyWaitMs: 5 },
    probeService: async () => ({ at: Date.now(), server: 'running', parseRunning: 1, queued: 0, healthy: true, starting: false, mine: 'unknown' }),
    startServer: async () => { restarts += 1; return { state: 'ready', tier: 'basic', running: true }; },
    parseWindow: async () => { throw new LocalMineruError('engine-busy', LOCAL_MESSAGES.engineBusy, { retryable: true }); },
  });
  const { jobId } = await h.importPdf('OtherParseBusy.pdf', 3);
  const failed = await h.settled(jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'engine-busy');
  assert.equal(restarts, 0, 'must not restart while another parse is active');
  assert.equal(failed.service.state, 'running', 'service is busy with another parse, not stopped');
  const manifest = await readManifest(jobDir(h.root, jobId));
  assert.equal(manifest.autoStart, undefined);
  assert.equal(manifest.restartService, undefined);
});

/* ---------- 6. Failed recovery updates job.service to stopped + manifest autoStart/restartService for 接着做 ---------- */

test('when auto-restart fails on dead parse-server, job.service becomes stopped and 接着做 restarts cleanly to finish', async t => {
  const orig = await import('../lib/mineru-local.js');
  let failOnce = true;
  const h = await serviceHarness(t, {
    pages: 4,
    limits: { engineBusyRetries: 1, engineBusyWaitMs: 5 },
    parseWindow: async options => {
      if (failOnce) {
        failOnce = false;
        // Simulate parse-server dying and failing to come back during the first attempt's auto-restart.
        await h.set({ unhealthy: true, persistUnhealthy: true, startFails: true });
      }
      return orig.parseWindow(options);
    },
  });
  const { jobId } = await h.importPdf('RetryRestart.pdf', 4);
  const failed = await h.settled(jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'engine-busy');
  assert.equal(failed.retryable, true);
  assert.equal(failed.service.state, 'stopped', 'never shows green running when parse-server is dead');
  const codes = (failed.contract?.events || []).map(entry => entry.code);
  assert.ok(codes.includes('service-restart') && codes.includes('service-restart-failed'), `expected restart + failed codes: ${codes.join(',')}`);
  const savedManifest = await readManifest(jobDir(h.root, jobId));
  assert.equal(savedManifest.autoStart, true);
  assert.equal(savedManifest.restartService, true);

  // Now the port/startup issue is resolved; clicking 接着做 restarts the service and completes.
  await h.set({ persistUnhealthy: false, startFails: false });
  await h.service.call('mineru.retry', { jobId });
  const retried = await until(async () => {
    const job = (await h.service.call('snapshot')).jobs.find(item => item.id === jobId);
    return job?.status === 'complete' ? job : false;
  }, 'retried job to complete', { timeoutMs: 30_000, intervalMs: 25 });
  assert.equal(retried.status, 'complete');
  assert.equal(retried.service.state, 'running');
});

/* ---------- 7. Localization ---------- */

test('restartingService message has an English translation with no Han characters', () => {
  const en = localizeAppMessage(LOCAL_MESSAGES.restartingService, 'en');
  assert.doesNotMatch(en, HAN);
  assert.match(en, /restarting the local MinerU service/i);
});
