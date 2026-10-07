import { modelCached, planIndex, readManifest } from '../../../retrieval-index.js';
import { sourceMatchesCourse, sourcesWithCourses, knownCourseNames } from '../../../source-courses.js';
import { courseScope } from '../../../course-tree.js';
import { groupSourcesByDocument } from '../../../source-groups.js';
import { notExamPointList } from '../../../exam-point-list.js';

/** The scope every course matches. */
export const ALL_COURSES = '*';

/** How many materials are named in a plan: the page says "and N more" for the rest. */
const NAMED_MATERIALS = 5;

/**
 * What a course holds and where its missing pages are: { documents (materials in the course), missing: [{ title, pages }] (the materials with pages to
 * index, the biggest first, the first few only), missingDocuments (how many there are in all) }. `picked` is the course's pages, `add` the ones a
 * build would index. The numbers of the plan itself (pages, toIndex) count pages; this says whose they are.
 */
export function describeScope({ picked, add }) {
  const byBiggest = (a, b) => b.pages - a.pages;
  const missing = groupSourcesByDocument(add).map(item => ({ title: item.title, pages: item.sourceIds.length })).sort(byBiggest);
  return { documents: groupSourcesByDocument(picked).length, missing: missing.slice(0, NAMED_MATERIALS), missingDocuments: missing.length };
}

/** What a build of a course would do, read from the library and the manifest as they are now. `ports.state` reads the library. */
export function createIndexPlanner(ports) {
  const courseSources = async course => {
    const state = await ports.state.read(), all = sourcesWithCourses(state).filter(notExamPointList);
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
