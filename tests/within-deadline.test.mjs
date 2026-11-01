import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TIMEOUT_MESSAGE, withinDeadline } from '../lib/within-deadline.js';

const never = () => new Promise(() => {});
const turn = () => new Promise(resolve => setImmediate(resolve));

test('the answer of the work is the answer, and its timer is gone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await withinDeadline(1000, race => race(Promise.resolve('ok'))), 'ok');
  t.mock.timers.tick(5000);
  await turn();
});

test('a failure of the work is its own failure', async () => {
  await assert.rejects(withinDeadline(1000, race => race(Promise.reject(new Error('refused')))), /refused/);
  await assert.rejects(withinDeadline(1000, () => { throw new Error('sync'); }), /sync/);
});

test('one limit spans every call: the second try does not start a limit of its own', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const answer = withinDeadline(1000, async race => {
    calls += 1;
    await race(new Promise(resolve => setTimeout(resolve, 600)));
    calls += 1;
    return race(never());
  });
  t.mock.timers.tick(600);
  await turn();
  assert.equal(calls, 2);
  t.mock.timers.tick(399);
  await turn();
  t.mock.timers.tick(1);
  await assert.rejects(answer, new RegExp(MODEL_TIMEOUT_MESSAGE.replace(/[()]/g, '\\$&')));
});

test('a limit that passes between two calls is no unhandled rejection, and the next call is refused', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const answer = withinDeadline(1000, async race => { await new Promise(resolve => { release = resolve; }); return race(never()); });
  t.mock.timers.tick(1000);
  await turn();
  release();
  await assert.rejects(answer, /timeout/);
});
