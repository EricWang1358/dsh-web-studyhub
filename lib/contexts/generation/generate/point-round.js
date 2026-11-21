import { coverageForDraft, sourcesOfDraft } from '../../../coverage-state.js';
import { ROUND_LIMIT, roundRequest } from '../../../coverage-round.js';
import { PLANNED_FAILED } from '../../../coverage.js';
import { POINT_LIMITS, outlineLeaves, pointSpans } from '../../../evidence/point-link.js';
import { draftPoints, pointHold } from '../../../evidence/point-report.js';

/* The top-up of a draft for some knowledge points (coverage.pointIds), the same round as any top-up (lib/coverage-round.js roundRequest, the
   round limit, the estimate, the review). Each point becomes one assignment in the existing shape: its passage (the verified places of its items that overlap
   or touch, lib/evidence/point-link.js pointSpans, and nothing around it: a question is credited to a point by overlapping its verified text), its title, one
   question (two for a large point). The assignment is credited to the section of the draft's coverage holding most of that passage, so the round is recorded
   by sections like every other (a fill round of a planned draft), and the round carries the point ids (a run stopped half way finishes them, covering.js).
   The points are read as the draft's report reads them (lib/evidence/point-report.js draftPoints: the draft's own questions count whatever course it is filed
   under). A held draft (pointHold: it cannot be added to from its sources, or rounds of its plan have not run), a point the outline no longer has, one that
   already has a question, one with no verified text in the draft's materials, or a round over the limit is refused as a whole: nothing runs in part. */

/** The section of the coverage holding most of [start, end) of a source, or null. */
function sectionAt(coverage, { sourceId, start, end }) {
  let best = null, most = 0;
  for (const section of coverage.sections || []) {
    if (section.sourceId !== sourceId) continue;
    const shared = Math.min(end, section.end) - Math.max(start, section.start);
    if (shared > most) { most = shared; best = section; }
  }
  return best;
}

/** A point's passage, at most `maxChars` (from its start when longer), inside its source. */
export function passageOf(span, text, { maxChars = POINT_LIMITS.maxChars } = {}) {
  const length = typeof text === 'string' ? text.length : span.end;
  return { start: span.start, end: Math.min(length, span.end, span.start + maxChars) };
}

/** The assignment of one knowledge point (lib/assigned-plan.js shape). */
export const pointAssignment = (point, { sourceId, start, end }, section) => ({ key: `point:${point.id}`, sectionId: section.key, sourceId, start, end,
  quota: point.quota, title: point.title });

const refusal = (coverage, error, extra = {}) => ({ coverage, round: { error, ...extra } });

/** The draft's points, or why not ({ status: 'unavailable', reason }); a record that cannot be read is 'unreadable' (as the report says). */
function pointsOf(state, draft) {
  try { return draftPoints(state, draft) || { status: 'unavailable', reason: 'no-outline' }; } catch { return { status: 'unavailable', reason: 'unreadable' }; }
}

/** Of `pointIds`, the ones a round would still write (no question yet), in their order; all of them when the points cannot be read (the round's refusal then says why). */
export function openPoints(state, draft, pointIds) {
  const found = pointsOf(state, draft);
  if (found.status !== 'ok') return [...pointIds];
  const open = new Set(found.uncovered);
  return pointIds.filter(id => open.has(id) || !found.points.some(point => point.id === id));
}

/** The round of `pointIds` for `draft`: { coverage, round, request } like lib/coverage-state.js topUpRound, or { coverage, round: { error, key?, reason? } }. */
export function pointTopUpRound(state, draft, { pointIds, batchSize = 5, limit = ROUND_LIMIT } = {}) {
  const coverage = coverageForDraft(state, draft, { targets: true });
  const hold = pointHold(draft);
  if (hold) return refusal(coverage, 'points-held', { reason: hold });
  const found = pointsOf(state, draft);
  if (found.status !== 'ok') return refusal(coverage, 'points-unavailable', { reason: found.reason });
  const sources = sourcesOfDraft(state, draft), byId = new Map(sources.map(source => [source.id, source]));
  const points = new Map(found.points.map(point => [point.id, point])), leaves = new Map(outlineLeaves(found.basis.outline).map(leaf => [leaf.id, leaf]));
  const wanted = [...new Set(pointIds)];
  const unknown = wanted.find(id => !points.has(id));
  if (unknown) return refusal(coverage, 'point-unknown', { key: unknown });
  const covered = wanted.find(id => points.get(id).cards > 0);
  if (covered) return refusal(coverage, 'point-covered', { key: covered });
  const built = [];
  for (const id of wanted) {
    const span = pointSpans(leaves.get(id), found.basis.inventory).find(item => byId.has(item.sourceId));
    const passage = span && { sourceId: span.sourceId, ...passageOf(span, byId.get(span.sourceId).text) }, section = passage && sectionAt(coverage, passage);
    if (!section) return refusal(coverage, 'point-no-text', { key: id });
    built.push({ section, assignment: pointAssignment(points.get(id), passage, section) });
  }
  const questions = built.reduce((sum, item) => sum + item.assignment.quota, 0);
  if (questions > limit) return refusal(coverage, 'too-many', { questions, points: wanted.length, limit });
  const order = new Map((coverage.sections || []).map((section, at) => [section.key, at])), picks = new Map();
  for (const { section, assignment } of [...built].sort((a, b) => order.get(a.section.key) - order.get(b.section.key) || a.assignment.start - b.assignment.start)) {
    if (!picks.has(section.key)) {
      picks.set(section.key, { key: section.key, id: section.id, sourceId: section.sourceId, title: section.title, state: section.state, questions: 0, reuse: 0,
        points: [] });
    }
    const pick = picks.get(section.key);
    pick.points.push(assignment);
    pick.questions += assignment.quota;
  }
  const list = [...picks.values()];
  const round = { picks: list, sections: list.length, questions, fresh: questions, reused: 0, plannedFailed: list.filter(pick => pick.state === PLANNED_FAILED).length,
    neverPlanned: list.filter(pick => pick.state !== PLANNED_FAILED).length, uncovered: list.length, left: 0, allQuestions: questions, rounds: 1, limit, complete: true,
    points: wanted.length, pointIds: wanted };
  return { coverage, round, request: roundRequest(round, coverage, sources, { batchSize }) };
}
