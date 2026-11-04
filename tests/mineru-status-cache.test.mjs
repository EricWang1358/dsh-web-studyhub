import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { mineruInstallStatePath } from '../lib/mineru-install.js';
import { patientCli, readJsonFile, sleep, until, writeJsonFile } from './helpers/wait.mjs';

/* #683: mineru.local.status spawned the mineru program (two Python start-ups, 2 s + 5 s on a real install) at every read older than 5 s. The answer is
   now reused until something that can change it happens (an install, an uninstall, a location change, a start, a stop, a conversion, `fresh: true`),
   and an answer older than `staleMs` is still given at once while a read in the background renews it. The program is a fake that logs every call. */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));

async function harness(t, { state = {}, noCli = false, staleMs } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'status-cache-home-'));
  const root = await mkdtemp(join(tmpdir(), 'status-cache-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'status-cache-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 10, modelsReady: true, ...state })); await writeFile(logPath, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const service = new StudyService(root, { mineru: { local: { cli: noCli ? null : cli, home: work, ...(staleMs !== undefined ? { staleMs } : {}) } } });
  const h = {
    call: (action, args) => service.call(action, args),
    set: patch => readJsonFile(statePath).then(current => writeJsonFile(statePath, { ...current, ...patch })),
    // The calls the program has seen, by name (`--version`, `server`, `config`).
    seen: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line).argv[0]]; } catch { return []; } }),
    versions: async () => (await h.seen()).filter(name => name === '--version').length,
    timed: async (action, args) => { const started = performance.now(); const value = await service.call(action, args); return { value, ms: performance.now() - started }; },
  };
  t.after(async () => {
    await sleep(20);
    service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return h;
}

test('a repeated mineru.local.status asks the program once and answers from memory in well under 100 ms', async t => {
  const h = await harness(t, { state: { readDelayMs: 400 } });
  const first = await h.timed('mineru.local.status');
  assert.equal(first.value.state, 'ready');
  const callsAfterFirst = (await h.seen()).length;
  assert.ok(callsAfterFirst > 0);
  // Well past the old 5 s window is not waited for here: the memory does not expire by itself within staleMs (30 s by default).
  for (let index = 0; index < 3; index++) {
    const again = await h.timed('mineru.local.status');
    assert.equal(again.value.checkedAt, first.value.checkedAt, 'the same answer');
    assert.ok(again.ms < 100, `repeated read took ${Math.round(again.ms)} ms`);
  }
  assert.equal((await h.seen()).length, callsAfterFirst, 'the program was not run again');
});

test('the program is asked about its version and its service at the same time, not one after the other', async t => {
  const h = await harness(t, { state: { readDelayMs: 800 } });
  const first = await h.timed('mineru.local.status');
  assert.equal(first.value.state, 'ready');
  // Four reads of 800 ms (--version, server status, then the two config gets) one after the other take over 3.2 s; in two rounds of two they take 1.6 s.
  assert.ok(first.ms < 2_800, `first read took ${Math.round(first.ms)} ms`);
});

test('where no mineru is installed the answer is immediate and nothing is spawned', async t => {
  const h = await harness(t, { noCli: true });
  const first = await h.timed('mineru.local.status');
  assert.equal(first.value.state, 'not-installed');
  assert.ok(first.ms < 300, `took ${Math.round(first.ms)} ms`);
  assert.deepEqual(await h.seen(), []);
});

test('fresh: true reads again and renews what the next plain read gets', async t => {
  const h = await harness(t);
  const first = await h.call('mineru.local.status');
  assert.equal(first.state, 'ready');
  await h.set({ running: false });
  // Outside the app the service stopped: a plain read still has the old answer (it is reused), a fresh one sees it.
  assert.equal((await h.call('mineru.local.status')).state, 'ready');
  assert.equal((await h.call('mineru.local.status', { fresh: true })).state, 'server-stopped');
  assert.equal((await h.call('mineru.local.status')).state, 'server-stopped');
});

test('starting and stopping the service forget the memory: the next read is a real one', async t => {
  const h = await harness(t, { state: { running: false } });
  assert.equal((await h.call('mineru.local.status')).state, 'server-stopped');
  await h.call('mineru.local.start', {});
  const afterStart = await h.call('mineru.local.status');
  assert.equal(afterStart.state, 'ready', 'a stale "stopped" is not shown after a start');
  await h.call('mineru.local.stop', {});
  assert.equal((await h.call('mineru.local.status')).state, 'server-stopped', 'a stale "ready" is not shown after a stop');
});

test('an install that changes (finished, uninstalled, another location) makes the memory stale at once, with no action involved', async t => {
  const h = await harness(t);
  const first = await h.call('mineru.local.status');
  assert.equal(first.install.status, 'idle');
  const versions = await h.versions();
  await mkdir(dirname(mineruInstallStatePath()), { recursive: true });
  // The install worked in the background and ended: its state file now says so (what the installer writes when a run completes).
  await mkdtemp(join(tmpdir(), 'status-cache-install-')).then(async folder => {
    t.after(() => rm(folder, { recursive: true, force: true }));
    await writeJsonFile(mineruInstallStatePath(), { version: 1, status: 'complete', finishedAt: '2026-11-05T10:00:00.000Z', installedFolder: folder, folder });
  });
  const second = await h.call('mineru.local.status');
  assert.equal(second.install.status, 'complete');
  assert.ok((await h.versions()) > versions, 'the program was asked again');
  // Uninstalled: the file goes back to idle.
  const versionsBefore = await h.versions();
  await writeJsonFile(mineruInstallStatePath(), { version: 1, status: 'idle' });
  const third = await h.call('mineru.local.status');
  assert.equal(third.install.status, 'idle');
  assert.ok((await h.versions()) > versionsBefore, 'the program was asked again after the uninstall');
});

test('an answer older than staleMs is given at once and renewed in the background', async t => {
  const h = await harness(t, { state: { readDelayMs: 150 }, staleMs: 60 });
  const first = await h.call('mineru.local.status');
  assert.equal(first.state, 'ready');
  const versions = await h.versions();
  await h.set({ running: false });
  await sleep(120);
  const stale = await h.timed('mineru.local.status');
  assert.equal(stale.value.state, 'ready', 'the old answer comes back first');
  assert.ok(stale.ms < 100, `took ${Math.round(stale.ms)} ms`);
  await until(async () => (await h.versions()) > versions, 'the background read');
  await until(async () => (await h.call('mineru.local.status')).state === 'server-stopped', 'the renewed answer');
});

test('a read that could not tell (unknown) is never reused: the next read asks again', async t => {
  const h = await harness(t, { state: { configFails: true } });
  const failed = await h.call('mineru.local.status');
  assert.equal(failed.state, 'unknown');
  await h.set({ configFails: false });
  assert.equal((await h.call('mineru.local.status')).state, 'ready');
});
