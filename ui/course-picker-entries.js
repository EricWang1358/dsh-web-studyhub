/* The course list as Combobox entries (components/option-list.js): the one place that turns the library's course ranking and
   "Course / Chapter" grouping (course-names.js) into rows, so the home heading, the guided flow's 换课程 and any later picker show the same
   tree in the same order. A course with chapters is an option of its own followed by its chapters at level 2 and up (drawn on the
   hairline); parked (inactive) courses stay reachable in a group of their own, last. */
import { ui, uiFormat } from './i18n.js';
import { groupCourseNames, isParkedCourse, rankCourses } from './course-names.js';

const label = (name) => name || ui('未分类课程');

function treeOptions(courses, current) {
  const options = [];
  for (const entry of groupCourseNames(rankCourses({ courses, current }))) {
    if (entry.type === 'course') { options.push({ value: entry.course.name, label: label(entry.course.name) }); continue; }
    options.push({ value: entry.parent.name, label: entry.parent.name, hint: uiFormat('{0} 章', [entry.chapters.length]), level: 1 });
    for (const { course, chapter, depth } of entry.chapters) options.push({ value: course.name, label: chapter, triggerLabel: course.name, level: Math.min(depth + 1, 3) });
  }
  return options;
}

/** `courses`: the snapshot's course records (name, active, counts). `current`: the focused course's name; it leads the list. */
export function courseEntries({ courses = [], current } = {}) {
  const live = courses.filter((course) => !isParkedCourse(course));
  const parked = courses.filter(isParkedCourse);
  const entries = treeOptions(live, current);
  if (parked.length) entries.push({ group: uiFormat('未激活的课程 ({0})', [parked.length]), options: treeOptions(parked, current) });
  return entries;
}
