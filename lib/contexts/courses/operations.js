import { courseList, courseView, courseProfile, findCourse, saveCourse, setCourseActive } from '../../courses.js';
import { currentCourse } from '../../focus.js';
import { libraryCourses } from '../../source-courses.js';
import { courseSkeleton, scopeTitles } from '../../custom-skeleton.js';

/* The course context owns course records (id, aliases, exam profile, examiner
   guidance, focus topics). It reads materials, bank and system only, so any
   higher context (generation, case practice, audio) may depend on it. Renames
   and merges rewrite records owned by other contexts and therefore run in the
   library coordinator (lib/contexts/library), in one store transaction.
   Whether a course counts (active / parked) is a setting on its record, written here. */
const refOf = (args = {}) => {
  if (args.id !== undefined || args.courseId !== undefined) return { id: args.id ?? args.courseId };
  if (args.name !== undefined) return { name: args.name };
  throw new Error('请指定课程');
};

/* A 定制方案 that names chapters keeps the title of each (lib/custom-plan.js scope.titles), read from the course's skeleton as it is now: a chapter id that names
   another chapter later is then reported, not used (lib/custom-skeleton.js chosenChapters). */
function withScopeTitles(state, args) {
  const scope = args?.custom?.scope, name = args?.name ?? (state.courses || []).find(course => course?.id === (args?.id ?? args?.courseId))?.name;
  if (scope?.kind !== 'chapters' || !Array.isArray(scope.chapters) || typeof name !== 'string' || !Array.isArray(state.sources)) return args;
  return { ...args, custom: { ...args.custom, scope: { ...scope, titles: scopeTitles(courseSkeleton(state, name), scope.chapters) } } };
}

export function createOperations(ports) {
  const { state: storagePort } = ports;
  const handlers = {
    'course.list': async () => {
      const state = await storagePort.read();
      return { courses: courseList(state, libraryCourses(state)) };
    },
    'course.get': async args => {
      const state = await storagePort.read();
      return courseView(state, findCourse(state, refOf(args)));
    },
    'course.profile': async (args = {}) => {
      const state = await storagePort.read();
      if (args.courseId !== undefined || args.id !== undefined || args.name !== undefined) return courseProfile(findCourse(state, refOf(args)));
      const current = currentCourse(state);
      if (!current) throw new Error('请先选择一门课程');
      return courseProfile(findCourse(state, { name: current }));
    },
  };
  const mutations = {
    'course.save': (state, args) => courseView(state, saveCourse(state, withScopeTitles(state, args))),
    // 有效课程: park a course the learner no longer studies, or bring it back (lib/course-active.js).
    'course.setActive': (state, args) => setCourseActive(state, args),
    'course.activate': (state, args) => setCourseActive(state, { ...args, active: true }),
    'course.deactivate': (state, args) => setCourseActive(state, { ...args, active: false }),
  };
  return { handlers, mutations };
}
