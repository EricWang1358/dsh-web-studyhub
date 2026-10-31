/* #487, plan A: the outline record says the lowest StudyHub that can update its book (`minReader`), and 更新全书 of a release that is too old refuses, saying so, before any model
   call and before anything is written. It protects releases that hold this check, not the ones already out: 3.4.1 run against such a record still plans an empty body (checked
   by running that tag's code; docs/review-book.md "Rolling back" says so), which is why the home also says once to back the library up. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { courseOutlineMaterial, currentCourseOutline, materialsFingerprint, OUTLINE_MIN_READER } from '../lib/course-outline-book.js';
import { extendedOutline } from '../lib/contexts/generation/book/jobs/stages.js';
import { planBook, readerTooOld } from '../lib/contexts/generation/book/plan.js';
import { planPapersOnly } from '../lib/contexts/generation/outline/plan.js';
import { inventoryNotice } from '../lib/contexts/generation/inventory/messages.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { currentVersion } from '../lib/update-check.js';
import { isNewerVersion } from '../lib/semver.js';
import { StudyService } from '../lib/service.js';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const nodes = [{ id: 'c', title: 'C', children: [{ id: 'p', title: 'P', anchors: ['doc:x@s0-1'] }] }];
const material = extra => courseOutlineMaterial({ title: '总纲 · C', course: 'C', orderBasis: { codes: [] }, fingerprint: 'abcdef12', nodes, other: { anchors: [] }, counts: {}, from: 'inventory', ...extra });

function library(minReader) {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], settings: {}, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const record = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c', title: 'Chapter', children: [{ id: 'p', title: 'Point', anchors: [`${lecture}@s0-1`] }] }], other: { anchors: [] }, counts: {}, from: 'inventory' }), createdAt: '2026-10-10T00:00:00.000Z' };
  if (minReader === null) delete record.courseOutline.minReader; else if (minReader !== undefined) record.courseOutline.minReader = minReader;
  state.sources.push(record);
  return state;
}

test('every outline written says its floor; a floor from the record it continues is never lowered', () => {
  assert.equal(material().courseOutline.minReader, OUTLINE_MIN_READER);
  assert.equal(OUTLINE_MIN_READER, '3.5.0', 'page spans and 清点 records: what 3.4 cannot update');
  assert.equal(material({ minReader: '9.1.0' }).courseOutline.minReader, '9.1.0');
  assert.equal(material({ minReader: '1.0.0' }).courseOutline.minReader, OUTLINE_MIN_READER);
  assert.equal(material({ minReader: 'soon' }).courseOutline.minReader, OUTLINE_MIN_READER);
  const later = { id: 'o1', ...material({ minReader: '9.1.0' }) };
  assert.equal(extendedOutline(later, nodes, 'o1').courseOutline.minReader, '9.1.0');
  const state = library('9.1.0');
  assert.equal(planPapersOnly(state, { course: COURSE, papers: [] }).base.minReader, '9.1.0');
});

test('readerTooOld: only a real version above the reader counts', () => {
  assert.equal(readerTooOld({ minReader: '5.0.0' }, '4.9.9'), true);
  assert.equal(readerTooOld({ minReader: '5.0.0' }, '5.0.0'), false);
  assert.equal(readerTooOld({ minReader: '5.0.0' }, '5.0.1'), false);
  assert.equal(readerTooOld({}, '4.0.0'), false, 'a record of a release before the field');
  assert.equal(readerTooOld({ minReader: 'soon' }, '4.0.0'), false);
  assert.equal(readerTooOld(null, '4.0.0'), false);
  assert.equal(isNewerVersion(OUTLINE_MIN_READER, currentVersion()), false, 'this release can update what it writes');
});

test('更新全书 of a release too old refuses before anything: says what it needs and what it runs; the same with 读更多 of one point', () => {
  const state = library('9.1.0');
  for (const request of [{ course: COURSE, language: 'zh' }, { course: COURSE, language: 'zh', point: 'p' }]) {
    assert.throws(() => planBook(state, request), error => {
      assert.equal(error.code, 'course-book-needs-newer');
      assert.match(error.message, /9\.1\.0/);
      assert.ok(error.message.includes(currentVersion()), error.message);
      assert.match(error.message, /升级/);
      assert.match(error.message, /没有写入/);
      return true;
    });
  }
  assert.throws(() => planBook(state, { course: COURSE, language: 'en' }), error => /upgrade/i.test(error.message) && /Nothing was written/.test(error.message));
});

test('a floor at or below this release, and a record without one, plan as before', () => {
  assert.doesNotThrow(() => planBook(library(), { course: COURSE, language: 'zh' }));
  assert.doesNotThrow(() => planBook(library(null), { course: COURSE, language: 'zh' }));
  assert.doesNotThrow(() => planBook(library(currentVersion()), { course: COURSE, language: 'zh' }));
});

test('through the service: refused with no model call, no job and no write, so no empty explanation can come of it', async t => {
  const fake = outlineModel({ inventory: 'none' }), root = await privateRoot(t, 'book-min-reader-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const state = library('9.1.0');
  await service.store.update(live => { live.sources.push(...structuredClone(state.sources)); live.decks.push(...structuredClone(state.decks)); live.focus = { mode: 'class', course: COURSE }; });
  const before = JSON.stringify((await service.store.read()).sources);
  await assert.rejects(service.call('generation.courseBook.build', { course: COURSE, language: 'zh' }), error => error.code === 'course-book-needs-newer');
  assert.equal(fake.calls.length, 0);
  const after = await service.store.read();
  assert.equal(JSON.stringify(after.sources), before);
  assert.equal(currentCourseOutline(after.sources, COURSE).courseOutline.minReader, '9.1.0');
});

test('what a release before 3.5 can be told: the one record it lists as a material names the danger', () => {
  assert.match(inventoryNotice('zh', 10, 2), /3\.5 以下.*不要点「更新全书」/);
  assert.match(inventoryNotice('en', 10, 2), /before 3\.5.*do not press Update the book/i);
});

test('the home says once to back the library up: only with a book, with the folder, gone after 知道了, kept per library', async () => {
  const ui = await loadUi(`export { default as BookBackupHint, rememberBackupSeen, backupSeen } from './ui/study-map/BookBackupHint.jsx';`);
  const draw = (bookCourses, root = '/lib') => renderToStaticMarkup(React.createElement(ui.BookBackupHint, { bookCourses, root }));
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key), key: at => [...storage.keys()][at] ?? null, get length() { return storage.size; } };
  globalThis.window ??= globalThis;
  try {
    assert.equal(draw([]), '', 'no book, nothing to lose');
    const hint = draw(['SA']);
    assert.match(hint, /data-book-backup/);
    assert.match(hint, /先把学习库文件夹复制一份/);
    assert.match(hint, /\/lib/);
    assert.match(hint, /更新全书/);
    assert.match(hint, /role="tooltip"/, 'how to back up and restore is behind a Tooltip');
    assert.match(hint, />知道了</);
    assert.doesNotMatch(hint, /title="/);
    ui.rememberBackupSeen('/lib');
    assert.equal(ui.backupSeen('/lib'), true);
    assert.equal(draw(['SA']), '');
    assert.match(draw(['SA'], '/other'), /data-book-backup/);
  } finally { delete globalThis.localStorage; }
});
