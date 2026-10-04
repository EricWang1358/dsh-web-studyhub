import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL, livenessFrom, parseListedParses, parseServerStatus, probeService, watchWindow } from '../lib/mineru-local.js';

/* What a running local window can honestly say about itself. The CLI's `parse --wait` prints nothing until it ends, so StudyHub asks the SERVICE, with
   read-only calls only (`server status --json`, `list parses --status pending|parsing --json`), at a modest interval, never two at once, never while no
   window runs, and with every failure of the question meaning "unknown", never "stuck". A parse of ours is recognised by its tier and its page range.
   (How the real CLI copes with these reads while it parses is unverified: the seam `limits.livenessMs: 0` turns the question off.) */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));

async function fakeCli(t, state = {}) {
  const work = await mkdtemp(join(tmpdir(), 'study-live-fake-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const env = { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath };
  return { work, cli: { file: process.execPath, prefix: [FAKE], env },
    set: async patch => writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')), ...patch })),
    calls: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).argv.join(' ')) };
}
const mine = { tier: 'basic', startPage: 11, endPage: 30 };
const active = (status, extra = {}) => ({ id: 7, tier: 'basic', page_range: '11-30', status, ...extra });

/* ---------- reading the answers ---------- */

test('the service status is read from its JSON: whether a parse runs, how many wait, whether the parse server is healthy or still starting; anything else is nothing', () => {
  assert.deepEqual(parseServerStatus(JSON.stringify({ workers: { parse_running: 1, parse_queue_length: 2 }, parse_server: { local: { healthy: true, starting: false } } })),
    { parseRunning: 1, queued: 2, healthy: true, starting: false });
  assert.deepEqual(parseServerStatus(JSON.stringify({ workers: { parse_running: 0 }, parse_server: { local: { healthy: false, starting: true } } })),
    { parseRunning: 0, queued: null, healthy: false, starting: true });
  assert.deepEqual(parseServerStatus(JSON.stringify({ parse_queue_length: 3 })), { parseRunning: null, queued: 3, healthy: null, starting: null }, 'a field at the top is read too');
  assert.equal(parseServerStatus(''), null);
  assert.equal(parseServerStatus('服务未在运行。'), null);
  assert.equal(parseServerStatus('{"workers": '), null, 'half a document is not an answer');
  assert.equal(parseServerStatus('[1, 2]'), null);
  assert.deepEqual(parseServerStatus(`noise before\n${JSON.stringify({ workers: { parse_running: 1 } })}\n`), { parseRunning: 1, queued: null, healthy: null, starting: null }, 'a banner line before the JSON is skipped');
});

test('the listed parses are read with their tier, page range and status; a page range may be written a few ways', () => {
  const rows = parseListedParses(JSON.stringify({ parses: [active('parsing'), { id: 8, tier: 'standard', page_range: '1–5', status: 'pending' }, { id: 9, tier: 'basic', page_range: '7', status: 'pending' }, { id: 10, tier: 'basic', page_range: null, status: 'parsing' }], total: 4 }));
  assert.deepEqual(rows.map(row => [row.tier, row.startPage, row.endPage, row.status]), [['basic', 11, 30, 'parsing'], ['standard', 1, 5, 'pending'], ['basic', 7, 7, 'pending'], ['basic', null, null, 'parsing']]);
  assert.deepEqual(parseListedParses(JSON.stringify({ parses: [] })), []);
  assert.equal(parseListedParses('not json'), null);
  assert.equal(parseListedParses(JSON.stringify({ nothing: true })), null);
});

/* ---------- asking the service ---------- */

test('probing: an idle service says so; a parse of ours is told from another one by its tier and its page range', async t => {
  const fake = await fakeCli(t);
  const idle = await probeService({ cli: fake.cli, ...mine });
  assert.deepEqual([idle.server, idle.parseRunning, idle.queued, idle.healthy, idle.starting, idle.mine], ['running', 0, 0, true, false, 'none']);
  await fake.set({ active: active('parsing') });
  assert.equal((await probeService({ cli: fake.cli, ...mine })).mine, 'parsing');
  assert.equal((await probeService({ cli: fake.cli, ...mine })).parseRunning, 1);
  await fake.set({ active: active('pending') });
  const waiting = await probeService({ cli: fake.cli, ...mine });
  assert.deepEqual([waiting.mine, waiting.queued, waiting.parseRunning], ['pending', 1, 0]);
  await fake.set({ active: active('parsing', { page_range: '31-50' }) });
  const other = await probeService({ cli: fake.cli, ...mine });
  assert.deepEqual([other.mine, other.parseRunning], ['none', 1], 'another page range is another parse: the service is busy, but not with this window');
  await fake.set({ active: active('parsing', { tier: 'standard' }) });
  assert.equal((await probeService({ cli: fake.cli, ...mine })).mine, 'none', 'another tier is another parse');
});

test('probing uses read-only calls only: the status, and the lists of pending and parsing parses when the status says something is working; an idle service costs one call', async t => {
  const fake = await fakeCli(t, { active: active('parsing') });
  await probeService({ cli: fake.cli, ...mine });
  const calls = await fake.calls();
  assert.equal(calls.length, 3, calls.join(' | '));
  for (const call of calls) assert.match(call, /^(server status --json|list parses --status (pending|parsing) --json)$/, call);
  assert.ok(!calls.some(call => /^(parse|server (start|stop|restart)|config set)/.test(call)));
  const idle = await fakeCli(t);
  await probeService({ cli: idle.cli, ...mine });
  assert.deepEqual(await idle.calls(), ['server status --json'], 'nothing is parsing or waiting: the lists could only repeat it');
});

test('every way the question can fail is "unknown" or a stopped service, never a throw and never "stuck"', async t => {
  const stopped = await fakeCli(t, { running: false });
  assert.equal((await probeService({ cli: stopped.cli, ...mine })).server, 'stopped');
  const noStatus = await fakeCli(t, { active: active('parsing'), statusJsonFails: true });
  const viaList = await probeService({ cli: noStatus.cli, ...mine });
  assert.deepEqual([viaList.server, viaList.mine, viaList.parseRunning], ['running', 'parsing', null], 'the list alone still says the parse is running');
  const noList = await fakeCli(t, { active: active('parsing'), listFails: true });
  const viaStatus = await probeService({ cli: noList.cli, ...mine });
  assert.deepEqual([viaStatus.server, viaStatus.mine, viaStatus.parseRunning], ['running', 'unknown', 1]);
  const nothing = await fakeCli(t, { statusJsonFails: true, listFails: true });
  assert.equal((await probeService({ cli: nothing.cli, ...mine })).server, 'unknown');
  assert.equal((await probeService({ cli: null, ...mine })).server, 'unknown');
  assert.equal((await probeService({ cli: { file: join(tmpdir(), 'no-such-mineru-binary'), prefix: [], env: {} }, ...mine })).server, 'unknown');
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await probeService({ cli: stopped.cli, ...mine, signal: aborted.signal })).server, 'unknown');
});

/* ---------- what the card says ---------- */

const T0 = 1_000_000;
const ctx = (over = {}) => ({ now: T0 + 30_000, silentMs: 120_000, idleProbes: 3, ...over });
const fresh = () => ({ lastSignalAt: T0, idleStreak: 0 });
const probe = (over = {}) => ({ at: T0, server: 'running', healthy: true, starting: false, parseRunning: 0, queued: 0, mine: 'none', ...over });

test('the states: waiting in the queue, converting, the service starting, a stopped service, and not knowing', () => {
  assert.equal(livenessFrom(probe({ mine: 'pending', queued: 1 }), fresh(), ctx()).state, 'queued');
  assert.equal(livenessFrom(probe({ mine: 'parsing', parseRunning: 1 }), fresh(), ctx()).state, 'parsing');
  assert.equal(livenessFrom(probe({ starting: true, healthy: false }), fresh(), ctx()).state, 'starting', 'a parse server that is still starting is starting, not unhealthy');
  assert.equal(livenessFrom(probe({ server: 'stopped' }), fresh(), ctx()).state, 'stopped');
  assert.equal(livenessFrom(probe({ server: 'unknown' }), fresh(), ctx()).state, 'unknown');
  assert.equal(livenessFrom(probe({ parseRunning: 1, mine: 'unknown' }), fresh(), ctx()).state, 'parsing', 'the status alone says a parse runs');
  assert.equal(livenessFrom(probe({ queued: 2, parseRunning: 0, mine: 'unknown' }), fresh(), ctx()).state, 'queued');
});

test('a sign of life moves the "last signal" to now; a probe that could not read anything does not', () => {
  const state = livenessFrom(probe({ mine: 'parsing', parseRunning: 1 }), fresh(), ctx({ now: T0 + 50_000 }));
  assert.equal(state.lastSignalAt, T0 + 50_000);
  assert.equal(state.idleStreak, 0);
  const unknown = livenessFrom(probe({ server: 'unknown' }), { lastSignalAt: T0, idleStreak: 2 }, ctx({ now: T0 + 50_000 }));
  assert.equal(unknown.lastSignalAt, T0);
  assert.equal(unknown.idleStreak, 2, 'a failed question changes nothing it knew');
});

test('"no response" is said only when the service says nothing is parsing or queued, more than once, for longer than the threshold; or when it is unhealthy', () => {
  let memory = fresh();
  const asked = at => { const next = livenessFrom(probe(), memory, ctx({ now: at })); memory = next; return next; };
  assert.equal(asked(T0 + 20_000).state, 'quiet', 'the first quiet answer is not a problem: the service may not have registered the parse yet');
  assert.equal(asked(T0 + 40_000).state, 'quiet');
  assert.equal(asked(T0 + 60_000).state, 'quiet', 'three quiet answers, but not yet for long enough');
  assert.equal(asked(T0 + 100_000).state, 'quiet');
  const late = asked(T0 + 130_000);
  assert.equal(late.state, 'silent');
  assert.equal(late.silentForMs, 130_000, 'how long nothing was heard');
  // a single quiet answer after a long wait is not enough either
  assert.equal(livenessFrom(probe(), { lastSignalAt: T0, idleStreak: 0 }, ctx({ now: T0 + 600_000 })).state, 'quiet');
  // an unhealthy service is said at once, whatever the clock says
  assert.equal(livenessFrom(probe({ healthy: false }), fresh(), ctx({ now: T0 + 5_000 })).state, 'silent');
});

test('a service that is busy with something else, or a probe that cannot see, never becomes "no response"', () => {
  let memory = fresh();
  for (let step = 1; step <= 12; step++) memory = livenessFrom(probe({ parseRunning: 1, mine: 'none' }), memory, ctx({ now: T0 + step * 60_000 }));
  assert.equal(memory.state, 'quiet', 'twelve minutes next to a busy service is still just quiet');
  memory = fresh();
  for (let step = 1; step <= 12; step++) memory = livenessFrom(probe({ server: 'unknown' }), memory, ctx({ now: T0 + step * 60_000 }));
  assert.equal(memory.state, 'unknown');
});

test('output from the command itself counts as a sign of life too', () => {
  const quiet = { lastSignalAt: T0, idleStreak: 5 };
  const touched = { ...quiet, lastSignalAt: T0 + 100_000, idleStreak: 0 };
  assert.equal(livenessFrom(probe(), touched, ctx({ now: T0 + 150_000 })).state, 'quiet');
  assert.equal(livenessFrom(probe(), quiet, ctx({ now: T0 + 150_000 })).state, 'silent');
});

/* ---------- the watcher ---------- */

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the watcher asks first after a short wait and then at the interval, one question at a time even when an answer is slower than the interval', async () => {
  let running = 0, peak = 0, asks = 0;
  const slow = async () => { asks++; running++; peak = Math.max(peak, running); await settle(60); running--; return probe(); };
  const seen = [];
  const watch = watchWindow({ cli: {}, ...mine, intervalMs: 20, firstMs: 10, probe: slow, onState: state => seen.push(state) });
  await settle(400);
  watch.stop();
  const asked = asks;
  assert.ok(asked >= 3, `asked ${asked} times`);
  assert.equal(peak, 1, 'never two probes at once');
  await settle(150);
  assert.equal(asks, asked, 'nothing is asked after stop');
  assert.equal(seen[0].state, 'quiet', 'before the first answer it says only what is known: converting, not yet confirmed');
});

test('stopping the watcher aborts the question in flight; a throwing probe is "unknown" and the watcher keeps going', async () => {
  let aborted = false, attempts = 0;
  const hanging = ({ signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }); });
  const first = watchWindow({ cli: {}, ...mine, intervalMs: 10, firstMs: 5, probe: hanging });
  await settle(40);
  first.stop();
  await settle(20);
  assert.equal(aborted, true);
  const states = [];
  const flaky = async () => { attempts++; if (attempts % 2) throw new Error('boom'); return probe({ mine: 'parsing', parseRunning: 1 }); };
  const second = watchWindow({ cli: {}, ...mine, intervalMs: 10, firstMs: 5, probe: flaky, onState: state => states.push(state.state) });
  await settle(200);
  second.stop();
  assert.ok(states.includes('unknown') && states.includes('parsing'), states.join());
});

test('the question can be switched off: no interval, no command line, no questions', async () => {
  let asks = 0;
  const counting = async () => { asks++; return probe(); };
  for (const options of [{ intervalMs: 0 }, { intervalMs: 10, cli: null }]) {
    const watch = watchWindow({ cli: {}, ...mine, firstMs: 5, probe: counting, ...options });
    assert.equal(watch.enabled, false);
    await settle(60); watch.stop();
  }
  assert.equal(asks, 0);
  assert.ok(LOCAL.livenessMs >= 15_000 && LOCAL.livenessMs <= 30_000, 'modest by default');
});

test('by default the first question is due a few seconds into the window, so a window that ends sooner is never asked about', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the clock stands still until the test moves it
  let asks = 0;
  const watch = watchWindow({ cli: {}, ...mine, probe: async () => { asks++; return probe(); } });
  assert.equal(watch.enabled, true);
  assert.ok(LOCAL.livenessFirstMs >= 3000, 'a few seconds');
  t.mock.timers.tick(LOCAL.livenessFirstMs - 1);
  assert.equal(asks, 0, 'nothing is asked before the first question is due');
  watch.stop(); // the window ended
  t.mock.timers.tick(LOCAL.livenessMs * 3);
  assert.equal(asks, 0, 'and nothing after the window has ended');
});

test('the watcher on a real (fake) CLI sees queued, then converting', async t => {
  const fake = await fakeCli(t, { active: active('pending') });
  const states = [];
  const until = async (condition, what) => { for (let i = 0; i < 400; i++) { if (condition()) return; await settle(25); } throw new Error(`timed out waiting for ${what}: ${states.join()}`); };
  const watch = watchWindow({ cli: fake.cli, ...mine, intervalMs: 40, firstMs: 10, onState: state => states.push(state.state) });
  await until(() => states.includes('queued'), 'queued');
  await fake.set({ active: active('parsing') });
  await until(() => states.includes('parsing'), 'parsing');
  watch.stop();
  assert.ok(states.includes('queued'), states.join());
  assert.ok(states.includes('parsing'), states.join());
  assert.ok(states.indexOf('queued') < states.lastIndexOf('parsing'));
});
