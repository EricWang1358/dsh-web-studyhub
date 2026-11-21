import { courseOutlineIndex, layoutOf } from '../course-outline.js';
import { currentCourseOutline, outlineStale } from '../course-outline-book.js';
import { currentInventory } from '../course-book-inventory.js';
import { ROUND_LIMIT } from '../coverage-round.js';
import { sourcesOfDraft } from '../coverage-state.js';
import { courseOf } from '../focus.js';
import { sourcesWithCourses } from '../source-courses.js';
import { linkedBook } from './point-rows.js';
import { POINT_LIMITS, outlineLeaves, pointGaps, pointSpans } from './point-link.js';

/* 知识点查缺 for one course: how many knowledge points its outline has, how many have a question (published or in a draft, the outline page's 未出题 lens reads
   the same link: lib/evidence/point-rows.js), and which have none, in the order to fill them. Read on demand (the draft page's `coverage.get`); never starts an
   outline build (it costs model calls). Pure over the library state. */

/** Why there are no numbers: no outline for the course, an outline of descriptors (its points name no inventory item), the inventory is gone, the outline is out
    of date (the materials changed since it was built). */
export const POINT_REASONS = Object.freeze(['no-outline', 'descriptors', 'no-inventory', 'stale']);
const unavailable = reason => ({ status: 'unavailable', reason });

/** What a report rests on: { status: 'ok', record, outline, inventory, book } or why not ({ status: 'unavailable', reason }). */
export function pointBasis(state, course, { root = '', now = Date.now() } = {}) {
  if (typeof course !== 'string' || course === '*') return unavailable('no-outline');
  const record = currentCourseOutline(state?.sources, course);
  if (!record) return unavailable('no-outline');
  const outline = record.courseOutline;
  if (outline.from !== 'inventory') return unavailable('descriptors');
  const inventory = currentInventory(state.sources, course)?.courseInventory;
  if (!inventory) return unavailable('no-inventory');
  const index = courseOutlineIndex(state, { course }, { root, now }), layout = layoutOf(index);
  if (outlineStale(outline, index.allDocuments)) return unavailable('stale');
  return { status: 'ok', record, outline, inventory, book: linkedBook(layout, record, index, state.sources, course) };
}

/**
 * The report: { status: 'ok', points, covered, uncovered, uncoverable, unplaced, list: [{ id, title, coverable, quota, dependents, prereqs }], more,
 * topUp: { pointIds, questions } | null } or { status: 'unavailable', reason }. `list` is the first POINT_LIMITS.listed uncovered points (prerequisites of others
 * first), `prereqs` the names of what a point rests on; `uncoverable` the uncovered points with no verified text to be written from; `topUp` what one round of
 * at most `limit` questions fills, in that order (what 「补这些知识点」 sends).
 */
export function coursePointReport(state, course, { limit = ROUND_LIMIT, root = '', now } = {}) {
  const basis = pointBasis(state, course, { root, ...(now ? { now } : {}) });
  if (basis.status !== 'ok') return basis;
  return reportOf(basis, { limit });
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

/** The report of a draft (`coverage.get`): the points of its materials, each with a question when the course has one for it anywhere (the outline page's answer).
    null for a draft of no course: an outline belongs to a course, so there is nothing to say. */
export function draftPointReport(state, draft, { limit = ROUND_LIMIT, root = '' } = {}) {
  const course = draftPointCourse(state, draft);
  if (typeof course !== 'string' || !course || course === '*') return null;
  const basis = pointBasis(state, course, { root });
  if (basis.status !== 'ok') return basis;
  const sourceIds = sourcesOfDraft(state, draft).map(source => source.id);
  return reportOf(basis, { limit, within: pointsIn(basis.outline, basis.inventory, sourceIds), sourceIds });
}

/** The report of a basis (pointBasis); `within`: the point ids it is about (default: every point of the outline); `sourceIds`: the sources it may be written
    from (a draft's materials: a point whose verified text is all elsewhere cannot be topped up through that draft). */
export function reportOf({ outline, inventory, book }, { limit = ROUND_LIMIT, within = null, sourceIds = null } = {}) {
  const all = pointGaps(outline, inventory, book.pointCards || []), mine = point => !within || within.has(point.id);
  const leaves = new Map(outlineLeaves(outline).map(leaf => [leaf.id, leaf])), from = sourceIds && new Set(sourceIds);
  const writable = point => point.coverable && (!from || pointSpans(leaves.get(point.id), inventory).some(span => from.has(span.sourceId)));
  const points = all.points.filter(mine).map(point => ({ ...point, coverable: writable(point) }));
  const gaps = { ...all, points, uncovered: all.uncovered.filter(id => !within || within.has(id)) }, byId = new Map(points.map(point => [point.id, point]));
  const titles = new Map([...leaves.values()].map(leaf => [leaf.id, leaf.title]));
  const uncovered = gaps.uncovered.map(id => byId.get(id));
  const list = uncovered.slice(0, POINT_LIMITS.listed).map(point => ({ id: point.id, title: point.title, coverable: point.coverable, quota: point.quota,
    dependents: point.dependents, prereqs: point.prereqIds.map(id => titles.get(id)).filter(Boolean) }));
  const chosen = [];
  let questions = 0;
  for (const point of uncovered) {
    if (!point.coverable || questions + point.quota > limit) continue;
    chosen.push(point.id);
    questions += point.quota;
  }
  return { status: 'ok', points: gaps.points.length, covered: gaps.points.length - uncovered.length, uncovered: uncovered.length,
    uncoverable: uncovered.filter(point => !point.coverable).length, unplaced: gaps.unplaced, list, more: Math.max(0, uncovered.length - list.length),
    topUp: chosen.length ? { pointIds: chosen, questions } : null };
}
