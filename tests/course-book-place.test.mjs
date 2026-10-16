/* 复习全书 S1 (docs/review-book.md "Open it", "Where you were"): what the page keeps of where the learner was and the light read it asks when it comes back into
   view. keepBook keeps { heading, offset } per library and course in the browser's storage; target, view, back, point, switched and chapter stay one-shots in
   memory and are never written. course.book.revision answers the book's revision alone, writes nothing, and moves with every write of the book (a save, a
   write of the main chat). 复制编号: the lowercase hid the book tools match, the number, the title and the course. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`export * from './ui/book/model.js';`);

/** A Map with the Storage methods the page's storage helpers call. */
const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
};

test('keepBook: the place (heading, offset) is kept in storage per library and course; the one-shots stay in memory and are never written', () => {
  const storage = memoryStorage();
  ui.keepBook('lib-a', 'ArchSS', { heading: 'h7', offset: -812.4, target: 'bk:p3', view: 'flip', back: true, point: 'h7', switched: true, chapter: 'h1' }, storage);
  assert.deepEqual([...storage.map.keys()], ['study-book-place:lib-a:ArchSS']);
  assert.deepEqual(JSON.parse(storage.map.get('study-book-place:lib-a:ArchSS')), { heading: 'h7', offset: -812 }, 'a small JSON: the heading and a whole offset');
  const kept = ui.keptBook('lib-a', 'ArchSS', storage);
  assert.equal(kept.heading, 'h7');
  assert.equal(kept.offset, -812);
  assert.equal(kept.target, 'bk:p3', 'the one-shots are read back from memory in this page load');
  for (const key of ['target', 'view', 'back', 'point', 'switched', 'chapter']) assert.equal(storage.map.get('study-book-place:lib-a:ArchSS').includes(`"${key}"`), false, `${key} is never written`);
  // A later visit (a new page load: a new memory) has the place and nothing else.
  ui.keepBook('lib-a', 'ArchSS', { target: null, view: null, back: false, point: null, switched: false, chapter: null }, storage);
  assert.deepEqual(ui.keptBook('lib-a', 'ArchSS', storage), { heading: 'h7', offset: -812, target: null, view: null, back: false, point: null, switched: false, chapter: null });
  assert.deepEqual(ui.keptBook('lib-b', 'ArchSS', memoryStorage()), null, 'another library has no place');
  // A place only moves the part it is given; a corrupt value is no place.
  ui.keepBook('lib-a', 'ArchSS', { offset: 40 }, storage);
  assert.deepEqual(JSON.parse(storage.map.get('study-book-place:lib-a:ArchSS')), { heading: 'h7', offset: 40 });
  storage.setItem('study-book-place:lib-a:Other', '{nope');
  assert.equal(ui.keptBook('lib-a', 'Other', storage), null);
  storage.setItem('study-book-place:lib-a:Other', JSON.stringify({ heading: 7 }));
  assert.equal(ui.keptBook('lib-a', 'Other', storage), null);
  // No storage at all (a private window, blocked or full): the place survives in memory for this page load, so the way back from practice still lands there.
  ui.keepBook('lib-c', null, { heading: 'h2', offset: 10.4 }, null);
  assert.deepEqual(ui.keptBook('lib-c', null, null), { heading: 'h2', offset: 10 }, 'kept in memory without storage');
  ui.keepBook('lib-c', null, { offset: -300, back: true, point: 'h2' }, null);
  assert.deepEqual(ui.keptBook('lib-c', null, null), { heading: 'h2', offset: -300, back: true, point: 'h2' }, 'the way back keeps heading and offset in memory');
  // A storage that refuses every write (full): the memory copy is the latest within this page load.
  const full = { getItem: () => JSON.stringify({ heading: 'h1', offset: 0 }), setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  ui.keepBook('lib-d', 'ArchSS', { heading: 'h9', offset: 120 }, full);
  assert.deepEqual(ui.keptBook('lib-d', 'ArchSS', full), { heading: 'h9', offset: 120 }, 'a full storage: memory wins in this page load');
});

test('复制编号: the lowercase hid the book tools match, then the number and title, then the course', () => {
  assert.equal(ui.pointCode({ hid: 'h7', number: '1.2.2', title: 'Architect the Solution (Asset)' }, 'ArchSS'), 'h7 · 1.2.2 Architect the Solution (Asset) · ArchSS');
  assert.equal(ui.pointCode({ hid: 'H12', number: '', title: '未归位' }, ''), 'h12 · 未归位 · 未分类课程');
});

test('course.book.revision: the book\'s revision alone, read only, moving with every write of the book', async t => {
  const base = await mkdtemp(join(tmpdir(), 'study-book-revision-')), root = join(base, 'library');
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedBookFixture(root, 'archss');
  const study = new StudyService(root);
  const book = await study.call('course.book.open', { course: BOOK_COURSE });
  const before = (await study.store.read()).revision;
  const first = await study.call('course.book.revision', { course: BOOK_COURSE });
  assert.deepEqual(first, { course: BOOK_COURSE, revision: book.revision });
  assert.equal((await study.store.read()).revision, before, 'reading it writes nothing');
  assert.deepEqual(await study.call('course.book.revision', {}), first, 'the current course by default');
  const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children || []))), point = leaves(book.nodes)[0];
  const saved = await study.call('course.book.save', { course: BOOK_COURSE, file: point.files.mine, text: 'Mine.', version: book.files[point.files.mine].version });
  const next = await study.call('course.book.revision', { course: BOOK_COURSE });
  assert.equal(next.revision, saved.revision);
  assert.ok(next.revision > first.revision, 'a save moves it');
  // The main chat's write (book.write) moves it too: what the chat wrote shows up when the page comes back.
  await study.call('book.write', { course: BOOK_COURSE, hid: point.hid, file: 'mine', markdown: 'Written by the chat.' });
  assert.ok((await study.call('course.book.revision', { course: BOOK_COURSE })).revision > next.revision);
  assert.deepEqual(await study.call('course.book.revision', { course: 'No such course' }), { course: 'No such course', revision: null }, 'no book: no revision');
  assert.deepEqual(writesFor('library', 'course.book.revision'), [], 'read only');
});
