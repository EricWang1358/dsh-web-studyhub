/* The reader's automatic outline as a tree: repeated generic sub-labels (英文原句 / 中文对照, Original / Translation,
   Question / Answer) are children of their part, not top-level entries. Pure logic; the panel is checked in outline-ui. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHeadings, structureOutline, defaultExpanded, outlineRows, filterOutline, sectionOf, sectionNeighbours, outlinePath } from '../ui/document-preview/reader/outline.js';
import { bilingualMarkdown, headingNodes, PART_TITLES } from './helpers/bilingual-transcript.mjs';

const entries = markdown => collectHeadings({ querySelectorAll: () => headingNodes(markdown) });
const item = (id, level, title) => ({ id, level, title });

test('the bilingual transcript: 英文原句 and 中文对照 under every part are minor children, the parts stay', () => {
  const tree = structureOutline(entries(bilingualMarkdown()));
  assert.equal(tree.length, 28, 'nothing is dropped from the outline');
  const minor = tree.filter(entry => entry.minor);
  assert.equal(minor.length, 18);
  assert.deepEqual([...new Set(minor.map(entry => entry.title))].sort(), ['中文对照', '英文原句']);
  const parts = tree.filter(entry => entry.title.startsWith('第'));
  assert.equal(parts.length, 9);
  assert.ok(parts.every(part => !part.minor && part.depth === 1 && part.parent === 'h-0'));
  assert.equal(tree[0].parent, null);
  assert.ok(minor.every(entry => entry.depth === 2 && tree.find(candidate => candidate.id === entry.parent).title.startsWith('第')));
  assert.equal(tree.find(entry => entry.title.startsWith('第二部分')).minorCount, 2);
});

test('collapsed by default: the title and the nine parts, one more level only where the reader is', () => {
  const tree = structureOutline(entries(bilingualMarkdown()));
  assert.deepEqual(outlineRows(tree, defaultExpanded(tree, 'h-0')).map(row => row.title), ['平台经济课堂实录', ...PART_TITLES.map(([zh], index) => `第${'一二三四五六七八九'[index]}部分：${zh}`)]);
  const inThird = tree.filter(entry => entry.parent === tree.find(part => part.title.startsWith('第三')).id);
  const rows = outlineRows(tree, defaultExpanded(tree, inThird[1].id));
  assert.equal(rows.length, 12, 'the labels of the current part show, the others stay folded');
  assert.deepEqual(rows.filter(row => row.minor).map(row => row.title), ['英文原句', '中文对照']);
});

test('a document without a title: the parts are the top level and the labels still fold under them', () => {
  const tree = structureOutline(entries(bilingualMarkdown({ title: '' })));
  assert.equal(tree.length, 27);
  assert.equal(tree.filter(entry => entry.minor).length, 18);
  assert.ok(tree.filter(entry => !entry.minor).every(entry => entry.parent === null && entry.depth === 0));
  assert.equal(outlineRows(tree, defaultExpanded(tree, tree[0].id)).filter(row => row.minor).length, 2, 'the first part is current, so its labels show');
});

test('Original / Translation and Question / Answer also fold; numbered labels count as the same label', () => {
  const pairs = ['Original', 'Translation'], flat = [];
  for (let n = 1; n <= 4; n += 1) flat.push(item(`s${n}`, 1, `Section ${n}`), item(`o${n}`, 2, pairs[0]), item(`t${n}`, 2, pairs[1]));
  const tree = structureOutline(flat);
  assert.deepEqual(tree.filter(entry => entry.minor).map(entry => entry.id), ['o1', 't1', 'o2', 't2', 'o3', 't3', 'o4', 't4']);
  const questions = structureOutline([1, 2, 3].flatMap(n => [item(`c${n}`, 1, `Chapter ${n}`), item(`q${n}`, 2, `Question ${n}`), item(`a${n}`, 2, `Answer ${n}`)]));
  assert.equal(questions.filter(entry => entry.minor).length, 6);
});

test('only a label that repeats under three or more parents folds; distinct headings and siblings never do', () => {
  assert.equal(structureOutline([1, 2, 3, 4].map(n => item(`p${n}`, 1, `Part ${n}`))).filter(entry => entry.minor).length, 0, 'Part 1, Part 2, … are siblings');
  const sameParent = structureOutline([item('a', 1, 'Chapter'), ...[1, 2, 3, 4].map(n => item(`e${n}`, 2, 'Example'))]);
  assert.equal(sameParent.filter(entry => entry.minor).length, 0, 'four Examples under one parent are real content');
  const twice = structureOutline([1, 2].flatMap(n => [item(`c${n}`, 1, `Chapter ${n}`), item(`x${n}`, 2, 'Summary')]));
  assert.equal(twice.filter(entry => entry.minor).length, 0, 'twice is not a pattern');
  const topLevel = structureOutline([1, 2, 3].map(n => item(`s${n}`, 1, '小结')));
  assert.equal(topLevel.filter(entry => entry.minor).length, 0, 'a repeated top-level heading has no parent to fold under');
  const withChildren = structureOutline([1, 2, 3].flatMap(n => [item(`c${n}`, 1, `Chapter ${n}`), item(`e${n}`, 2, 'Exercises'), item(`d${n}`, 3, `Case study number ${n} in detail`)]));
  assert.equal(withChildren.filter(entry => entry.minor).length, 0, 'a heading with sub-headings of its own is structure');
  const long = structureOutline([1, 2, 3].flatMap(n => [item(`c${n}`, 1, `Chapter ${n}`), item(`l${n}`, 2, '这是一条相当长的小节标题而不是一个通用的小标签它重复出现')]));
  assert.equal(long.filter(entry => entry.minor).length, 0, 'a long title is not a generic label');
  const pages = structureOutline([1, 2, 3, 4].map(n => ({ id: `page-${n}`, level: 1, title: '', page: n })));
  assert.equal(pages.filter(entry => entry.minor).length, 0);
  assert.deepEqual(structureOutline([]), []);
});

test('depth follows nesting, not the heading number: a level that skips still nests under the nearest parent', () => {
  const tree = structureOutline([item('a', 1, 'A'), item('b', 3, 'B'), item('c', 2, 'C'), item('d', 1, 'D')]);
  assert.deepEqual(tree.map(entry => [entry.id, entry.parent, entry.depth]), [['a', null, 0], ['b', 'a', 1], ['c', 'a', 1], ['d', null, 0]]);
  assert.equal(tree[0].children, 2);
});

test('few-entry outlines open fully; a long one opens only the top level and the path to the current entry', () => {
  const small = structureOutline([item('a', 1, 'A'), item('b', 2, 'B'), item('c', 2, 'C'), item('d', 1, 'D')]);
  assert.equal(outlineRows(small, defaultExpanded(small, 'a')).length, 4);
  const big = structureOutline(Array.from({ length: 40 }, (_, n) => [item(`g${n}`, 1, `Group ${n}`), item(`m${n}`, 2, `Subject ${n} basics`), item(`k${n}`, 2, `Subject ${n} advanced`)]).flat());
  assert.equal(big.length, 120);
  const rows = outlineRows(big, defaultExpanded(big, 'k7'));
  assert.equal(rows.length, 42, 'forty groups plus the two topics of the current group');
  assert.ok(rows.some(row => row.id === 'k7'));
});

test('the filter lists matching entries flat, each with the parts above it, folding case and width', () => {
  const tree = structureOutline(entries(bilingualMarkdown()));
  const hits = filterOutline(tree, '对照');
  assert.equal(hits.length, 9);
  assert.deepEqual(hits[2].trail, ['平台经济课堂实录', '第三部分：双边市场与网络效应']);
  assert.equal(filterOutline(tree, 'ＰＬＡＴＦＯＲＭ').length, 0, 'the titles are Chinese; the English bracket lines are not headings');
  assert.deepEqual(filterOutline(tree, '定价').map(hit => hit.title), ['第四部分：定价与补贴策略']);
  assert.equal(filterOutline(tree, '   ').length, tree.length, 'a blank query is no filter');
  assert.deepEqual(filterOutline(tree, '不存在的标题'), []);
});

test('previous and next walk the sections, not the labels; a label belongs to its part', () => {
  const tree = structureOutline(entries(bilingualMarkdown()));
  const third = tree.find(entry => entry.title.startsWith('第三')), label = tree.find(entry => entry.parent === third.id && entry.title === '中文对照');
  assert.equal(sectionOf(tree, label.id), third.id);
  assert.equal(sectionOf(tree, third.id), third.id);
  assert.equal(sectionOf(tree, 'unknown'), null);
  const around = sectionNeighbours(tree, label.id);
  assert.match(around.previous.title, /^第二部分/);
  assert.match(around.next.title, /^第四部分/);
  assert.equal(sectionNeighbours(tree, tree[0].id).previous, null);
  assert.deepEqual(outlinePath(tree, label.id), ['第三部分：双边市场与网络效应', '中文对照'], 'the toolbar says where a label is: its part first');
  assert.deepEqual(outlinePath(tree, third.id), ['第三部分：双边市场与网络效应']);
});
