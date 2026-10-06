import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalCommand } from '../lib/local-command.js';
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
