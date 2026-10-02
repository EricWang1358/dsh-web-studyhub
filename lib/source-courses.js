import { courseScope, courseTree } from './course-tree.js';

// Course ownership is independent of evidence: regrouping never edits source text or citations.
export function checkedCourses(value) {
  if (!Array.isArray(value) || value.length > 30 || value.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 200))
    throw new Error('课程需为不超过 30 个名称的列表，每个名称为 1–200 字');
  return [...new Set(value.map(name => name.trim()))];
}

/* The relations of the library's shared (frozen) collections are built once and kept while those exact arrays are the
   committed ones: a snapshot asked for them eight times, each a pass over every card citation. Callers only read them. */
const relationMemo = new WeakMap();
export function sourceRelations(state) {
  const { sources, decks, drafts } = state;
  const shared = Array.isArray(sources) && Object.isFrozen(sources) && Object.isFrozen(decks) && Object.isFrozen(drafts);
  if (shared) {
    const hit = relationMemo.get(sources);
    if (hit && hit.decks === decks && hit.drafts === drafts) return hit.relations;
  }
  const relations = new Map((sources || []).map(source => [source.id, []]));
  for (const [kind, list] of [['deck', decks], ['draft', drafts]]) {
    for (const deck of list || []) {
      if (deck.systemKind) continue;
      const ids = new Set((deck.cards || []).flatMap(card => (card.citations || []).map(ref => ref.sourceId)));
      for (const id of ids) relations.get(id)?.push({ id: deck.id, title: deck.title, course: deck.course ?? deck.folder ?? '', kind, archived: !!deck.archived });
    }
  }
  if (shared) relationMemo.set(sources, { decks, drafts, relations });
  return relations;
}

export function sourcesWithCourses(state) {
  const relations = sourceRelations(state);
  return (state.sources || []).map(source => {
    const usedBy = relations.get(source.id) || [];
    const explicit = Array.isArray(source.courses);
    const courses = explicit ? source.courses : [...new Set([source.course, source.audio?.course, ...usedBy.map(deck => deck.course)].filter(Boolean))];
    return { ...source, courses, coursesInferred: !explicit && courses.length > 0, usedBy };
  });
}

export function libraryCourses(state, sources = sourcesWithCourses(state)) {
  return [...new Set([
    ...(state.decks || []).filter(deck => !deck.archived && !deck.systemKind).map(deck => deck.course ?? deck.folder ?? ''),
    ...(state.drafts || []).filter(deck => !deck.archived && !deck.systemKind).map(deck => deck.course ?? deck.folder ?? ''),
    ...sources.flatMap(source => source.courses.length ? source.courses : ['']),
    // A course record that holds its own knowledge (exam, guidance, focus) is a course even before it has decks.
    ...(Array.isArray(state.courses) ? state.courses : []).filter(course => course && typeof course.name === 'string' && course.name.trim() &&
      (course.exam || course.guidanceSourceIds?.length || course.focusTopics?.length)).map(course => course.name),
  ])];
}

/** Every course name the library states anywhere (decks, drafts, sources, course records): the names a no-space slash may follow. */
export function knownCourseNames(state) {
  const names = new Set();
  const add = name => { if (typeof name === 'string' && name.trim()) names.add(name); };
  for (const deck of [...(state?.decks || []), ...(state?.drafts || [])]) add(deck?.course ?? deck?.folder);
  for (const source of state?.sources || []) {
    for (const name of Array.isArray(source?.courses) ? source.courses : []) add(name);
    add(source?.course); add(source?.audio?.course);
  }
  for (const course of Array.isArray(state?.courses) ? state.courses : []) add(course?.name);
  return [...names];
}

/**
 * The courses a scope can be set to: the library's courses plus the parents nobody filed anything under
 * ("Lone" for "Lone / ch 1" and "Lone / ch 2"), so choosing a parent works before it holds an item of its own.
 */
export function courseScopes(state, courses = libraryCourses(state)) {
  const known = knownCourseNames(state);
  const have = new Set(courses);
  const implicit = courseTree(courses.filter(Boolean), known).filter(row => row.implicit && !have.has(row.name)).map(row => row.name);
  return implicit.length ? [...courses, ...implicit] : courses;
}

export function importCourses(args, fallback) {
  if (args.courses !== undefined) return checkedCourses(args.courses);
  if (args.course !== undefined) return args.course === '' || args.course === null ? [] : checkedCourses([args.course]);
  return fallback ? [fallback] : [];
}

/**
 * Is the source in `course`'s scope? A parent scope includes the sources of every course inside it (lib/course-tree.js).
 * `known`: the library's course names (knownCourseNames), or an already prepared `courseScope` matcher as `course`.
 */
export function sourceMatchesCourse(source, course, known = []) {
  const courses = source.courses || [];
  if (course === undefined || course === null || course === '*') return true;
  if (course === '') return !courses.length;
  const within = typeof course === 'function' ? course : courseScope(course, known);
  return courses.some(within);
}

/**
 * The course a new item made from these sources gets: the preferred (current scope) one when they all share it,
 * else their single common course, else the preferred scope when it is a parent that holds all of them, else none.
 * Writing: the result is a stored name, never a rewrite of a child to its parent.
 */
export function courseForSources(state, sourceIds, preferred, known = knownCourseNames(state)) {
  const sources = sourcesWithCourses(state).filter(source => sourceIds.includes(source.id));
  if (!sources.length) return preferred || '';
  const assigned = sources.filter(source => source.courses.length);
  if (!assigned.length) return preferred || '';
  const common = assigned[0].courses.filter(course => assigned.every(source => source.courses.includes(course)));
  if (common.includes(preferred)) return preferred;
  if (common.length === 1) return common[0];
  const within = preferred ? courseScope(preferred, known) : null;
  return within && assigned.every(source => source.courses.some(within)) ? preferred : '';
}

/** Resolve one destination at launch. An empty explicit course is a real choice. */
export function resolveCourse(state, args = {}, { course, sourceIds = args.sourceIds || [], preferred = '' } = {}) {
  if (args.course !== undefined || args.courses !== undefined) {
    const selected = importCourses(args);
    if (selected.length > 1) throw new Error('题组或课堂请选择一门课程');
    return selected[0] || '';
  }
  if (course !== undefined) return importCourses({ course })[0] || '';
  return courseForSources(state, sourceIds, preferred);
}

/** Reusing evidence adds an association, never changes its content or other associations. */
export function addSourceCourses(state, sourceIds, courses) {
  const additions = checkedCourses(courses), wanted = new Set(sourceIds);
  const current = new Map(sourcesWithCourses(state).filter(source => wanted.has(source.id)).map(source => [source.id, source.courses]));
  for (const source of state.sources) if (wanted.has(source.id))
    source.courses = [...new Set([...(current.get(source.id) || []), ...additions])];
}

/** One book is one assignment per page: a converted 600-page book must change course in one call, so the ceiling is a sanity limit, not a size of book. */
const MAX_ASSIGNMENTS = 5000;

export function assignSourceCourses(state, assignments) {
  if (!Array.isArray(assignments) || !assignments.length || assignments.length > MAX_ASSIGNMENTS) throw new Error('请选择 1–5000 份资料');
  const current = new Map(sourcesWithCourses(state).map(source => [source.id, source]));
  const seen = new Set();
  const changes = assignments.map(item => {
    const source = current.get(item?.id);
    if (!source || seen.has(item.id)) throw new Error('资料不存在或重复，请刷新后重试');
    seen.add(item.id);
    if (item.expectedCourses !== undefined && JSON.stringify([...checkedCourses(item.expectedCourses)].sort()) !== JSON.stringify([...source.courses].sort()))
      throw new Error('资料归属已变化，请重新查看整理建议');
    return { id: source.id, courses: checkedCourses(item.courses), previousCourses: source.courses };
  });
  for (const change of changes) state.sources.find(source => source.id === change.id).courses = change.courses;
  return { updated: changes.length, assignments: changes };
}

export function checkedCourseSuggestions(raw, sources) {
  if (!Array.isArray(raw?.proposals)) throw new Error('AI 没有返回可用的资料整理建议');
  const byId = new Map(sources.map(source => [source.id, source]));
  const seen = new Set();
  return raw.proposals.map(item => {
    const source = byId.get(item?.id);
    if (!source || seen.has(item.id)) throw new Error('AI 建议包含未知或重复资料，请重试');
    seen.add(item.id);
    return { id: source.id, title: source.title, courses: checkedCourses(item.courses), expectedCourses: source.courses,
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : '' };
  });
}
