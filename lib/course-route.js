import { cardLevel, isDue, latestOutcomes } from "./mastery.js";
import { coursesOf, currentCourse } from "./focus.js";

/* 课程路线：一门课程按学习库里的题组顺序排成一章一章，按部就班往下学。
   这里只做确定性的部分：每章学到哪里、下一批学什么（先巩固前面没掌握的，
   再按顺序学新题），以及给首页、结果页和主对话看的进度摘要。 */

export const COURSE_BATCH = 10;
const REVIEW_CAP = 5;

function chaptersOf(state, course, outcome) {
  return (coursesOf(state.decks).get(course) || []).map((deck) => {
    let total = 0, fresh = 0, weak = 0, mastered = 0;
    for (const card of deck.cards) {
      if (card.suspended) continue;
      total++;
      const level = cardLevel(card, outcome(deck.id, card.id));
      if (level === "new") fresh++;
      else if (level === "weak") weak++;
      else if (level === "mastered" || level === "familiar") mastered++;
    }
    return { deck, deckId: deck.id, title: deck.title, total, learned: total - fresh, weak, mastered };
  }).filter((chapter) => chapter.total);
}

/**
 * The next batch: up to REVIEW_CAP cards already met in this course that are
 * weak or due, then `count` new cards in chapter order from the first unfinished
 * chapter (or from `fromDeckId`), running into the next chapter when one ends.
 */
export function courseBatch(state, { course = currentCourse(state), count = COURSE_BATCH, fromDeckId, now = Date.now(), outcome, language } = {}) {
  if (course == null) return null;
  outcome ||= latestOutcomes(state.attempts);
  const chapters = chaptersOf(state, course, outcome);
  let start = fromDeckId ? chapters.findIndex((c) => c.deckId === fromDeckId) : chapters.findIndex((c) => c.learned < c.total);
  if (fromDeckId && start < 0) throw new Error("这个题组不在当前课程里");
  const fresh = [];
  let last = start;
  for (let i = Math.max(0, start); start >= 0 && i < chapters.length && fresh.length < count; i++) {
    const { deck } = chapters[i];
    deck.cards.forEach((card, index) => {
      if (fresh.length >= count || card.suspended || cardLevel(card, outcome(deck.id, card.id)) !== "new") return;
      fresh.push({ deckId: deck.id, card, position: index + 1 });
      last = i;
    });
  }
  // Consolidate what this course has already covered before moving on.
  const reached = new Set(chapters.slice(0, Math.max(last, start) + 1).map((c) => c.deckId));
  const reviews = chapters.filter((c) => reached.has(c.deckId)).flatMap(({ deck }) => deck.cards
    .filter((card) => !card.suspended)
    .map((card) => ({ deckId: deck.id, card, level: cardLevel(card, outcome(deck.id, card.id)) }))
    .filter((x) => x.level === "weak" || (x.level !== "new" && isDue(x.card, now))))
    .sort((a, b) => Number(b.level === "weak") - Number(a.level === "weak") ||
      (Date.parse(a.card.review?.due_at || 0) || 0) - (Date.parse(b.card.review?.due_at || 0) || 0))
    .slice(0, REVIEW_CAP);
  const first = fresh[0], lastFresh = fresh.at(-1);
  const firstChapter = first && chapters.find((c) => c.deckId === first.deckId);
  const label = language === "en" ? (first
    ? `${firstChapter.title} · Questions ${first.position}–${fresh.filter((x) => x.deckId === first.deckId).at(-1).position}${lastFresh.deckId !== first.deckId ? " · into the next chapter" : ""}`
    : reviews.length ? "Reinforce learned questions" : "") : first
    ? `${firstChapter.title} · 第 ${first.position}–${fresh.filter((x) => x.deckId === first.deckId).at(-1).position} 题${lastFresh.deckId !== first.deckId ? " · 进入下一章" : ""}`
    : reviews.length ? "巩固已学的题" : "";
  return { course, reviews, fresh, label, chapterIndex: firstChapter ? chapters.indexOf(firstChapter) : null };
}

/** Where the learner stands in a course, for the desk, the result page and the chat. */
export function courseRoute(state, { course = currentCourse(state), now = Date.now(), language } = {}) {
  if (course == null) return null;
  const outcome = latestOutcomes(state.attempts);
  const chapters = chaptersOf(state, course, outcome);
  if (!chapters.length) return null;
  const current = chapters.findIndex((c) => c.learned < c.total);
  const sum = (key) => chapters.reduce((n, c) => n + c[key], 0);
  const batch = courseBatch(state, { course, now, outcome, language });
  return {
    course,
    cards: sum("total"), learned: sum("learned"), mastered: sum("mastered"), weak: sum("weak"),
    current: current < 0 ? null : current,
    chapters: chapters.map(({ deck, ...c }, i) => ({ ...c,
      status: c.learned === c.total ? "done" : i === current ? "current" : c.learned ? "started" : "upcoming" })),
    next: batch && (batch.fresh.length || batch.reviews.length)
      ? { label: batch.label, fresh: batch.fresh.length, reviews: batch.reviews.length } : null,
  };
}
