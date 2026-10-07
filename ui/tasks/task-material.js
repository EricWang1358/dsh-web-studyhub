import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { displayTitle } from '../../lib/document-title.js';
import { contractOf } from './task-model.js';

/* Which ONE material a task concerns, for 打开资料 in the header of the 任务 console. "One material" is one row of the 资料 list (lib/source-groups.js): a PDF's pages,
   a recording's parts and a merged recording batch are one. Pure; no I/O, no ui(). What it reads is what the job already records: `job.sourceIds` (a question run, a top-up,
   a supplement, a conversion, a translation, an audio / transcript / subtitle import: every source it read or made, extra sources included) and the source refs of its contract
   (`result.refs`, the only thing an archived record keeps). The grouped library is read as it is now: a source that is gone, or a material that was archived since, is not offered.
   Null when the task has no sources, concerns several materials, or is a day of 为你定制. Else { key, title, sourceIds, openId }: `openId` is the source the 资料 row opens (the first page). */
export function taskMaterial(task, sources) {
  const contract = contractOf(task);
  if (contract.kind === 'coach-daily' || !Array.isArray(sources) || !sources.length) return null;
  const recorded = [...(Array.isArray(task?.sourceIds) ? task.sourceIds : []), ...(contract.result?.refs || []).filter((ref) => ref.kind === 'source').map((ref) => ref.id)]
    .filter((id) => typeof id === 'string' && id);
  const ids = [...new Set(recorded)];
  if (!ids.length) return null;
  const groups = groupSourcesByDocument(sources), owner = new Map(groups.flatMap((group) => group.sourceIds.map((id) => [id, group])));
  // One material only when every recorded source is still there and they all sit in the same row; one that is gone means the run read more than what is left.
  const found = ids.map((id) => owner.get(id));
  const first = found[0];
  if (!first || found.some((group) => group !== first) || first.archived) return null;
  return { key: first.key, title: displayTitle(first.title), sourceIds: first.sourceIds, openId: first.sourceIds[0] };
}
