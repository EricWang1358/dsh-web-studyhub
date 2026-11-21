import { courseOutlineIndex, layoutOf } from '../course-outline-index.js';
import { currentCourseOutline, outlineStale } from '../course-outline-book.js';
import { currentInventory } from '../course-book-inventory.js';
import { ROUND_LIMIT } from '../coverage-round.js';
import { roundList } from '../coverage-run.js';
import { sourcesOfDraft } from '../coverage-state.js';
import { canAddFromSources } from '../draft-continuation.js';
import { courseOf } from '../focus.js';
import { sourcesWithCourses } from '../source-courses.js';
import { linkedBook } from './point-rows.js';
import { POINT_LIMITS, outlineLeaves, pointGaps, pointSpans } from './point-link.js';

/* 知识点查缺 for one course: how many knowledge points its outline has, how many have a question (published or in a draft, the outline page's 未出题 lens reads
   the same link: lib/evidence/point-rows.js), and which have none, in the order to fill them. Read on demand (the draft page's `coverage.get { points: true }`);
   never starts an outline build (it costs model calls). Pure over the library state. */

/** Why there are no numbers: no outline for the course, an outline of descriptors (its points name no inventory item), the inventory is gone, the outline is out
    of date (the materials changed since it was built), or the records could not be read (a malformed outline or inventory: the rest of the answer stands). */
export const POINT_REASONS = Object.freeze(['no-outline', 'descriptors', 'no-inventory', 'stale', 'unreadable']);
const unavailable = reason => ({ status: 'unavailable', reason });

const reported = new Set(), REPORTED_MAX = 50;
/** A record that cannot be read is said in the host's log the way other non-fatal failures are (`[study] …` on the console, lib/job-cleanup.js), once per cause
    (the page asks again on every change); the answer goes on as 'unreadable'. `where`: who read it. */
export function reportUnreadable(error, where) {
  const line = `[study] knowledge points: ${where} could not read the course outline or inventory: ${String(error?.message || error).slice(0, 300)}`;
  if (reported.has(line)) return;
  if (reported.size >= REPORTED_MAX) reported.clear();
  reported.add(line);
  console.warn(line);
}

/** Why a draft is not offered 补这些知识点 although it has points without a question: it cannot be added to from its sources (a case paper, an edit or a repair of a
    published deck: lib/draft-continuation.js canAddFromSources), or rounds of its plan have not run yet (a point round credits a planned section, and the plan
    would then skip that section's round: the planned questions would be lost). */
export const POINT_HOLDS = Object.freeze(['cannot-top-up', 'planned-rounds']);

/** The hold of a draft (POINT_HOLDS), or null. */
export function pointHold(draft) {
  if (!canAddFromSources(draft)) return 'cannot-top-up';
  const planned = roundList(draft?.editorial?.coverageSpec).some(item => !item.fill && (item.status === 'pending' || item.status === 'running'));
  return planned ? 'planned-rounds' : null;
}

/** What a report rests on: { status: 'ok', record, outline, inventory, book } or why not ({ status: 'unavailable', reason }). `withDraft`: a draft whose questions
    count whatever course it is filed under (the draft's own report counts its own questions). */
export function pointBasis(state, course, { root = '', now = Date.now(), withDraft } = {}) {
  if (typeof course !== 'string' || course === '*') return unavailable('no-outline');
  const record = currentCourseOutline(state?.sources, course);
  if (!record) return unavailable('no-outline');
  const outline = record.courseOutline;
  if (outline.from !== 'inventory') return unavailable('descriptors');
  const inventory = currentInventory(state.sources, course)?.courseInventory;
  if (!inventory) return unavailable('no-inventory');
  const index = courseOutlineIndex(state, { course, ...(withDraft ? { withDraft } : {}) }, { root, now }), layout = layoutOf(index);
  if (outlineStale(outline, index.allDocuments)) return unavailable('stale');
  return { status: 'ok', record, outline, inventory, book: linkedBook(layout, record, index, state.sources, course) };
}

/** The points of an outline some of whose items stand in these sources (a verified place or not): the points of a draft's materials. */
export function pointsIn(outline, inventory, sourceIds) {
  const wanted = new Set(sourceIds), byItem = new Map((inventory?.items || []).map(item => [item.id, item]));
  return new Set(outlineLeaves(outline).filter(leaf => leaf.items.some(id => (byItem.get(id)?.places || []).some(place => wanted.has(place.sourceId)))).map(leaf => leaf.id));
}

/** The course a draft's points are read in: its own, else the one it was generated for, else the first course of its materials. */
export function draftPointCourse(state, draft) {
  const own = courseOf(draft, state) || draft?.editorial?.generation?.course;
  if (own) return own;
  const wanted = new Set(draft?.editorial?.generation?.sourceIds || []);
  return sourcesWithCourses(state).filter(source => wanted.has(source.id)).flatMap(source => source.courses || []).find(Boolean) ?? null;
}

/**
 * The points of a draft as both the report and the top-up read them (once): null for a draft of no course (an outline belongs to a course), { status:
 * 'unavailable', reason } or { status: 'ok', basis, points: [{ id, title, cards, prereqIds, dependents, coverable, quota }] (the draft's materials' points;
 * `coverable`: verified text in those materials), uncovered: [id], unplaced, sourceIds }. A question of the draft itself counts whatever course it is filed under.
 */
export function draftPoints(state, draft, { root = '' } = {}) {
  const course = draftPointCourse(state, draft);
  if (typeof course !== 'string' || !course || course === '*') return null;
  const basis = pointBasis(state, course, { root, withDraft: draft?.id });
  if (basis.status !== 'ok') return basis;
  const sourceIds = sourcesOfDraft(state, draft).map(source => source.id), from = new Set(sourceIds);
  const within = pointsIn(basis.outline, basis.inventory, sourceIds), leaves = new Map(outlineLeaves(basis.outline).map(leaf => [leaf.id, leaf]));
  const gaps = pointGaps(basis.outline, basis.inventory, basis.book.pointCards || []);
  const writable = point => point.coverable && pointSpans(leaves.get(point.id), basis.inventory).some(span => from.has(span.sourceId));
  const points = gaps.points.filter(point => within.has(point.id)).map(point => ({ ...point, coverable: writable(point) }));
  return { status: 'ok', basis, points, uncovered: gaps.uncovered.filter(id => within.has(id)), unplaced: gaps.unplaced, sourceIds };
}

/**
 * The report of a draft (`coverage.get { points: true }`): { status: 'ok', points, covered, uncovered, uncoverable, unplaced, list: [{ id, title, coverable, quota,
 * dependents, prereqs }], more, topUp: { pointIds, questions } | null, hold? } or { status: 'unavailable', reason }, or null (a draft of no course). `list` is the
 * first POINT_LIMITS.listed uncovered points (prerequisites of others first), `prereqs` the names of what a point rests on; `uncoverable` the uncovered points with
 * no verified text in the draft's materials; `topUp` what one round of at most `limit` questions fills, in that order (what 「补这些知识点」 sends), none while the
 * draft is held (`hold`, POINT_HOLDS). A record that cannot be read gives 'unreadable', never a failed answer.
 */
export function draftPointReport(state, draft, { limit = ROUND_LIMIT, root = '' } = {}) {
  let found;
  try { found = draftPoints(state, draft, { root }); } catch (error) { reportUnreadable(error, 'the draft report'); return unavailable('unreadable'); }
  if (!found || found.status !== 'ok') return found;
  const hold = pointHold(draft);
  return { ...reportOf(found, { limit, offer: !hold }), ...(hold ? { hold } : {}) };
}

/** The report of what draftPoints found; `offer`: false leaves `topUp` out. */
function reportOf({ basis, points, uncovered: ids, unplaced }, { limit, offer }) {
  const byId = new Map(points.map(point => [point.id, point])), titles = new Map(outlineLeaves(basis.outline).map(leaf => [leaf.id, leaf.title]));
  const uncovered = ids.map(id => byId.get(id));
  const list = uncovered.slice(0, POINT_LIMITS.listed).map(point => ({ id: point.id, title: point.title, coverable: point.coverable, quota: point.quota,
    dependents: point.dependents, prereqs: point.prereqIds.map(id => titles.get(id)).filter(Boolean) }));
  const chosen = [];
  let questions = 0;
  for (const point of offer ? uncovered : []) {
    if (!point.coverable || questions + point.quota > limit) continue;
    chosen.push(point.id);
    questions += point.quota;
  }
  return { status: 'ok', points: points.length, covered: points.length - uncovered.length, uncovered: uncovered.length,
    uncoverable: uncovered.filter(point => !point.coverable).length, unplaced, list, more: Math.max(0, uncovered.length - list.length),
    topUp: chosen.length ? { pointIds: chosen, questions } : null };
}
