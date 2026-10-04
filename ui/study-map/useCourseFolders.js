import { useMemo } from 'react';
import { isParked } from '../CourseActive.jsx';
import { courseMatcher, courseNamesOf } from '../PageScope.jsx';
import { courseOrder } from '../../lib/course-tree.js';

/**
 * The library catalogue grouped by course. The current course is a scope (a
 * parent includes the courses inside it) and leads, its decks newest first and
 * its chapters in natural order. 未激活 courses (lib/course-active.js) are
 * listed apart, collapsed, and still reachable. `shownFolders` is what the
 * tree draws now; `otherCourseCount` is how many live courses are held back.
 */
export function useCourseFolders(data, { query, showArchived, showOtherCourses, showParked }) {
  const courses = data.focus?.courses;
  const visible = data.decks.filter((deck) => {
    if (!!deck.archived !== showArchived) return false;
    if (!query) return true;
    return `${deck.title} ${deck.folder} ${deck.topics.join(' ')}`.toLowerCase().includes(query);
  });
  const inFocus = useMemo(() => (data.focus?.course == null ? () => false : courseMatcher(data, data.focus.course)),
    [data.focus?.course, courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const folders = useMemo(() => {
    const groups = new Map();
    for (const deck of visible) {
      const course = deck.course ?? deck.folder ?? '';
      if (!groups.has(course)) groups.set(course, []);
      groups.get(course).push(deck);
    }
    const stamp = (deck) => Date.parse(deck.publishedAt || deck.createdAt || 0);
    for (const [course, list] of groups) if (inFocus(course)) list.sort((a, b) => stamp(b) - stamp(a));
    const order = courseOrder(courseNamesOf(data));
    return [...groups].sort(([left], [right]) => (Number(inFocus(right)) - Number(inFocus(left))) || (inFocus(left) && inFocus(right) ? order(left, right) : 0));
  }, [visible, inFocus]); // eslint-disable-line react-hooks/exhaustive-deps
  const parkedByName = useMemo(() => new Map((courses || []).filter(isParked).map((course) => [course.name, course])), [courses]);
  const parkedFolders = folders.filter(([course]) => parkedByName.has(course) && !inFocus(course));
  const liveFolders = folders.filter((entry) => !parkedFolders.includes(entry));
  const shownLive = query || showArchived || showOtherCourses ? liveFolders : liveFolders.filter(([course]) => inFocus(course));
  const shownParked = query || showParked ? parkedFolders : [];
  const shownFolders = [...shownLive, ...shownParked];
  return { visible, inFocus, shownFolders, parkedByName, parkedFolders, otherCourseCount: liveFolders.length - shownLive.length,
    singleCourse: shownFolders.length === 1 && inFocus(shownFolders[0][0]) };
}

export default useCourseFolders;
