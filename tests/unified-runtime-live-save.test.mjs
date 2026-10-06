import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSaved, readSaved } from '../lib/live.js';
import { hostModel, library } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';
import { taskKindOf } from '../ui/tasks/task-model.js';

// S2-6: the proofread save of a live class as a job of the unified runtime, whatever the suite's own switch side is.
// audio-family-baseline-live runs the same expectations on both sides; this file covers what only the runtime has.

const ID = 'saved-class-0001';
const SENTENCES = ['Transactions preserve consistency across related database changes.', 'Partitioning splits one big table into smaller physical pieces by a chosen key.'];

/** A host model that answers like hostModel until `hold()` is called; then every request waits for its stop. */
function holdable() {
  const answer = hostModel([]); let holding = false, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const complete = (system, prompt, options) => {
    if (!holding) return answer(system, prompt, options);
    entered();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  return { complete, reached, hold: () => { holding = true; } };
}
async function savedClass(t, model = holdable()) {
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: model.complete, ...switchOptions('runtime', { complete: model.complete, paths: [...AUDIO_SWITCHES] }) });
  await writeSaved(lib.root, { id: ID, title: 'Databases week 5', course: 'Databases',
    segments: SENTENCES.map((en, index) => ({ id: index + 1, t: index * 5000, en, zh: `译：${en}`, zhState: 'done' })) });
  return { ...lib, model };
}
const rowOf = async (lib, id) => (await lib.service.call('snapshot')).jobs.find(job => job.id === id);

test('a class save is a job of its own kind; one class is not saved twice at once; a stop leaves the class alone', async t => {
  const lib = await savedClass(t);
  lib.model.hold();
  const started = await lib.service.call('live.save', { id: ID, proofread: true });
  await lib.model.reached;
  const row = await rowOf(lib, started.jobId);
  assert.deepEqual([row.contract.kind, taskKindOf(row), row.contract.capabilities],
    ['audio-live-save', 'audio', { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: true, set: false, executionModes: ['direct', 'subagent'] }]);
  await assert.rejects(lib.service.call('live.save', { id: ID, proofread: true }), /这场课堂正在保存/);
  await lib.service.call('job.cancel', { jobId: started.jobId });
  const stopped = await settleJob(lib.service, started.jobId);
  assert.equal(stopped.status, 'cancelled');
  assert.ok(lib.service.runtime.liveSessions.registered(lib.root, ID), 'the class is still there, not closed or rebuilt');
  assert.deepEqual((await lib.state()).sources, []);
});

test('a class deleted while it is being saved is not saved and not brought back', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }), answer = hostModel([]);
  const lib = await savedClass(t, { complete: async (system, prompt, options) => { await gate; return answer(system, prompt, options); } });
  const started = await lib.service.call('live.save', { id: ID, proofread: true });
  await lib.service.call('live.delete', { id: ID });
  release();
  const done = await settleJob(lib.service, started.jobId);
  assert.deepEqual([done.status, done.stage], ['failed', '这场实录已被删除，没有保存']);
  assert.deepEqual([(await lib.state()).sources, await readSaved(lib.root, ID).catch(() => null)], [[], null]);
});
