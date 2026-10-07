/* 考点清单 (exam point list; code name: exam blueprint) seen from the lists of the library. Browser-safe and import-free, because lib/source-groups.js (shared with the UI) uses it.

   A 考点清单 is a source record (so it stays readable, citable and backed up like one), but it is NOT course material: every place that lists, picks, counts or searches the
   library's materials leaves it out, and the 备考补习 page reads its own lists from `snapshot.examPointLists` (summaries) and `source.get` (the whole record). Releases that
   do not know this rule show it as an ordinary Markdown material; that is the accepted fallback. */

export const EXAM_POINT_LIST_PROVENANCE = 'exam-blueprint';

/** Is this record a 考点清单? (The provenance mark and the structured list; a record with only one of them is an ordinary source.) */
export const isExamPointListSource = source => source?.provenance === EXAM_POINT_LIST_PROVENANCE && !!source.blueprint && typeof source.blueprint === 'object';
/** The filter every list of materials applies. */
export const notExamPointList = source => !isExamPointListSource(source);

/** What the snapshot carries of a list (the whole record is read on demand: it can be large). */
export const examPointListSummary = source => ({ id: source.id, title: source.title, courses: Array.isArray(source.courses) ? [...source.courses] : [], createdAt: source.createdAt ?? null,
  archived: source.archived === true, scope: source.blueprint.scope?.label ?? null, basis: source.blueprint.basis ?? null, supersedes: source.blueprint.supersedes ?? null, points: Array.isArray(source.blueprint.points) ? source.blueprint.points.length : 0,
  chars: typeof source.text === 'string' ? source.text.length : 0 });

/** A request that names a list as material (to make questions from, to ask about, as guidance) is refused in the learner's words. */
export function assertMaterials(sources) {
  if (!(sources || []).some(isExamPointListSource)) return;
  throw Object.assign(new Error('考点清单不是资料，不能用来出题或当作指引 / An exam point list is not course material, so it cannot be used to make questions or as guidance'), { code: 'exam-point-list-not-material' });
}
