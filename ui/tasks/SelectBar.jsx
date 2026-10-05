import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Tooltip } from '../components/index.js';

/* The bar of the selection, under the filters: ONE row of a fixed height that is always there, so picking a task moves nothing. With nothing selected it holds the
   box 「全选当前筛选」; with a selection, the count and the actions (归档 or, in the archive, 取消归档; 删除; 取消选择). Presentational: the console owns the selection
   (ui/tasks/task-selection.js) and what the buttons do. */
export default function SelectBar({ filter, summary, busy = false, onToggleAll, onArchive, onUnarchive, onDelete, onClear }) {
  const { count, selectable, all } = summary;
  return (
    <div className="tc-pickbar" role="group" aria-label={ui('批量操作')} data-active={count > 0 ? 'true' : 'false'}>
      <Tooltip content={ui('只有已结束的任务可以选择。')} anchorClassName="tc-pickbar__tip">
        <span className="tc-pickbar__box">
          <Checkbox className="tc-pickbar__all" label={count > 0 ? uiFormat('已选 {0}', [count]) : ui('全选当前筛选')} checked={all} disabled={selectable === 0} onChange={() => onToggleAll?.()} />
        </span>
      </Tooltip>
      {count > 0 && (
        <div className="tc-pickbar__actions">
          {filter === 'archived'
            ? <Button size="sm" className="tc-pickbar__btn" disabled={busy} onClick={onUnarchive}>{ui('取消归档')}</Button>
            : <Button size="sm" className="tc-pickbar__btn" disabled={busy} onClick={onArchive}>{ui('归档')}</Button>}
          <Button size="sm" variant="danger" className="tc-pickbar__btn" disabled={busy} onClick={onDelete}>{ui('删除')}</Button>
          <Button size="sm" variant="quiet" className="tc-pickbar__btn" onClick={onClear}>{ui('取消选择')}</Button>
        </div>
      )}
    </div>
  );
}
