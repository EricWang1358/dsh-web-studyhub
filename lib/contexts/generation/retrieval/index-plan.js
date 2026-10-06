import { modelCached, planIndex, readManifest } from '../../../retrieval-index.js';
import { sourceMatchesCourse, sourcesWithCourses, knownCourseNames } from '../../../source-courses.js';
import { courseScope } from '../../../course-tree.js';

/** The scope every course matches. */
export const ALL_COURSES = '*';

/** What a build of a course would do, read from the library and the manifest as they are now. `ports.state` reads the library. */
export function createIndexPlanner(ports) {
  const courseSources = async course => {
    const state = await ports.state.read(), all = sourcesWithCourses(state);
    const wanted = typeof course === 'string' && course !== '' ? course : ALL_COURSES;
    const within = wanted === ALL_COURSES ? wanted : courseScope(wanted, knownCourseNames(state));
    return { picked: all.filter(source => sourceMatchesCourse(source, within)), library: all.map(source => source.id) };
  };
  return Object.freeze({
    /** { picked, library, manifest, plan, firstRun }: `library` is every page id, so a page leaves the index only when it left the whole library. */
    async prepare(course) {
      const { picked, library } = await courseSources(course), manifest = await readManifest(ports.state.root);
      return { picked, library, manifest, plan: planIndex({ sources: picked, library, manifest }), firstRun: !(await modelCached()) };
    },
  });
}
