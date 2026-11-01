/* #461 on the outline page: its buttons start the task in one click, so what they send carries the learner's go-ahead (`confirm: true`): 生成总纲 /
   重新整理 (the outline build) and 用清点结果重新整理总纲 (the review book with rebuildOutline). #462: the outline a review book build extends keeps the cut the
   learner chose. No browser, no model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { extendedOutline } from '../lib/contexts/generation/book/jobs/stages.js';
import { courseOutlineMaterial } from '../lib/course-outline-book.js';

const ui = await loadUi(`export { organiseArgs, REBUILD_OUTLINE } from './ui/outline/CourseOutline.jsx';
  export { rebuildTipText } from './ui/outline/words.js';`);

test('the outline page sends confirm: true with every rebuild it starts', () => {
  assert.deepEqual(ui.organiseArgs('SA', null), { course: 'SA', confirm: true });
  assert.deepEqual(ui.organiseArgs('SA', ['doc:a']), { course: 'SA', confirm: true, papers: ['doc:a'] });
  assert.deepEqual(ui.organiseArgs('SA', []), { course: 'SA', confirm: true, papers: [] });
  assert.deepEqual({ ...ui.REBUILD_OUTLINE }, { rebuildOutline: true, confirm: true });
});

test('重新整理 says on hover that the notes do not move right away: the book page lists each place first', () => {
  assert.match(ui.rebuildTipText(), /不会马上动你写的内容.*先列出每一处/);
});

test('an outline extended by a review book build keeps its cut (granularity, maxPoints)', () => {
  const nodes = [{ id: 'c', title: 'C', children: [{ id: 'p', title: 'P', anchors: ['doc:x'] }] }];
  const outline = { id: 'o1', ...courseOutlineMaterial({ title: '总纲 · C', course: 'C', orderBasis: { codes: [] }, fingerprint: 'abcdef12', nodes, other: { anchors: [] }, counts: {},
    from: 'inventory', shape: { granularity: 'coarse', maxPoints: 40 } }) };
  const next = extendedOutline(outline, [{ id: 'c', title: 'C', children: [{ id: 'p', title: 'P', anchors: ['doc:x'] }, { id: 'q', title: 'Q', anchors: ['doc:y'] }] }], 'o1');
  assert.deepEqual([next.courseOutline.shape, next.courseOutline.from, next.courseOutline.supersedes], [{ granularity: 'coarse', maxPoints: 40 }, 'inventory', 'o1']);
});
