import { useMemo } from 'react';
import { decksInCourse } from '../PageScope.jsx';
import { mergeProgress } from './map-model.js';

/* Mastery weighted by card count. Deck rows carry no mastery of their own in
   the snapshot; the per-deck figures live on `progress`. The current course
   leads; the whole library follows as context when it holds other courses. */
const measure = (decks, progress) => {
  const rows = decks.map((deck) => progress[deck.id]).filter((p) => p && p.total);
  const total = rows.reduce((n, p) => n + p.total, 0);
  return total ? { value: Math.round(rows.reduce((n, p) => n + (p.mastery || 0) * p.total, 0) / total), cards: total, node: mergeProgress(rows) } : null;
};

/** { course, whole, name, others, primary }: the current course's mastery, the library's, and which to headline. */
export function useCourseMastery(data, progress) {
  return useMemo(() => {
    const live = data.decks.filter((deck) => !deck.archived && !deck.inactive);
    const name = data.focus?.course;
    // A parent course measures active sub-courses inside it; a parked course picked as current is still measured.
    const inCourse = name != null ? decksInCourse(data, name) : [];
    const course = inCourse.length ? measure(inCourse, progress) : null;
    const whole = measure(live, progress);
    const others = course && live.some((deck) => !inCourse.includes(deck) && progress[deck.id]?.total);
    return { course, whole, name, others, primary: course || whole };
  }, [data, progress]);
}

export default useCourseMastery;
