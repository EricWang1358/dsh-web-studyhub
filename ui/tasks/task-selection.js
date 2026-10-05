import { contractOf, taskId } from './task-model.js';

/* Which tasks of the 任务 list can be selected (for 归档, 取消归档 and 删除) and how a selection behaves while the list changes. Plain data and predicates (no React, no ui()):
   a selection is a Set of task ids (what survives a retry, as in the list and in deep links). Only FINISHED tasks can be selected; what runs, waits, pauses or stops cannot,
   and a day of 为你定制 (a record its own file already ages out) is not offered. A selection never holds anything the list in front of the learner does not show. */

const FINISHED = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
/** A call to the host names at most this many tasks (the host refuses more). */
export const BATCH_LIMIT = 100;

export const isSelectableTask = (task) => { const contract = contractOf(task); return FINISHED.has(contract.status) && contract.kind !== 'coach-daily'; };
export const selectableIds = (tasks) => tasks.filter(isSelectableTask).map(taskId);

/** The selection with `id` added, or taken out when it was there. */
export function toggleSelection(selection, id) {
  const next = new Set(selection);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Every task of `shown` that can be selected (the current filter's 全选). */
export const selectAll = (shown) => new Set(selectableIds(shown));

/** All of what can be selected in `shown` is selected (false when there is nothing to select). */
export function allSelected(shown, selection) {
  const ids = selectableIds(shown);
  return ids.length > 0 && ids.every((id) => selection.has(id));
}

/** The box on 全选: when everything is selected it clears, otherwise (nothing or some) it selects everything. */
export const toggleAll = (shown, selection) => (allSelected(shown, selection) ? new Set() : selectAll(shown));

/** What the bar says: how many are selected, how many could be, and whether that is all of them. */
export function selectionSummary(shown, selection) {
  const ids = selectableIds(shown);
  return { count: ids.filter((id) => selection.has(id)).length, selectable: ids.length, all: allSelected(shown, selection) };
}

/**
 * The selection after the list changed (a refresh, another filter): ids that are no longer in `shown`, or that can no longer be selected (the task runs again), drop out.
 * The same Set comes back when nothing changed, so a refresh that changes nothing re-renders nothing.
 */
export function reconcileSelection(selection, shown) {
  if (!selection.size) return selection;
  const keep = new Set(selectableIds(shown));
  const next = [...selection].filter((id) => keep.has(id));
  return next.length === selection.size ? selection : new Set(next);
}

/** `ids` in parts of at most `size`, in order. */
export function chunk(ids, size = BATCH_LIMIT) {
  const parts = [];
  for (let start = 0; start < ids.length; start += size) parts.push(ids.slice(start, start + size));
  return parts;
}
