import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const { taskBadge, unseenResults, readSeenAt, markSeenAt, resultOpener } = await loadUi(`
  export { taskBadge, unseenResults } from './ui/tasks/task-model.js';
  export { readSeenAt, markSeenAt } from './ui/tasks/seen-tasks.js';
  export { resultOpener } from './ui/tasks/task-actions.js';
`);

/* The 任务 entry of the sidebar says what has news: jobs still running, and jobs that ended since the learner last had the console open. A question run, a
   draft's publication, a repair, an extension have no letter in the 信箱 (audio, PDF conversion, translation and a passage top-up do), so the badge is how
   they tell the learner they finished or failed. Opening the console clears it. */

const SEEN = Date.parse('2026-10-05T10:00:00.000Z');
const job = (id, type, status, finishedAt, extra = {}) => ({ id, type, status, startedAt: '2026-10-05T09:00:00.000Z', ...(finishedAt ? { finishedAt } : {}), ...extra });
const after = '2026-10-05T11:00:00.000Z', before = '2026-10-05T09:30:00.000Z';

test('a question run, a publication, a repair or an extension that ended after the last visit counts, and a failure is told apart', () => {
  const data = { jobs: [job('g1', undefined, 'complete', after), job('g2', undefined, 'failed', after), job('p1', 'draft-publish', 'complete', after),
    job('r1', 'draft-repair', 'interrupted', after), job('e1', 'extension', 'complete', after)] };
  const news = unseenResults(data, SEEN);
  assert.deepEqual(news.map(item => item.id).sort(), ['e1', 'g1', 'g2', 'p1', 'r1']);
  const badge = taskBadge(data, SEEN);
  assert.deepEqual(badge, { running: 0, unseen: 5, failed: 2, total: 5 }, 'interrupted is a failure the learner has to look at');
});

test('what ended before the visit, what is still running, what the learner stopped and what already has a letter are not news', () => {
  const data = { jobs: [job('old', undefined, 'complete', before), job('live', undefined, 'running'), job('queued', undefined, 'queued'), job('stopped', undefined, 'cancelled', after),
    job('a', 'audio-import', 'complete', after), job('pdf', 'pdf-convert', 'failed', after), job('tr', 'translation', 'complete', after), job('sup', 'supplement', 'complete', after),
    { id: 'coach:2026-10-04', type: 'coach-daily', status: 'complete', date: '2026-10-04', startedAt: '2026-10-04T08:00:00.000Z', finishedAt: after }] };
  assert.deepEqual(unseenResults(data, SEEN), []);
  assert.deepEqual(taskBadge(data, SEEN), { running: 2, unseen: 0, failed: 0, total: 2 }, 'only the two that are still going');
});

test('a job with no end time is judged by when it started, and nothing breaks without jobs', () => {
  assert.equal(unseenResults({ jobs: [job('x', undefined, 'failed', undefined, { startedAt: after })] }, SEEN).length, 1);
  assert.equal(unseenResults({ jobs: [job('x', undefined, 'failed', undefined, { startedAt: before })] }, SEEN).length, 0);
  assert.deepEqual(taskBadge({}, SEEN), { running: 0, unseen: 0, failed: 0, total: 0 });
  assert.deepEqual(taskBadge(null, SEEN), { running: 0, unseen: 0, failed: 0, total: 0 });
});

const memory = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => { map.set(key, String(value)); }, map }; };

test('the time of the last visit is kept per library, starts at the first look, and a blocked storage does not stop the badge', () => {
  const storage = memory();
  assert.equal(readSeenAt('/lib/a', { now: 1000, storage }), 1000, 'the first look: nothing that ended before it is news');
  assert.equal(readSeenAt('/lib/a', { now: 9999, storage }), 1000, 'and it is kept, not moved on at every start');
  markSeenAt('/lib/a', 5000, storage);
  assert.equal(readSeenAt('/lib/a', { now: 9999, storage }), 5000);
  assert.equal(readSeenAt('/lib/b', { now: 7000, storage }), 7000, 'another library has its own');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readSeenAt('/lib/a', { now: 42, storage: blocked }), 42);
  assert.doesNotThrow(() => markSeenAt('/lib/a', 1, blocked));
});

test('the result of an AI note draft opens the note, while the note is still there', () => {
  const finished = { id: 'n-job', contract: { jobId: 'n-job', kind: 'extension', status: 'complete', result: { refs: [{ kind: 'note', id: 'note-1' }], completeness: 'complete' }, detail: {} } };
  const opened = [];
  const app = { data: { notes: [{ id: 'note-1', title: '笔记' }] }, learn: { openLearningTarget: target => opened.push(target) } };
  const opener = resultOpener(finished, app);
  assert.equal(opener.label, '打开笔记');
  opener.run();
  assert.deepEqual(opened, [{ kind: 'note', id: 'note-1' }]);
  assert.equal(resultOpener(finished, { ...app, data: { notes: [] } }), null, 'a deleted note is not offered');
  assert.equal(resultOpener(finished, { data: app.data }), null, 'nor without a way to open it');
});
