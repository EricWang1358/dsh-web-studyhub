import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireFullRunLock, fullRunHolder } from '../scripts/qa/test-lock.mjs';

/* Full test runs on one machine take turns (scripts/qa/test-lock.mjs): several agents running the whole suite at once starve each
   other's browsers and ffmpeg until the timing tests flake. A lock file names the run that is going; it is stale when that process
   is gone or the run is older than 45 minutes. Targeted runs do not queue. */

const lockModule = pathToFileURL(fileURLToPath(new URL('../scripts/qa/test-lock.mjs', import.meta.url))).href;
const testScript = fileURLToPath(new URL('../scripts/test.mjs', import.meta.url));
const holdSuite = fileURLToPath(new URL('./fixtures/runner-hold/', import.meta.url));
const exists = file => access(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) { const value = await check(); if (value) return value; } throw new Error(`timed out waiting for ${what}`); };
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'study-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A process of its own that takes the lock, says "held" and keeps it until told to let go (or killed). */
function holder(file, extra = '') {
  const code = `import { acquireFullRunLock } from ${JSON.stringify(lockModule)};
    const lock = await acquireFullRunLock({ file: ${JSON.stringify(file)}, pollMs: 20, maxWaitMs: 15000, log: line => console.log('log: ' + line) });
    console.log('held reduced=' + lock.reduced);
    ${extra}
    process.stdin.on('data', async () => { await lock.release(); console.log('released'); process.exit(0); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', part => { buffer += part; const parts = buffer.split('\n'); buffer = parts.pop(); lines.push(...parts); });
  return { child, lines, closed: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))), release: () => child.stdin.write('go\n') };
}

test('the first run takes the lock, names itself in it, and releases it for the next one', async t => {
  const file = join(await folder(t), 'lock', 'full-run.lock');
  const lock = await acquireFullRunLock({ file, log: () => assert.fail('nobody to wait for') });
  assert.equal(lock.reduced, false);
  const held = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.ok(Math.abs(held.startedAt - Date.now()) < 60_000);
  assert.equal((await fullRunHolder({ file })).pid, process.pid);
  await lock.release();
  assert.equal(await exists(file), false);
  assert.equal(await fullRunHolder({ file }), null);
  await lock.release();
});

test('a second run waits for the first, says so once, and goes when it is released', async t => {
  const file = join(await folder(t), 'full-run.lock');
  const first = holder(file);
  await until(() => first.lines.includes('held reduced=false'), 'the first holder');
  const second = holder(file);
  await until(() => second.lines.some(line => /^log: .*waiting/i.test(line)), 'the waiting notice');
  await sleep(150);
  assert.equal(second.lines.filter(line => line.startsWith('log:')).length, 1, 'one line, not one per poll');
  assert.ok(!second.lines.includes('held reduced=false'), 'the second run is still queued');
  assert.match(second.lines.find(line => line.startsWith('log:')), new RegExp(`pid ${first.child.pid}\\b`));
  first.release();
  assert.deepEqual(await first.closed, { code: 0, signal: null });
  await until(() => second.lines.includes('held reduced=false'), 'the second holder');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, second.child.pid);
  second.release();
  assert.deepEqual(await second.closed, { code: 0, signal: null });
  assert.equal(await exists(file), false);
});

test('after the longest wait a run goes ahead with fewer workers and leaves the other run\'s lock alone', async t => {
  const file = join(await folder(t), 'full-run.lock');
  const first = holder(file);
  await until(() => first.lines.includes('held reduced=false'), 'the first holder');
  const lines = [];
  const started = Date.now();
  const lock = await acquireFullRunLock({ file, pollMs: 20, maxWaitMs: 300, log: line => lines.push(line) });
  assert.equal(lock.reduced, true);
  assert.ok(Date.now() - started >= 280);
  assert.equal(lines.length, 2, lines.join(' | '));
  assert.match(lines[1], /reduced|fewer/i);
  await lock.release();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, first.child.pid, 'releasing what it never held changes nothing');
  first.release();
  await first.closed;
});

test('a lock whose process is gone, or that is older than 45 minutes, is taken over', async t => {
  const dir = await folder(t), file = join(dir, 'full-run.lock');
  const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise(resolve => gone.once('close', resolve));
  await writeFile(file, JSON.stringify({ pid: gone.pid, startedAt: Date.now() }), 'utf8');
  assert.equal(await fullRunHolder({ file }), null, 'nobody is running');
  let lock = await acquireFullRunLock({ file, log: () => assert.fail('a dead run is not waited for') });
  assert.equal(lock.reduced, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
  await lock.release();
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 46 * 60_000 }), 'utf8');
  assert.equal(await fullRunHolder({ file }), null, 'a run that has taken over 45 minutes is not holding the machine');
  lock = await acquireFullRunLock({ file, log: () => assert.fail('a stale run is not waited for') });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).startedAt > Date.now() - 60_000, true);
  await lock.release();
  await writeFile(file, 'half a wri', 'utf8');
  await sleep(30);
  lock = await acquireFullRunLock({ file, staleAfterMs: 20, log: () => {} });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid, 'an unreadable lock is stale once it is not fresh');
  await lock.release();
});

test('a holder that is killed leaves a lock the next run finds stale', async t => {
  const file = join(await folder(t), 'full-run.lock');
  const first = holder(file);
  await until(() => first.lines.includes('held reduced=false'), 'the first holder');
  first.child.kill('SIGKILL');
  await first.closed;
  assert.equal(await exists(file), true, 'a hard kill cannot clean up');
  assert.equal(await fullRunHolder({ file }), null);
  const lock = await acquireFullRunLock({ file, log: () => assert.fail('nothing left to wait for') });
  assert.equal(lock.reduced, false);
  await lock.release();
});

test('a wait can be abandoned by a signal', async t => {
  const file = join(await folder(t), 'full-run.lock');
  const first = holder(file);
  await until(() => first.lines.includes('held reduced=false'), 'the first holder');
  const controller = new AbortController();
  const waiting = acquireFullRunLock({ file, pollMs: 20, maxWaitMs: 60_000, signal: controller.signal, log: () => {} });
  setTimeout(() => controller.abort(), 100);
  assert.equal(await waiting, null);
  first.release();
  await first.closed;
});

test('a lock that cannot be written never stops a run', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'blocked'), 'a file where a folder is needed', 'utf8');
  const lock = await acquireFullRunLock({ file: join(dir, 'blocked', 'full-run.lock'), log: () => {} });
  assert.equal(lock.reduced, false);
  await lock.release();
});

/** `node scripts/test.mjs` over the one-test fixture suite, with a lock file of its own. */
/** `release`: the run holds until that file exists, so a test never races the machine's load against a fixed hold. */
function fullRun(dir, { hold = 100, release, args = [], env = {} } = {}) {
  const log = join(dir, `run-${Math.random().toString(36).slice(2)}.log`);
  const childEnv = { ...process.env, STUDY_TEST_SUITE_DIR: holdSuite, STUDY_TEST_LOCK_FILE: join(dir, 'full-run.lock'), STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json'),
    STUDY_TEST_LOCK_POLL_MS: '40', STUDY_FIXTURE_LOG: log, STUDY_FIXTURE_HOLD_MS: String(hold),
    ...(release ? { STUDY_FIXTURE_RELEASE_FILE: release } : {}), ...env };
  delete childEnv.NODE_TEST_CONTEXT; // this suite runs inside node --test; the runs it starts are runs of their own
  const child = spawn(process.execPath, [testScript, ...args], { env: childEnv, windowsHide: true });
  const run = { child, out: '', err: '', log, started: () => readFile(log, 'utf8').catch(() => '').then(text => /^start (\d+)/m.exec(text)?.[1]),
    ended: () => readFile(log, 'utf8').catch(() => '').then(text => /^end (\d+)/m.exec(text)?.[1]) };
  child.stdout.on('data', part => { run.out += part; }); child.stderr.on('data', part => { run.err += part; });
  run.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  return run;
}

test('two full runs of the suite queue: the second prints one line, starts after the first has ended, and the lock is gone at the end', async t => {
  const dir = await folder(t), release = join(dir, 'release');
  const first = fullRun(dir, { release });
  await until(() => first.started(), 'the first run to start its tests');
  const second = fullRun(dir, { hold: 100 });
  await until(() => /waiting/i.test(second.err), 'the notice');
  assert.equal(second.err.trim().split('\n').length, 1, `one line: ${second.err}`);
  assert.match(second.err, new RegExp(`pid ${first.child.pid}\\b`));
  assert.equal(await second.started(), undefined, 'queued behind the first');
  await writeFile(release, '');
  assert.equal((await first.closed).code, 0, first.err + first.out);
  assert.equal((await second.closed).code, 0, second.err + second.out);
  assert.ok(Number(await second.started()) >= Number(await first.ended()), 'the second suite started after the first one ended');
  assert.equal(await exists(join(dir, 'full-run.lock')), false);
});

test('STUDY_TEST_NO_LOCK=1 runs without queueing and without a lock', async t => {
  const dir = await folder(t), release = join(dir, 'release');
  const first = fullRun(dir, { release });
  await until(() => first.started(), 'the first run to start its tests');
  const second = fullRun(dir, { hold: 50, env: { STUDY_TEST_NO_LOCK: '1' } });
  assert.equal((await second.closed).code, 0, second.err + second.out);
  assert.equal(second.err, '');
  assert.equal(JSON.parse(await readFile(join(dir, 'full-run.lock'), 'utf8')).pid, first.child.pid, 'the first run still holds it');
  await writeFile(release, '');
  assert.equal((await first.closed).code, 0);
});

test('a run with file arguments does not take the lock or wait for one', async t => {
  const dir = await folder(t), release = join(dir, 'release');
  const first = fullRun(dir, { release });
  await until(() => first.started(), 'the first run to start its tests');
  const second = fullRun(dir, { hold: 50, args: [join(holdSuite, 'hold.test.mjs')] });
  assert.equal((await second.closed).code, 0, second.err + second.out);
  assert.doesNotMatch(second.err, /waiting/i);
  assert.equal(JSON.parse(await readFile(join(dir, 'full-run.lock'), 'utf8')).pid, first.child.pid);
  await writeFile(release, '');
  assert.equal((await first.closed).code, 0);
});

test('a signal ends the run and releases the lock', { skip: process.platform === 'win32' && 'Windows ends a process on a signal without running its handlers; the stale-lock rules cover that case' }, async t => {
  const dir = await folder(t);
  const run = fullRun(dir, { hold: 20_000 });
  await until(() => run.started(), 'the run to start its tests');
  assert.equal(await exists(join(dir, 'full-run.lock')), true);
  run.child.kill('SIGTERM');
  const { code, signal } = await run.closed;
  assert.ok(signal === 'SIGTERM' || code === 143, `ended by the signal: ${code} ${signal}`);
  assert.equal(await exists(join(dir, 'full-run.lock')), false, 'the lock is released');
});

test('a signal while queued ends the wait and leaves the other run\'s lock alone', { skip: process.platform === 'win32' && 'Windows ends a process on a signal without running its handlers' }, async t => {
  const dir = await folder(t);
  const first = fullRun(dir, { hold: 1500 });
  await until(() => first.started(), 'the first run to start its tests');
  const second = fullRun(dir, { hold: 50 });
  await until(() => /waiting/i.test(second.err), 'the notice');
  second.child.kill('SIGTERM');
  const { code, signal } = await second.closed;
  assert.ok(signal === 'SIGTERM' || code === 143, `${code} ${signal}`);
  assert.equal(await second.started(), undefined, 'its tests never began');
  assert.equal(JSON.parse(await readFile(join(dir, 'full-run.lock'), 'utf8')).pid, first.child.pid);
  assert.equal((await first.closed).code, 0);
});
