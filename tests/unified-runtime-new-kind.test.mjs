/* S6-4: a new kind of ordinary task, added with nothing but a definition, an executor (its `run`) and an optional detail. The kind below is synthetic and does nothing real;
   it is registered through the two published doors (`runtime.register` for the context that submits, `runtime.registerJob` for the definition) and then driven only through the
   generic paths: the job.* doors of the jobs context, the snapshot and the task console's own reading code. No kernel file, no kind/type branch and no console file knows its name.
   The real-world evidence is S4-10 (note.generate): lib/jobs/** untouched, see docs/plans/unified-job-runtime/s6-4-minimal-integration.md. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import { StudyService } from '../lib/service.js';
import { OUTPUT_LIMIT } from '../lib/job-output.js';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';

const KIND = 'widget-sync', API = 'widgets.v1';
const consoleCode = await loadUi(`export { taskSummary, taskKindLabel } from './ui/tasks/task-summary.js'; export { tasksOf, taskKindOf, runningTaskCount } from './ui/tasks/task-model.js';`);
const POLICY = Object.freeze({ purpose: 'other', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });

/* ---------- the whole integration: a definition and what the domain does ---------- */

/** The domain's own single-flight (a private gate, nothing public): one widget sync at a time, the next ones are queued by `admit`. */
function domain() {
  const waiting = [], state = { active: 0, started: [], authorised: true };
  // A place in the domain's line, given up when the Job is stopped while it waits (the way every real gate of the codebase behaves).
  const take = signal => state.active < 1 ? (state.active++, Promise.resolve()) : new Promise((resolve, reject) => {
    const entry = () => resolve();
    waiting.push(entry);
    signal.addEventListener('abort', () => { const at = waiting.indexOf(entry); if (at >= 0) { waiting.splice(at, 1); reject(signal.reason); } }, { once: true });
  });
  const give = () => { const next = waiting.shift(); if (next) next(); else state.active--; };
  return { state, take, give, waiting };
}

/** The optional live-output bridge: what a step of this kind writes is shown by the console's reader (job.output) under the job's list id. */
const outputBridge = (id, outputs) => ({ open: callId => outputs.open(id, callId), append: (callId, text) => outputs.append(id, callId, text),
  reasoning: (callId, count) => outputs.reasoning(id, callId, count), close: callId => outputs.close(id, callId) });
const untilStopped = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });

function definitionOf(world, outputs) {
  return {
    kind: KIND, version: 1, title: 'Widget sync', legacyFields: ['widgets'], legacyId: input => `widget-${input.name}`,
    capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: true, set: false, executionModes: ['direct'] },
    async admit(context, input) {
      // The domain's own authorisation is asked on every Attempt: the first, and a retry after it was withdrawn.
      if (!world.state.authorised) throw Object.assign(new Error('not allowed'), { code: 'not-authorised' });
      context.present(observed => ({ title: `Sync ${input.name}`, stage: { code: `widgets.${observed.status}`, text: observed.status },
        progress: { done: 0, total: null, unit: 'widgets', percent: null, segments: [] }, legacy: { widgets: 0 } }));
      await world.take(context.signal); // queued until the domain's gate lets it in
      return { finish: world.give, state: { widgets: 0 } };
    },
    async run(context, input) {
      const state = context.admission.state;
      world.state.started.push(input.name);
      context.present(observed => ({ title: `Sync ${input.name}`, stage: { code: `widgets.${observed.status}`, text: observed.status },
        progress: { done: state.widgets, total: null, unit: 'widgets', percent: null, segments: [] }, legacy: { widgets: state.widgets } }));
      if (input.mode === 'fail') throw new Error('the widget service refused');
      if (input.mode === 'hold') await Promise.race([world.hold.promise, untilStopped(context.signal)]);
      context.signal.throwIfAborted();
      if (input.mode === 'ignore-stop') await world.late.promise; // does not look at the signal: its stop is late
      const step = context.gateway.step(`${input.name}:1`, POLICY, { output: outputBridge(`widget-${input.name}`, outputs) });
      const text = await step.complete('system', input.mode === 'big' ? 'x'.repeat(OUTPUT_LIMIT * 2) : 'sync');
      state.widgets = text.length;
      context.progress({ done: state.widgets, unit: 'widgets' });
      return input.mode === 'partial' ? { refs: [{ kind: 'widget', id: input.name }], completeness: 'partial' } : { refs: [{ kind: 'widget', id: input.name }], completeness: 'complete' };
    },
  };
}

/* ---------- the harness ---------- */

async function harness(t) {
  const world = { ...domain(), hold: gate(), late: gate() }, chunks = [];
  const complete = async (_system, prompt, request) => {
    // the "model" writes in pieces, the way a provider streams; a big prompt makes it write more than the console keeps
    const pieces = prompt.length > OUTPUT_LIMIT ? Array.from({ length: 6 }, (_, index) => `${String(index).repeat(OUTPUT_LIMIT / 2)}`) : ['alpha ', 'beta'];
    for (const piece of pieces) { request.onOutput?.(piece); chunks.push(piece.length); }
    return pieces.join('');
  };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete, paths: [] });
  const root = await privateRoot(t, 'runtime-new-kind-');
  const service = new StudyService(root, { complete, ...managed });
  const scope = new Context();
  // The two published doors: a context that submits, and the definition. This is the whole integration.
  const dispose = service.runtime.register({ id: 'widgets', version: 1, operations: {
    start: { execute: (args, context) => context.jobs.submit(KIND, { name: args.name, mode: args.mode ?? 'ok' }) } } });
  service.runtime.registerJob(scope, API, definitionOf(world, service.runtime.work.jobOutputs));
  t.after(async () => { world.hold.release(); world.late.release(); await service.dispose(); await scope.fiber.dispose(); dispose?.(); });
  const start = (name, mode) => service.call('widgets.start', { name, mode });
  const row = async id => (await service.call('snapshot')).jobs.find(job => job.id === id);
  return { service, world, start, row, chunks, options: { workOwner: managed.workOwner, jobExecutor: managed.jobExecutor, jobModelHost: managed.jobModelHost } };
}
const status = (h, id) => h.service.call('job.status', { jobId: id });
const ended = (h, id) => until(async () => { const job = await status(h, id); return job.finished && job; }, 'the job to end');
const taskOf = async (h, logicalId) => consoleCode.tasksOf(await h.service.call('snapshot')).find(task => task.contract.jobId === logicalId);

/* ---------- what the generic paths do with it ---------- */

test('submit, list, status, wait and the console all know the new kind without being told its name', async t => {
  const h = await harness(t), started = await h.start('one');
  assert.ok(started.jobId, 'submit answers with the Job');
  const done = await h.service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 5 });
  assert.deepEqual([done.status, done.stage], ['complete', 'complete']);
  const listed = (await h.service.call('job.status')).jobs.map(job => [job.id, job.type, job.status]);
  assert.deepEqual(listed, [['widget-one', KIND, 'complete']], 'the list, under the name the domain gave it');
  const snapshotted = await h.row('widget-one');
  assert.equal(snapshotted.contract.jobId, started.jobId);
  assert.deepEqual([snapshotted.contract.kind, snapshotted.contract.title, snapshotted.contract.result.completeness], [KIND, 'Sync one', 'complete']);
  assert.deepEqual(snapshotted.contract.result.refs, [{ kind: 'widget', id: 'one' }]);
  assert.deepEqual(snapshotted.contract.calls.map(call => [call.stepKey, call.kind, call.feature, call.executionMode]), [['one:1', 'other', 'other', 'direct']], 'one Call, observed by the gateway');
  assert.equal(snapshotted.widgets, 10, 'the domain\'s own detail rides on the record (legacyFields)');
  // the console reads it by the generic path: an unknown kind is a task of the generic kind, with its own title, state and progress
  const tasks = consoleCode.tasksOf(await h.service.call('snapshot'));
  assert.equal(tasks.length, 1);
  assert.equal(consoleCode.taskKindOf(tasks[0]), 'extension', 'no console branch for the new kind: it is shown as a generic task');
  const summary = consoleCode.taskSummary(tasks[0]);
  assert.deepEqual([summary.state, summary.title], ['done', 'Sync one']);
  assert.ok(summary.line && !/undefined|NaN/.test(JSON.stringify(summary)), 'a readable line, no holes');
});

test('success, failure and partial are what the kind said, each as the public contract says it', async t => {
  const h = await harness(t);
  const ok = await ended(h, (await h.start('ok')).jobId), failed = await ended(h, (await h.start('bad', 'fail')).jobId), partial = await ended(h, (await h.start('half', 'partial')).jobId);
  assert.deepEqual([ok.status, failed.status, partial.status], ['complete', 'failed', 'complete']);
  const rows = await Promise.all([ok, failed, partial].map(job => h.row(job.id)));
  assert.deepEqual(rows.map(item => item.id), ['widget-ok', 'widget-bad', 'widget-half']);
  assert.deepEqual(rows.map(item => item.contract.result.completeness), ['complete', null, 'partial']);
  assert.equal(rows[1].contract.error.message, 'the widget service refused');
  assert.deepEqual(rows[1].contract.actions.retry.available, true, 'a failed Job of a kind that declares retry can be retried');
  assert.equal(rows[2].contract.stage.code, 'widgets.complete', 'a partial result is complete with its completeness, not a made-up failure');
  const states = rows.map(item => consoleCode.taskSummary(consoleCode.tasksOf({ jobs: [item] })[0]).state);
  assert.deepEqual(states, ['done', 'fail', 'partial'], 'the console\'s generic states: a partial result is its own state, not a failure');
});

test('queued and running are what they are, an unknown total stays unknown, and a stop works in both states', async t => {
  const h = await harness(t);
  const first = await h.start('first', 'hold'), second = await h.start('second', 'hold');
  await until(() => h.world.state.started.includes('first'), 'the first to run');
  assert.deepEqual([(await status(h, first.jobId)).status, (await status(h, second.jobId)).status], ['running', 'queued']);
  const running = await h.row('widget-first');
  assert.deepEqual([running.contract.progress.total, running.contract.progress.percent, running.contract.progress.unit], [null, null, 'widgets'], 'no total, no invented percent');
  assert.equal(consoleCode.runningTaskCount(await h.service.call('snapshot')), 2);
  assert.equal(consoleCode.taskSummary(await taskOf(h, second.jobId)).state, 'queued');
  // stop the queued one: it never runs; stop the running one: it ends cancelled and lets the next in
  assert.equal((await h.service.call('job.control', { jobId: second.jobId, action: 'cancel' })).action, 'cancel');
  assert.equal((await ended(h, second.jobId)).status, 'cancelled');
  assert.equal(h.world.state.started.includes('second'), false, 'a cancelled queued Job never started');
  await h.service.call('job.control', { jobId: first.jobId, action: 'cancel' });
  assert.equal((await ended(h, first.jobId)).status, 'cancelled');
  assert.equal(h.world.state.active, 0, 'the domain\'s gate was given back');
});

test('retry is the generic control: the same Job, a new Attempt, and the domain\'s authorisation is asked again, before any work', async t => {
  const h = await harness(t);
  const first = await h.start('again', 'fail'), failed = await ended(h, first.jobId);
  assert.equal(failed.status, 'failed');
  const retried = await h.service.call('job.control', { jobId: first.jobId, action: 'retry' });
  assert.equal(retried.action, 'retry');
  await ended(h, first.jobId);
  const row = await h.row('widget-again');
  assert.equal(row.contract.runtime.attempts.length, 2, 'two Attempts of one Job');
  assert.equal(row.contract.jobId, first.jobId, 'the same Job');
  // the domain withdraws its authorisation: a retry is refused by the same admission, and the work does not start again
  h.world.state.authorised = false;
  const started = h.world.state.started.length;
  await h.service.call('job.control', { jobId: first.jobId, action: 'retry' });
  const refused = await ended(h, first.jobId);
  assert.deepEqual([refused.status, refused.stage, h.world.state.started.length], ['failed', 'not allowed', started], 'no run, no model call');
  h.world.state.authorised = true;
});

test('a submission the domain\'s admission refuses ends as a failed Job with the reason, and no work, no model request starts', async t => {
  const h = await harness(t);
  h.world.state.authorised = false;
  const job = await h.start('nope'), refused = await ended(h, job.jobId);
  assert.deepEqual([refused.status, refused.stage], ['failed', 'not allowed']);
  assert.deepEqual([h.world.state.started.length, h.chunks.length], [0, 0]);
  assert.equal((await h.row('widget-nope')).contract.calls.length, 0, 'not one Call');
});

test('output is the generic reader: from a cursor, partial while writing, truncated to what the console keeps', async t => {
  const h = await harness(t);
  const small = await ended(h, (await h.start('small')).jobId), call = (await h.row(small.id)).contract.calls[0];
  const all = await h.service.call('job.output', { jobId: small.id, callId: call.callId, cursor: 0 });
  assert.deepEqual([all.text, all.supported, all.retention.limit], ['alpha beta', true, OUTPUT_LIMIT]);
  const rest = await h.service.call('job.output', { jobId: small.id, callId: call.callId, cursor: 6 });
  assert.equal(rest.text, 'beta', 'only what follows the cursor');
  const big = await ended(h, (await h.start('big', 'big')).jobId), bigCall = (await h.row(big.id)).contract.calls[0];
  const kept = await h.service.call('job.output', { jobId: big.id, callId: bigCall.callId, cursor: 0 });
  assert.ok(kept.text.length <= OUTPUT_LIMIT && kept.writtenChars > OUTPUT_LIMIT, 'the tail is kept, the count says how much was written');
  assert.ok(kept.partial === true || kept.truncated === true, 'and the reply says it is partial');
});

test('a stop that arrives late changes nothing: the Job ends cancelled, publishes no result, and a second stop after it is no second ending', async t => {
  const h = await harness(t);
  const job = await h.start('slow', 'ignore-stop');
  await until(() => h.world.state.started.includes('slow'), 'the work to start');
  await h.service.call('job.control', { jobId: job.jobId, action: 'cancel' });
  assert.equal((await status(h, job.jobId)).status, 'cancelling', 'stopping until the work really lets go');
  await assert.rejects(h.service.call('job.control', { jobId: job.jobId, action: 'retry' }), error => Boolean(error.message), 'a retry is not offered while it is stopping');
  h.world.late.release();
  const end = await ended(h, job.jobId), row = await h.row('widget-slow');
  assert.deepEqual([end.status, row.contract.result.refs, row.contract.runtime.attempts.length], ['cancelled', [], 1], 'the late result was dropped');
  assert.equal(row.contract.events.filter(event => event.type === 'settled').length, 1, 'one ending');
  await h.service.call('job.control', { jobId: job.jobId, action: 'cancel' }); // a stop after the end is harmless: it answers, and ends nothing twice
  const again = await h.row('widget-slow');
  assert.deepEqual([again.status, again.contract.events.filter(event => event.type === 'settled').length, again.contract.runtime.attempts.length], ['cancelled', 1, 1]);
});

test('another owner never sees, controls or waits for it; an unload ends what is running and leaves nothing running', async t => {
  const h = await harness(t);
  const job = await h.start('mine', 'hold');
  await until(() => h.world.state.started.includes('mine'), 'the work to start');
  const stranger = { ...h.options, workOwner: Symbol('someone else') };
  await assert.rejects(h.service.runtime.call('job.control', { jobId: job.jobId, action: 'cancel' }, stranger), /not found|owner/i);
  assert.deepEqual((await h.service.runtime.call('job.status', {}, stranger)).jobs, [], 'not even in a list');
  await h.service.dispose();
  h.world.hold.release();
  await until(() => h.world.state.active === 0, 'the gate to be given back after the unload');
  assert.equal([...h.service.runtime.work.jobs.values()].filter(item => item.type === KIND && ['running', 'queued', 'cancelling'].includes(item.status)).length, 0, 'nothing is left running');
});

/* ---------- the proof that nothing else had to know ---------- */

test('no kernel file, no console file and no inventory knows the synthetic kind: it was added by registration alone', async () => {
  const mentions = [];
  for (const directory of ['lib/jobs', 'ui/tasks', 'lib/runtime', 'lib/contexts/jobs']) {
    const walk = async path => { for (const entry of await readdir(new URL(`../${path}`, import.meta.url), { withFileTypes: true })) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:js|jsx)$/.test(entry.name) && /widget-sync|widgets\.v1/.test(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'))) mentions.push(file);
    } };
    await walk(directory);
  }
  assert.deepEqual(mentions, []);
});
