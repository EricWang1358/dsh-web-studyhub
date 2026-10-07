import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalCommand } from '../lib/local-command.js';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { until } from './helpers/wait.mjs';

/* D-9 of the S5-0 baseline: a stopped command is over when its process tree is gone, not when the stop was asked for. */

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const SLOW = `
  const { writeFileSync } = require('node:fs');
  writeFileSync(process.argv[1], String(process.pid));
  console.log('ready');
  setInterval(() => {}, 1000);
`;

async function slowCommand(t) {
  const dir = await mkdtemp(join(tmpdir(), 'local-command-')), pidFile = join(dir, 'pid');
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pid = async () => Number(await until(() => readFile(pidFile, 'utf8').then(text => text || null, () => null), 'the child to start'));
  return { cli: { file: process.execPath, prefix: ['-e', SLOW, pidFile] }, pid };
}

test('an aborted command rejects with the abort reason only after its process has exited', async t => {
  const { cli, pid } = await slowCommand(t), controller = new AbortController();
  const lines = [], running = runLocalCommand(cli, [], { signal: controller.signal, timeoutMs: 0, onLine: line => lines.push(line) });
  const child = await pid(); await until(() => lines.includes('ready'), 'the first output');
  const reason = new Error('stop it');
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
  assert.equal(alive(child), false, 'the process was gone when the rejection arrived');
});

test('a command that runs past its time limit is over only when its process has exited', async t => {
  const { cli, pid } = await slowCommand(t), running = runLocalCommand(cli, [], { timeoutMs: 1500 });
  const child = await pid();
  await assert.rejects(running, { code: 'timeout' });
  assert.equal(alive(child), false);
});

test('a command that already ended is not touched by a late abort, and an already aborted signal starts nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'local-command-')), marker = join(dir, 'ran');
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const controller = new AbortController();
  const result = await runLocalCommand({ file: process.execPath, prefix: ['-e', 'console.log("done")'] }, [], { signal: controller.signal });
  controller.abort(new Error('late'));
  assert.deepEqual([result.code, result.stdout.trim()], [0, 'done']);
  const before = new AbortController(); before.abort(new Error('early'));
  await assert.rejects(runLocalCommand({ file: process.execPath, prefix: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] }, [], { signal: before.signal }), /early/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});


// Mock Node's process boundary, not a production test hook. Every test restores the ESM binding.
function controlledCommand(t, { pid = 12345, killThrows = false } = {}) {
  const child = Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: t.mock.fn(() => { if (killThrows) throw Object.assign(new Error('kill denied'), { code: 'EPERM' }); return false; }) });
  const killer = new EventEmitter();
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = t.mock.fn(file => file === 'controlled-command' ? child : killer);
  syncBuiltinESMExports();
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('kill denied'), { code: 'EPERM' }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  return { child, killer, cli: { file: 'controlled-command' } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const killThrows of [false, true]) test(`a refused kill (${killThrows ? 'throws' : 'returns false'}) keeps caller resources until close, beyond the old deadline`, async t => {
  const { child, killer, cli } = controlledCommand(t, { killThrows });
  const controller = new AbortController(), reason = new Error('original stop');
  let releases = 0;
  const running = runLocalCommand(cli, [], { signal: controller.signal, timeoutMs: 0 }).finally(() => { releases++; });
  const rejected = assert.rejects(running, error => error === reason);
  controller.abort(reason);
  // Windows taskkill may itself fail to start; even its fallback can throw.
  if (process.platform === 'win32') assert.doesNotThrow(() => killer.emit('error', new Error('taskkill unavailable')));
  t.mock.timers.tick(10_001); await flush();
  assert.equal(releases, 0, 'alive or unknown is not proof of exit');
  controller.signal.dispatchEvent(new Event('abort'));
  child.emit('error', Object.assign(new Error('cannot signal child'), { code: 'EPERM' }));
  await flush();
  assert.equal(releases, 0, 'a kill error does not release the caller either');
  child.emit('close', null); await rejected;
  child.emit('close', null); controller.signal.dispatchEvent(new Event('abort'));
  await flush(); assert.equal(releases, 1, 'confirmed close releases exactly once');
});

test('a timed out command stays pending past the old kill deadline and retains the timeout reason', async t => {
  const { child, cli } = controlledCommand(t);
  let released = false;
  const running = runLocalCommand(cli, [], { timeoutMs: 50 }).finally(() => { released = true; });
  const rejected = assert.rejects(running, { code: 'timeout' });
  t.mock.timers.tick(50); t.mock.timers.tick(10_001); await flush();
  assert.equal(released, false);
  child.emit('error', new Error('stop not confirmed')); await flush();
  assert.equal(released, false);
  child.emit('close', null); await rejected;
});

test('an error from an already started command waits for close before freeing caller resources', async t => {
  const { child, cli } = controlledCommand(t), error = new Error('process operation failed');
  let released = false;
  const running = runLocalCommand(cli, [], { timeoutMs: 0 }).finally(() => { released = true; });
  const rejected = assert.rejects(running, value => value === error);
  child.emit('error', error); await flush();
  assert.equal(released, false);
  child.emit('close', 1); await rejected;
});

test('a command that never spawned rejects without waiting for close', async t => {
  const { child, cli } = controlledCommand(t, { pid: null });
  const rejected = assert.rejects(runLocalCommand(cli, [], { timeoutMs: 0 }), { code: 'not-installed' });
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await rejected;
});


test('a real missing executable rejects as not installed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'missing-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(runLocalCommand({ file: join(dir, 'does-not-exist') }, [], { timeoutMs: 0 }), { code: 'not-installed' });
});

test('a synchronous spawn failure is returned without starting a stop wait', async () => {
  await assert.rejects(runLocalCommand({ file: null }, [], { timeoutMs: 0 }), { code: 'ERR_INVALID_ARG_TYPE' });
});
