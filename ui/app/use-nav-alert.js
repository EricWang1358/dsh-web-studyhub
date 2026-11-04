import { useTaskBadge } from '../tasks/use-task-badge.js';
import { navAlert, navAlertText } from '../nav-alert.js';
import { useApp } from './app-context.js';

/** The sidebar's one attention dot for the library on screen (ui/nav-alert.js), with its reason, and the 任务 badge it was read from.
    The sidebar draws the dot on its row; the top bar's menu button carries it while the sidebar is a closed drawer. */
export function useNavAlert() {
  const { data, nav, board } = useApp();
  const page = nav.navPage;
  const tasks = useTaskBadge({ root: data?.root, data, viewing: page === 'tasks' });
  const alert = data ? navAlert({ failedTasks: tasks.failed, due: data.today?.due, boardDue: board.due.overdue + board.due.today, page }) : null;
  return { alert, reason: navAlertText(alert), tasks };
}
