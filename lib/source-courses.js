// Course ownership is independent of evidence: regrouping never edits source text or citations.
export function checkedCourses(value) {
  if (!Array.isArray(value) || value.length > 30 || value.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 200))
    throw new Error('课程需为不超过 30 个名称的列表，每个名称为 1–200 字');
  return [...new Set(value.map(name => name.trim()))];
}

export function sourceRelations(state) {
  const relations = new Map((state.sources || []).map(source => [source.id, []]));
  for (const [kind, decks] of [['deck', state.decks], ['draft', state.drafts]]) {
    for (const deck of decks || []) {
      if (deck.systemKind) continue;
      const ids = new Set((deck.cards || []).flatMap(card => (card.citations || []).map(ref => ref.sourceId)));
      for (const id of ids) relations.get(id)?.push({ id: deck.id, title: deck.title, course: deck.course ?? deck.folder ?? '', kind, archived: !!deck.archived });
    }
  }
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
  ])];
}

export function importCourses(args, fallback) {
  if (args.courses !== undefined) return checkedCourses(args.courses);
  if (args.course !== undefined) return args.course === '' || args.course === null ? [] : checkedCourses([args.course]);
  return fallback ? [fallback] : [];
}

export function sourceMatchesCourse(source, course) {
  const courses = source.courses || [];
  return course === undefined || course === null || course === '*' || (course === '' ? !courses.length : courses.includes(course));
}

export function courseForSources(state, sourceIds, preferred) {
  const sources = sourcesWithCourses(state).filter(source => sourceIds.includes(source.id));
  if (!sources.length) return preferred || '';
  const assigned = sources.filter(source => source.courses.length);
  if (!assigned.length) return preferred || '';
  const common = assigned[0].courses.filter(course => assigned.every(source => source.courses.includes(course)));
  return common.includes(preferred) ? preferred : common.length === 1 ? common[0] : '';
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

export function assignSourceCourses(state, assignments) {
  if (!Array.isArray(assignments) || !assignments.length || assignments.length > 200) throw new Error('请选择 1–200 份资料');
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
