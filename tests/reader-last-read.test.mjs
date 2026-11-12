/* 上次读到: where a material was last read, per viewer (ui/document-preview/reader/last-read.js). The store keeps one place per
   library and material, the newest ones only; a plain open of a material (its 资料 row) goes back there, an open aimed at a place
   (a quote, a way back, a chapter, a page) does not. The scroll restore itself is the reading loop's (checked in the browser). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAST_READ_KEY, LAST_READ_LIMIT, lastReadKey, readLastRead, saveLastRead, saveLastView, forgetLastRead, lastReadOpening } from '../ui/document-preview/reader/last-read.js';

const memory = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map };
};
const place = (overrides = {}) => ({ documentId: 'doc-1', revision: 'r1', sourceId: 'p3', page: 3, sectionId: 'page-3', sectionTitle: '第 2 章 需求', sectionOffset: 120, scrollTop: 900, progress: 0.4, ...overrides });

test('the key names the library and the material; without either there is none', () => {
  assert.equal(lastReadKey('D:/lib', 'pdf:abc'), 'D:/lib|pdf:abc');
  assert.equal(lastReadKey('', 'pdf:abc'), '');
  assert.equal(lastReadKey('D:/lib', ''), '');
});

test('a saved place is read back as it was, with the time it was saved', () => {
  const storage = memory();
  assert.equal(saveLastRead('lib|m', place(), { storage, now: 1000 }), true);
  assert.deepEqual(readLastRead('lib|m', storage), { ...place(), at: 1000 });
  assert.equal(readLastRead('lib|other', storage), null);
});

test('only the newest places are kept', () => {
  const storage = memory();
  for (let index = 0; index < LAST_READ_LIMIT + 5; index += 1) saveLastRead(`lib|m${index}`, place(), { storage, now: index });
  const kept = JSON.parse(storage.getItem(LAST_READ_KEY));
  assert.equal(Object.keys(kept).length, LAST_READ_LIMIT);
  assert.equal(readLastRead('lib|m0', storage), null, 'the oldest went');
  assert.ok(readLastRead(`lib|m${LAST_READ_LIMIT + 4}`, storage), 'the newest stays');
});

test('forget removes one place; a corrupt or missing store reads as nothing and never throws', () => {
  const storage = memory();
  saveLastRead('lib|m', place(), { storage, now: 1 });
  forgetLastRead('lib|m', storage);
  assert.equal(readLastRead('lib|m', storage), null);
  storage.setItem(LAST_READ_KEY, '{not json');
  assert.equal(readLastRead('lib|m', storage), null);
  assert.equal(saveLastRead('lib|m', place(), { storage, now: 2 }), true, 'a corrupt store is replaced');
  assert.equal(readLastRead('lib|m', null), null);
  assert.equal(saveLastRead('lib|m', place(), { storage: null }), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readLastRead('lib|m', broken), null);
  assert.equal(saveLastRead('lib|m', place(), { storage: broken }), false);
});

test('a stored value that is not a place reads as nothing', () => {
  const storage = memory();
  storage.setItem(LAST_READ_KEY, JSON.stringify({ 'lib|a': 'x', 'lib|b': { sectionId: 5 }, 'lib|c': { scrollTop: -1 } }));
  for (const key of ['lib|a', 'lib|b', 'lib|c']) assert.equal(readLastRead(key, storage), null, key);
});

test('a plain open of a material goes back to its place; an open aimed somewhere does not', () => {
  const entry = { ...place(), at: 5 };
  const plain = { entry, sourceId: 'p1', firstSourceId: 'p1' };
  const opened = lastReadOpening({ ...plain, nonce: 'n1' });
  assert.equal(opened.sectionId, 'page-3');
  assert.equal(opened.scrollTop, 900);
  assert.equal(opened.lastRead, true);
  assert.equal(opened.nonce, 'n1');
  assert.equal(lastReadOpening({ ...plain, entry: null }), null, 'nothing stored');
  assert.equal(lastReadOpening({ ...plain, quote: '一段引文' }), null, 'a quote');
  assert.equal(lastReadOpening({ ...plain, resume: { sectionId: 'x', nonce: 1 } }), null, 'a way back');
  assert.equal(lastReadOpening({ ...plain, peekPage: 4 }), null, '看原页图');
  assert.equal(lastReadOpening({ ...plain, sourceId: 'p7' }), null, 'a chapter or a page of the material');
  assert.equal(lastReadOpening({ ...plain, localMode: true }), null, 'saved writing');
  // Opens aimed elsewhere (gate review of #1021): picking pages to practise (openReaderForPages), and a reader with a way back to a question
  // (QuestionSourcePage: a page-1 card opens at page 1, not at the kept place or view).
  assert.equal(lastReadOpening({ ...plain, pickPages: true }), null, 'picking pages');
  assert.equal(lastReadOpening({ ...plain, back: true }), null, 'a way back to the question');
  assert.equal(lastReadOpening({ ...plain, entry: { ...entry, view: 'original', originalPage: 4 }, back: true }), null, 'not the kept 原始 PDF either');
});

test('the view a material was left in (原始 PDF at a page) is kept in the same record, and leaving it clears it (#1001)', () => {
  const storage = memory();
  // Switched to 原始 PDF at page 5 before any text place was kept: the text place of that moment is kept with it.
  assert.equal(saveLastView('lib|m', { original: true, page: 5, place: place({ page: 5, sectionId: 'page-5' }) }, { storage, now: 1 }), true);
  assert.deepEqual(readLastRead('lib|m', storage), { ...place({ page: 5, sectionId: 'page-5' }), view: 'original', originalPage: 5, at: 1 });
  // A page turn in 原始 PDF changes only the page.
  saveLastView('lib|m', { original: true, page: 9 }, { storage, now: 2 });
  assert.equal(readLastRead('lib|m', storage).originalPage, 9);
  assert.equal(readLastRead('lib|m', storage).sectionId, 'page-5');
  const opened = lastReadOpening({ entry: readLastRead('lib|m', storage), sourceId: 'p1', firstSourceId: 'p1', nonce: 'n' });
  assert.deepEqual([opened.view, opened.originalPage], ['original', 9], 'a plain open says which view to open');
  // A text place kept later (reading on in the text) is the text view again.
  saveLastRead('lib|m', place(), { storage, now: 3 });
  assert.equal(readLastRead('lib|m', storage).view, undefined);
  saveLastView('lib|m', { original: true, page: 4 }, { storage, now: 4 });
  saveLastView('lib|m', { original: false }, { storage, now: 5 });
  assert.deepEqual(readLastRead('lib|m', storage), { ...place(), at: 5 }, 'back to the text: the view goes, the place stays');
  // A view with nothing else is still a record; a bad page is not kept.
  saveLastView('lib|n', { original: true, page: 2 }, { storage, now: 6 });
  assert.deepEqual(readLastRead('lib|n', storage), { view: 'original', originalPage: 2, at: 6 });
  assert.equal(saveLastView('lib|o', { original: true, page: 0 }, { storage }), false);
  storage.setItem(LAST_READ_KEY, JSON.stringify({ 'lib|x': { view: 'other' } }));
  assert.equal(readLastRead('lib|x', storage), null, 'an unknown view is no record');
});
