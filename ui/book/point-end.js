/* 复习全书, what a point's ONE end button says (ui/book/PointEnd.jsx; docs/review-book.md "The end of a point"). Pure, for the tests: ids only, the words
   are the component's. A point with questions not read yet offers 练 5 道 first; a 翻看 day 已看; today's last point 今天的读完了; a read point 下一个 (练 5 道
   quiet beside it when it has questions). Until the
   期末一周 plan has answered (`ready`), the default (读完了，下一个) shows disabled, so the block keeps its height and nothing changes under the pointer later. */
import { createContext } from 'react';

/** The page's end of a point: (node) => the element under it (ui/book/PointEnd.jsx), or null; without it (翻看) a point has no end button. */
export const PointEndContext = createContext(null);

/** ready: book.crunch answered; flip: a 翻看 day; done: 读完 (marked, or enough questions answered on a day of the 期末一周); seen: 已看; questions: the point has
    some; lastToday: the last of today's points; hasNext: a point comes after it (ui/book/route.js).
    -> { primary: 'read' | 'seen' | 'practice' | 'today' | 'next', quiet: 'read' | 'today' | 'mock' | 'practice' | null, waiting, hasNext } */
export function endState({ ready = false, flip = false, done = false, seen = false, questions = false, lastToday = false, hasNext = true }) {
  const state = (primary, quiet = null) => ({ primary, quiet, waiting: false, hasNext });
  if (!ready) return { primary: 'read', quiet: null, waiting: true, hasNext };
  if (flip) return state(seen ? 'next' : 'seen');
  if (questions && !done) return state('practice', lastToday ? 'today' : 'read');
  if (lastToday) return state('today', 'mock');
  // A point read keeps 练 5 道 within reach (quiet) when it has questions.
  return done ? state('next', questions ? 'practice' : null) : state('read');
}
