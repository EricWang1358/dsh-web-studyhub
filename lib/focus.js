import { latestOutcomes, cardLevel, deckProgress } from "./mastery.js";
import { libraryCourses, sourcesWithCourses } from './source-courses.js';
import { courseOf as courseOfRecord, courseIndex } from './courses.js';

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

export function currentCourse(state) {
  const courses = libraryCourses(state);
  const selected = state.focus?.course;
  if (selected != null && courses.includes(selected)) return selected;
  // Older versions persisted the unassigned display label as the focus value.
  if (selected === '未分类课程' && courses.includes('')) return '';
  return courses[0] ?? null;
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
  return freshCardsForDecks(state, coursesOf(state.decks).get(course) || [], count);
}

export function focusView(state) {
  const courses = coursesOf(state.decks);
  const sources = sourcesWithCourses(state), sourceCounts = new Map();
  for (const source of sources) for (const course of source.courses.length ? source.courses : [''])
    sourceCounts.set(course, (sourceCounts.get(course) || 0) + 1);
  const selected = currentCourse(state);
  const outcome = latestOutcomes(state.attempts);
  const targets = new Set(state.focus?.targetTopics || []);
  const roleWeak = state.decks.filter((deck) => !deck.archived && !deck.systemKind)
    .flatMap((deck) => deckProgress(deck, outcome).topics.map((topic) => ({
      deckId: deck.id, deckTitle: deck.title, topic: topic.name,
      weak: topic.counts.weak, fresh: topic.counts.new, mastery: topic.mastery,
    })))
    .filter((item) => !targets.size || targets.has(item.topic))
    .sort((a, b) => b.weak - a.weak || a.mastery - b.mastery).slice(0, 5);
  return {
    mode: state.focus?.mode === "interview" ? "interview" : "class",
    course: selected,
    courseId: selected ? courseIndex(state).resolve(selected)?.id ?? null : null,
    role: state.focus?.role || "",
    jd: state.focus?.jd || "",
    targetTopics: state.focus?.targetTopics || [],
    roleWeak,
    courses: libraryCourses(state, sources).map(name => ({
      name, deckIds: (courses.get(name) || []).map((deck) => deck.id), count: (courses.get(name) || []).length,
      sourceCount: sourceCounts.get(name) || 0,
    })),
    fresh: courseFreshCards(state, selected),
  };
}

export function setFocus(state, input) {
  const mode = input.mode || state.focus?.mode || "class";
  if (!["class", "interview"].includes(mode)) throw new Error("请选择课堂跟学或面试准备");
  const course = input.course === undefined ? currentCourse(state) : input.course;
  if (course !== null && (typeof course !== "string" || !libraryCourses(state).includes(course)))
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
