import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { aiBlocks } from '../lib/course-book-ai-text.js';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { BOOK_COURSE, BOOK_FIXTURES, EXAM_IN_DAYS, seedBookFixture } from './helpers/book-fixtures.mjs';

/* The two review-book fixtures (tests/helpers/book-fixtures.mjs) the browser tests and scripts/qa/book-shots.mjs look at: sixteen points over four chapters,
   each with the real shape of notes and ONE whole-point AI block of 3,000-6,000 characters; no questions in 'archss', most points with 10-25 in 'questions'. */

const leavesOf = nodes => nodes.flatMap(node => (node.leaf ? [node] : leavesOf(node.children || [])));
async function openFixture(kind) {
  const base = await mkdtemp(join(tmpdir(), 'study-book-fixture-')), root = join(base, 'library');
  const seeded = await seedBookFixture(root, kind), service = new StudyService(root);
  const book = await service.call('course.book.open', { course: BOOK_COURSE }), courses = (await service.call('snapshot')).courses;
  return { base, seeded, service, book, courses };
}

test('book fixtures: archss has sixteen points over four chapters, the notes in the real shape, one 3,000-6,000 character whole-point block each, no questions', async () => {
  const { base, service, book, courses, seeded } = await openFixture('archss');
  try {
    assert.equal(book.status, 'ok');
    assert.equal(book.nodes.length, 4, 'four chapters');
    const leaves = leavesOf(book.nodes);
    assert.equal(leaves.length, 16);
    assert.equal(seeded.points.length, 16);
    for (const leaf of leaves) {
      assert.equal(leaf.questionTotal, 0, `${leaf.title}: no questions`);
      for (const label of ['**知识梳理**', '**讲解**', '**例子**', '**补充（资料以外）**', '**出处**']) assert.ok(leaf.gen.includes(label), `${leaf.title}: ${label}`);
      assert.match(leaf.gen, /\[\^2\]/, `${leaf.title}: cite marks`);
      const blocks = aiBlocks(leaf.mine), whole = blocks.filter(block => block.mode === 'here');
      assert.equal(whole.length, 1, `${leaf.title}: one whole-point block`);
      assert.equal(whole[0].state, 'new');
      assert.ok(whole[0].body.length >= 3000 && whole[0].body.length <= 6000, `${leaf.title}: ${whole[0].body.length} characters`);
      assert.match(whole[0].body, /^这段在讲什么\n[\s\S]*### 1\. [\s\S]*原文说：[\s\S]*意思就是：[\s\S]*资料原文：[\s\S]*补充（资料以外）/);
    }
    assert.ok(leaves.filter(leaf => leaf.gen.includes('**考情**')).length >= 4, 'some points carry 考情');
    assert.ok(leaves.filter(leaf => aiBlocks(leaf.mine).some(block => block.mode === 'explain')).length >= 3, 'a few points carry a short explain block');
    const course = courses.find(item => item.name === BOOK_COURSE);
    assert.equal(course.exam.date, addDays(localDate(), EXAM_IN_DAYS), 'the exam is five days after today');
  } finally { await service.dispose(); await rm(base, { recursive: true, force: true }); }
});

test('book fixtures: questions has 10-25 questions on most points, two Q&As in the book, the same notes', async () => {
  const { base, service, book } = await openFixture('questions');
  try {
    const leaves = leavesOf(book.nodes), counts = leaves.map(leaf => leaf.questionTotal);
    assert.equal(leaves.length, 16);
    assert.ok(counts.filter(count => count >= 10 && count <= 25).length >= 12, `most points have 10-25 questions: ${counts}`);
    assert.equal(leaves.filter(leaf => String(leaf.qa ?? '').trim()).length, 2, 'two points have a Q&A');
    assert.equal(leaves.filter(leaf => aiBlocks(leaf.mine).some(block => block.mode === 'here')).length, 16);
    const crunch = await service.call('book.crunch', { course: BOOK_COURSE, date: localDate() });
    assert.equal(crunch.status, 'ok');
    assert.ok(crunch.plan.days.some(day => day.mode === 'flip'), 'the plan has a 翻看 day');
  } finally { await service.dispose(); await rm(base, { recursive: true, force: true }); }
});

test('book fixtures: the names', () => {
  assert.deepEqual(BOOK_FIXTURES, ['archss', 'questions']);
});
