/* 3.1.0 step 2: the exam-blueprint build as ONE new kind of Job of the unified runtime (`exam-blueprint-build`, behind the switch `runtime.pilot.examBlueprint`).
   Stage 0 checks the inputs with no model; stage 1 reads lecture slides in windows (a checkpoint between windows); stages 2-3 read a sample paper's shape and map its questions to the points;
   stage 4 checks every place and saves ONE blueprint material through the materials context (step 1's module). The queue, lifecycle, control, metering and the 任务 console are the runtime's.
   Fakes only: no real model, no network. Written before the code. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until, settleJob } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { isExamBlueprintSource } from '../lib/exam-blueprint-material.js';
import { WINDOW_SLIDES } from '../lib/contexts/generation/blueprint/plan.js';

const KIND = 'exam-blueprint-build';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, taskKindOf } from './ui/tasks/task-model.js';`);
const stamp = '2026-10-01T00:00:00.000Z';

/** A lecture deck of `pages` slides, one source per slide; slide `blank` is a picture only and was skipped at import (so it is not a source). */
const deck = (pages, { blank = [], total = pages + blank.length } = {}) => Array.from({ length: pages }, (_, index) => {
  const page = index + 1;
  return { id: `deck-${page}`, title: `传输层.pptx · p.${page}`, text: `## 第 ${page} 页 · 主题${page}\n\n要点${page}：内容${page}内容${page}`, createdAt: stamp, courses: ['网络'],
    document: { page, totalPages: total, format: 'pptx' } };
});
const PAPER = { id: 'paper-1', title: '老师给的样卷', createdAt: stamp, courses: ['网络'],
  text: 'Q1 简述主题3的作用。(10分)\nQ2 比较主题4与主题5。(10分)\nQ3 一道讲义没讲过的题。(5分)' };

const requestData = prompt => JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length).split('\n\nYour previous reply')[0]);
/** The fake model: answers each stage from the request data, and can be told to break. */
function model({ held, fail, junk } = {}) {
  const calls = [];
  const complete = async (system, prompt, request) => {
    const data = requestData(prompt);
    const call = { stage: data.stage, data, request };
    calls.push(call);
    reportUsage({ uncachedInputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (held && calls.length === held.at) await held.gate.promise;
    if (fail?.(call, calls)) throw new Error('provider down');
    if (junk?.(call, calls)) return 'this is not json';
    if (data.stage === 'extract') {
      const first = data.slides[0];
      const page = first.page;
      return JSON.stringify({ points: [
        { title: `主题${page}`, requirement: '掌握', evidence: [{ slideId: first.id, quote: `要点${page}：内容${page}内容${page}` }] },
        // a quote that is not on the slide: dropped, and counted
        { title: `虚构${page}`, evidence: [{ slideId: first.id, quote: '这句话不在任何一页上' }] },
      ] });
    }
    if (data.stage === 'shape') {
      return JSON.stringify({ questions: [
        { label: 'Q1', type: '简答', marks: 10, quote: '简述主题3的作用' }, { label: 'Q2', type: '比较', marks: 10, quote: '比较主题4与主题5' },
        { label: 'Q3', type: '简答', marks: 5, quote: '一道讲义没讲过的题' }] });
    }
    const byTitle = title => data.points.find(point => point.title === title)?.id;
    return JSON.stringify({ mappings: [{ label: 'Q1', pointIds: [byTitle('主题3')].filter(Boolean) }, { label: 'Q2', pointIds: [byTitle('主题4'), 'p999'].filter(Boolean) }, { label: 'Q3', pointIds: [] }] });
  };
  return { calls, complete, of: stage => calls.filter(call => call.stage === stage) };
}

async function world(t, { sources = deck(2, { blank: [3] }), paper = true, fake = model(), enabled = true } = {}) {
  const root = await privateRoot(t, 'exam-blueprint-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions(enabled ? 'runtime' : 'legacy', { complete: fake.complete, paths: enabled ? ['examBlueprint'] : [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...structuredClone(sources), ...(paper ? [structuredClone(PAPER)] : [])); });
  const slides = sources.map(source => source.id);
  const request = (extra = {}) => ({ title: '网络 · 传输层 考点清单', course: '网络', scope: { label: '传输层' }, language: 'zh',
    inputs: [{ role: 'lecture', sourceIds: slides, title: '传输层.pptx' }, ...(paper ? [{ role: 'past-paper', sourceIds: [PAPER.id], title: PAPER.title }] : [])], ...extra });
  const build = extra => service.call('generation.blueprint.build', request(extra));
  const jobs = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND);
  const blueprints = async () => (await service.store.read()).sources.filter(isExamBlueprintSource);
  const contract = () => jobs()[0].contract;
  return { service, fake, request, build, jobs, blueprints, contract, slides };
}
const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });

test('stage 0 refuses, with a code and with no model call and no Job: switch off, no slides, a paper or a textbook alone, a missing material, slides with no text', async t => {
  const off = await world(t, { enabled: false });
  await refused(off.build(), 'blueprint-disabled');
  const w = await world(t);
  await refused(w.build({ inputs: [] }), 'blueprint-needs-primary-input');
  await refused(w.build({ inputs: [{ role: 'past-paper', sourceIds: [PAPER.id] }] }), 'blueprint-needs-primary-input');
  await refused(w.build({ inputs: [{ role: 'textbook', sourceIds: [PAPER.id] }, { role: 'past-paper', sourceIds: [PAPER.id] }] }), 'blueprint-needs-primary-input');
  await refused(w.build({ inputs: [{ role: 'lecture', sourceIds: ['no-such-slide'] }] }), 'blueprint-input-missing');
  await refused(w.build({ inputs: [{ role: 'lecture', documentId: 'no-such-deck' }] }), 'blueprint-input-missing');
  await refused(w.build({ title: '  ' }), 'blueprint-title-required');
  const blank = await world(t, { sources: [{ ...deck(1)[0], text: '   ' }] });
  await refused(blank.build(), 'blueprint-no-readable-text');
  for (const item of [off, w, blank]) assert.deepEqual([item.fake.calls.length, item.jobs().length], [0, 0], 'a refusal costs nothing');
});

test('the estimate is a range of calls and tokens from the real prompts, asked with no model, no Job, and the same through usage.estimate', async t => {
  const w = await world(t, { sources: deck(25) });
  const priced = await w.build({ estimate: true });
  assert.equal(priced.status, 'estimate');
  const windows = Math.ceil(25 / WINDOW_SLIDES);
  // a window each, then the paper: its shape and its mapping
  assert.deepEqual([priced.estimate.calls.low, priced.estimate.calls.high], [windows + 2, windows + 2]);
  assert.ok(priced.estimate.totalTokens.low > 0 && priced.estimate.totalTokens.high >= priced.estimate.totalTokens.low);
  const again = await w.service.call('usage.estimate', { feature: 'blueprint', ...w.request() });
  assert.deepEqual(again.totalTokens, priced.estimate.totalTokens);
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0]);
  const none = await world(t, { paper: false });
  assert.equal((await none.build({ estimate: true })).estimate.calls.high, 1, 'no sample paper: only the slide windows');
});

test('one build is one Job: slides, then the sample paper, then one blueprint material, with a Call per model call and the usage booked once', async t => {
  const w = await world(t);
  const started = await w.build();
  assert.ok(started.jobId);
  // found whole the moment the call returns, before anything else has had a turn
  assert.equal(w.jobs().length, 1);
  assert.equal(w.contract().title, '网络 · 传输层 考点清单');
  const ended = await settleJob(w.service, started.jobId);
  assert.equal(ended.status, 'complete');
  const { contract } = w.jobs()[0];
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], [KIND, 'complete', 'complete', 1]);
  const [saved] = await w.blueprints();
  assert.deepEqual(contract.result.refs, [{ kind: 'source', id: saved.id }]);
  // 1 window (2 slides), the paper's shape, the mapping
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['extract', 'shape', 'map']);
  assert.deepEqual(contract.calls.map(call => [call.kind, call.feature, call.executionMode]), [['plan', 'other', 'direct'], ['plan', 'other', 'direct'], ['plan', 'other', 'direct']]);
  assert.equal(new Set(contract.calls.map(call => call.stepKey)).size, 3, 'a stable step key each');
  const { byFeature } = await usageLedger(w.service.store.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.other.calls], [['other'], 3]);
  // the material
  assert.deepEqual([saved.title, saved.provenance, saved.format, saved.courses], ['网络 · 传输层 考点清单', 'exam-blueprint', 'md', ['网络']]);
  const { blueprint } = saved;
  assert.deepEqual(blueprint.points.map(point => [point.id, point.title, point.backing.kind]), [['p1', '主题1', 'slides']]);
  assert.deepEqual(blueprint.points.map(point => point.title), ['主题1'], 'one point per window in the fake; the invented quote is not a point');
  assert.equal(blueprint.basis.label, '依据 1 份样卷；权重仅供参考');
  assert.deepEqual(blueprint.inputs.find(item => item.role === 'lecture').skippedPages, [3], 'the picture-only slide is reported');
  for (const point of blueprint.points) assert.ok(point.evidence.every(place => place.sourceId && place.quote && place.role));
  assert.deepEqual(blueprint.points[0].evidence[0], { ...blueprint.points[0].evidence[0], sourceId: 'deck-1', role: 'lecture', page: 1 });
  // the console's own detail
  assert.deepEqual(contract.detail.blueprint.windows, { done: 1, total: 1 });
  assert.deepEqual(contract.detail.blueprint.skippedPages, [3]);
  assert.equal(contract.detail.blueprint.dropped.evidence, 1);
  assert.equal(contract.detail.blueprint.dropped.points, 1);
  assert.deepEqual([contract.progress.done, contract.progress.total, contract.progress.unit], [3, 3, 'steps']);
});

test('sample-paper questions map to points only through slides: the shape is kept, an unknown point id is ignored, a question with no point is listed as unmatched', async t => {
  const w = await world(t, { sources: deck(5) });
  await settleJob(w.service, (await w.build()).jobId);
  const [{ blueprint }] = await w.blueprints();
  // the fake writes one point per window: the window of slides 1-5 yields '主题1' only, so every question is unmatched
  assert.deepEqual(blueprint.examShape.unmatched, ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(blueprint.examShape.questions.map(item => [item.label, item.type, item.marks, item.pointIds]), [['Q1', '简答', 10, []], ['Q2', '比较', 10, []], ['Q3', '简答', 5, []]]);
  assert.ok(blueprint.points.every(point => point.backing.kind === 'slides'), 'a point the sample paper does not reach stays a slide point');
});

test('a mapped question adds the sample paper as a second place of the point: backing is both', async t => {
  // a model that extracts a point from every slide, so topics 3 and 4 exist
  const every = model();
  const base = every.complete;
  every.complete = async (system, prompt, request) => {
    const data = requestData(prompt);
    if (data.stage !== 'extract') return base(system, prompt, request);
    every.calls.push({ stage: 'extract', data, request });
    return JSON.stringify({ points: data.slides.map(slide => ({ title: `主题${slide.page}`, evidence: [{ slideId: slide.id, quote: `要点${slide.page}：内容${slide.page}内容${slide.page}` }] })) });
  };
  const both = await world(t, { sources: deck(5), fake: every });
  await settleJob(both.service, (await both.build()).jobId);
  const [{ blueprint, text }] = await both.blueprints();
  const byTitle = Object.fromEntries(blueprint.points.map(point => [point.title, point]));
  assert.deepEqual([byTitle['主题3'].backing.kind, byTitle['主题4'].backing.kind, byTitle['主题1'].backing.kind], ['both', 'both', 'slides']);
  assert.deepEqual(byTitle['主题3'].evidence.map(place => place.role), ['lecture', 'past-paper']);
  assert.deepEqual(blueprint.examShape.questions.map(item => [item.label, item.pointIds]), [['Q1', [byTitle['主题3'].id]], ['Q2', [byTitle['主题4'].id]], ['Q3', []]], 'p999 is not a point and is ignored');
  assert.deepEqual(blueprint.examShape.unmatched, ['Q3']);
  assert.ok(text.includes('样卷形态') && text.includes('Q3'));
});

test('slides only: no paper stage, no weights, and the blueprint says so', async t => {
  const w = await world(t, { paper: false });
  await settleJob(w.service, (await w.build()).jobId);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['extract']);
  const [{ blueprint }] = await w.blueprints();
  assert.equal(blueprint.basis.label, '没有样卷：只列出讲义中的考点，不含考试形态与权重');
  assert.equal(blueprint.examShape, undefined);
});

test('long decks are read in windows with a checkpoint between them: pausing waits for the call in flight, then the resume asks only for the windows left', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { sources: deck(25), paper: false, fake: model({ held }) });
  const started = await w.build();
  await until(() => w.fake.calls.length === 1, 'the first window to reach the model');
  await w.service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal(w.contract().status, 'pausing', 'the call in flight is not interrupted');
  held.gate.release();
  await until(() => w.contract().status === 'paused', 'the checkpoint between windows');
  assert.equal(w.fake.of('extract').length, 1, 'no second window was started while pausing');
  assert.deepEqual(await w.blueprints(), [], 'nothing is saved before the end');
  await w.service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const ended = await settleJob(w.service, started.jobId);
  assert.equal(ended.status, 'complete');
  assert.equal(w.fake.of('extract').length, Math.ceil(25 / WINDOW_SLIDES), 'every window was asked once in all');
  const calls = w.jobs()[0].contract.calls;
  assert.equal(calls.filter(call => call.status === 'skipped').length, 1, 'the finished window is shown as reused, not asked again');
  assert.equal(w.jobs()[0].contract.runtime.attempts.length, 2);
  assert.equal((await w.blueprints()).length, 1);
});

test('stopping aborts the call in flight and saves nothing', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { fake: model({ held }) });
  const started = await w.build();
  await until(() => w.fake.calls.length === 1, 'the model to be asked');
  await w.service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  assert.equal(w.fake.calls[0].request.signal.aborted, true);
  held.gate.release();
  const ended = await settleJob(w.service, started.jobId);
  assert.equal(ended.status, 'cancelled');
  assert.deepEqual(await w.blueprints(), [], 'no half-written blueprint');
});

test('a failed build is retried from the start: every model call is asked again, and nothing was saved in between', async t => {
  let broke = false;
  const fake = model({ fail: call => { if (!broke && call.stage === 'extract' && call.data.slides[0].page === 11) { broke = true; return true; } return false; } });
  const w = await world(t, { sources: deck(25), paper: false, fake });
  const started = await w.build();
  const failed = await settleJob(w.service, started.jobId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(await w.blueprints(), [], 'a failed build leaves no blueprint');
  assert.equal(fake.of('extract').length, 2, 'window 1 answered, window 2 failed');
  assert.equal(w.contract().actions.retry.available, true);
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  const ended = await settleJob(w.service, started.jobId);
  assert.equal(ended.status, 'complete');
  assert.equal(fake.of('extract').length, 2 + 3, 'the retry asks window 1 again: nothing of the failed attempt was kept');
  assert.equal(w.jobs()[0].contract.runtime.attempts.length, 2);
  assert.equal((await w.blueprints()).length, 1);
});

test('an unreadable answer is asked again once; a second one fails the build instead of saving a blueprint with a hole', async t => {
  const once = await world(t, { paper: false, fake: model({ junk: (call, calls) => call.stage === 'extract' && calls.length === 1 }) });
  assert.equal((await settleJob(once.service, (await once.build()).jobId)).status, 'complete');
  assert.equal(once.fake.of('extract').length, 2);
  const twice = await world(t, { paper: false, fake: model({ junk: call => call.stage === 'extract' }) });
  const failed = await settleJob(twice.service, (await twice.build()).jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(twice.fake.of('extract').length, 2);
  assert.deepEqual(await twice.blueprints(), []);
});

test('a slide that is a picture only is never sent to the model and never invented into a point', async t => {
  const w = await world(t, { sources: [...deck(2), { ...deck(3)[2], text: '' }], paper: false });
  await settleJob(w.service, (await w.build()).jobId);
  const sent = w.fake.of('extract').flatMap(call => call.data.slides.map(slide => slide.page));
  assert.deepEqual(sent, [1, 2]);
  const [{ blueprint }] = await w.blueprints();
  assert.deepEqual(blueprint.inputs[0].skippedPages, [3]);
});

test('the console draws it as a task without a branch for its kind, and no kernel or console file knows its name', async t => {
  const w = await world(t);
  await settleJob(w.service, (await w.build()).jobId);
  const tasks = consoleCode.tasksOf(await w.service.call('snapshot'));
  assert.equal(tasks.length, 1);
  assert.equal(consoleCode.taskKindOf(tasks[0]), 'extension');
  const summary = consoleCode.taskSummary(tasks[0]);
  assert.deepEqual([summary.state, summary.title], ['done', '网络 · 传输层 考点清单']);
  assert.ok(summary.line && !/undefined|NaN/.test(JSON.stringify(summary)));
  const names = [];
  for (const dir of ['lib/jobs', 'lib/jobs/lifecycle', 'ui/tasks', 'lib/contexts/jobs']) {
    const folder = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isFile() && /\.(js|jsx)$/.test(entry.name) && /exam-blueprint|examBlueprint/i.test(await readFile(join(folder, entry.name), 'utf8'))) names.push(`${dir}/${entry.name}`);
    }
  }
  assert.deepEqual(names, []);
});
