import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { estimateFromState } from '../lib/token-estimate.js';
import { topUpRound, draftMaterials, coverageForDraft } from '../lib/coverage-state.js';
import { materialForecast, materialReport, materialIndex } from '../lib/coverage-materials.js';
import { REPEAT_LIMIT } from '../lib/coverage-run.js';
import { settleJob } from './helpers/wait.mjs';
import { sectionsOf } from '../lib/sections.js';
import { sectionedModel } from './helpers/coverage-fixture.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { eightRecordings, pdfBook, notes, stateOf } from './helpers/materials-fixture.mjs';

/* Flow A before and after the run: the creation form says 「选了 N 份资料，M 份会出题，K 份不会：原因」 from the plan the run is made with; the draft page says 「选了 N 份，M 份已出题，K 份没出题」
   with each material's reason from what the draft holds, read live; a material without a question has its own 补题, which runs as a fill round of the same executor. */

const sentenceNote = (n) => ({ id: `snote-${n}`, title: `Topic ${n}`, text: Array.from({ length: 3 }, (_, k) => `Recording ${n}, part 1, point ${k + 1}.1: we discuss the platform team and what each product group must build here.`).join('\n\n') });

async function library(t, sources, { complete, spread = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-all-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // `spread`: a planner that follows the prompt and takes a point from every material it is given (the plain path has no program check of the spread, only the prompt).
  const service = new StudyService(root), model = spread ? sectionedModel() : clusteringModel();
  service.complete = complete ? complete(model) : model.complete;
  for (const source of sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text });
  return { service, model, ids: sources.map(source => source.id) };
}

test('before the run: the estimate says how many materials get a question, and a count raised to one per material', () => {
  const { sources } = eightRecordings(), state = stateOf(sources), ids = sources.map(source => source.id);
  const raised = estimateFromState('generate', { sourceIds: ids, coverageLevel: 'standard', count: 5 }, state, { language: 'zh' });
  assert.deepEqual(raised.coverage.raised, { from: 5, to: 8 });
  assert.equal(raised.coverage.goal, 8);
  assert.deepEqual([raised.coverage.materials.selected, raised.coverage.materials.planned, raised.coverage.materials.missing.length], [8, 8, 0]);
  const level = estimateFromState('generate', { sourceIds: ids, coverageLevel: 'standard', autoComplete: false }, state, { language: 'zh' });
  assert.equal(level.coverage.materials.planned, 8, 'round 1 holds every recording, also when the rounds wait for the learner');
});

test('before the run: more materials than one round holds, rounds waiting for the learner: the rest is named with the round they wait for', () => {
  const many = notes(40, 700), state = stateOf(many);
  const estimate = estimateFromState('generate', { sourceIds: many.map(source => source.id), coverageLevel: 'full', autoComplete: false }, state, { language: 'zh' });
  const forecast = estimate.coverage.materials;
  assert.equal(forecast.selected, 40);
  assert.equal(forecast.planned, 30);
  assert.equal(forecast.missing.length + forecast.more, 10);
  assert.ok(forecast.missing.every(item => item.reason === 'round' && item.round === 2));
  const auto = estimateFromState('generate', { sourceIds: many.map(source => source.id), coverageLevel: 'full', autoComplete: true }, state, { language: 'zh' });
  assert.equal(auto.coverage.materials.planned, 40, 'the rounds go on by themselves: every material gets its question');
});

test('materialForecast and materialReport name a material that has no text', () => {
  const sources = [...notes(2), { id: 'blank', title: 'Scan', text: '   \n  ' }];
  const index = materialIndex(sources, { sections: sectionsOf(sources) });
  assert.deepEqual(index.list.map(item => item.reason), [undefined, undefined, 'no-text']);
  const forecast = materialForecast({ materials: index, plan: {}, rounds: [{ assignments: index.list.slice(0, 2).map(item => ({ material: item.key })) }] });
  assert.deepEqual(forecast.missing.map(item => item.reason), ['no-text']);
  const report = materialReport({ materials: { ...index, list: [index.list[2]] }, coverage: { sections: [] } });
  assert.deepEqual(report.rows.map(row => row.reason), ['no-text']);
});

test('after the run: 「选了 8 份，7 份已出题」 with the reason of the eighth, and its 补题 gives it a question in a fill round of its own', async (t) => {
  const { sources } = eightRecordings();
  // The planner finds nothing it can quote in recording 5 (its sentences are hidden from it) until the learner presses 补题 for it.
  let hide = true;
  const { service, ids } = await library(t, sources, { complete: (model) => (system, prompt, context) =>
    model.complete(system, hide && system.startsWith('Plan a source-grounded assessment') ? prompt.replaceAll('Recording 5, part', 'Recording five, part') : prompt, context) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.deepEqual([view.materials.selected, view.materials.covered, view.materials.missing], [8, 7, 1]);
  const row = view.materials.rows[0];
  assert.equal(row.title, 'lecture-05.mp3');
  assert.equal(row.reason, 'plan-short', 'the plan came back short for it (the attempts of its section say so)');
  assert.ok(row.topUp?.keys.length >= 1 && row.topUp.questions >= 1 && row.topUp.questions <= 30);
  hide = false;
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: row.topUp.keys, manual: true, autoComplete: false } });
  assert.equal(next.coverage.sections, row.topUp.keys.length);
  assert.equal((await settleJob(service, next.jobId)).status, 'complete');
  const after = await service.call('coverage.get', { draftId: draft.id });
  assert.deepEqual([after.materials.covered, after.materials.missing], [8, 0], 'every material has a question now');
  const spec = (await service.call('export')).drafts[0].editorial.coverageSpec;
  const last = spec.rounds.at(-1);
  assert.equal(last.fill, true, 'the press is a fill round of its own, after the planned rounds');
  assert.deepEqual([...last.sectionIds].sort(), [...row.topUp.keys].sort());
  assert.ok(spec.rounds.slice(1, -1).every(round => !round.status || round.status === 'pending'), 'the planned rounds were not run by the press');
});

test('the press of a material asks a section that failed again and again too (REPEAT_LIMIT is the run\'s bound, not the learner\'s)', () => {
  const book = pdfBook({ pages: 3 }), keyOf = page => `${book[page - 1].id}#pg${page}`;
  const draft = { id: 'd', cards: [], editorial: { generation: { sourceIds: book.map(source => source.id) },
    coverageSpec: { version: 1, level: 'standard', goal: 45, quotas: [1, 2, 3].map(page => ({ sectionId: keyOf(page), quota: 15, reason: 'share' })), rounds: [{ round: 1, questions: 30, sectionIds: [keyOf(1), keyOf(2)], status: 'done' }],
      attempts: { [keyOf(1)]: { n: REPEAT_LIMIT, reason: 'plan-short', round: 4 } } } } };
  const state = stateOf(book, { drafts: [draft] }), keys = [1, 2, 3].map(keyOf);
  const run = topUpRound(state, draft, { sectionIds: keys, fit: true });
  assert.ok(!run.round.picks.some(pick => pick.key === keyOf(1)), 'a run puts it last (and the round is full before it)');
  const press = topUpRound(state, draft, { sectionIds: keys, manual: true });
  assert.ok(press.round.picks.some(pick => pick.key === keyOf(1)), 'the press asks it');
  assert.ok(press.round.questions <= 30);
  const report = draftMaterials(state, draft, coverageForDraft(state, draft, { targets: true }));
  assert.equal(report.rows[0].reason, 'plan-short');
  assert.ok(report.rows[0].topUp.keys.includes(keyOf(1)));
});

test('a plain run: a count below the number of materials is raised, a selected source the library lost is said', async (t) => {
  const own = Array.from({ length: 6 }, (_, index) => sentenceNote(index + 1));
  const { service, ids } = await library(t, own, { spread: true });
  const started = await service.call('generate', { sourceIds: [...ids, 'gone-before-the-run'], count: 3, kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.deepEqual(job.countRaised, { from: 3, to: 6 });
  assert.equal(job.missingSources, 1);
  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.requested, 6);
  assert.deepEqual(draft.editorial.generation.countRaised, { from: 3, to: 6 });
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.deepEqual(view.materials.raised, { from: 3, to: 6 });
  assert.equal(view.materials.missingSources, 1);
  assert.equal(view.materials.selected, 6);
  assert.equal(view.materials.covered, 6, 'six notes, six questions, one each');
});
