import { uiFormat } from './i18n.js';

/* The sidebar's one attention dot (#655). A dot means "something here waits for you, now": it is on at most one row, the most pressing one,
   and it always has a reason the learner can read (the first line of the row's Tooltip). With nothing to act on there is no dot at all, so an
   empty library, a new learner or a quiet day shows a sidebar without dots; the first steps of a new learner are the home's first-run line, not
   dots (the 「从这里开始」 markers of 3.7 are gone for that reason).

   What counts, most pressing first:
     1. tasks that did not finish since the console was last opened (ui/tasks/use-task-badge.js `failed`): the work the learner asked for is
        stuck until they look;
     2. questions due for review today (the snapshot's `today.due`): 回到题目 starts them;
     3. to-do cards that are overdue or due today (lib/board-model.js): the learner set those dates.
   The page the learner is on carries no dot: they are already there. When the row with the dot is folded away (in a closed 「更多」, or the
   whole sidebar behind the narrow window's menu button), the control that opens it carries the same dot and reason (ui/app/AppSidebar.jsx). */

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** The one alert, or null: { id: the row (a page id, 'review' for 回到题目), kind, count }. */
export function navAlert({ failedTasks = 0, due = 0, boardDue = 0, page = null } = {}) {
  const candidates = [
    { id: 'tasks', kind: 'failed', count: count(failedTasks) },
    { id: 'review', kind: 'due', count: count(due) },
    { id: 'board', kind: 'board', count: count(boardDue) },
  ];
  return candidates.find((item) => item.count > 0 && item.id !== page) || null;
}

/** The reason, in the learner's words: the first line of the Tooltip of the row with the dot (and of the control that opens it). */
export function navAlertText(alert) {
  if (!alert) return '';
  if (alert.kind === 'failed') return uiFormat('{0} 个任务没有完成，点开看原因', [alert.count]);
  if (alert.kind === 'due') return uiFormat('今天有 {0} 道题到期复习', [alert.count]);
  return uiFormat('待办里有 {0} 项已逾期或今天截止', [alert.count]);
}
