import React from 'react';
import { ui } from '../i18n.js';
import { Menu } from '../components/index.js';

/* The ⋯ of a task's header (#668): 删除 is not one of the buttons of the row (it had the weight of the primary action, a red outline beside 归档); it is the one item of this menu, in the danger colour.
   What it does is unchanged: the record leaves the list at once and the notice offers 撤销 (ui/tasks/TaskConsole.jsx askDelete / removeDay). A past day of 为你定制 says it deletes the day (its file keeps
   fourteen days); a running task has no menu (it is never deleted). `onDelete` gets the item's id. */
export default function TaskMore({ day = false, onDelete, defaultOpen = false }) {
  const items = [{ id: 'delete', label: day ? ui('删除这一天') : ui('删除任务记录'), hint: day ? ui('只保留最近 14 天') : undefined, danger: true, attrs: { 'data-task-delete': '' } }];
  return <Menu className="tc-head__more" label={ui('更多操作')} items={items} defaultOpen={defaultOpen} onSelect={onDelete} data-tour="tasks-more" data-task-more />;
}
