import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { RollingCorrection } from '../lib/live-correction.js';
import { liveCorrectionDefinition } from '../lib/contexts/audio/jobs/live-correction.js';
import { until } from './helpers/wait.mjs';

// S2-5: the context correction of a live class as ONE job for as long as the class needs it. The correction (cursor, versions, memory) stays with the
// class; the job owns the model path. A class stands in for LiveSession here: sentences, a status, and the two saves the correction asks for.

const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'live-correction' }), inspect: () => ({ state: 'lost' }),
  start({ run, cancel }) { void run(); return { id: 'native-1', ownerAgentId: 'owner', stop: cancel, append() {} }; } };

function fakeClass(status = 'live') {
  const session = { id: 'class-1', title: 'Databases', status, segments: [], rev: 0, now: Date.now, saves: 0, scheduleSave() {}, async saveNow() { session.saves++; } };
  const say = count => { for (let i = 0; i < count; i++) { const id = session.segments.length + 1; session.segments.push({ id, t: id * 1000, en: `Sentence ${id}.`, zh: `句 ${id}` }); } };
  return { session, say };
}
/** A host model that corrects nothing but gives every batch a note and the class memory, citing the last sentence it was asked about. */
const modelHost = (log, { slow = 0 } = {}) => {
  const answer = async (system, prompt, request) => {
    log.push(request?.reasoningEffort ?? 'default');
    if (slow) await new Promise(resolve => setTimeout(resolve, slow));
    const last = JSON.parse(prompt).items.at(-1).n;
    return JSON.stringify({ items: [], note: { text: '知识点', refs: [last] }, memory: { text: '摘要', refs: [last] }, followups: [] });
  };
  return { ctx: {}, route: { provider: 'p', model: 'm' }, complete: answer, light: answer };
};
function harness(t, { session, host, intervalMs = 5 }) {
  const ctx = new Context(), lifecycle = createJobLifecycle('/private-library', createRuntimeWork());
  lifecycle.register(ctx, 'audio.v1', liveCorrectionDefinition);
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  const port = lifecycle.scoped({ owner: Symbol('owner'), domain: 'audio.v1', executor, modelHost: host });
  const correction = new RollingCorrection(session, Object.assign(() => {}, { policy: 'p' }), { managed: true, intervalMs });
  session.correction = correction;
  const binding = { worker: { audioSettings: async () => ({ textProvider: 'host', liveCorrectionReasoning: 'low', liveTranslateModel: 'm' }), language: 'zh' },
    work: { jobOutputs: undefined }, session };
  return { port, correction, start: () => { correction.claim(); return port.submit('audio-live-correction', { sessionId: session.id }, {}, binding); } };
}

test('a driven correction has no timer and cannot ask without its job', async () => {
  const { session } = fakeClass();
  const correction = new RollingCorrection(session, Object.assign(() => { throw new Error('legacy model used'); }, { policy: 'p' }), { managed: true, intervalMs: 1 });
  correction.start();
  assert.equal(correction.timer, undefined, 'exactly one driver: the job, never this object\'s own timer');
  session.segments.push({ id: 1, t: 0, en: 'A sentence.', zh: '句' });
  await correction.run();
  assert.match(correction.snapshot().error, /后台任务负责/, 'the service\'s own model is never reached around the job');
});

test('the job runs the passes of a live class on the gateway, runs the last pass when the class ends, and then completes', async t => {
  const { session, say } = fakeClass(), log = [], h = harness(t, { session, host: modelHost(log) });
  say(10);
  const started = await h.start();
  await until(() => h.correction.snapshot().covered === 10, 'the first sentences to be covered');
  say(5);
  await until(() => h.correction.snapshot().covered === 15, 'sentences that arrive later to be covered');
  assert.equal(h.port.status(started.jobId).status, 'running', 'the job lasts as long as the class');
  say(3);
  session.status = 'ended';
  await h.correction.finish();
  const done = await h.port.wait(started.jobId);
  assert.deepEqual([done.status, h.correction.snapshot().covered, h.correction.claimed], ['complete', 18, false]);
  assert.ok(done.calls.length >= 3 && done.calls.every(call => call.stepKey.startsWith('live.correct:') && call.status === 'ok'));
  assert.ok(log.every(effort => effort === 'default' || effort === 'low'), 'the learner\'s correction reasoning rides on every request');
});

test('stopping the job only stops correcting: the class is untouched and its correction can be driven again', async t => {
  const { session, say } = fakeClass(), log = [], h = harness(t, { session, host: modelHost(log) });
  say(4);
  const started = await h.start();
  await until(() => h.correction.snapshot().covered === 4);
  await h.port.control(started.jobId, 'cancel');
  assert.equal((await h.port.wait(started.jobId)).status, 'cancelled');
  assert.deepEqual([session.status, h.correction.claimed, h.correction.driver], ['live', false, null]);
  say(2);
  assert.equal(await h.correction.run().then(() => h.correction.snapshot().covered), 4, 'without its job nothing is asked');
  const again = await h.start();
  await until(() => h.correction.snapshot().covered === 6);
  await h.port.control(again.jobId, 'cancel');
});

test('measure: a 90-minute class (about 180 passes) keeps the job\'s calls and the console snapshot at a size to look at', async t => {
  const { session, say } = fakeClass(), h = harness(t, { session, host: modelHost([]), intervalMs: 1 });
  const started = await h.start();
  for (let pass = 0; pass < 180; pass++) { say(8); await until(() => h.correction.snapshot().covered === session.segments.length, `pass ${pass}`); }
  session.status = 'ended';
  await h.correction.finish();
  const done = await h.port.wait(started.jobId), snapshot = JSON.stringify(h.port.status(started.jobId));
  console.log(`MEASURE passes=180 calls=${done.calls.length} events=${done.events.length} steps=${done.runtime.steps.length} snapshotBytes=${snapshot.length}`);
  assert.equal(done.status, 'complete');
});
