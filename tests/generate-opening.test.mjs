import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组 opens already filled in (ui/generate-opening.js): the documents of the current course that have no question yet are ticked, a whole book is left for the
   chapter picker, and one line says why. The guess is conservative: a document that already has questions, a book, an ambiguous library are never guessed, and
   nothing ticked is better than a wrong claim ("还没出过题"). */

const m = await loadUi(`
  export * as opening from './ui/generate-opening.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;

const text = (id, course, extra = {}) => ({ id, title: `${id}.md`, text: 'x'.repeat(2000), courses: course ? [course] : [], usedBy: [], ...extra });
const pdfPages = (hash, n, course, extra = {}) => Array.from({ length: n }, (_, at) => ({ id: `${hash}-${at + 1}`, title: `${hash}.pdf · 第 ${at + 1} 页`, text: 'y'.repeat(300), courses: course ? [course] : [],
  usedBy: [], document: { id: hash.padEnd(64, 'a'), materialId: `document-${hash.padEnd(64, 'a')}-pdf`, page: at + 1, extractionVersion: 2, format: 'pdf' }, ...extra }));
const library = (sources, extra = {}) => ({ sources, decks: [], drafts: [], courses: [], focus: { course: '*', courses: [{ name: '数据库' }, { name: '网络' }] }, materialCoverage: {}, ...extra });
const deck = (id, kind = 'deck') => ({ id, title: id, kind, archived: false });
const known = ['数据库', '网络'];

test('the documents of the page\'s course that have no question yet are ticked, with the reason as data', () => {
  const data = library([text('a', '数据库'), text('b', '数据库'), text('c', '网络')]);
  const result = m.opening.openingSelection(data, { scope: '数据库', known });
  assert.deepEqual(result.sourceIds, ['a', 'b'], 'the other course is left alone');
  assert.deepEqual(result.reason, { code: 'unused', course: '数据库', count: 2, used: 0, big: 0 });
});

test('a document that already has questions is not ticked: published, in a draft, or in the coverage digest, and an archived deck still counts (no false "never asked")', () => {
  const sources = [text('new1', '数据库'), text('new2', '数据库'), text('inDeck', '数据库', { usedBy: [deck('d1')] }), text('inDraft', '数据库', { usedBy: [deck('d2', 'draft')] }),
    text('oldDeck', '数据库', { usedBy: [{ ...deck('d3'), archived: true }] }), text('digest', '数据库')];
  const data = library(sources, { materialCoverage: { 'source:digest': [1, 2, 3] } });
  const result = m.opening.openingSelection(data, { scope: '数据库', known });
  assert.deepEqual(result.sourceIds, ['new1', 'new2']);
  assert.deepEqual([result.reason.count, result.reason.used], [2, 4], 'the line can say how many were left out because they have questions');
});

test('a whole book is left for the chapter picker, and a pile that is too long for one request is not ticked past the limit', () => {
  const book = pdfPages('book', 301, '数据库');
  const data = library([text('slides', '数据库'), ...book]);
  const result = m.opening.openingSelection(data, { scope: '数据库', known });
  assert.deepEqual(result.sourceIds, ['slides']);
  assert.equal(result.reason.big, 1, 'one book was left out and the line says so');
  // 400 000 characters each: the second would pass the 600 000 characters one request takes, so it stays unticked and is counted
  const long = [text('l1', '数据库', { text: 'z'.repeat(400000) }), text('l2', '数据库', { text: 'z'.repeat(400000) })];
  const over = m.opening.openingSelection(library(long), { scope: '数据库', known });
  assert.deepEqual(over.sourceIds, ['l1']);
  assert.equal(over.reason.big, 1);
});

test('one document in the course is ticked even when it has questions (nothing to choose), and says it is the only one', () => {
  const only = library([text('only', '数据库', { usedBy: [deck('d1')] }), text('else', '网络')]);
  const result = m.opening.openingSelection(only, { scope: '数据库', known });
  assert.deepEqual(result.sourceIds, ['only']);
  assert.equal(result.reason.code, 'single');
});

test('a library of one document ticks it even when the page is on all courses of a library with several', () => {
  const data = library([text('only', '数据库')]);
  assert.deepEqual(m.opening.openingSelection(data, { scope: '*', known }).sourceIds, ['only']);
});

test('every document of the course already has questions: nothing is ticked and nothing is claimed', () => {
  const data = library([text('a', '数据库', { usedBy: [deck('d1')] }), text('b', '数据库', { usedBy: [deck('d1')] })]);
  assert.deepEqual(m.opening.openingSelection(data, { scope: '数据库', known }), { sourceIds: [], reason: null });
});

test('all courses at once: the library\'s only course is the course, several courses are not guessed, a library without courses is one pile', () => {
  const sources = [text('a', '数据库'), text('b', '网络')];
  assert.deepEqual(m.opening.openingSelection(library(sources), { scope: '*', known }), { sourceIds: [], reason: null }, 'two courses and no current one: ask');
  const one = library([text('a', '数据库'), text('b', '数据库')], { focus: { course: '*', courses: [{ name: '数据库' }] } });
  assert.deepEqual(m.opening.openingSelection(one, { scope: '*', known: ['数据库'] }).sourceIds, ['a', 'b']);
  const none = library([text('a', ''), text('b', '')], { focus: { course: '*', courses: [] } });
  const result = m.opening.openingSelection(none, { scope: '*', known: [] });
  assert.deepEqual(result.sourceIds, ['a', 'b']);
  assert.equal(result.reason.course, '', 'no course to name');
});

test('the unassigned scope means the documents of no course, and a parent course takes in its chapters', () => {
  const data = library([text('free', ''), text('a', '数据库'), text('ch', '数据库 / 第一章')], { focus: { course: '*', courses: [{ name: '数据库' }, { name: '数据库 / 第一章' }] } });
  assert.deepEqual(m.opening.openingSelection(data, { scope: '', known: ['数据库', '数据库 / 第一章'] }).sourceIds, ['free']);
  assert.deepEqual(m.opening.openingSelection(data, { scope: '数据库', known: ['数据库', '数据库 / 第一章'] }).sourceIds, ['a', 'ch']);
});

test('reference-question material, archived documents and sample papers named as references are not offered', () => {
  const data = library([text('a', '数据库'), text('ref', '数据库'), text('gone', '数据库', { archived: true }), text('b', '数据库')]);
  const result = m.opening.openingSelection(data, { scope: '数据库', known, exclude: ['ref'] });
  assert.deepEqual(result.sourceIds, ['a', 'b']);
});

test('the reason is a short plain sentence in both languages and names what it did and what it left out', () => {
  const line = reason => m.opening.openingLine(reason);
  assert.equal(line(null), '');
  assert.equal(line({ code: 'unused', course: '数据库', count: 3, used: 0, big: 0 }), '已选中「数据库」里还没出过题的 3 份资料。');
  assert.equal(line({ code: 'unused', course: '', count: 1, used: 0, big: 0 }), '已选中还没出过题的 1 份资料。');
  assert.equal(line({ code: 'unused', course: '数据库', count: 3, used: 2, big: 0 }), '已选中「数据库」里还没出过题的 3 份资料。 没选：已出过题的 2 份。');
  assert.equal(line({ code: 'unused', course: '数据库', count: 3, used: 2, big: 1 }), '已选中「数据库」里还没出过题的 3 份资料。 没选：已出过题的 2 份、太长的 1 份。 整本教材请在列表里按章节选。');
  assert.equal(line({ code: 'single', course: '数据库', count: 1, used: 0, big: 0 }), '这里只有这一份资料，已替你选中。');
  m.setUiLanguage('en');
  try {
    for (const reason of [{ code: 'unused', course: '数据库', count: 3, used: 2, big: 1 }, { code: 'unused', course: '', count: 1, used: 0, big: 0 }, { code: 'single', count: 1 }])
      assert.doesNotMatch(line(reason).replace('数据库', ''), han);
    assert.equal(line({ code: 'unused', course: 'DB', count: 1, used: 0, big: 0 }), 'Selected the 1 material in "DB" that has no questions yet.');
    assert.equal(line({ code: 'unused', course: 'DB', count: 3, used: 0, big: 0 }), 'Selected the 3 materials in "DB" that have no questions yet.');
    assert.equal(line({ code: 'unused', course: '', count: 3, used: 2, big: 1 }), 'Selected the 3 materials that have no questions yet. Left out: 2 with questions already, 1 too long. Pick a whole book by chapter in the list.');
    assert.equal(line({ code: 'single', count: 1 }), 'There is only this one material here, so it is selected for you.');
  } finally { m.setUiLanguage('zh'); }
});

test('the line holds only while the selection is the one it describes', () => {
  assert.equal(m.opening.openingStands({ sourceIds: ['a', 'b'] }, ['b', 'a']), true, 'order does not matter');
  assert.equal(m.opening.openingStands({ sourceIds: ['a', 'b'] }, ['a']), false, 'the learner unticked one');
  assert.equal(m.opening.openingStands({ sourceIds: ['a', 'b'] }, ['a', 'b', 'c']), false, 'or added one');
  assert.equal(m.opening.openingStands(null, ['a']), false);
  assert.equal(m.opening.openingStands({ sourceIds: [] }, []), false);
});
