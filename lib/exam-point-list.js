/* 考点清单 (exam point list; code name: exam blueprint) seen from the lists of the library. Browser-safe and import-free, because lib/source-groups.js (shared with the UI) uses it.

   A 考点清单 is a source record (so it stays readable, citable and backed up like one), but it is NOT course material: every place that lists, picks, counts or searches the
   library's materials leaves it out, and the 备考补习 page reads its own lists from `snapshot.examPointLists` (summaries) and `source.get` (the whole record). Releases that
   do not know this rule show it as an ordinary Markdown material; that is the accepted fallback. */

export const EXAM_POINT_LIST_PROVENANCE = 'exam-blueprint';
/** A 课程总纲 (course outline, lib/course-outline-book.js) is the other list of the library: a reference for coverage, order and focus, never a material. */
export const COURSE_OUTLINE_PROVENANCE = 'course-outline';

/** Is this record a 考点清单? (The provenance mark and the structured list; a record with only one of them is an ordinary source.) */
export const isExamPointListSource = source => source?.provenance === EXAM_POINT_LIST_PROVENANCE && !!source.blueprint && typeof source.blueprint === 'object';
/** Is this record a 课程总纲? (The provenance mark and the structured outline, as for a 考点清单.) */
export const isCourseOutlineSource = source => source?.provenance === COURSE_OUTLINE_PROVENANCE && !!source.courseOutline && typeof source.courseOutline === 'object';
/** Is this record one of the library's own lists (a 考点清单 or a 课程总纲), which are not course material? Every list of materials leaves these out. */
export const isLibraryListSource = source => isExamPointListSource(source) || isCourseOutlineSource(source);
/** The filter every list of materials applies: neither a 考点清单 nor a 课程总纲. */
export const notExamPointList = source => !isLibraryListSource(source);

/**
 * Does a list stand on texts that are no longer what it was built from? Each input saved with a fingerprint (inputFingerprint of its sources' texts, in order) is compared with
 * the current texts; a source it names that is gone counts too. A list saved before fingerprints existed has none to compare, so it is never stale.
 * `textOf(sourceId)` returns the source's current text, or undefined when it is gone.
 */
export function examPointListStale(source, textOf) {
  if (typeof textOf !== 'function') return false;
  return (Array.isArray(source?.blueprint?.inputs) ? source.blueprint.inputs : []).some(input => {
    if (typeof input?.fingerprint !== 'string' || !input.fingerprint) return false;
    const texts = (Array.isArray(input.sourceIds) ? input.sourceIds : []).map(textOf);
    return texts.some(text => typeof text !== 'string') || inputFingerprint(texts) !== input.fingerprint;
  });
}

/** The ids of `ids` that this list stands on: an input's source or a place of an exam point. */
export function examPointListCites(source, ids) {
  const blueprint = source?.blueprint;
  return (Array.isArray(blueprint?.inputs) ? blueprint.inputs : []).some(input => (input?.sourceIds || []).some(id => ids.has(id))) ||
    (Array.isArray(blueprint?.points) ? blueprint.points : []).some(point => (point?.evidence || []).some(place => ids.has(place?.sourceId)));
}

/** What the snapshot carries of a list (the whole record is read on demand: it can be large). `textOf` is the library's source text lookup (see examPointListStale); without it `stale` is false. */
export const examPointListSummary = (source, textOf) => ({ id: source.id, title: source.title, courses: Array.isArray(source.courses) ? [...source.courses] : [], createdAt: source.createdAt ?? null,
  archived: source.archived === true, scope: source.blueprint.scope?.label ?? null, basis: source.blueprint.basis ?? null, supersedes: source.blueprint.supersedes ?? null, points: Array.isArray(source.blueprint.points) ? source.blueprint.points.length : 0,
  chars: typeof source.text === 'string' ? source.text.length : 0, stale: examPointListStale(source, textOf) });

/** The words a point's tier is shown with. `must` means "a sample paper tested it" (what is known), never a certainty of the exam. */
export const TIER_LABEL = Object.freeze({ must: '样卷考过', extra: '补充' });

/**
 * A short fingerprint of the texts a list was built from (FNV-1a, 32-bit, hex). Browser-safe, so the page and the library compute the same value.
 * `texts` are the source texts of one input, in the order of its sourceIds. A change of any text changes the value; the same texts give the same value.
 */
export function inputFingerprint(texts) {
  let hash = 0x811c9dc5;
  for (const char of (Array.isArray(texts) ? texts : []).map(text => String(text ?? '')).join('\u0000')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** A request that names a list as material (to make questions from, to ask about, as guidance) is refused in the learner's words. */
export function assertMaterials(sources) {
  const list = sources || [];
  if (list.some(isExamPointListSource)) throw Object.assign(new Error('考点清单不是资料，不能用来出题或当作指引 / An exam point list is not course material, so it cannot be used to make questions or as guidance'), { code: 'exam-point-list-not-material' });
  // The outline is a reference made by the model: never the source of a question, or the evidence of one.
  if (list.some(isCourseOutlineSource)) throw Object.assign(new Error('课程总纲只是参考，不是资料，不能用来出题或当作指引 / A course outline is a reference, not course material, so it cannot be used to make questions or as guidance'), { code: 'course-outline-not-material' });
}
