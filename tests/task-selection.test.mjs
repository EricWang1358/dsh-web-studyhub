import test from 'node:test';
import assert from 'node:assert/strict';
import { archivedTasksOf, filterTasks, taskFilters, tasksOf } from '../ui/tasks/task-model.js';
import { allSelected, isSelectableTask, reconcileSelection, selectAll, selectableIds, selectionSummary, toggleSelection, toggleAll, chunk } from '../ui/tasks/task-selection.js';

/* 任务 归档 and 批量删除: which tasks can be selected and how a selection behaves while the list changes. Plain data, no React. */

const at = (n) => new Date(Date.UTC(2026, 9, 5, 8, n)).toISOString();
const job = (id, status, extra = {}) => ({ id, status, deckTitle: `Deck ${id}`, startedAt: at(Number(id.replace(/\D/g, '')) || 0), ...extra });
const audio = (id, status, extra = {}) => ({ id, type: 'audio-import', batchId: `batch-${id}`, filename: `${id}.mp3`, status, startedAt: at(Number(id.replace(/\D/g, '')) || 0), ...extra });
const archived = (id, status, when) => ({ id, archived: { at: when }, contract: { contractVersion: 1, jobId: id, kind: 'generation', title: `Deck ${id}`, status, actions: {}, progress: { done: 0, total: null, unit: null, percent: null, segments: [] },
  result: { refs: [], completeness: null }, startedAt: when, calls: [], events: [], detail: {}, stage: { code: 'finished', args: { status } }, usage: { tokens: null, tokenUsage: null, calls: 0 }, execution: { mode: null }, error: null } });
const tasks = [job('a1', 'complete'), job('a2', 'failed'), job('a3', 'cancelled'), job('a4', 'running'), job('a5', 'queued'), audio('a6', 'interrupted'), audio('a7', 'running'), job('a8', 'cancelling')];
const ids = (list) => [...list].sort();

test('only finished tasks (complete, failed, cancelled, interrupted) can be selected; running, queued, pausing and stopping ones cannot', () => {
  const listed = tasksOf({ jobs: tasks });
  assert.deepEqual(ids(selectableIds(listed)), ids(['a1', 'a2', 'a3', 'batch-a6']), 'an audio task is named by what survives a retry');
  for (const task of tasks) assert.equal(isSelectableTask(task), ['a1', 'a2', 'a3', 'a6'].includes(task.id), task.id);
  assert.equal(isSelectableTask(job('p1', 'running', { paused: true })), false, 'a paused task is still running');
  assert.equal(isSelectableTask({ id: 'coach:2026-10-01', type: 'coach-daily', status: 'complete', date: '2026-10-01', today: false }), false, 'a day of 为你定制 is not archived or batch-deleted');
});

test('select all follows the current filter and takes only what can be selected there', () => {
  const listed = tasksOf({ jobs: tasks });
  assert.deepEqual(ids(selectAll(filterTasks(listed, 'all'))), ids(['a1', 'a2', 'a3', 'batch-a6']));
  assert.deepEqual(ids(selectAll(filterTasks(listed, 'failed'))), ids(['a2', 'batch-a6']), 'the failed filter: failed and interrupted');
  assert.deepEqual(ids(selectAll(filterTasks(listed, 'running'))), [], 'nothing in 进行中 can be selected');
  assert.equal(allSelected(filterTasks(listed, 'running'), new Set()), false, 'no selectable task: select-all is not "all selected"');
});

test('toggling one task, toggling all, and the summary the bar shows', () => {
  const listed = tasksOf({ jobs: tasks });
  let selection = toggleSelection(new Set(), 'a1');
  assert.deepEqual([...selection], ['a1']);
  assert.deepEqual(selectionSummary(listed, selection), { count: 1, selectable: 4, all: false });
  selection = toggleAll(listed, selection);
  assert.equal(allSelected(listed, selection), true, 'one click on the box when some are picked selects every one');
  assert.equal(selection.size, 4);
  assert.deepEqual(selectionSummary(listed, selection), { count: 4, selectable: 4, all: true });
  assert.equal(toggleAll(listed, selection).size, 0, 'and one more click clears it');
  assert.deepEqual([...toggleSelection(new Set(['a1']), 'a1')], [], 'a task toggles off');
});

test('a selection survives a refresh of the list by id, and drops ids that vanished or that stopped being selectable', () => {
  const before = tasksOf({ jobs: tasks });
  const selection = new Set(['a1', 'a2', 'batch-a6']);
  assert.equal(reconcileSelection(selection, before), selection, 'nothing changed: the very same set (no re-render)');
  const refreshed = tasksOf({ jobs: [job('a1', 'complete'), audio('a6', 'interrupted'), job('a9', 'complete')] });
  const kept = reconcileSelection(selection, refreshed);
  assert.deepEqual(ids(kept), ids(['a1', 'batch-a6']), 'a2 is gone from the list');
  const resumed = tasksOf({ jobs: [job('a1', 'running'), audio('a6', 'interrupted')] });
  assert.deepEqual(ids(reconcileSelection(new Set(['a1', 'batch-a6']), resumed)), ['batch-a6'], 'a task that is running again can no longer be selected');
  assert.deepEqual([...reconcileSelection(new Set(['x']), [])], []);
});

test('changing the filter keeps only what the new list shows: nothing hidden is ever acted on', () => {
  const listed = tasksOf({ jobs: tasks });
  const selection = new Set(['a1', 'a2', 'a3']);
  const failedOnly = reconcileSelection(selection, filterTasks(listed, 'failed'));
  assert.deepEqual([...failedOnly], ['a2']);
});

test('the archived list: newest archived first, counted in its own filter next to 全部, 进行中 and 失败, and selectable as a whole', () => {
  const data = { jobs: tasks, archivedJobs: [archived('o1', 'complete', at(10)), archived('o2', 'failed', at(30)), archived('o3', 'cancelled', at(20))] };
  const list = archivedTasksOf(data);
  assert.deepEqual(list.map((task) => task.id), ['o2', 'o3', 'o1']);
  assert.deepEqual(taskFilters(tasksOf(data), list).map((item) => [item.id, item.count]), [['all', 8], ['running', 4], ['failed', 2], ['archived', 3]], '全部 does not count the archived ones');
  assert.deepEqual(ids(selectableIds(list)), ids(['o1', 'o2', 'o3']));
  assert.deepEqual(archivedTasksOf({}), []);
  assert.deepEqual(taskFilters(tasksOf({ jobs: [] })).map((item) => item.id), ['all', 'running', 'failed', 'archived'], 'the filter is always there, with count 0');
});

test('a long selection is sent in calls of at most 100', () => {
  const many = Array.from({ length: 250 }, (_, index) => `t${index}`);
  assert.deepEqual(chunk(many, 100).map((part) => part.length), [100, 100, 50]);
  assert.deepEqual(chunk([], 100), []);
});
