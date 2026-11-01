/* #489 item 6: what the book page needs to say about upkeep without going to the 总纲 page: materials changed since the outline (`outdated`), a point left short (`short`). No model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookService, COURSE } from './helpers/book-agent-library.mjs';

const POINTS = (lecture, lectureKey) => [{ id: 'c1', title: '第 1 章', children: ['一', '二'].map((title, at) => ({ id: `p${at + 1}`, title: `知识点${title}`, anchors: [`${lectureKey}#${at}`] })) }];

test('course.book.open says outdated only when the course\'s materials changed since the outline', async t => {
  const { study } = await bookService(t, { chapters: POINTS });
  assert.equal((await study.call('course.book.open')).outdated, undefined);
  await study.call('source.add', { title: 'A new lecture', text: 'New material for this course.', course: COURSE });
  assert.equal((await study.call('course.book.open')).outdated, true);
});

test('a point left short says so; a complete one says nothing', async t => {
  const { study } = await bookService(t, { chapters: POINTS });
  await study.store.update(state => {
    const notes = state.sources.find(source => source.provenance === 'course-outline-notes');
    notes.courseNotes.leaves[0].body.status = 'short';
  });
  const [one, two] = (await study.call('course.book.open')).nodes[0].children;
  assert.equal(one.short, true);
  assert.equal(two.short, undefined);
});
