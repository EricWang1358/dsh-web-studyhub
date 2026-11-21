import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coveragePlan, coverageSpec } from '../lib/coverage-plan.js';
import { planningInputFor } from '../lib/coverage-state.js';
import { STRENGTH } from '../lib/coverage-strength.js';
import { DENSITIES, DEPTHS, settingsOfCell } from '../lib/contexts/generation/presets.js';
import { allocatePointQuotas, assignmentsForPoint } from '../lib/contexts/generation/generate/point-allocate.js';
import { applyRound1PointPlan, roundPointsFor } from '../lib/contexts/generation/generate/point-plan.js';
import { POINT_LIMITS } from '../lib/evidence/point-link.js';
import { writesInOnePass } from '../lib/one-pass/route.js';
import { lengthWeights } from '../lib/section-weights.js';
import { StudyService } from '../lib/service.js';
import { estimateFromState } from '../lib/token-estimate.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { COURSE, pointLibrary, pointPages, pointRecords } from './helpers/point-library.mjs';
import { settleJob } from './helpers/wait.mjs';

/* Feature 1: Round-1 per-knowledge-point allocation (lib/contexts/generation/generate/point-allocate.js, point-plan.js). */

const mkPoint = (id, { order = 0, sectionKey = 's1#0', sourceId = 's1', start = 0, end = 200, items = 4, places = 4, dependents = 0, baseQuota, spans } = {}) => ({
  id,
  title: `Point ${id}`,
  order,
  items,
  baseQuota: baseQuota ?? (items >= POINT_LIMITS.largeItems ? POINT_LIMITS.largeQuota : POINT_LIMITS.quota),
  dependents,
  prereqIds: [],
  spans: spans ?? [{ sourceId, start, end, places, chars: end - start, sectionKey }],
});

test('allocatePointQuotas: deterministic regardless of input order, enforces section floor, then priority order (focus -> dependents -> items -> reading order)', () => {
  const pts = [
    mkPoint('p1', { order: 0, sectionKey: 's1#0', items: 3, dependents: 0 }),
    mkPoint('p2', { order: 1, sectionKey: 's1#0', items: 10, dependents: 2 }),
    mkPoint('p3', { order: 2, sectionKey: 's1#0', items: 8, dependents: 1 }),
    mkPoint('p4', { order: 3, sectionKey: 's2#0', items: 2, dependents: 0 }),
    mkPoint('p5', { order: 4, sectionKey: 's2#0', items: 5, dependents: 0 }),
  ];
  // Budget 3 across 2 sections: Pass 1 picks p2 (best in s1) and p5 (best in s2); Pass 2 picks p3 (dependents: 1 > p1, p4).
  const first = allocatePointQuotas(pts, 3, { level: 'standard' });
  const reversed = allocatePointQuotas([...pts].reverse(), 3, { level: 'standard' });
  assert.deepEqual(first.allocations.map(a => [a.point.id, a.quota, a.reason]), [['p2', 1, 'section-floor'], ['p3', 1, 'point'], ['p5', 1, 'section-floor']]);
  assert.deepEqual(reversed.allocations.map(a => [a.point.id, a.quota, a.reason]), first.allocations.map(a => [a.point.id, a.quota, a.reason]));
  assert.equal(first.remaining, 0);

  // Focus tier on s2 lifts p4 ahead of p3 when choosing Pass-2 breadth-first.
  const sectionMeta = new Map([['s1#0', { focusTier: 99, weight: 100 }], ['s2#0', { focusTier: 0, weight: 100 }]]);
  const focused = allocatePointQuotas(pts, 3, { level: 'standard', sectionMeta });
  assert.deepEqual(focused.allocations.map(a => a.point.id), ['p2', 'p4', 'p5']);
});

test('allocatePointQuotas: equal questions & points gives 1 each; large points (>= largeItems) boost to 2 before ordinary points receive surplus', () => {
  const pts = [
    mkPoint('small-a', { order: 0, items: 5, places: 5 }),
    mkPoint('large-b', { order: 1, items: POINT_LIMITS.largeItems, places: 20 }),
    mkPoint('small-c', { order: 2, items: 10, places: 10 }),
  ];
  const exact = allocatePointQuotas(pts, 3, { level: 'standard' });
  assert.deepEqual(exact.allocations.map(a => [a.point.id, a.quota]), [['small-a', 1], ['large-b', 1], ['small-c', 1]]);

  // Budget 4: large-b took section-floor (20 items), small-c & small-a took Pass-2 'point', then large-b boosted to 2 (Pass 3: 'large').
  const boosted = allocatePointQuotas(pts, 4, { level: 'standard' });
  assert.deepEqual(boosted.allocations.map(a => [a.point.id, a.quota, a.reason]), [
    ['small-a', 1, 'point'], ['large-b', 2, 'large'], ['small-c', 1, 'point'],
  ]);

  // Budget 9 at lean (maxQuota 4): every point capped at STRENGTH.lean.maxQuota = 4, total sum = 9.
  const surplus = allocatePointQuotas(pts, 9, { level: 'lean' });
  assert.equal(surplus.remaining, 0);
  assert.equal(surplus.allocations.reduce((sum, a) => sum + a.quota, 0), 9);
  assert.ok(surplus.allocations.every(a => a.quota <= STRENGTH.lean.maxQuota));
  assert.ok(surplus.allocations.find(a => a.point.id === 'large-b').quota >= surplus.allocations.find(a => a.point.id === 'small-a').quota);
});

test('allocatePointQuotas: respects verified-evidence capacity and returns remaining overflow; assignmentsForPoint splits across multiple verified spans', () => {
  const pts = [
    mkPoint('a', { order: 0, items: 2, spans: [
      { sourceId: 's1', start: 0, end: 60, places: 1, chars: 60, sectionKey: 's1#0' },
      { sourceId: 's1', start: 80, end: 140, places: 1, chars: 60, sectionKey: 's1#0' },
    ] }),
    mkPoint('b', { order: 1, items: 1, places: 1, start: 200, end: 260 }),
  ];
  const res = allocatePointQuotas(pts, 5, { level: 'full' });
  assert.deepEqual(res.allocations.map(a => [a.point.id, a.quota]), [['a', 2], ['b', 1]]);
  assert.equal(res.remaining, 2, 'points with 2 and 1 verified places cap at 3 total, leaving 2 for section remainder');

  const split = assignmentsForPoint(res.allocations[0].point, 2, new Map([['s1#0', 0]]));
  assert.deepEqual(split.map(item => [item.key, item.start, item.end, item.quota, item.pointId]), [
    ['point:a', 0, 60, 1, 'a'],
    ['point:a~2', 80, 140, 1, 'a'],
  ]);
});

test('roundPointsFor and applyRound1PointPlan: clean fallback when course/outline/inventory is absent, descriptors, stale, or malformed', t => {
  const { state, sources } = pointLibrary({ spread: true });
  const list = [sources.p1, sources.p2];
  const { leaves } = planningInputFor(state, list);
  const base = coveragePlan({ leaves, weights: lengthWeights(leaves), level: 'standard', onePass: true });

  // No course / wildcard course.
  assert.equal(roundPointsFor(state, { course: '', sources: list, leaves }), null);
  assert.equal(roundPointsFor(state, { course: '*', sources: list, leaves }), null);
  assert.equal(applyRound1PointPlan(base, { state, course: '', sources: list, leaves }), base);

  // Descriptors outline / missing inventory.
  assert.equal(roundPointsFor(pointLibrary({ from: 'descriptors', spread: true }).state, { course: COURSE, sources: list, leaves }), null);
  assert.equal(roundPointsFor(pointLibrary({ withInventory: false, spread: true }).state, { course: COURSE, sources: list, leaves }), null);

  // Stale outline.
  const staleLib = pointLibrary({ spread: true });
  staleLib.sources.p2.text += '\n\nAdded paragraph after outline build.';
  assert.equal(roundPointsFor(staleLib.state, { course: COURSE, sources: [staleLib.sources.p1, staleLib.sources.p2], leaves }), null);

  // Malformed inventory: caught, reported once via reportUnreadable, falls back cleanly.
  const warned = t.mock.method(console, 'warn', () => {});
  const broken = pointLibrary({ spread: true });
  const inv = broken.state.sources.find(s => s.courseInventory).courseInventory;
  Object.defineProperty(inv, 'items', { get() { throw new TypeError('broken-round1-inventory'); } });
  assert.equal(applyRound1PointPlan(base, { state: broken.state, course: COURSE, sources: [broken.sources.p1, broken.sources.p2], leaves }), base);
  assert.ok(warned.mock.calls.some(call => String(call.arguments[0]).includes('broken-round1-inventory')));
});

test('applyRound1PointPlan: preserves unpointed sections, keeps Round 1 total budget & multi-round isolation, and records spec pointIds/pointQuotas', () => {
  const { state, sources } = pointLibrary({ spread: true });
  const extra = { id: 'doc-p3', title: 'Appendix', text: 'Appendix text without any outline point. '.repeat(40), createdAt: '2026-11-01T00:00:00.000Z', courses: [COURSE] };
  const allSources = [sources.p1, sources.p2, extra];
  const { leaves } = planningInputFor(state, allSources);
  // Precompute points only on p1 & p2 (extra has no points) so we test mixed pointed + unpointed Round 1 and multi-round isolation.
  const pre = roundPointsFor(state, { course: COURSE, sources: [sources.p1, sources.p2], leaves });
  assert.ok(pre && pre.points.length === 3);

  // Single-round mixed plan: p1 & p2 are point-allocated, extra keeps its original section assignment.
  const single = coveragePlan({ leaves, weights: lengthWeights(leaves), level: 'standard', onePass: true, limit: 30 });
  const applied = applyRound1PointPlan(single, { leaves, points: pre });
  assert.equal(applied.rounds[0].questions, single.rounds[0].questions);
  assert.equal(applied.plan.quotas.reduce((sum, q) => sum + q.quota, 0), applied.plan.goal);
  assert.ok(applied.rounds[0].assignments.some(a => a.pointId === 'pa'));
  assert.ok(applied.rounds[0].assignments.some(a => a.pointId === 'pb'));
  assert.ok(applied.rounds[0].assignments.some(a => a.pointId === 'pc'));
  assert.ok(applied.rounds[0].assignments.some(a => a.sourceId === 'doc-p3' && !a.pointId), 'unpointed section keeps its section assignment');

  const spec = coverageSpec({ plan: applied.plan, rounds: applied.rounds, weights: lengthWeights(leaves) });
  assert.deepEqual(spec.rounds[0].pointIds, ['pa', 'pb', 'pc']);
  assert.ok(Array.isArray(spec.pointQuotas) && spec.pointQuotas.length === 3);
  const plainSpec = coverageSpec({ plan: single.plan, rounds: single.rounds, weights: lengthWeights(leaves) });
  assert.equal(plainSpec.rounds[0].pointIds, undefined);
  assert.equal(plainSpec.pointQuotas, undefined);

  // Multi-round isolation (limit = 2): Round 1 covers only its own section(s); Round 2+ stay completely untouched.
  const multi = coveragePlan({ leaves, weights: lengthWeights(leaves), level: 'standard', onePass: true, limit: 2 });
  assert.ok(multi.rounds.length >= 2);
  const multiApplied = applyRound1PointPlan(multi, { leaves, points: pre });
  assert.equal(multiApplied.rounds[0].questions, multi.rounds[0].questions);
  assert.deepEqual(multiApplied.rounds.slice(1), multi.rounds.slice(1), 'rounds 2..N are untouched');
  const r1SectionSet = new Set(multi.rounds[0].assignments.map(a => a.sectionId));
  assert.ok(multiApplied.rounds[0].assignments.every(a => r1SectionSet.has(a.sectionId)), 'Round 1 never steals sections from later rounds');
});

test('preset matrix interaction & estimateFromState: all 9 cells (density x depth) + custom count allocate Round 1 points consistently', () => {
  const { state, sources } = pointLibrary({ spread: true });
  const list = [sources.p1, sources.p2];
  const { leaves } = planningInputFor(state, list);

  for (const density of DENSITIES) {
    for (const depth of DEPTHS) {
      const settings = settingsOfCell({ density, depth });
      const onePass = writesInOnePass({ kind: 'quiz', performance: settings.performance });
      const raw = coveragePlan({ leaves, weights: lengthWeights(leaves), level: settings.coverageLevel, onePass });
      const planned = applyRound1PointPlan(raw, { state, course: COURSE, sources: list, leaves });
      assert.equal(planned.rounds[0].questions, raw.rounds[0].questions, `${density} x ${depth}: total budget preserved`);
      assert.ok(planned.rounds[0].pointIds.length >= 1, `${density} x ${depth}: allocates knowledge points`);
      const est = estimateFromState('generate', { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE, kind: 'quiz', ...settings }, state, {});
      assert.equal(est.coverage.firstRoundPoints, planned.rounds[0].pointIds.length, `${density} x ${depth}: estimate matches Round 1 points`);
      assert.ok(est.totalTokens.high > 0, `${density} x ${depth}: positive token estimate`);
    }
  }

  // Custom count = 1 picks only the highest-priority prerequisite point (pa).
  const estOne = estimateFromState('generate', { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE, coverageLevel: 'standard', count: 1, kind: 'quiz' }, state, {});
  assert.equal(estOne.coverage.firstRoundPoints, 1);

  // Without outline, estimate omits firstRoundPoints.
  const noOutline = pointLibrary({ from: 'descriptors', spread: true }).state;
  const estFallback = estimateFromState('generate', { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE, coverageLevel: 'standard', kind: 'quiz' }, noOutline, {});
  assert.equal(estFallback.coverage.firstRoundPoints, undefined);
});

/* ---------- End-to-end StudyService integration tests ---------- */

async function createPointService(t, { withOutline = true, roundLimit = 8 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-round1-points-'));
  const log = [], fake = createFakeModel({ log, usage: true });
  const service = new StudyService(root, { coach: false, complete: fake, coverage: { roundLimit } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: pointPages({ spread: true }) });
  if (withOutline) {
    const { outline, inventory } = pointRecords(await service.call('export'));
    await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [outline, inventory] });
  }
  return { service, log };
}

test('end-to-end one-pass Round 1 (lean): allocates Point A and Point B upfront on page 1, and top-up fills Point C cleanly', async t => {
  const { service, log } = await createPointService(t);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'lean', kind: 'quiz', language: 'English', course: COURSE });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);

  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.generation.performance.strategy, 'one-pass');
  assert.deepEqual(draft.editorial.coverageSpec.rounds[0].pointIds, ['pa', 'pb']);
  assert.equal(job.coverageRun.list[0].points, 2, 'task console row reports 2 knowledge points in Round 1');

  const writeCalls = log.filter(entry => entry.handler === 'generation.one-pass.write');
  assert.ok(writeCalls.length >= 1);
  const combined = writeCalls.map(entry => `${entry.prompt}`).join('\n');
  assert.ok(combined.includes('Point A') && combined.includes('Point B'), 'both knowledge points named to one-pass writer');

  const report = (await service.call('coverage.get', { draftId: draft.id, points: true })).points;
  assert.equal(report.status, 'ok');
  assert.equal(report.covered, 2, 'Point A and Point B are both covered right in Round 1');
  assert.deepEqual(report.list.map(p => p.id), ['pc', 'pd'], 'only Point C (page 2, skipped by lean) and uncoverable Point D remain');
  assert.deepEqual(report.topUp, { pointIds: ['pc'], questions: 1 });

  // Follow-up top-up compatibility: 补这些知识点 cleanly covers Point C.
  const topUp = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: ['pc'] } });
  assert.equal((await settleJob(service, topUp.jobId)).status, 'complete');
  const after = (await service.call('coverage.get', { draftId: draft.id, points: true })).points;
  assert.equal(after.covered, 3, 'all 3 coverable points covered after top-up');
  assert.equal(after.topUp, null);
});

test('end-to-end one-pass standard × scenario and lean × quick cover knowledge points in Round 1 with matching writeStyle', async t => {
  const { service: s1 } = await createPointService(t);
  const stdStart = await s1.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], ...settingsOfCell({ density: 'standard', depth: 'scenario' }), kind: 'quiz', language: 'English', course: COURSE });
  assert.equal((await settleJob(s1, stdStart.jobId)).status, 'complete');
  const stdDraft = (await s1.call('export')).drafts[0];
  assert.deepEqual(stdDraft.editorial.coverageSpec.rounds[0].pointIds, ['pa', 'pb', 'pc']);
  const stdReport = (await s1.call('coverage.get', { draftId: stdDraft.id, points: true })).points;
  assert.equal(stdReport.covered, 3, 'all 3 coverable knowledge points covered right in Round 1');
  assert.ok(stdDraft.cards.some(c => c.citations.some(cit => cit.quote?.includes('Alpha one'))));
  assert.ok(stdDraft.cards.some(c => c.citations.some(cit => cit.quote?.includes('Alpha two'))));
  assert.ok(stdDraft.cards.some(c => c.citations.some(cit => cit.quote?.includes('Beta rule'))));
  assert.ok(stdDraft.cards.some(c => c.citations.some(cit => cit.quote?.includes('Gamma claim'))));

  const { service: s2 } = await createPointService(t);
  const quickStart = await s2.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], ...settingsOfCell({ density: 'lean', depth: 'quick' }), kind: 'quiz', language: 'English', course: COURSE });
  assert.equal((await settleJob(s2, quickStart.jobId)).status, 'complete');
  const quickDraft = (await s2.call('export')).drafts[0];
  assert.equal(quickDraft.editorial.generation.performance.writeStyle, 'quick');
  assert.deepEqual(quickDraft.editorial.coverageSpec.rounds[0].pointIds, ['pa', 'pb']);
});

test('end-to-end staged (blueprint) Round 1 allocates per knowledge point and covers both Point A and Point B', async t => {
  const { service, log } = await createPointService(t);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], ...settingsOfCell({ density: 'standard', depth: 'blueprint' }), count: 3, kind: 'quiz', language: 'English', course: COURSE });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);

  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.generation.performance.strategy, 'staged');
  assert.deepEqual(draft.editorial.coverageSpec.rounds[0].pointIds, ['pa', 'pb', 'pc']);
  assert.ok(!log.some(entry => entry.handler?.startsWith('generation.one-pass')), 'staged pipeline only');
  const report = (await service.call('coverage.get', { draftId: draft.id, points: true })).points;
  assert.equal(report.covered, 3, 'all 3 coverable knowledge points covered in staged Round 1');
});

test('end-to-end non-quiz (flashcard) coverage run allocates Round 1 by knowledge points via staged pipeline', async t => {
  const { service, log } = await createPointService(t);
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'standard', count: 3, kind: 'flashcard', language: 'English', course: COURSE });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);

  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.generation.performance.strategy, 'staged');
  assert.deepEqual(draft.editorial.coverageSpec.rounds[0].pointIds, ['pa', 'pb', 'pc']);
  assert.ok(!log.some(entry => entry.handler?.startsWith('generation.one-pass')), 'flashcards use staged pipeline');
  const report = (await service.call('coverage.get', { draftId: draft.id, points: true })).points;
  assert.equal(report.covered, 3, 'all 3 coverable knowledge points covered for flashcards');
});

test('end-to-end fallback when no course outline exists: runs section-based Round 1 cleanly without pointIds', async t => {
  const { service } = await createPointService(t, { withOutline: false });
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'standard', kind: 'quiz', language: 'English', course: COURSE });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.coverageSpec.rounds[0].pointIds, undefined);
  assert.equal(draft.editorial.coverageSpec.pointQuotas, undefined);
  assert.ok(draft.cards.length >= 2);
});

test('end-to-end multi-round run with autoComplete: Round 1 allocates points on page 1, Round 2 completes page 2 cleanly', async t => {
  const { service } = await createPointService(t, { roundLimit: 2 });
  const started = await service.call('generate', { sourceIds: ['doc-p1', 'doc-p2'], coverageLevel: 'standard', autoComplete: true, kind: 'quiz', language: 'English', course: COURSE });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);

  const draft = (await service.call('export')).drafts[0];
  const rounds = draft.editorial.coverageSpec.rounds;
  assert.ok(rounds.length >= 2, `expected multi-round plan, got ${rounds.length}`);
  assert.deepEqual(rounds[0].pointIds, ['pa', 'pb'], 'Round 1 allocated by knowledge points for page 1');
  assert.equal(rounds[0].status, 'done');
  assert.equal(rounds[1].status, 'done', 'Round 2 ran cleanly without being skipped');
  const report = (await service.call('coverage.get', { draftId: draft.id, points: true })).points;
  assert.equal(report.covered, 3, 'all 3 coverable points covered across Round 1 + Round 2');
});
