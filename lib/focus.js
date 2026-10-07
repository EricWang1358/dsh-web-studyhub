import { latestOutcomes, cardLevel, deckProgress } from "./mastery.js";
import { libraryCourses, sourcesWithCourses, courseScopes, knownCourseNames } from './source-courses.js';
import { courseScope, courseOrder, courseKnown, coursePath, courseAncestors } from './course-tree.js';
import { courseOf as courseOfRecord, courseIndex } from './courses.js';
import { courseActivityRules, activityFields } from './course-active.js';
import { notExamPointList } from './exam-point-list.js';

/** A deck's course name. Pass the state (or a course index) to resolve ids and renamed names too. */
export const courseOf = (deck, state) => state ? courseOfRecord(deck, state) : deck.course ?? deck.folder ?? '';

export function coursesOf(decks) {
  const courses = new Map();
  for (const deck of decks) {
    if (deck.archived || deck.systemKind) continue;
    const name = courseOf(deck);
    if (!courses.has(name)) courses.set(name, []);
    courses.get(name).push(deck);
  }
  return courses;
}

/**
 * The active decks inside a course scope: the course itself and every course it contains (lib/course-tree.js),
 * a parent's own decks first, then its chapters in natural order. `*` is every deck, `''` the uncategorised ones.
 * Reading only: a deck keeps its own course name.
 * Parked courses (lib/course-active.js) do not count, except when the scope is that parked course itself (a deliberate
 * pick reads everything inside it) or `includeInactive` is set (the learner's "show parked courses" for a page view).
 */
export function decksInCourse(state, course, { includeInactive = false } = {}) {
  const rules = courseActivityRules(state);
  const all = (state.decks || []).filter(deck => !deck.archived && !deck.systemKind);
  const live = includeInactive ? all : all.filter(deck => rules.deckActive(deck));
  if (course === undefined || course === null || course === '*') return live;
  const known = courseKnown(knownCourseNames(state)), within = courseScope(course, known);
  const parked = !includeInactive && !rules.none && typeof course === 'string' && !rules.status(course).active;
  const inside = (parked ? all : live).filter(deck => within(courseOf(deck)));
  if (within.uncategorised) return inside;
  const order = courseOrder(known);
  return inside.sort((a, b) => order(courseOf(a), courseOf(b)));
}

export function currentCourse(state) {
  const courses = libraryCourses(state);
  const selected = state.focus?.course;
  if (selected != null && (courses.includes(selected) || courseScopes(state, courses).includes(selected))) return selected;
  // Older versions persisted the unassigned display label as the focus value.
  if (selected === '未分类课程' && courses.includes('')) return '';
  // With nothing chosen the default is the first course that is not parked.
  const rules = courseActivityRules(state);
  return courses.find(name => rules.status(name).active) ?? courses[0] ?? null;
}

export function freshCardsForDecks(state, decks, count = 10) {
  const outcome = latestOutcomes(state.attempts);
  const newest = [...decks].sort((a, b) =>
    Date.parse(b.publishedAt || b.createdAt || 0) - Date.parse(a.publishedAt || a.createdAt || 0));
  return newest.flatMap((deck) => deck.cards
    .filter((card) => !card.suspended && cardLevel(card, outcome(deck.id, card.id)) === "new")
    .map((card) => ({ deckId: deck.id, cardId: card.id,
      addedAt: card.addedAt || deck.publishedAt || deck.createdAt || "" })))
    .sort((a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0))
    .slice(0, count).map(({ deckId, cardId }) => ({ deckId, cardId }));
}

export function courseFreshCards(state, course = currentCourse(state), count = 10) {
  if (course == null) return [];
  return freshCardsForDecks(state, decksInCourse(state, course), count);
}

/**
 * When each course was last used (ISO time): the newest import into it, deck or
 * draft created in it, or answer given in one of its decks. Pickers rank
 * courses with it (WP14); a course never used has no entry.
 */
export function courseActivity(state, sources = sourcesWithCourses(state).filter(notExamPointList)) {
  const latest = new Map();
  const touch = (name, time) => {
    if (typeof time !== 'string' || !time) return;
    if (!latest.has(name) || latest.get(name) < time) latest.set(name, time);
  };
  for (const source of sources) for (const name of source.courses?.length ? source.courses : ['']) touch(name, source.createdAt);
  const deckCourse = new Map();
  for (const deck of [...(state.decks || []), ...(state.drafts || [])]) {
    if (deck.archived || deck.systemKind) continue;
    const name = courseOf(deck);
    deckCourse.set(deck.id, name);
    touch(name, deck.updatedAt || deck.createdAt);
  }
  for (const attempt of state.attempts || []) if (deckCourse.has(attempt.deckId)) touch(deckCourse.get(attempt.deckId), attempt.timestamp);
  return latest;
}

export function focusView(state) {
  const courses = coursesOf(state.decks);
  const sources = sourcesWithCourses(state).filter(notExamPointList), sourceCounts = new Map();
  for (const source of sources) for (const course of source.courses.length ? source.courses : [''])
    sourceCounts.set(course, (sourceCounts.get(course) || 0) + 1);
  const selected = currentCourse(state);
  const index = courseIndex(state), rules = courseActivityRules(state);
  // A parent counts what is inside it too ("含子课程"): the totals add every course of the subtree.
  const known = courseKnown(knownCourseNames(state));
  const totals = new Map();
  const bump = (name, field, amount = 1) => { for (const path of courseAncestors(name, known)) { const row = totals.get(path) || { decks: 0, sources: 0 }; row[field] += amount; totals.set(path, row); } };
  for (const [name, list] of courses) if (name) bump(name, 'decks', list.length);
  for (const source of sources) for (const path of new Set(source.courses.filter(Boolean).flatMap(name => courseAncestors(name, known)))) {
    const row = totals.get(path) || { decks: 0, sources: 0 };
    row.sources++;
    totals.set(path, row);
  }
  const listed = libraryCourses(state, sources), implicit = new Set(courseScopes(state, listed).slice(listed.length));
  const outcome = latestOutcomes(state.attempts);
  const activity = courseActivity(state, sources);
  const targets = new Set(state.focus?.targetTopics || []);
  const roleWeak = state.decks.filter((deck) => !deck.archived && !deck.systemKind && rules.deckActive(deck))
    .flatMap((deck) => deckProgress(deck, outcome).topics.map((topic) => ({
      deckId: deck.id, deckTitle: deck.title, topic: topic.name,
      weak: topic.counts.weak, fresh: topic.counts.new, mastery: topic.mastery,
    })))
    .filter((item) => !targets.size || targets.has(item.topic))
    .sort((a, b) => b.weak - a.weak || a.mastery - b.mastery).slice(0, 5);
  return {
    mode: state.focus?.mode === "interview" ? "interview" : "class",
    course: selected,
    courseId: selected ? index.resolve(selected)?.id ?? null : null,
    role: state.focus?.role || "",
    jd: state.focus?.jd || "",
    targetTopics: state.focus?.targetTopics || [],
    roleWeak,
    courses: [...listed, ...implicit].map(name => ({
      id: name ? index.resolve(name)?.id ?? null : null, name, deckIds: (courses.get(name) || []).map((deck) => deck.id), count: (courses.get(name) || []).length,
      sourceCount: sourceCounts.get(name) || 0, ...(activity.has(name) ? { lastUsedAt: activity.get(name) } : {}),
      ...(name ? { deckTotal: totals.get(coursePath(name, known))?.decks || 0, sourceTotal: totals.get(coursePath(name, known))?.sources || 0 } : {}),
      ...(implicit.has(name) ? { implicit: true } : {}),
      ...activityFields(rules, name),
    })),
    fresh: courseFreshCards(state, selected),
  };
}

export function setFocus(state, input) {
  const mode = input.mode || state.focus?.mode || "class";
  if (!["class", "interview"].includes(mode)) throw new Error("请选择课堂跟学或面试准备");
  const course = input.course === undefined ? currentCourse(state) : input.course;
  if (course !== null && (typeof course !== "string" || !courseScopes(state).includes(course)))
    throw new Error("请选择已有课程");
  const role = input.role === undefined ? state.focus?.role || "" : input.role;
  const jd = input.jd === undefined ? state.focus?.jd || "" : input.jd;
  if (typeof role !== "string" || role.length > 200 || typeof jd !== "string" || jd.length > 20000)
    throw new Error("岗位名称或 JD 过长");
  const targetTopics = input.targetTopics === undefined ? state.focus?.targetTopics || [] : input.targetTopics;
  if (!Array.isArray(targetTopics) || targetTopics.length > 30 ||
      targetTopics.some((topic) => typeof topic !== "string" || topic.length > 200))
    throw new Error("岗位知识点范围无效");
  state.focus = { mode, course, role: role.trim(), jd: jd.trim(), targetTopics };
  return focusView(state);
}
