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

const ui = await loadUi(`export * from './ui/book/model.js';
  export { placeKeeper } from './ui/book/use-book-place.js';
  export { readShare } from './ui/book/BookBar.jsx';`);

/** A Map with the Storage methods the page's storage helpers call. */
const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
};

test('keepBook: the place (heading, offset) is kept in storage per library and course; the one-shots stay in memory and are never written', () => {
  const storage = memoryStorage();
  ui.keepBook('lib-a', 'ArchSS', { heading: 'h7', offset: -812.4, target: 'bk:p3', view: 'flip', back: true, point: 'h7', switched: true, chapter: 'h1', folds: [0, 2] }, storage);
  assert.deepEqual([...storage.map.keys()], ['study-book-place:lib-a:ArchSS']);
  assert.deepEqual(JSON.parse(storage.map.get('study-book-place:lib-a:ArchSS')), { heading: 'h7', offset: -812 }, 'a small JSON: the heading and a whole offset');
  const kept = ui.keptBook('lib-a', 'ArchSS', storage);
  assert.equal(kept.heading, 'h7');
  assert.equal(kept.offset, -812);
  assert.equal(kept.target, 'bk:p3', 'the one-shots are read back from memory in this page load');
  assert.deepEqual(kept.folds, [0, 2]);
  for (const key of ['target', 'view', 'back', 'point', 'switched', 'chapter', 'folds']) assert.equal(storage.map.get('study-book-place:lib-a:ArchSS').includes(`"${key}"`), false, `${key} is never written`);
  // A later visit (a new page load: a new memory) has the place and nothing else.
  ui.keepBook('lib-a', 'ArchSS', { target: null, view: null, back: false, point: null, switched: false, chapter: null, folds: null }, storage);
  assert.deepEqual(ui.keptBook('lib-a', 'ArchSS', storage), { heading: 'h7', offset: -812, target: null, view: null, back: false, point: null, switched: false, chapter: null, folds: null });
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

test('the place for the next visit is the last one measured: a write after the page went away (the sidebar, pagehide) keeps the last stretch of scrolling and reads no page', () => {
  let page = { heading: 'h3', offset: 120 }, reads = 0;
  const written = [], keeper = ui.placeKeeper(() => { reads += 1; return page; }, place => written.push(place));
  keeper.write();
  assert.deepEqual(written, [], 'nothing measured yet: nothing written');
  keeper.save();
  assert.deepEqual(written, [{ heading: 'h3', offset: 120 }]);
  // The learner scrolls on (each frame measured), then leaves within the 500 ms of the throttle: the page is gone (nothing to measure) when the write runs.
  page = { heading: 'h3', offset: -640 };
  keeper.measure();
  page = null;
  const before = reads;
  keeper.write();
  assert.equal(reads, before, 'the write on leaving reads nothing of the page');
  assert.deepEqual(written.at(-1), { heading: 'h3', offset: -640 }, 'the last measured place, not the one of the last throttled save');
  keeper.save();
  assert.deepEqual(written.at(-1), { heading: 'h3', offset: -640 }, 'a measure that finds no page keeps the last place');
  // The way back to practice keeps its own place (a row of 翻看, the heading above a link): the write on leaving puts no older measure back over it.
  keeper.keep({ heading: 'h9', offset: 80, point: 'h9' });
  keeper.measure();
  keeper.write();
  assert.deepEqual(written.slice(-2), [{ heading: 'h9', offset: 80, point: 'h9' }, { heading: 'h9', offset: 80, point: 'h9' }]);
  // The page is still there while it leaves: a save already on its way (the throttle's timer, a late change of the heading being read) measures another heading and
  // must not replace the way back's place; only the learner scrolling again does.
  page = { heading: 'h10', offset: 941 };
  keeper.save();
  assert.deepEqual(written.at(-1), { heading: 'h9', offset: 80, point: 'h9' }, 'a save on its way keeps the way back');
  keeper.resume();
  keeper.save();
  assert.deepEqual(written.at(-1), { heading: 'h10', offset: 941 }, 'after a new scroll the page is measured again');
});

test('the bar\'s reading line: a long point is read to the share the window\'s foot has passed once its top is under the bar; a short one is full once its end is on screen after a scroll', () => {
  const bar = 100, foot = 900;
  // Long (3000 px): nothing while its top is below the bar; part way as it scrolls; full once its end is on screen.
  assert.equal(ui.readShare({ top: 140, bottom: 3140, height: 3000 }, bar, foot, false), 0);
  assert.equal(ui.readShare({ top: 140, bottom: 3140, height: 3000 }, bar, foot, true), 0, 'its top not yet under the bar: 0 even after a scroll');
  assert.equal(ui.readShare({ top: 0, bottom: 3000, height: 3000 }, bar, foot, true), 0.3);
  assert.equal(ui.readShare({ top: -1500, bottom: 1500, height: 3000 }, bar, foot, true), 0.8);
  assert.equal(ui.readShare({ top: -2200, bottom: 800, height: 3000 }, bar, foot, true), 1, 'its end on screen: full');
  // Short (500 px): empty at the top of the page; full once the reader scrolled and the whole point is on screen, or its top went under the bar with its end visible.
  assert.equal(ui.readShare({ top: 160, bottom: 660, height: 500 }, bar, foot, false), 0, 'not scrolled yet: empty');
  assert.equal(ui.readShare({ top: 120, bottom: 620, height: 500 }, bar, foot, true), 1, 'all of it on screen after a scroll: full');
  assert.equal(ui.readShare({ top: -200, bottom: 300, height: 500 }, bar, foot, true), 1, 'its top under the bar, its end visible: full');
  assert.equal(ui.readShare({ top: 400, bottom: 900.5, height: 500.5 }, bar, foot, true), 0, 'its end just below the window: not all on screen');
  assert.equal(ui.readShare({ top: 0, bottom: 0, height: 0 }, bar, foot, true), 0, 'nothing drawn: 0');
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
