import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobControl, audioControl, generationControl } from '../lib/job-control.js';
import { createPool } from '../lib/audio-pool.js';
import { generateBatched } from '../lib/batch.js';
import { finishTranscript } from '../lib/audio-import.js';
import { StudyService } from '../lib/service.js';
import { qualityPlan, qualityReview, withQualityStages } from './helpers/assessment.mjs';
import { settleJob, until, sleep } from './helpers/wait.mjs';

// WP-TC step 3: instant controls. A change applies from the NEXT call, never interrupts a running one, is bounded, is reported back,
// and the pools read the live values.

const spec = { count: { type: 'int', min: 1, max: 6 }, mode: { type: 'enum', values: ['a', 'b'] }, paused: { type: 'bool' } };

test('a control accepts only what its spec allows and reports what is now in force', () => {
  const job = {}, seen = [];
  const control = createJobControl({ job, spec, values: { count: 3, mode: 'a', paused: false }, apply: (changed) => seen.push(changed) });
  assert.deepEqual(job.control.values, { count: 3, mode: 'a', paused: false });
  assert.deepEqual(job.control.limits.count, { type: 'int', min: 1, max: 6 });
  const result = control.patch({ count: 5 });
  assert.deepEqual(result.applied, { count: 5 });
  assert.deepEqual(result.changed, { count: 5 });
  assert.deepEqual(result.values, { count: 5, mode: 'a', paused: false });
  assert.deepEqual(seen, [{ count: 5 }]);
  assert.equal(job.control.values.count, 5, 'the snapshot job shows the value in force');
  // The same value again is not a change: nothing is applied twice, and it is still reported.
  const again = control.patch({ count: 5 });
  assert.deepEqual(again.changed, {});
  assert.deepEqual(again.applied, { count: 5 });
  assert.equal(seen.length, 1);
  for (const bad of [{ count: 0 }, { count: 7 }, { count: 2.5 }, { count: '3' }, { mode: 'c' }, { paused: 'yes' }, { nope: 1 }, null, [1]])
    assert.throws(() => control.patch(bad), /control|object/i, JSON.stringify(bad));
  assert.equal(control.values.count, 5, 'a refused patch changes nothing');
  assert.throws(() => control.patch({ count: 2, mode: 'zzz' }), /mode/);
  assert.equal(control.values.count, 5, 'and not even the valid half of it');
});

test('pausing is a flag the job shows, with a gate that opens on resume or on cancel', async () => {
  const job = {}, control = createJobControl({ job, spec, values: { count: 3, mode: 'a', paused: false } });
  await control.waitIfPaused();
  control.patch({ paused: true });
  assert.equal(job.paused, true);
  let open = false;
  const waiting = control.waitIfPaused().then(() => { open = true; });
  await sleep(20);
  assert.equal(open, false, 'held while paused');
  control.patch({ paused: false });
  await waiting;
  assert.equal(job.paused, false);
  control.patch({ paused: true });
  const controller = new AbortController();
  const stopped = control.waitIfPaused(controller.signal);
  controller.abort(new Error('stopped by the learner'));
  await assert.rejects(stopped, /stopped by the learner/);
  control.close();
  assert.equal('control' in job, false, 'a finished job has nothing to adjust');
  assert.equal('paused' in job, false);
});

test('the audio pool takes a new limit for the next call and never interrupts a running one', async () => {
  const pool = createPool({ limit: 1 });
  let active = 0, peak = 0;
  const gates = [];
  const work = async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => gates.push(resolve)); active--; };
  const runs = Array.from({ length: 4 }, () => pool.run(work));
  await until(() => gates.length === 1, 'the first call');
  assert.equal(active, 1);
  pool.setLimit(3);
  await until(() => gates.length === 3, 'two more calls admitted by the raised limit');
  assert.equal(pool.state.limit, 3);
  assert.equal(pool.state.effective, 3);
  pool.setLimit(1);
  assert.equal(active, 3, 'lowering does not stop the three that are running');
  gates.splice(0).forEach((resolve) => resolve());
  await until(() => gates.length === 1, 'the fourth call waits for the lowered limit');
  assert.equal(active, 1);
  gates.splice(0).forEach((resolve) => resolve());
  await Promise.all(runs);
  assert.equal(peak, 3);
});

test('a paused pool admits nothing new; the running calls finish; resuming goes on', async () => {
  const pool = createPool({ limit: 2 });
  const started = [], gates = [];
  const call = (name) => pool.run(async () => { started.push(name); await new Promise((resolve) => gates.push(resolve)); });
  const first = call('a');
  await until(() => started.length === 1, 'a started');
  pool.setPaused(true);
  assert.equal(pool.state.paused, true);
  const second = call('b');
  await sleep(30);
  assert.deepEqual(started, ['a'], 'b is held although a slot is free');
  gates.shift()();
  await first;
  pool.setPaused(false);
  await until(() => started.length === 2, 'b starts after the resume');
  gates.shift()();
  await second;
});

test('with the automatic back-off off, a refused call is retried after its wait but the limit stays where the learner put it', async () => {
  const pool = createPool({ limit: 3, backoff: () => 1 });
  pool.setAdaptive(false);
  let refused = 0;
  const run = () => pool.run(async (attempt) => { if (attempt === 0 && refused++ < 3) throw Object.assign(new Error('429 too many requests'), { status: 429 }); return 'ok'; });
  assert.deepEqual(await Promise.all([run(), run(), run()]), ['ok', 'ok', 'ok']);
  assert.equal(pool.state.effective, 3, 'not lowered');
  assert.equal(pool.state.refused, 3, 'but the refusals are still counted');
  pool.setAdaptive(true);
  refused = 0;
  await Promise.all([run(), run(), run()]);
  assert.ok(pool.state.effective < 3, 'switching it back on makes the next refusal lower the limit');
});

test('audioControl: concurrency, reasoning, back-off and pause reach the pool, the settings and the transcription gate', () => {
  const job = { parallel: { text: {}, transcribe: { limit: 1 } } }, settings = { textConcurrency: 3, transcribeConcurrency: 1, proofreadReasoning: 'default', translateReasoning: 'low' };
  const pool = createPool({ limit: 3 }), gate = [];
  const control = audioControl({ job, settings, pools: { text: pool }, setTranscribeLimit: (limit) => gate.push(limit) });
  assert.deepEqual(control.values, { textConcurrency: 3, transcribeConcurrency: 1, proofreadReasoning: 'default', translateReasoning: 'low', autoBackoff: true, paused: false });
  assert.deepEqual(control.spec.textConcurrency, { type: 'int', min: 1, max: 6 });
  assert.deepEqual(control.spec.transcribeConcurrency, { type: 'int', min: 1, max: 3 });
  control.patch({ textConcurrency: 5, transcribeConcurrency: 2, proofreadReasoning: 'high', translateReasoning: 'lowest', autoBackoff: false });
  assert.equal(pool.state.limit, 5);
  assert.equal(settings.textConcurrency, 5);
  assert.deepEqual(gate, [2]);
  assert.equal(job.parallel.transcribe.limit, 2);
  assert.equal(settings.proofreadReasoning, 'high', 'the next proofread call reads it from the settings of the job');
  assert.equal(settings.translateReasoning, 'lowest');
  control.patch({ paused: true });
  assert.equal(pool.state.paused, true);
  control.patch({ paused: false });
  assert.equal(pool.state.paused, false);
  assert.throws(() => control.patch({ proofreadReasoning: 'turbo' }), /proofreadReasoning/);
  assert.throws(() => control.patch({ textConcurrency: 7 }), /textConcurrency/);
  assert.throws(() => control.patch({ transcribeConcurrency: 4 }), /transcribeConcurrency/);
});

test('the windows of an audio stage follow the live limit: raised, more start at once; lowered, a finished window does not start another', async () => {
  const paragraphs = Array.from({ length: 700 }, (_, index) => `Paragraph ${index + 1} of the lecture about software architecture.`);
  const pool = createPool({ limit: 1 });
  let active = 0, peak = 0, started = 0;
  const gates = [];
  const complete = async (system, prompt, options) => {
    started++; active++; peak = Math.max(peak, active);
    try {
      if (options.kind === 'proofread') await new Promise((resolve) => gates.push(resolve));
      return options.kind === 'proofread' ? '{"corrections":[]}' : JSON.stringify({ titleEn: 'P', titleZh: '部分', paragraphs: JSON.parse(prompt).paragraphs.map((item) => ({ n: item.n, zh: 'T' })) });
    } finally { active--; }
  };
  const running = finishTranscript({ paragraphs, filename: 'lecture.wav', settings: { textConcurrency: 1 }, complete, saved: { get: async () => null, set: async () => {} },
    keys: { raw: 'r', text: 't' }, pools: { text: pool } });
  await until(() => gates.length === 1, 'the first window');
  assert.equal(active, 1, 'one window at a time to begin with');
  pool.setLimit(3);
  await until(() => gates.length === 3, 'two more windows start the moment the limit is raised, while the first is still being worked on');
  assert.equal(active, 3);
  pool.setLimit(1);
  gates.splice(0).forEach((resolve) => resolve());
  await until(() => gates.length === 1, 'only one window is started after the three finish');
  assert.equal(active, 1);
  const rest = setInterval(() => gates.splice(0).forEach((resolve) => resolve()), 5);
  try { await running; } finally { clearInterval(rest); }
  assert.ok(started > 5);
});

// ---- generation ----

const paragraph = (n) => `Section ${n}. Architecture includes the principles guiding a system's design and evolution, number ${n}. `.repeat(2);
const sources = Array.from({ length: 4 }, (_, index) => ({ id: `s${index + 1}`, title: `Page ${index + 1}`, text: paragraph(index + 1) }));
const number = (id) => Number(String(id).replace(/\D+/g, ''));
const card = (n, index, targetId, sourceId) => ({ id: `q${index + 1}`, targetId, kind: 'flashcard', topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `What does section ${n} say about architecture principle ${n}?`, answer: `Principles guide later choices ${n}.`, hint: 'Think about change over time.',
  explanation: `The passage ties principle ${n} to design and evolution.`, misconception: 'Architecture only describes components.',
  citations: [{ sourceId, quote: paragraph(number(sourceId)).slice(0, 60) }] });
function provider({ latency = 8, hold } = {}) {
  const log = { active: 0, peak: 0, calls: 0, stages: [] };
  let next = 0;
  const complete = async (system, prompt, context = {}) => {
    log.calls++; log.active++; log.peak = Math.max(log.peak, log.active); log.stages.push(context.stageEffort);
    try {
      await hold?.();
      await new Promise((resolve) => setTimeout(resolve, latency));
      const data = () => JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
      if (system.startsWith('Plan a source-grounded assessment')) {
        const request = data(), source = request.sources[0];
        const plan = qualityPlan({ ...request, kind: 'flashcard', sources: [source] });
        return JSON.stringify({ targets: plan.targets.map((target) => ({ ...target, objective: `Planned ${++next}`, citations: [{ sourceId: source.id, quote: paragraph(number(source.id)).slice(0, 60) }] })) });
      }
      if (system.startsWith('Prepare supported answers')) {
        const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.objective), index, target.targetId, target.citations[0].sourceId));
        return JSON.stringify({ items: cards.map((item, index) => ({ targetId: plan.targets[index].targetId, answer: item.answer, reasoning: item.explanation,
          scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'scope' })) });
      }
      if (system.startsWith('You author')) {
        const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.objective), index, target.targetId, target.citations[0].sourceId));
        return JSON.stringify({ deck: { title: 'D', cards }, changes: [], checks: qualityReview({ cards }).checks });
      }
      if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
      throw new Error(`unexpected call: ${system.slice(0, 40)}`);
    } finally { log.active--; }
  };
  return { complete, log };
}
const run = (model, request = {}) => generateBatched(model.complete, { count: 15, kind: 'flashcard', sources, performance: { concurrency: 1, batchSize: 5, fillRounds: 0 }, ...request });

test('generation reads the live concurrency: raising it lets more calls run together from then on', async () => {
  const job = {}, control = generationControl({ job, request: { performance: { concurrency: 1, batchSize: 5, fillRounds: 0 } } });
  const model = provider({ latency: 25 });
  const running = run(model, { control });
  await until(() => model.log.calls >= 1, 'the first call');
  assert.equal(model.log.peak, 1, 'one at a time to begin with');
  const reply = control.patch({ concurrency: 4 });
  assert.equal(reply.applied.concurrency, 4);
  const result = await running;
  assert.equal(result.cards.length, 15);
  assert.ok(model.log.peak >= 2, `calls overlapped after the change: ${model.log.peak}`);
  assert.ok(model.log.peak <= 4);
});

test('generation paused: the calls in flight finish, no new call starts; resuming goes on and every card still arrives', async () => {
  const job = {}, control = generationControl({ job, request: { performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } } });
  const model = provider({ latency: 15 });
  const running = run(model, { control, performance: { concurrency: 2, batchSize: 5, fillRounds: 0 } });
  await until(() => model.log.calls >= 1, 'the first call');
  control.patch({ paused: true });
  await until(() => model.log.active === 0, 'in-flight calls finish');
  const frozen = model.log.calls;
  await sleep(120);
  assert.equal(model.log.calls, frozen, 'nothing new started while paused');
  assert.equal(job.paused, true);
  control.patch({ paused: false });
  const result = await running;
  assert.equal(result.cards.length, 15);
  assert.ok(model.log.calls > frozen);
});

test('generation reads the reasoning of each stage at the moment of the call', async () => {
  // A stand-in for the job's own step closure: it hands the stage levels of the control to every call, as the generation operation does.
  const control = generationControl({ job: {}, request: { performance: { concurrency: 1, batchSize: 5, fillRounds: 0, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' } } });
  assert.equal(control.values.effortReview, 'follow');
  assert.equal(control.values.effortWriting, 'low');
  control.patch({ effortReview: 'highest', effortPlanning: 'high' });
  assert.deepEqual([control.values.effortPlanning, control.values.effortReview, control.values.effortWriting, control.values.effortRepair], ['high', 'highest', 'low', 'low']);
  assert.throws(() => control.patch({ effortReview: 'turbo' }), /effortReview/);
  assert.throws(() => control.patch({ concurrency: 9 }), /concurrency/);
  assert.deepEqual(control.spec.concurrency, { type: 'int', min: 1, max: 8 });
});

// ---- the service action ----

const source = { id: 'page-a', title: 'Book p.1', text: "Architecture includes the principles guiding a system's design and evolution over time." };
const answer = (n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Architecture', objective: `Target ${n}`, prompt: `Question ${n}: what does the passage establish?`,
  answer: `Answer ${n}.`, hint: 'Think about scope.', explanation: 'The passage states it.', misconception: 'Confusing scope.', citations: [{ sourceId: source.id, quote: source.text }] });

test('job.control: a running generation job takes the change, reports it back and the next calls use it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', source);
  const efforts = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const inner = withQualityStages(async (system, prompt) => {
    if (system.includes('editor')) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
    return JSON.stringify({ title: 'D', cards: Array.from({ length: request.count }, (_, index) => ({ ...answer(index + 1), id: `n${index + 1}`, objective: `New ${index + 1}` })) });
  });
  service.complete = async (system, prompt, options) => { efforts.push(options?.stageEffort); await gate; return inner(system, prompt); };
  const started = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  await until(() => efforts.length >= 1, 'the first model call');
  const running = (await service.call('snapshot')).jobs.find((job) => job.id === started.jobId);
  assert.equal(running.control.values.concurrency, 4, 'the snapshot shows what can be adjusted and its current value');
  assert.equal(running.control.limits.concurrency.max, 8);
  assert.equal(running.paused, false, 'not paused to begin with');
  const reply = await service.call('job.control', { jobId: started.jobId, patch: { concurrency: 2, effortReview: 'highest' } });
  assert.deepEqual(reply.applied, { concurrency: 2, effortReview: 'highest' });
  assert.equal(reply.values.concurrency, 2);
  assert.match(reply.note, /下一|next/i);
  const after = (await service.call('snapshot')).jobs.find((job) => job.id === started.jobId);
  assert.equal(after.control.values.concurrency, 2);
  assert.ok(after.events.some((event) => event.code === 'control'), 'the change is a line of the log');
  release();
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.ok(efforts.slice(1).some((stages) => stages?.review === 'highest'), `later calls were told the new review level: ${JSON.stringify(efforts.map((e) => e?.review))}`);
  const finished = (await service.call('snapshot')).jobs.find((job) => job.id === started.jobId);
  assert.equal('control' in finished, false, 'a finished job has nothing left to adjust');
  await assert.rejects(service.call('job.control', { jobId: started.jobId, patch: { concurrency: 3 } }), /结束|finished|ended/i);
  await assert.rejects(service.call('job.control', { jobId: 'missing', patch: { concurrency: 3 } }), /not found|不存在|Study job/i);
});

test('job.control refuses a bad request before touching the job', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-control-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', source);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  service.complete = async () => { await gate; throw new Error('stop'); };
  const started = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  await assert.rejects(service.call('job.control', { jobId: started.jobId, patch: { concurrency: 99 } }), /concurrency/);
  await assert.rejects(service.call('job.control', { jobId: started.jobId, patch: { textConcurrency: 2 } }), /textConcurrency|Unknown control/);
  await assert.rejects(service.call('job.control', { jobId: started.jobId }), /patch/);
  const snapshot = (await service.call('snapshot')).jobs.find((job) => job.id === started.jobId);
  assert.equal(snapshot.control.values.concurrency, 4, 'nothing moved');
  release();
  await settleJob(service, started.jobId).catch(() => {});
});
