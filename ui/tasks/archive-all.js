import { uiFormat } from '../i18n.js';
import { offerRestore } from '../undoable.js';
import { batchRun } from './task-batch.js';

/* 全部归档 on the home: job.archive { all: true } puts EVERY finished job of the library away (not only the cards on screen). The notice counts and 撤销 brings back
   exactly what the host says it archived (`archived` and `alreadyArchived` of its reply), never a guess from the cards. `archive()` is the app's dismissJobs(quick)
   with no id: it resolves the quick action's { ok, result }. */
export const archivedIdsOf = (reply) => [...new Set([...(Array.isArray(reply?.archived) ? reply.archived : []), ...(Array.isArray(reply?.alreadyArchived) ? reply.alreadyArchived : [])])];

export async function archiveAllWithUndo({ archive, quick, core, toast }) {
  const done = await archive();
  if (done?.ok === false) return { ok: false };
  const ids = archivedIdsOf(done?.result);
  if (!ids.length) return { ok: true, ids };
  offerRestore(toast, { message: uiFormat('已归档 {0} 个任务：在「任务」的「已归档」里。', [ids.length]), restored: uiFormat('已取消归档 {0} 个任务', [ids.length]),
    // The keyboard focus after 撤销: the 全部归档 button again (it is back with the cards), else the first card's way on.
    focus: () => document.querySelector('.jobs-dismiss-all') || document.querySelector('.home-activity .cjc__go'),
    restore: async () => { const back = await batchRun('unarchive', ids, { quick, core }); if (back.ok === false) { toast.error?.(back.message); return false; } return true; } });
  return { ok: true, ids };
}
