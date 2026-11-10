import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyLiveJobs, LIVE_JOBS } from '../ui/app/live-jobs.js';
import { shareUnchanged } from '../ui/snapshot-share.js';

/* The panel's step after a snapshot answer that was not whole (#886): the live read of the running jobs, put over the rows the panel holds. It is best effort:
   a failed live read keeps what the panel holds and leaves the next poll to try again; a later request, a library switch or a snapshot that landed while it
   was in flight owns the panel. ui/app/use-library-connection.js takes this step; these tests drive it with the same refs the hook passes. */

const running = { id: 'job-a', status: 'running', stage: 'Planning', savedCount: 1 };
const other = { id: 'job-b', status: 'complete', stage: 'Done' };

function panel(jobs = [running, other]) {
  const { value, texts } = shareUnchanged(null, { fingerprint: 'f1', jobs, decks: [] }, {});
  const refs = { dataRef: { current: value }, snapshotKey: { current: texts }, epoch: { current: 3 }, requestSequence: { current: 7 } };
  const shown = [];
  return { refs, held: value, shown, setData: (next) => shown.push(next), started: 3, sequence: 7 };
}

/** A host call whose answer the test releases: the read is in flight until `answer` or `fail` runs. */
function pending() {
  const asked = [];
  let settle;
  const call = (action, args) => { asked.push(action); return new Promise((resolve, reject) => { settle = { resolve, reject }; void args; }); };
  return { call, asked, answer: (value) => settle.resolve(value), fail: (error) => settle.reject(error) };
}

test('a failed live read after an unchanged answer keeps what the panel holds, and the refresh still succeeds', async () => {
  const p = panel(), host = pending();
  const step = applyLiveJobs({ call: host.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData });
  host.fail(Object.assign(new Error('The host did not answer'), { code: 'ECONNRESET' }));
  assert.equal(await step, p.held, 'the refresh answers the data it holds, it does not fail');
  assert.deepEqual(host.asked, [LIVE_JOBS]);
  assert.equal(p.shown.length, 0, 'nothing is drawn');
  assert.equal(p.refs.dataRef.current, p.held);

  // The next poll tries again and draws the live row.
  const again = pending();
  const next = applyLiveJobs({ call: again.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData });
  again.answer({ jobs: [{ ...running, stage: 'Writing part 2', savedCount: 9 }] });
  const value = await next;
  assert.equal(value.jobs[0].savedCount, 9);
  assert.equal(value.jobs[1], other, 'a row the live read does not carry keeps its identity');
  assert.deepEqual(p.shown, [value]);
  assert.equal(p.refs.dataRef.current, value);
});

test('a live answer that lands after a later request started is dropped (the sequence guard)', async () => {
  const p = panel(), host = pending();
  const step = applyLiveJobs({ call: host.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData });
  p.refs.requestSequence.current++;
  host.answer({ jobs: [{ ...running, savedCount: 5 }] });
  assert.equal(await step, p.held);
  assert.equal(p.shown.length, 0);
  assert.equal(p.refs.dataRef.current, p.held);
});

test('a live answer that lands after the library was switched is dropped (the epoch guard)', async () => {
  const p = panel(), host = pending();
  const step = applyLiveJobs({ call: host.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData });
  p.refs.epoch.current++;
  host.answer({ jobs: [{ ...running, savedCount: 5 }] });
  assert.equal(await step, p.held);
  assert.equal(p.shown.length, 0);
});

test('a live answer that lands after another snapshot was drawn is dropped: that snapshot owns the panel', async () => {
  const p = panel(), host = pending();
  const step = applyLiveJobs({ call: host.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData });
  const newer = { ...p.held, fingerprint: 'f2', jobs: [{ ...running, status: 'complete' }, other] };
  p.refs.dataRef.current = newer;
  host.answer({ jobs: [{ ...running, savedCount: 5 }] });
  assert.equal(await step, newer, 'the refresh answers the newer data');
  assert.equal(p.shown.length, 0);
  assert.equal(p.refs.dataRef.current, newer);
});

test('a failed live read after a guard moved still answers what the panel holds now', async () => {
  const p = panel(), host = pending();
  const step = applyLiveJobs({ call: host.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData });
  const newer = { ...p.held, fingerprint: 'f2' };
  p.refs.dataRef.current = newer;
  host.fail(new Error('gone'));
  assert.equal(await step, newer);
  assert.equal(p.shown.length, 0);
});

test('with no active job nothing is asked', async () => {
  const p = panel([other]), host = pending();
  assert.equal(await applyLiveJobs({ call: host.call, refs: p.refs, started: p.started, sequence: p.sequence, setData: p.setData }), p.held);
  assert.deepEqual(host.asked, []);
});

test('the library connection takes this step after every answer that was not a whole snapshot', async () => {
  const source = (await readFile('ui/app/use-library-connection.js', 'utf8')).replace(/\r\n/g, '\n');
  assert.match(source, /import \{ applyLiveJobs \} from '\.\/live-jobs\.js';/);
  assert.match(source, /if \(next\.unchanged && refs\.dataRef\.current\) return liveJobs\(\);/);
  assert.match(source, /return next\.partial \? liveJobs\(\) : result;/);
  assert.match(source, /const liveJobs = \(\) => applyLiveJobs\(\{ call, refs, started, sequence, setData \}\);/);
});
