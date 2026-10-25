/* 复习全书 structure on the page (#470, docs/review-book.md "Structure"): the three items of 更多 beside 编辑这个知识点… (moreItems, pure), and where a
   chapter or point sits and can go (ui/book/book-structure.js: nodeAt, moveTargets, shiftPlace), which is what 改名 / 移动到… send to
   course.book.rename / move. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { moreItems } from './ui/book/BookMore.jsx';
  export { moveTargets, nodeAt, shiftPlace, structureFailureText } from './ui/book/book-structure.js';
  export { setUiLanguage } from './ui/i18n.js';`);

const CJK = /[\u3400-\u9fff]/;
const ids = items => items.filter(item => !item.heading).map(item => item.id);
const item = (items, id) => items.find(entry => entry.id === id);
const point = (hid, number, title) => ({ hid, number, title, leaf: true, children: [] });
const book = { nodes: [
  { hid: 'h1', number: '1', title: 'Introduction', leaf: false, children: [point('h2', '1.1', 'What architects do'), point('h3', '1.2', 'Stakeholders and concerns')] },
  { hid: 'h4', number: '2', title: 'Requirements', leaf: false, children: [point('h5', '2.1', 'Functional requirements')] },
] };

test('更多: 改名… / 移动到… / 删除这个知识点… stand right after 编辑这个知识点…, and 未归位 has none of them', () => {
  const items = ui.moreItems({});
  assert.deepEqual(ids(items).slice(0, 4), ['edit', 'rename', 'move', 'delete']);
  assert.equal(item(items, 'rename').label, '改名…');
  assert.equal(item(items, 'move').label, '移动到…');
  assert.equal(item(items, 'delete').label, '删除这个知识点…');
  assert.equal(item(items, 'rename').hint, undefined, 'no hint where no rule is hidden');
  const unplaced = ui.moreItems({ unplaced: true });
  for (const id of ['rename', 'move', 'delete']) assert.equal(item(unplaced, id), undefined, `${id} is left out on 未归位`);
});

test('nodeAt: where a node sits in course.book.open\'s tree (parent, siblings, index), null for none', () => {
  const found = ui.nodeAt(book.nodes, 'h3');
  assert.equal(found.node.title, 'Stakeholders and concerns');
  assert.equal(found.parent.hid, 'h1');
  assert.equal(found.index, 1);
  assert.deepEqual(found.siblings.map(node => node.hid), ['h2', 'h3']);
  assert.equal(ui.nodeAt(book.nodes, 'h1').parent, null);
  assert.equal(ui.nodeAt(book.nodes, 'nope'), null);
});

test('moveTargets: the top level and every chapter or section but the node and what is below it', () => {
  assert.deepEqual(ui.moveTargets(book, 'h3').map(option => option.value), ['book', 'h1', 'h4']);
  assert.deepEqual(ui.moveTargets(book, 'h1').map(option => option.value), ['h4'], 'a top-level chapter: the top level again and its own points are no targets');
  assert.deepEqual(ui.moveTargets(book, 'h3').map(option => option.label), ['书的顶层', '1 Introduction', '2 Requirements']);
  assert.deepEqual(ui.moveTargets(book, 'missing'), []);
});

test('shiftPlace: one sibling up or down as beforeHid / afterHid, null at either end', () => {
  assert.equal(ui.shiftPlace(book, 'h2', -1), null, 'the first has nothing above it');
  assert.deepEqual(ui.shiftPlace(book, 'h2', 1), { afterHid: 'h3' });
  assert.deepEqual(ui.shiftPlace(book, 'h3', -1), { beforeHid: 'h2' });
  assert.equal(ui.shiftPlace(book, 'h3', 1), null, 'the last has nothing below it');
  assert.equal(ui.shiftPlace(book, 'h5', -1), null, 'an only child cannot move among siblings');
  assert.equal(ui.shiftPlace(book, 'missing', 1), null);
});

test('a stale structure version is said short (and read again); any other refusal has no short line of its own', () => {
  assert.match(ui.structureFailureText({ code: 'course-book-conflict' }), /这本书的结构刚被改过/);
  assert.equal(ui.structureFailureText({ code: 'course-book-node-missing' }), null);
  assert.equal(ui.structureFailureText(null), null);
});

test('更多 and the move targets in English: every word they show is translated', () => {
  ui.setUiLanguage('en');
  try {
    const items = ui.moreItems({});
    for (const id of ['rename', 'move', 'delete']) assert.doesNotMatch(item(items, id).label, CJK, `${id} in English`);
    for (const option of ui.moveTargets(book, 'h3')) assert.doesNotMatch(`${option.value} ${option.label}`, CJK, `${option.value} in English`);
    assert.doesNotMatch(ui.structureFailureText({ code: 'course-book-conflict' }), CJK);
  } finally { ui.setUiLanguage('zh'); }
});
