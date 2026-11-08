import { courseIdFor, courseKey, courseList, courseView, courseProfile, findCourse, saveCourse, setCourseActive } from '../../courses.js';
import { checkedMethod, courseMethod } from '../../course-method.js';
import { methodProgress } from '../../course-method-progress.js';
import { stageGate } from '../../course-method-gate.js';
import { currentCourse } from '../../focus.js';
import { libraryCourses } from '../../source-courses.js';
import { courseSkeleton, scopeTitles } from '../../custom-skeleton.js';

/* The course context owns course records (id, aliases, exam profile, examiner
   guidance, focus topics, method). It reads materials, bank and system only, so any
   higher context (generation, case practice, audio) may depend on it. Renames
   and merges rewrite records owned by other contexts and therefore run in the
   library coordinator (lib/contexts/library), in one store transaction.
   Whether a course counts (active / parked) is a setting on its record, written here. */
const refOf = (args = {}) => {
  if (args.id !== undefined || args.courseId !== undefined) return { id: args.id ?? args.courseId };
  if (args.name !== undefined) return { name: args.name };
  throw new Error('请指定课程');
};

function resolveMethodCourse(state, args = {}) {
  if (args.id !== undefined || args.courseId !== undefined) return findCourse(state, { id: args.id ?? args.courseId });
  const asked = args.name ?? args.course;
  const target = asked !== undefined ? asked : currentCourse(state);
  if (target === undefined || target === null || !courseKey(String(target))) {
    throw new Error(asked !== undefined ? '请指定课程' : '请先选择一门课程');
  }
  const name = String(target).trim();
  try {
    return findCourse(state, { name });
  } catch (error) {
    // A self-study focus goal before any material or deck is imported is already a real course in focus.
    if (courseKey(state?.focus?.course) === courseKey(name)) return { id: courseIdFor(name), name };
    throw error;
  }
}

function methodView(state, record) {
  const progress = methodProgress(state, record.name);
  return {
    course: record.name,
    courseId: record.id,
    own: !!record.method,
    method: courseMethod(record),
    progress,
    gate: stageGate(state, record.name, progress),
  };
}

/* A 定制方案 that names chapters keeps the title of each (lib/custom-plan.js scope.titles): a chapter id that names another chapter later is then reported, not
   used (lib/custom-skeleton.js chosenChapters). A save of the whole record (the 你的定制 card's switches) never re-points a chapter the plan had: it keeps the
   title it had, or none (lib/custom-skeleton.js scopeTitles). */
function withScopeTitles(state, args) {
  const courses = state.courses || [], id = args?.id ?? args?.courseId;
  const record = (id !== undefined ? courses.find(course => course?.id === id) : null) ?? courses.find(course => course?.name === args?.name);
  const scope = args?.custom?.scope, name = args?.name ?? record?.name;
  if (scope?.kind !== 'chapters' || !Array.isArray(scope.chapters) || typeof name !== 'string' || !Array.isArray(state.sources)) return args;
  return { ...args, custom: { ...args.custom, scope: { ...scope, titles: scopeTitles(courseSkeleton(state, name), scope, record?.custom?.scope) } } };
}

export function createOperations(ports) {
  const { state: storagePort, readAttempts = async () => [] } = ports;
  const readShared = () => (storagePort.view ? storagePort.view() : storagePort.read());
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
    'course.method.get': async (args = {}) => {
      const [state, attempts] = await Promise.all([readShared(), readAttempts()]);
      const full = Array.isArray(state.attempts) ? state : { ...state, attempts };
      return methodView(full, resolveMethodCourse(full, args));
    },
    'course.method.save': async (args = {}) => {
      if (args?.method === undefined) throw new Error('请提供要保存的学法（method），或传 null 恢复默认学法');
      checkedMethod(args.method);
      const saved = await storagePort.update(state => {
        if (args.id !== undefined || args.courseId !== undefined) {
          const found = findCourse(state, { id: args.id ?? args.courseId });
          return saveCourse(state, { id: found.id, name: args.name ?? args.course ?? found.name, method: args.method });
        }
        const asked = args.name ?? args.course;
        if (asked !== undefined) return saveCourse(state, { name: asked, method: args.method });
        const current = currentCourse(state);
        if (!current) throw new Error('请先选择一门课程');
        return saveCourse(state, { name: current, method: args.method });
      });
      const [state, attempts] = await Promise.all([readShared(), readAttempts()]);
      const full = Array.isArray(state.attempts) ? state : { ...state, attempts };
      return methodView(full, findCourse(full, { id: saved.id }));
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
