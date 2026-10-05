import React, { useEffect, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Tooltip } from '../components/index.js';

/* The bar of the selection, under the filters: ONE row of a fixed height that is always there, so picking a task moves nothing. With nothing selected it holds the
   box 「全选当前筛选」; with a selection, the count and the actions (归档 or, in the archive, 取消归档; 删除; 取消选择). Presentational: the console owns the selection
   (ui/tasks/task-selection.js) and what the buttons do.
   The box is a real tri-state checkbox (checked = everything that can be selected, mixed = some). Its words are in a tooltip in the top layer: the list column scrolls and
   clips, and a tooltip inside it was cut off. The count is also announced (a polite status), and when the selection ends under the keyboard focus (the buttons go away
   with it) the focus moves to the bar instead of falling to the page. */
export default function SelectBar({ filter, summary, busy = false, onToggleAll, onArchive, onUnarchive, onDelete, onClear }) {
  const { count, selectable, all } = summary;
  const box = useRef(null), bar = useRef(null), before = useRef(count);
  const some = count > 0 && !all;
  // `indeterminate` is a property of the input, not an attribute: the browser then also says "mixed" to a screen reader.
  useEffect(() => { const input = box.current?.querySelector('input'); if (input) input.indeterminate = some; }, [some, count]);
  useEffect(() => {
    const ended = before.current > 0 && count === 0;
    before.current = count;
    if (ended && (!document.activeElement || document.activeElement === document.body)) bar.current?.focus({ preventScroll: true });
  }, [count]);
  const label = count > 0 ? uiFormat('已选 {0}', [count]) : ui('全选当前筛选');
  return (
    <div className="tc-pickbar" ref={bar} tabIndex={-1} role="group" aria-label={ui('批量操作')} data-active={count > 0 ? 'true' : 'false'}>
      <Tooltip content={ui('只有已结束的任务可以选择。')} layer placement="right-start" outside=".tc-list" anchorClassName="tc-pickbar__tip">
        <span className="tc-pickbar__box" ref={box}>
          <Checkbox className="tc-pickbar__all" label={label} checked={all} disabled={selectable === 0} onChange={() => onToggleAll?.()} />
        </span>
      </Tooltip>
      <span className="sh-visually-hidden" role="status">{count > 0 ? label : ''}</span>
      {count > 0 && (
        <div className="tc-pickbar__actions">
          {filter === 'archived'
            ? <Button size="sm" className="tc-pickbar__btn" disabled={busy} onClick={onUnarchive}>{ui('取消归档')}</Button>
            : <Button size="sm" className="tc-pickbar__btn" disabled={busy} onClick={onArchive}>{ui('归档')}</Button>}
          <Button size="sm" variant="danger" className="tc-pickbar__btn" disabled={busy} onClick={onDelete}>{ui('删除')}</Button>
          <Button size="sm" variant="quiet" className="tc-pickbar__btn tc-pickbar__btn--clear" onClick={onClear}>{ui('取消选择')}</Button>
        </div>
      )}
    </div>
  );
}
