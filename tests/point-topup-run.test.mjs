import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { settleJob } from './helpers/wait.mjs';
import { pinStaged } from './helpers/staged-strategy.mjs';
import { COURSE, SENTENCES, pointPages, pointRecords } from './helpers/point-library.mjs';

/* 补这些知识点 end to end, with the fake model: a draft's report names a knowledge point without a question (B: it teaches on page 1 but owns no page, so
   no page-based count could ever give it one), 「补这些知识点」 tops it up through the same top-up run as any other (estimate first, the draft's own strategy),
   and the report read again has it covered. */

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-points-'));
  const log = [], fake = createFakeModel({ log, usage: true }), review = { fail: false };
  // `review.fail`: the one-pass review fails every card it judges from then on (a question the review drops).
  const complete = async (system, prompt, options) => {
    const reply = await fake(system, prompt, options);
    if (!review.fail || log.findLast(entry => entry.system === system && entry.prompt === prompt)?.handler !== 'generation.one-pass.review') return reply;
    const value = JSON.parse(reply);
    return JSON.stringify({ reviews: value.reviews.map(entry => ({ ...entry, verdict: 'fail', blocker: 1, issue: 'The quote does not support the answer.' })) });
  };
  const service = new StudyService(root, { coach: false, complete, coverage: { roundLimit: 8 } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: pointPages({ spread: true }) });
  const { outline, inventory } = pointRecords(await service.call('export'));
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [outline, inventory] });
  return { service, log, review };
}

const reportOf = async (service, draftId) => (await service.call('coverage.get', { draftId, points: true })).points;

async function topUpB(service, draft) {
  const before = await reportOf(service, draft.id);
  assert.equal(before.status, 'ok', JSON.stringify(before));
  assert.ok(before.list.some(point => point.id === 'pb'), `B has no question yet: ${JSON.stringify(before.list)}`);
  const request = { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: ['pb'] } };
  const estimate = await service.call('usage.estimate', { feature: 'generate', ...request });
  // The estimate is the point round's, not the ordinary top-up's (a draft whose sections all have a question: tests/point-review-fixes.test.mjs, B1).
  const ask = async coverage => (await service.call('usage.estimate', { feature: 'generate', resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage })).totalTokens?.high ?? 0;
  assert.ok(estimate.totalTokens?.high > 0, `the estimate shows before the run: ${JSON.stringify(estimate).slice(0, 200)}`);
  assert.notEqual(estimate.totalTokens.high, await ask({}), 'not the ordinary top-up');
  assert.equal(await ask({ pointIds: ['n-rebuilt'] }), 0, 'a refused point round costs nothing');
  const started = await service.call('generate', request);
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const after = (await service.call('export')).drafts.find(item => item.id === draft.id);
  const report = await reportOf(service, draft.id);
  assert.ok(!report.list.some(point => point.id === 'pb'), 'B left the list');
  assert.equal(report.covered, before.covered + 1);
  const added = after.cards.filter(card => !draft.cards.some(old => old.id === card.id));
  assert.ok(added.some(card => card.citations.some(citation => citation.quote?.includes('Beta rule'))), 'the new question quotes B\'s item');
  return { before, report, after };
}

test('a one-pass draft: B is topped up in one pass, its assignment named and counted, and leaves the list', async t => {
  const { service, log } = await library(t);
  const ids = ['doc-p1', 'doc-p2'];
  // count: 1 keeps round 1 to one question (allocated to A, the prerequisite), leaving B open on page 1 so 补这些知识点 tops up B.
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean', count: 1, kind: 'quiz', language: 'English', course: COURSE });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.generation.performance.strategy, 'one-pass');
  const first = log.length;
  const { after, report } = await topUpB(service, draft);
  const calls = log.slice(first).filter(entry => entry.handler?.startsWith('generation.'));
  assert.ok(calls.some(entry => entry.handler === 'generation.one-pass.write'), 'written in one pass, as the draft was');
  const write = calls.find(entry => entry.handler === 'generation.one-pass.write');
  assert.ok(`${write.prompt}`.includes('Point B'), 'the point is named to the writer');
  assert.ok(!`${write.prompt}`.includes(SENTENCES.c), 'and only its passage is sent');
  assert.equal(after.editorial.generation.performance.strategy, 'one-pass');
  const rounds = after.editorial.coverageSpec.rounds, last = rounds.at(-1);
  assert.equal(rounds.length, draft.editorial.coverageSpec.rounds.length + 1, 'one round was added');
  assert.deepEqual([last.fill, last.status, last.questions], [true, 'done', 1], 'a fill round of the plan, like a press for one material');
  assert.ok(report.list.every(point => point.id !== 'pb'));
});

test('a staged draft keeps its strategy: B is written step by step and leaves the list', async t => {
  const { service, log } = await library(t);
  await pinStaged(service);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], count: 1, kind: 'quiz', language: 'English', course: COURSE });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  const first = log.length;
  await topUpB(service, draft);
  const calls = log.slice(first).filter(entry => entry.handler?.startsWith('generation.'));
  assert.ok(!calls.some(entry => entry.handler?.startsWith('generation.one-pass')), `no one-pass call: ${[...new Set(calls.map(entry => entry.handler))]}`);
});

test('a question the review drops does not count: the point stays on the list', async t => {
  const { service, review, log } = await library(t);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'lean', count: 1, kind: 'quiz', language: 'English', course: COURSE });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  const before = await reportOf(service, draft.id);
  assert.ok(before.list.some(point => point.id === 'pb'));
  review.fail = true;
  const first = log.length;
  const topUp = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: ['pb'] } });
  await settleJob(service, topUp.jobId);
  const handlers = log.slice(first).map(entry => entry.handler);
  assert.ok(handlers.includes('generation.one-pass.write') && handlers.includes('generation.one-pass.review'), `written, then judged: ${[...new Set(handlers)]}`);
  const after = (await service.call('export')).drafts.find(item => item.id === draft.id);
  assert.ok(!after.cards.some(card => card.citations.some(citation => citation.quote?.includes('Beta rule'))), 'the dropped question is not in the draft');
  const report = await reportOf(service, draft.id);
  assert.ok(report.list.some(point => point.id === 'pb'), 'B still has no question');
  assert.deepEqual([report.covered, report.uncovered], [before.covered, before.uncovered]);
});

test('a host stop in a point round: the round keeps its points, and 接着做 writes them (nothing is skipped in silence)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-points-stop-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fake = createFakeModel({ usage: true });
  let hang = false, reached;
  const arrived = new Promise(resolve => { reached = resolve; });
  const complete = async (system, prompt, options) => {
    if (!hang) return fake(system, prompt, options);
    reached();
    return new Promise((resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  let service = new StudyService(root, { coach: false, complete, coverage: { roundLimit: 8 } });
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: pointPages({ spread: true }) });
  const { outline, inventory } = pointRecords(await service.call('export'));
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [outline, inventory] });
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'lean', count: 1, kind: 'quiz', language: 'English', course: COURSE });
  await settleJob(service, started.jobId);
  const draft = (await service.call('export')).drafts[0];
  hang = true;
  await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: ['pb'] } });
  await arrived;
  const mid = (await service.call('export')).drafts[0].editorial.coverageSpec.rounds.at(-1);
  await service.dispose();
  assert.deepEqual([mid.fill, mid.status, mid.pointIds], [true, 'running', ['pb']], 'the round in flight names its points');
  service = new StudyService(root, { coach: false, complete: fake, coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  const card = (await service.call('snapshot')).jobs.find(job => job.draftId === draft.id && job.contract?.status === 'interrupted');
  assert.ok(card, 'the stopped job is interrupted');
  const reply = await service.call('job.control', { jobId: card.id, action: 'retry' });
  const done = await settleJob(service, reply.attemptId ?? reply.jobId ?? card.id);
  assert.equal(done.status, 'complete', done.stage);
  const after = (await service.call('export')).drafts[0];
  assert.equal(after.cards.length, draft.cards.length + 1, `the round ran (not skipped as done): ${done.stage}`);
  assert.deepEqual([after.editorial.coverageSpec.rounds.length, after.editorial.coverageSpec.rounds.at(-1).status], [mid.round, 'done'], 'the same round, finished');
  assert.ok(after.cards.some(card => card.citations.some(citation => citation.quote?.includes('Beta rule'))), 'B was written');
  assert.ok(!(await reportOf(service, draft.id)).list.some(point => point.id === 'pb'), 'B left the list');
});

test('a host stop in a point round, then the outline is rebuilt with new ids: 接着做 skips that round with why and goes on, nothing stays pending', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-points-rebuilt-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fake = createFakeModel({ usage: true });
  let hang = false, reached;
  const arrived = new Promise(resolve => { reached = resolve; });
  const complete = async (system, prompt, options) => {
    if (!hang) return fake(system, prompt, options);
    reached();
    return new Promise((resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  let service = new StudyService(root, { coach: false, complete, coverage: { roundLimit: 8 } });
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: pointPages({ spread: true }) });
  const { outline, inventory } = pointRecords(await service.call('export'));
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [outline, inventory] });
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'lean', count: 1, kind: 'quiz', language: 'English', course: COURSE });
  await settleJob(service, started.jobId);
  const draft = (await service.call('export')).drafts[0];
  hang = true;
  await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: ['pb'] } });
  await arrived;
  await service.dispose();
  // The outline is organised again while the host is down: the same course, new leaf ids.
  const rebuilt = JSON.parse(JSON.stringify(outline).replace(/"p([abcd])"/g, '"r$1"'));
  Object.assign(rebuilt, { id: `${outline.id}-2`, createdAt: '2026-11-02T00:00:00.000Z' });
  service = new StudyService(root, { coach: false, complete: fake, coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [rebuilt] });
  const card = (await service.call('snapshot')).jobs.find(job => job.draftId === draft.id && job.contract?.status === 'interrupted');
  assert.ok(card, 'the stopped job is interrupted');
  const reply = await service.call('job.control', { jobId: card.id, action: 'retry' });
  const done = await settleJob(service, reply.attemptId ?? reply.jobId ?? card.id);
  assert.equal(done.status, 'complete', done.stage);
  const rounds = (await service.call('export')).drafts[0].editorial.coverageSpec.rounds;
  assert.deepEqual([rounds.at(-1).pointIds, rounds.at(-1).status, rounds.at(-1).reason], [['pb'], 'skipped', 'points-changed'], 'the round says why it did not run');
  assert.ok(!rounds.some(round => round.status === 'pending' || round.status === 'running'), `nothing pending: ${JSON.stringify(rounds.map(round => round.status))}`);
  const still = (await service.call('snapshot')).jobs.filter(job => job.draftId === draft.id && job.contract?.status === 'interrupted');
  assert.deepEqual(still, [], 'the interrupted card cleared');
});

test('a stale point id is refused before anything runs', async t => {
  const { service } = await library(t);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'lean', kind: 'quiz', language: 'English', course: COURSE });
  await settleJob(service, started.jobId);
  const draft = (await service.call('export')).drafts[0];
  await assert.rejects(service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: ['n-rebuilt'] } }), /课程总纲里找不到这些知识点|not in the course outline/);
  const jobs = (await service.call('snapshot')).jobs.filter(job => job.draftId === draft.id && job.status !== 'complete');
  assert.deepEqual(jobs, [], 'no job was started');
});

test('coverage.get reads the knowledge points only when asked (the draft page); every other caller gets none', async t => {
  const { service } = await library(t);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'lean', kind: 'quiz', language: 'English', course: COURSE });
  await settleJob(service, started.jobId);
  const draft = (await service.call('export')).drafts[0];
  assert.equal((await service.call('coverage.get', { draftId: draft.id })).points, undefined);
  assert.equal((await reportOf(service, draft.id)).status, 'ok');
});
