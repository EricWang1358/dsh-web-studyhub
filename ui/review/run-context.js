/* Where the question being practised sits: its course, its chapter (the deck, as the course route calls a chapter: lib/course-route.js) and the
   whole course. No new measure: the numbers are the snapshot's per-deck progress (data.progress, lib/mastery.js) and the roll-up the home's
   course mastery uses (ui/study-map/map-model.js mergeProgress, weighted by question count), worded by the 资料 page's own mastery line. */
import { decksInCourse } from '../PageScope.jsx';
import { mergeProgress } from '../study-map/map-model.js';

/** A deck's or roll-up's progress node as the summary masteryText (ui/document-preview/practice/mastery-copy.js) words: 掌握 N% · N 题 / 未学 · N 题. */
const summaryOf = (node) => ({ total: node.total, percent: node.mastery, state: node.status === 'todo' ? 'unlearned' : 'learning' });

/**
 * { course, chapter, whole } for the deck of the question being practised, or null when there is nothing to say (no such deck, a system deck such as
 * 为你定制 that belongs to no course, or a deck without questions). `course` is the course name ('' = uncategorised); `chapter` and `whole` are
 * summaries; `whole` is null when the course holds no other deck with questions (it would repeat the chapter's number).
 */
export function runContextOf(data, deckId) {
  const deck = data?.decks?.find((item) => item.id === deckId);
  const progress = data?.progress;
  if (!deck || deck.systemKind || !progress?.[deck.id]?.total) return null;
  const course = deck.course ?? deck.folder ?? '';
  const inCourse = decksInCourse(data, course).filter((item) => progress[item.id]?.total);
  const others = inCourse.some((item) => item.id !== deck.id);
  return { course, chapter: summaryOf(progress[deck.id]), whole: others ? summaryOf(mergeProgress(inCourse.map((item) => progress[item.id]))) : null };
}
