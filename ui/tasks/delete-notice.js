import { uiFormat } from '../i18n.js';
import { contractOf, isArchivedTask, isHeldTask, taskKindOf } from './task-model.js';
import { taskSummary } from './task-summary.js';

/* What the notice of 删除 in the 任务 console says (it stands in for the old confirmation, so it keeps that dialog's facts), from what job.delete really does
   (lib/contexts/jobs/operations.js removeLive / releaseRecord):
   - an audio import: its working copy (the batch or single folder) goes to the background cleanup, so it cannot be continued;
   - a PDF conversion that is still in the list and can 接着做: its retry hold is released with its pieces;
   - a PDF conversion that waits for the learner (listed or archived): the converted text and what they changed are lost, and that is what it says;
   - a question run: only the record goes; its draft stays (nothing of it is touched), so questions can still be added from the draft;
   - nothing else: sources, drafts and decks are never deleted. */

/** The record's working files go with it (and 接着做 is gone). */
export function losesWorkingFiles(task) {
  const kind = taskKindOf(task);
  if (kind === 'audio') return true;
  return kind === 'pdf' && !isHeldTask(task) && !isArchivedTask(task) && !!contractOf(task).actions?.retry?.available;
}

/** A question run whose draft outlives its record. */
export const keepsDraft = (task) => ['generation', 'supplement'].includes(taskKindOf(task)) && !!contractOf(task).detail?.draftId;

/** The words of the notice for deleting `tasks` (finished ones) while `running` (a count) were left alone. */
export function deleteNoticeText(tasks, running = 0) {
  let message = tasks.length === 1 ? uiFormat('已删除「{0}」', [taskSummary(tasks[0]).title]) : uiFormat('已删除 {0} 个任务', [tasks.length]);
  if (running) message = uiFormat('{0}；跳过 {1} 个进行中的任务', [message, running]);
  const files = tasks.filter(losesWorkingFiles).length, drafts = tasks.filter(keepsDraft).length, waiting = tasks.filter(isHeldTask).length;
  if (waiting) message = tasks.length === 1 ? uiFormat('{0}；转换好的文字和你改过的地方也会丢掉', [message]) : uiFormat('{0}；其中 {1} 个任务转换好的文字和你改过的地方也会丢掉', [message, waiting]);
  if (files) message = uiFormat('{0}；其中 {1} 个任务的中间文件也会删除，之后不能接着做', [message, files]);
  if (drafts) message = uiFormat('{0}；草稿还在，可以从草稿接着出题', [message]);
  return drafts ? uiFormat('{0}；资料和题组也不会删除', [message]) : uiFormat('{0}；资料、草稿和题组不会删除', [message]);
}
