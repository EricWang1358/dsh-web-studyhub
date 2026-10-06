/* S4-9: the model families of P4 together. A translation, a generation, a daily recap and a teaching of the learning workflow run on ONE service with every switch on:
   one public job table, one Call per model call and one ledger write per call, the same list/status/wait/control/output meaning for all of them, switches that move
   one family and no other, a host sub-agent where a policy asks for it, and a library that goes back to the in-process paths without re-running anything.
   (The coach, which has no start of its own in the mix, and the assistant, which only the panel starts, are covered by their own suites.) Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { gate } from './helpers/model-family-baseline.mjs';
import { until, settleJob } from './helpers/wait.mjs';
import { ALL_FAMILIES, ALL_POLICIES, childHost, childReply, mixedLibrary, mixedModel } from './helpers/model-mix.mjs';

const TYPES = ['translation', 'generation', 'daily-recap', 'workflow-teaching'];
const rowsOf = async service => (await service.call('snapshot')).jobs.filter(job => TYPES.includes(job.type));
const idOf = row => row.contract.jobId;
const allEnded = service => until(async () => { const rows = await rowsOf(service); return rows.length === 4 && rows.every(row => row.contract.finishedAt); }, 'every job of the mix to end', { timeoutMs: 60_000 });
const gates = () => ({ translation: gate(), generation: gate(), recap: gate(), workflow: gate() });
const releaseAll = held => Object.values(held).forEach(item => item.release?.() ?? item.open?.());
const startAll = async f => ({ translation: await f.translate({ concurrency: 1 }), generation: await f.generate(), recap: await f.recap(), workflow: await f.teach() });
/** The model has stopped being asked: every family that was started has had its calls. */
const quiet = model => { let last = -1; return until(() => { const now = model.calls.length, same = now === last && now > 0; last = now; return same; }, 'the model to fall quiet', { timeoutMs: 60_000, intervalMs: 400 }); };
const refusal = async (service, jobId, action) => service.call('job.control', { jobId, action }).then(() => 'ok', error => error.code);

test('all four at once: one job table, every family at the model together (translation overlapping the generation), and the same words for list, status, wait and control', async t => {
  const held = gates(), model = mixedModel({ held });
  const f = await mixedLibrary(t, { model });
  t.after(() => releaseAll(held));
  const started = await startAll(f);
  await until(() => Object.values(held).every(item => item.entered), 'every family to reach the model');
  assert.deepEqual(Object.entries(model.live).filter(([, count]) => count > 0).map(([family]) => family).sort(), ['generation', 'recap', 'translation', 'workflow'], 'four families in flight at once');
  const rows = await rowsOf(f.service);
  assert.deepEqual(rows.map(row => row.type).sort(), [...TYPES].sort(), 'one record of the public table per job, none twice');
  assert.equal(new Set(rows.map(idOf)).size, 4);
  assert.ok(rows.every(row => row.contract.contractVersion === 2 && row.contract.runtime.attempts.length === 1 && row.status === 'running'));
  for (const row of rows) {
    const status = await f.service.call('job.status', { jobId: idOf(row) });
    assert.deepEqual([status.status, status.type], ['running', row.type], 'status says what the table says');
  }
  const byType = Object.fromEntries(rows.map(row => [row.type, row]));
  // What a family cannot do is refused in the same words; what it can is done the same way.
  for (const type of ['daily-recap', 'workflow-teaching']) for (const action of ['pause', 'set', 'retry']) assert.equal(await refusal(f.service, idOf(byType[type]), action), 'capability-unsupported', `${type} ${action}`);
  assert.equal(await refusal(f.service, idOf(byType.generation), 'pause'), 'capability-unsupported');
  assert.equal(await refusal(f.service, idOf(byType.translation), 'retry'), 'capability-unsupported');
  assert.equal(await refusal(f.service, idOf(byType.translation), 'pause'), 'ok', 'only the translation pauses, at a wave boundary');
  assert.deepEqual(Object.keys(started).sort(), ['generation', 'recap', 'translation', 'workflow']);
  // Stopping one of them stops that one: the others carry on to their ends.
  await f.service.call('job.control', { jobId: idOf(byType['daily-recap']), action: 'cancel' });
  releaseAll(held);
  const recap = await f.service.call('job.wait', { jobId: idOf(byType['daily-recap']), timeoutSeconds: 30 });
  assert.equal(recap.status, 'cancelled');
  for (const type of ['generation', 'workflow-teaching']) assert.equal((await f.service.call('job.wait', { jobId: idOf(byType[type]), timeoutSeconds: 30 })).status, 'complete', type);
  await until(async () => (await rowsOf(f.service)).find(row => row.type === 'translation').contract.status === 'paused', 'the translation to pause at its wave boundary');
});

test('one Call per model call and one ledger write per Call, for every family of the mix', async t => {
  const model = mixedModel(), f = await mixedLibrary(t, { model });
  await startAll(f);
  await allEnded(f.service);
  const rows = await rowsOf(f.service), calls = rows.flatMap(row => row.contract.calls).filter(call => call.modelRequest !== false && call.kind !== 'wait');
  // How each job ends is the first test's business (on a starved machine a family's own time limit may end one); what follows holds whatever way they ended.
  assert.ok(rows.every(row => ['complete', 'failed'].includes(row.contract.status)), 'every job of the mix is over');
  assert.equal(new Set(calls.map(call => call.callId)).size, calls.length, 'no Call is recorded twice');
  assert.equal(calls.length, model.calls.length, 'the model was asked exactly as often as Calls were recorded');
  const { byFeature } = await usageLedger(f.service.store.root).summary({ days: 1 });
  assert.equal(Object.values(byFeature).reduce((sum, feature) => sum + feature.calls, 0), calls.length, 'the ledger booked each Call once, at its one writing point');
  assert.deepEqual(Object.keys(byFeature).sort(), ['flow', 'generate', 'other'], 'translation and recap are `other`, the learning workflow `flow`, the generation `generate`');
  const output = await f.service.call('job.output', { jobId: idOf(rows[0]), callId: rows[0].contract.calls[0].callId });
  assert.deepEqual([output.supported, output.source], [true, 'memory'], 'a Call\'s output is read the same way whatever family made it');
});

test('a switch moves its own family and no other; the translation overlaps the generation only with its own switch', async t => {
  const plans = [[[], 'nothing'], [['translation'], 'translation'], [['dailyRecap'], 'daily-recap'], [['workflow'], 'workflow-teaching'], [['generation'], 'generation']];
  for (const [on, moved] of plans) {
    const model = mixedModel(), f = await mixedLibrary(t, { on, model });
    await startAll(f);
    await quiet(model);
    const rows = await rowsOf(f.service);
    assert.deepEqual(rows.filter(row => row.contract.runtime).map(row => row.type), moved === 'nothing' ? [] : [moved], `only ${moved} is a Job of the runtime`);
  }
  // The same library with the translation switch but without its parallel policy: one model call at a time between translation and generation.
  const serial = { generation: gate() }, serialModel = mixedModel({ held: serial });
  const f = await mixedLibrary(t, { on: ['translation', 'generation'], model: serialModel });
  t.after(() => serial.generation.release());
  await f.generate(); await until(() => serial.generation.entered, 'the generation to be at the model');
  const translating = await f.translate();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(serialModel.peak.translation, 0, 'the translation waits for the library');
  serial.generation.release();
  assert.equal((await settleJob(f.service, translating.jobId)).status, 'complete');
  assert.equal(serialModel.peak.all, 1, 'one model call at a time in the library');
});

test('with the policies on, the recap, the teaching and the translation ask a host sub-agent through the one gateway, and the usage is still counted once', async t => {
  const host = childHost({ replyFor: childReply }), model = mixedModel(), f = await mixedLibrary(t, { model, host });
  await f.translate(); await f.recap(); await f.teach();
  await until(async () => { const rows = await rowsOf(f.service); return rows.length === 3 && rows.every(row => row.contract.finishedAt); }, 'the three jobs to end', { timeoutMs: 60_000 });
  const rows = await rowsOf(f.service);
  assert.deepEqual(rows.map(row => row.status), ['complete', 'complete', 'complete']);
  const calls = rows.flatMap(row => row.contract.calls);
  assert.ok(calls.length > 0 && calls.every(call => call.runner === 'subagent' && call.executionMode === 'agent-preferred' && call.parentId === 'parent' && call.childId), 'every call was a child of the host');
  assert.equal(model.calls.length, 0, 'the direct model was not asked');
  assert.equal(host.started.length, calls.length);
  assert.equal(host.disposed.length, calls.length, 'every child was released');
  assert.ok(rows.every(row => row.contract.execution.mode === 'subagent'));
});

test('going back: a library whose switches are turned off keeps what the Jobs made, starts nothing by itself, and runs new work the in-process way', async t => {
  const held = { translation: gate() }, model = mixedModel({ held }), f = await mixedLibrary(t, { on: [...ALL_FAMILIES, ...ALL_POLICIES], model });
  const root = f.service.store.root;
  await f.translate({ concurrency: 1 });
  await until(() => held.translation.entered, 'the translation to be at the model');
  held.translation.release();
  await until(async () => (await f.service.call('materials.translation.list', { documentId: f.doc.documentId })).items.length > 0, 'a first wave to be kept');
  await f.service.dispose();   // the host goes away with the translation still running
  const before = model.calls.length;
  const back = mixedModel(), service = new StudyService(root, { complete: back.complete });
  t.after(() => service.dispose());
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(back.calls.length, 0, 'a restart asks no model by itself');
  assert.equal(model.calls.length, before, 'and the old Jobs ask nothing either: the in-flight Attempt is not submitted again');
  const kept = (await service.call('materials.translation.list', { documentId: f.doc.documentId })).items.length;
  assert.ok(kept > 0, 'the paragraphs the Job kept are readable');
  const again = await service.call('generation.translation.start', f.doc);
  const ended = await settleJob(service, again.jobId);
  assert.equal(ended.status, 'complete');
  const row = (await service.call('snapshot')).jobs.find(job => job.id === again.jobId);
  assert.equal(row.contract.runtime, undefined, 'the new job is the in-process one');
  assert.ok(back.calls.length > 0 && back.calls.length < 3, 'only what was not kept is asked');
});
