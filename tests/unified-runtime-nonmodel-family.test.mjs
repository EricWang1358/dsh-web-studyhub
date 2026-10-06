import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { venvLayout } from '../lib/marker-install.js';
import { usageLedger } from '../lib/model-usage.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { fakeIndexPort } from './helpers/index-port.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { answer, course, model, noteOf } from './helpers/recap-library.mjs';
import { patientCli, until } from './helpers/wait.mjs';
import { FRESH } from './helpers/mineru-setup-harness.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* S5-7: the non-model family together and next to a model job (docs/plans/unified-job-runtime/s5-7-acceptance.md): a PDF conversion, the Marker install, the local
   MinerU setup and an index build run beside a model generation without sharing a limit or a queue with it, respect their own shared directory/library locks,
   and read the same through the tool (`job.status`) and the public snapshot, with missing usage left empty instead of 0. Everything is a fake. */

const FAKE_PYTHON = fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
const FAKE_MINERU = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const NON_MODEL = ['pdf-convert', 'marker-install', 'mineru-setup', 'retrieval-index'];
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
const still = job => ['queued', 'running', 'cancelling'].includes(job.status);

async function family(t) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-family-')), before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = join(dir, 'home'); delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const files = { py: join(dir, 'py.json'), mineru: join(dir, 'mineru.json') };
  await writeFile(files.py, JSON.stringify({})); await writeFile(join(dir, 'py.log'), '');
  await writeFile(files.mineru, JSON.stringify({ version: '4.0.10', ...FRESH })); await writeFile(join(dir, 'mineru.log'), '');
  const pyEnv = { FAKE_PY_STATE: files.py, FAKE_PY_LOG: join(dir, 'py.log') };
  const mineruCli = patientCli({ file: process.execPath, prefix: [FAKE_MINERU], env: { FAKE_MINERU_STATE: files.mineru, FAKE_MINERU_LOG: join(dir, 'mineru.log') } });
  const cloud = await startFakeMineru({ holdWhen: () => false }), index = fakeIndexPort(), fake = model(), clock = { time: 5_000_000 };
  const paths = ['dailyRecap', 'pdfConvert', 'markerInstall', 'mineruSetup', 'retrievalIndex'];
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths, complete: fake.complete });
  const service = new StudyService(join(dir, 'library'), { ...managed, complete: fake.complete, coach: false, retrieval: index.port,
    marker: { install: { pythons: [patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: pyEnv })], freeMegabytes: async () => 100_000,
      venvPython: folder => patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...pyEnv, FAKE_PY_VENV: venvLayout(folder).venv } }),
      markerCli: () => patientCli({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) } },
    mineru: { baseUrl: cloud.baseUrl, now: () => clock.time, sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 10)); },
      local: { cli: mineruCli, home: join(dir, 'mineru-home'), modelsCli: patientCli({ ...mineruCli }) } } });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose(); await cloud.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  await call('mineru.settings.set', { token: cloud.token, acknowledge: true });
  await service.store.update(state => {
    state.decks.push({ id: 'd', title: course, course, cards: Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`,
      answer: '正确答案', explanation: '先核对条件。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
  });
  await answer(service, 10);
  const book = Array.from({ length: 4 }, (_, i) => `<!-- page: ${i + 1} -->\nOS 第 ${i + 1} 页讲进程。`).join('\n\n');
  await call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });
  const upload = async pages => {
    const bytes = await makePdf({ pages }), { uploadId, chunkBytes } = await call('mineru.upload.start', { name: `Book${pages}.pdf`, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  const jobs = async () => (await call('snapshot')).jobs;
  return { dir, service, call, cloud, index, fake, jobs, upload, ledger: () => usageLedger(join(dir, 'library')),
    ended: (id, what) => until(async () => { const job = (await jobs()).find(item => item.id === id); return job && !still(job) && job; }, what || `job ${id} to end`, { timeoutMs: 240_000 }) };
}

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
