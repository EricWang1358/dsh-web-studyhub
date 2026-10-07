import test from 'node:test';
import assert from 'node:assert/strict';
import { noteOf, course } from './helpers/recap-library.mjs';
import { family, NON_MODEL, still } from './helpers/nonmodel-library.mjs';
import { until } from './helpers/wait.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* S5-7: the non-model family together and next to a model job (docs/plans/unified-job-runtime/s5-7-acceptance.md): a PDF conversion, the Marker install, the local
   MinerU setup and an index build run beside a model generation without sharing a limit or a queue with it, respect their own shared directory/library locks,
   and read the same through the tool (`job.status`) and the public snapshot, with missing usage left empty instead of 0. Everything is a fake. */

const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);

test('a PDF conversion, the Marker install, the local setup and an index build all finish while a model generation is held: no limit, queue or lock is shared with it', async t => {
  const f = await family(t);
  const held = (() => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; })();
  f.fake.gates.set(0, held);
  t.after(() => held.release());
  const recap = await f.call('note.daily.generate', { course });
  await until(() => f.fake.calls.length === 1, 'the generation to reach the model');
  const started = {
    pdf: await f.call('mineru.import', { uploadId: await f.upload(3), title: 'Book', courses: ['OS'] }),
    install: await f.call('marker.install.start', { confirm: true }),
    setup: await f.call('mineru.local.setup', { tier: 'basic', confirm: true }),
    index: await f.call('retrieval.index.start', { course: 'OS' }),
  };
  await f.ended(started.pdf.jobId, 'the conversion'); await f.ended(started.setup.id, 'the setup'); await f.ended(started.index.runId, 'the index build');
  await until(async () => (await f.call('marker.install.status')).status === 'complete', 'the install', { timeoutMs: 240_000 });
  assert.equal((await f.jobs()).find(job => job.type === 'daily-recap').status, 'running', 'the model job was still held the whole time');
  const kinds = (await f.jobs()).filter(job => NON_MODEL.includes(job.type));
  assert.deepEqual(kinds.map(job => job.type).sort(), [...NON_MODEL].sort());
  for (const job of kinds) assert.notEqual(job.status, 'queued', `${job.type} did not wait behind the model job or each other`);
  assert.equal(f.fake.calls.length, 1, 'no non-model job asked the model');
  assert.equal(consoleCode.runningTaskCount(await f.call('snapshot')), 1, 'only the generation is still counted as running');
  held.release();
  await until(async () => (await noteOf(f.service, recap.id)).generation?.status === 'done', 'the generation to end');
});

test('the shared locks still hold in a mixed run: one conversion at a time, one install per DSH home, one setup and one index build per library', async t => {
  const f = await family(t);
  const first = await f.call('mineru.import', { uploadId: await f.upload(3) }), second = await f.call('mineru.import', { uploadId: await f.upload(5) });
  assert.equal(second.queuedBehind, 1);
  await f.ended(first.jobId); await f.ended(second.jobId);
  const install = await f.call('marker.install.start', { confirm: true });
  await assert.rejects(f.call('marker.install.start', { confirm: true }), { code: 'busy' });
  await assert.rejects(f.call('marker.install.uninstall', { confirm: true }), { code: 'busy' });
  assert.equal(install.status, 'running');
  await until(async () => (await f.call('marker.install.status')).status === 'complete', 'the install', { timeoutMs: 240_000 });
  const a = await f.call('retrieval.index.start', { course: 'OS' }), b = await f.call('retrieval.index.start', { course: 'OS' });
  assert.equal(b.runId, a.runId, 'one build per library');
  await f.ended(a.runId);
  const jobs = (await f.jobs()).filter(job => NON_MODEL.includes(job.type));
  assert.equal(jobs.filter(job => job.type === 'retrieval-index').length, 1);
});

test('tool and public operation agree for every non-model job: the same state, progress and result in `job.status` and the snapshot, and usage that is missing is null, never 0', async t => {
  const f = await family(t);
  const pdf = await f.call('mineru.import', { uploadId: await f.upload(3), courses: ['OS'] });
  await f.call('retrieval.index.start', { course: 'OS' });
  await f.call('marker.install.start', { confirm: true });
  await f.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await until(async () => (await f.jobs()).filter(job => NON_MODEL.includes(job.type)).length === 4 && (await f.jobs()).every(job => !still(job)), 'all four to end', { timeoutMs: 240_000 });
  for (const job of (await f.jobs()).filter(item => NON_MODEL.includes(item.type))) {
    const tool = await f.call('job.status', { jobId: job.id }), { contract } = job;
    assert.deepEqual([tool.id, tool.type, tool.status, tool.finished], [job.id, job.type, job.status, true], `${job.type}: the tool and the snapshot name the same job and state`);
    assert.equal(tool.stage, job.stage, `${job.type}: one stage text`);
    assert.deepEqual(contract.usage, { tokens: null, tokenUsage: null, calls: 0 }, `${job.type}: unknown usage is null, not 0`);
    assert.equal(contract.execution.mode, null);
    assert.equal(contract.calls.every(call => call.tokens === null && call.tokenUsage === null), true);
    const summary = consoleCode.taskSummary(job);
    assert.equal(summary.state, 'done', `${job.type}: the console agrees`);
  }
  const done = (await f.jobs()).find(job => job.id === pdf.jobId);
  assert.deepEqual(done.contract.result.refs.map(ref => ref.kind), Array(3).fill('source'));
  assert.equal((await f.call('job.status', { jobId: pdf.jobId })).sourceIds.length, 3, 'the tool reads the same result');
});

test('the capabilities the console offers are the ones each path really has, and no usage row is written for work that made no model call', async t => {
  const f = await family(t);
  const expected = { 'pdf-convert': { retry: true }, 'marker-install': { retry: false }, 'mineru-setup': { retry: false }, 'retrieval-index': { retry: false } };
  const featuresBefore = Object.keys((await f.ledger().summary()).byFeature).sort();
  await f.call('mineru.import', { uploadId: await f.upload(3) });
  await f.call('retrieval.index.start', { course: 'OS' });
  await f.call('marker.install.start', { confirm: true });
  await f.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await until(async () => (await f.jobs()).filter(job => NON_MODEL.includes(job.type)).length === 4 && (await f.jobs()).every(job => !still(job)), 'all four to end', { timeoutMs: 240_000 });
  for (const job of (await f.jobs()).filter(item => NON_MODEL.includes(item.type))) {
    const { capabilities, actions } = job.contract;
    assert.equal(capabilities.cancel, true);
    assert.equal(capabilities.pauseMode, 'unsupported');
    assert.equal(capabilities.set, false);
    assert.equal(capabilities.retry, expected[job.type].retry, job.type);
    assert.equal(actions.pause.available, false); assert.equal(actions.set.available, false); assert.equal(actions.resume.available, false);
  }
  assert.deepEqual(Object.keys((await f.ledger().summary()).byFeature).sort(), featuresBefore, 'the usage ledger gained no feature from non-model work');
});
