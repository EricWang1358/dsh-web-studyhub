import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, pagesInGroup, pageNeeds } from '../ui/pages.js';
import { NAV_DEFAULTS, mergeOrder } from '../ui/nav-order.js';
import { LIBRARY_KEYS, initialLibraryState, libraryReducer } from '../ui/app/library-state.js';
import { taskKindOf, tasksOf, runningTaskCount, pickTask, taskFilters, filterTasks } from '../ui/tasks/task-model.js';
import { usageEntry } from '../lib/usage-registry.js';

// WP-TC step 1: the 任务 page in the sidebar, its running-count badge and the deep link to one job.

// #654: the sidebar's groups are by content; 任务 heads 「更多 › 任务、笔记与待办」 (it was in 每天, after 创建题组). A failed job still shows: the
// one attention dot goes on 「更多」 while it is closed (ui/nav-alert.js, tests/nav-alert.test.mjs).
test('任务 is a sidebar page of 更多 › 任务、笔记与待办, first in it, that needs no host component', () => {
  assert.equal(PAGES.tasks.label, '任务');
  assert.equal(PAGES.tasks.group, 'notes');
  assert.equal(PAGES.tasks.glyph, 'tasks');
  assert.deepEqual(pageNeeds('tasks'), [], 'the console only reads what the snapshot already holds');
  const notes = NAV_DEFAULTS.notes;
  assert.equal(notes[0], 'tasks');
  assert.deepEqual(pagesInGroup('notes'), notes);
  // A learner's saved order keeps its sequence; the page they never saw is added after it (mergeOrder).
  const merged = mergeOrder({ notes: ['board', 'notes'] }, NAV_DEFAULTS).notes;
  assert.deepEqual(merged.slice(0, 2), ['board', 'notes']);
  assert.ok(merged.includes('tasks'));
  assert.ok(usageEntry('nav.tasks'), 'the sidebar entry is a registered control');
  assert.equal(usageEntry('nav.tasks').navGroup, 'notes');
});

test('the library remembers which job the console was opened on, and forgets it with the library', () => {
  assert.ok(LIBRARY_KEYS.includes('taskFocus'));
  const fresh = initialLibraryState({});
  assert.equal(fresh.taskFocus, null);
  const set = libraryReducer(fresh, { type: 'set', key: 'taskFocus', value: { jobId: 'abc', nonce: 1 } });
  assert.deepEqual(set.taskFocus, { jobId: 'abc', nonce: 1 });
  assert.equal(libraryReducer(set, { type: 'reset', initial: {} }).taskFocus, null);
});

const job = (id, type, status, extra = {}) => ({ id, type, status, startedAt: extra.startedAt || '2026-10-05T10:00:00.000Z', ...extra });

test('every job type has a kind the console labels and groups by', () => {
  assert.equal(taskKindOf(job('a', 'audio-import', 'running')), 'audio');
  assert.equal(taskKindOf(job('a', 'pdf-convert', 'running')), 'pdf');
  assert.equal(taskKindOf(job('a', 'translation', 'running')), 'translation');
  assert.equal(taskKindOf(job('a', 'supplement', 'running')), 'supplement');
  assert.equal(taskKindOf(job('a', 'draft-repair', 'running')), 'repair');
  assert.equal(taskKindOf(job('a', 'draft-publish', 'running')), 'publish');
  assert.equal(taskKindOf(job('a', undefined, 'running')), 'generation');
  assert.equal(taskKindOf(job('a', 'extension', 'running')), 'extension');
});

test('the badge counts what is waiting or running, not what has finished', () => {
  const data = { jobs: [job('1', 'audio-import', 'running'), job('2', undefined, 'queued'), job('3', undefined, 'cancelling'),
    job('4', 'pdf-convert', 'complete'), job('5', undefined, 'failed'), job('6', undefined, 'cancelled')] };
  assert.equal(runningTaskCount(data), 3);
  assert.equal(runningTaskCount({}), 0);
  assert.equal(runningTaskCount(null), 0);
});

test('tasks list newest first, and the filters count the same list they filter', () => {
  const data = { jobs: [job('old', undefined, 'complete', { startedAt: '2026-10-04T09:00:00.000Z' }),
    job('new', 'audio-import', 'running', { startedAt: '2026-10-05T11:00:00.000Z' }),
    job('bad', 'pdf-convert', 'failed', { startedAt: '2026-10-05T10:00:00.000Z' })] };
  const tasks = tasksOf(data);
  assert.deepEqual(tasks.map((task) => task.id), ['new', 'bad', 'old']);
  const filters = taskFilters(tasks);
  assert.deepEqual(filters.map((filter) => [filter.id, filter.count]), [['all', 3], ['running', 1], ['failed', 1], ['archived', 0]]);
  assert.deepEqual(filterTasks(tasks, 'running').map((task) => task.id), ['new']);
  assert.deepEqual(filterTasks(tasks, 'failed').map((task) => task.id), ['bad']);
  assert.deepEqual(filterTasks(tasks, 'all').length, 3);
});

test('the console opens on the job it was linked to, else the one that is running, else the newest', () => {
  const tasks = tasksOf({ jobs: [job('done', undefined, 'complete', { startedAt: '2026-10-05T12:00:00.000Z' }),
    job('run', 'audio-import', 'running', { startedAt: '2026-10-05T10:00:00.000Z' })] });
  assert.equal(pickTask({ tasks, focus: { jobId: 'done' } }), 'done');
  assert.equal(pickTask({ tasks, focus: { jobId: 'gone' } }), 'run', 'a link to a job that no longer exists falls back');
  assert.equal(pickTask({ tasks }), 'run');
  assert.equal(pickTask({ tasks: tasks.filter((task) => task.id === 'done') }), 'done');
  assert.equal(pickTask({ tasks: [] }), null);
  // A selection the learner made stays while it still exists.
  assert.equal(pickTask({ tasks, current: 'done' }), 'done');
  assert.equal(pickTask({ tasks, current: 'vanished' }), 'run');
  // A new deep link wins over the old selection.
  assert.equal(pickTask({ tasks, current: 'done', focus: { jobId: 'run', nonce: 2 }, focusSeen: 1 }), 'run');
});
