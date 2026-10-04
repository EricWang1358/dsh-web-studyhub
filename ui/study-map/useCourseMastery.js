import { useMemo } from 'react';
import { courseMatcher } from '../PageScope.jsx';
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
    const live = data.decks.filter((deck) => !deck.archived);
    const name = data.focus?.mode === 'interview' ? null : data.focus?.course;
    // A parent course measures the courses inside it too.
    const within = name != null ? courseMatcher(data, name) : null;
    const inCourse = within ? live.filter((deck) => !deck.systemKind && within(deck.course ?? deck.folder ?? '')) : [];
    const course = inCourse.length ? measure(inCourse, progress) : null;
    const whole = measure(live, progress);
    const others = course && live.some((deck) => !inCourse.includes(deck) && progress[deck.id]?.total);
    return { course, whole, name, others, primary: course || whole };
  }, [data.decks, data.focus?.course, data.focus?.courses, data.focus?.mode, progress]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default useCourseMastery;
