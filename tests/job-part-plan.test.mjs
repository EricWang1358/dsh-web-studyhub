import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { planGeneration } from '../lib/batch.js';
import { partPlanOf, PART_PLAN_SOURCES, PART_PLAN_LABEL } from '../lib/part-plan.js';
import { jobContract } from '../lib/job-contract.js';

// What each part of a question run covers (the 任务 console's 资料部分 follows a part to its material): recorded when the parts are planned, so a part that is
// still waiting has it too, and read by the job contract into partList[i].sourceIds / .range.

const page = (id, number, extra = {}) => ({ id, title: `Networks · 第 ${number} 页`, text: `page ${number} `.repeat(20), document: { page: number, bookTitle: 'Networks', format: 'pdf' }, ...extra });
const ZH = { range: (from, to) => from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`, join: '、' };
const EN = { range: (from, to) => from === to ? `p. ${from}` : `pp. ${from}–${to}`, join: ', ' };

test('a part is described by the sources it was planned over: their ids once each, and a short label with the page range', () => {
  const planned = [{ sources: [page('p1', 12), page('p2', 13), page('p3', 14)], kind: 'quiz', count: 5 }, { sources: [page('p4', 40)], kind: 'quiz', count: 2 }];
  const plan = partPlanOf(planned, ZH);
  assert.deepEqual(plan.map((entry) => entry.part), [1, 2]);
  assert.deepEqual(plan[0].sourceIds, ['p1', 'p2', 'p3']);
  assert.equal(plan[0].label, 'Networks · 第 12–14 页');
  assert.equal(plan[1].label, 'Networks · 第 40 页');
  assert.equal(partPlanOf(planned, EN)[0].label, 'Networks · pp. 12–14');
});

test('a long source sliced into several pieces is one id, and pages that are not consecutive are listed as separate runs', () => {
  const piece = (text) => ({ ...page('big', 7), text });
  const plan = partPlanOf([{ sources: [piece('a'), piece('b'), page('p9', 9), page('p10', 10), page('p20', 20)], kind: 'quiz', count: 3 }], ZH);
  assert.deepEqual(plan[0].sourceIds, ['big', 'p9', 'p10', 'p20']);
  assert.equal(plan[0].label, 'Networks · 第 7 页、第 9–10 页、第 20 页');
});

test('sources without pages are named by their titles, several documents are named in turn', () => {
  const note = (id, title) => ({ id, title, text: 'x' });
  const plan = partPlanOf([{ sources: [note('n1', 'Week 3 transcript'), note('n2', 'Lecture notes'), page('p1', 3, { document: { page: 3, bookTitle: 'Other book', format: 'pdf' } })], count: 2 }], ZH);
  assert.equal(plan[0].label, 'Week 3 transcript、Lecture notes、Other book · 第 3 页');
});

test('what is recorded stays small: at most PART_PLAN_SOURCES ids (with the true count kept) and a label of at most PART_PLAN_LABEL characters', () => {
  const many = Array.from({ length: 80 }, (_, index) => page(`s${index}`, index * 2 + 1));
  const [entry] = partPlanOf([{ sources: many, count: 5 }], ZH);
  assert.equal(entry.sourceIds.length, PART_PLAN_SOURCES);
  assert.equal(entry.sourceCount, 80);
  assert.ok(entry.label.length <= PART_PLAN_LABEL, `label is ${entry.label.length} characters`);
  assert.match(entry.label, /…$/);
  const [wide] = partPlanOf([{ sources: [{ id: 'x', title: 'T'.repeat(500), text: 'x' }], count: 1 }], ZH);
  assert.ok(wide.label.length <= PART_PLAN_LABEL);
  assert.deepEqual(partPlanOf([], ZH), []);
  assert.deepEqual(partPlanOf(undefined, ZH), []);
  assert.deepEqual(partPlanOf([{ count: 1 }, { sources: [{ title: 'no id', text: 'x' }], count: 1 }], ZH).map((entry) => entry.sourceIds), [[], []]);
});

test('it describes what planGeneration really cuts: one entry per planned part, the same order', () => {
  const sources = Array.from({ length: 6 }, (_, index) => page(`p${index + 1}`, index + 1, { text: 'word '.repeat(40000) }));
  const planned = planGeneration({ sources, count: 12, kind: 'quiz', performance: { batchSize: 5 } });
  const plan = partPlanOf(planned, ZH);
  assert.equal(plan.length, planned.length);
  assert.ok(plan.length > 1);
  const known = new Set(sources.map((source) => source.id));
  assert.ok(planned.every((part, at) => plan[at].sourceIds.length > 0 && plan[at].sourceIds.every((id) => known.has(id))));
});

const generation = (extra = {}) => ({ id: 'g', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 0, parts: 3, startedAt: '2026-10-05T10:00:00Z', steps: [], ...extra });
const plan = [{ part: 1, sourceIds: ['p1', 'p2'], sourceCount: 2, label: 'Networks · 第 1–2 页' }, { part: 2, sourceIds: ['p3'], sourceCount: 1, label: 'Networks · 第 3 页' }];

test('the contract carries each part\'s sourceIds and range from the start of the run, for a question run and for a supplement', () => {
  for (const type of [undefined, 'supplement']) {
    const list = jobContract(generation({ type, partPlan: plan })).detail.partList;
    assert.deepEqual(list.map((part) => [part.part, part.status]), [[1, 'waiting'], [2, 'waiting'], [3, 'waiting']]);
    assert.deepEqual(list[0].sourceIds, ['p1', 'p2']);
    assert.equal(list[0].range, 'Networks · 第 1–2 页');
    assert.equal(list[0].sourceCount, 2);
    assert.deepEqual(list[1].sourceIds, ['p3']);
    assert.equal(list[2].sourceIds, undefined, 'a part the plan does not name has nothing to follow');
    assert.equal(list[2].range, undefined);
  }
});

test('once the run has reported, the parts keep their sources next to what they kept and why', () => {
  const list = jobContract(generation({ status: 'complete', parts: 2, partPlan: plan,
    partReport: { summary: 's', parts: [{ part: 1, asked: 5, kept: 5, status: 'passed' }, { part: 2, asked: 5, kept: 0, status: 'failed', reasons: ['quality'] }] } })).detail.partList;
  assert.deepEqual(list.map((part) => [part.part, part.kept, part.sourceIds.length]), [[1, 5, 2], [2, 0, 1]]);
  assert.deepEqual(list[1].reasons, ['quality']);
});

test('a job with no plan (an older run, a case paper, a translation) has parts without sources and nothing breaks', () => {
  const list = jobContract(generation({ partPlan: undefined })).detail.partList;
  assert.equal(list.length, 3);
  assert.ok(list.every((part) => part.sourceIds === undefined && part.range === undefined));
  assert.deepEqual(jobContract(generation({ parts: 0, partPlan: [] })).detail.partList, []);
  assert.doesNotThrow(() => jobContract(generation({ partPlan: 'broken' })));
  assert.doesNotThrow(() => jobContract(generation({ partPlan: [null, { part: 'x' }, { part: 1, sourceIds: 'nope' }] })));
  const translation = jobContract({ id: 't', type: 'translation', status: 'running', parts: 1, startedAt: '2026-10-05T10:00:00Z', steps: [] });
  assert.ok(Array.isArray(translation.detail.partList || []));
});

test('the snapshot of a job stays small however many sources a part has', () => {
  const huge = [{ part: 1, sourceIds: Array.from({ length: 500 }, (_, index) => `s${index}`), sourceCount: 500, label: 'L'.repeat(5000) }];
  const [part] = jobContract(generation({ parts: 1, partPlan: huge })).detail.partList;
  assert.ok(part.sourceIds.length <= PART_PLAN_SOURCES);
  assert.ok(part.range.length <= PART_PLAN_LABEL);
});

// The run itself writes the plan when it plans the parts.
const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
test('a real run records partPlan on the job as soon as its parts are planned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-part-plan-')), previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const fake = createFakeModel({ latencyMs: 5, usage: true });
  const service = new StudyService(root, { complete: (system, prompt, context = {}) => fake(system, prompt, context), coach: false, language: 'zh' });
  t.after(async () => {
    await service.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const text = 'Microservices split a system into independently deployable services that own their data. Event-driven architecture lets services react to events published by others. ';
  const source = await service.call('source.add', { title: 'Service architecture', text: text.repeat(3) });
  const started = await service.call('generate', { sourceIds: [source.id], count: 5, kind: 'quiz', title: 'Plan', concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS,
    performance: { concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS } });
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.partPlan.length, job.parts);
  assert.deepEqual(job.partPlan[0].sourceIds, [source.id]);
  assert.equal(typeof job.partPlan[0].label, 'string');
  assert.ok(job.partPlan[0].label.length > 0);
  assert.deepEqual(jobContract(job).detail.partList[0].sourceIds, [source.id]);
});
