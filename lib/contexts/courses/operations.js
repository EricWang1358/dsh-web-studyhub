import { courseList, courseView, courseProfile, findCourse, saveCourse } from '../../courses.js';
import { currentCourse } from '../../focus.js';
import { libraryCourses } from '../../source-courses.js';

/* The course context owns course records (id, aliases, exam profile, examiner
   guidance, focus topics). It reads materials, bank and system only, so any
   higher context (generation, case practice, audio) may depend on it. Renames
   and merges rewrite records owned by other contexts and therefore run in the
   library coordinator (lib/contexts/library), in one store transaction. */
const refOf = (args = {}) => {
  if (args.id !== undefined || args.courseId !== undefined) return { id: args.id ?? args.courseId };
  if (args.name !== undefined) return { name: args.name };
  throw new Error('请指定课程');
};

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
    'course.save': (state, args) => courseView(state, saveCourse(state, args)),
  };
  return { handlers, mutations };
}
