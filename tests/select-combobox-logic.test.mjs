import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const { flattenOptions, selectableOptions, matchRanges, highlightParts, optionMatches, filterEntries, listRows, resolveActions, findOption, isGroup, courseEntries, setUiLanguage } = await loadUi(
  `export * from './ui/components/option-list.js'; export { courseEntries } from './ui/course-picker-entries.js'; export { setUiLanguage } from './ui/i18n.js';`);

// WP-4: the data side of Select and Combobox is plain functions: filtering, highlight ranges, the course/chapter tree, footer actions.

const course = (value, extra = {}) => ({ value, label: value, ...extra });
const tree = [
  course('MA1522 线性代数', { level: 1, hint: '4 章' }),
  course('第 1 章 行列式', { level: 2 }), course('第 2 章 矩阵', { level: 2 }), course('第 3 章 向量空间', { level: 2 }),
  course('CS2040S 数据结构'), course('ST2131 概率论'),
];
const values = (entries) => flattenOptions(entries).map((option) => option.value);

test('matchRanges finds every occurrence of every word, case-insensitively, merged', () => {
  assert.deepEqual(matchRanges('第 4 章 特征值与特征向量', '特征'), [[6, 8], [10, 12]]);
  assert.deepEqual(matchRanges('MA1522 Linear', 'ma linear'), [[0, 2], [7, 13]]);
  assert.deepEqual(matchRanges('abcabc', 'abc bc'), [[0, 6]], 'overlapping and touching matches merge into one');
  assert.deepEqual(matchRanges('abc', ''), []);
  assert.deepEqual(matchRanges('abc', '   '), []);
  assert.deepEqual(matchRanges('abc', 'z'), []);
});

test('highlightParts cuts a label along the matches and keeps all of the text', () => {
  const parts = highlightParts('期末 · 特征分解专项', '特征');
  assert.deepEqual(parts, [{ text: '期末 · ', match: false }, { text: '特征', match: true }, { text: '分解专项', match: false }]);
  assert.equal(parts.map((part) => part.text).join(''), '期末 · 特征分解专项');
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightParts(undefined, 'a'), [{ text: '', match: false }]);
});

test('an option matches when every word is in its label, hint or keywords', () => {
  const option = { label: '第 2 章 矩阵', hint: 'MA1522', keywords: ['matrix'] };
  assert.equal(optionMatches(option, ''), true);
  assert.equal(optionMatches(option, '矩阵'), true);
  assert.equal(optionMatches(option, 'ma1522 矩阵'), true, 'the hint is searchable');
  assert.equal(optionMatches(option, 'MATRIX'), true, 'so are keywords');
  assert.equal(optionMatches(option, '矩阵 向量'), false, 'all words must match');
});

test('filtering keeps the tree: a matching chapter shows its course, a matching course keeps all its chapters', () => {
  assert.deepEqual(values(filterEntries(tree, '矩阵')), ['MA1522 线性代数', '第 2 章 矩阵']);
  assert.deepEqual(values(filterEntries(tree, 'MA1522')), ['MA1522 线性代数', '第 1 章 行列式', '第 2 章 矩阵', '第 3 章 向量空间']);
  assert.deepEqual(values(filterEntries(tree, 'cs2040')), ['CS2040S 数据结构']);
  assert.deepEqual(values(filterEntries(tree, '量子')), []);
  assert.equal(filterEntries(tree, ''), tree, 'an empty query returns the list untouched');
});

test('a course kept only to place a matching chapter is context, not a choice (Enter picks the chapter that was typed)', () => {
  const shown = filterEntries(tree, '矩阵');
  assert.deepEqual(flattenOptions(shown).map((option) => [option.value, !!option.context]), [['MA1522 线性代数', true], ['第 2 章 矩阵', false]]);
  assert.deepEqual(selectableOptions(shown).map((option) => option.value), ['第 2 章 矩阵']);
  assert.deepEqual(listRows(shown).map((row) => [row.type, row.index]), [['context', undefined], ['option', 0]]);
  const whole = filterEntries(tree, 'MA1522');
  assert.equal(whole.some((option) => option.context), false, 'a course that matches itself is a choice, with all its chapters');
});

test('a deeper tree: a level-3 match pulls in both ancestors, not its siblings', () => {
  const deep = [course('A', { level: 1 }), course('A1', { level: 2 }), course('A1a', { level: 3 }), course('A1b', { level: 3 }), course('A2', { level: 2 }), course('B')];
  assert.deepEqual(values(filterEntries(deep, 'a1a')), ['A', 'A1', 'A1a']);
  assert.deepEqual(values(filterEntries(deep, 'a1')), ['A', 'A1', 'A1a', 'A1b']);
});

test('groups: empty groups vanish, a matching heading keeps its whole group, options keep their group heading', () => {
  const entries = [
    { group: '当前', options: [course('MA1522')] },
    { group: '最近使用', options: [course('CS2040S'), course('ST2131')] },
    { group: '全部', options: [course('PC1101'), course('GEA1000')] },
  ];
  assert.deepEqual(filterEntries(entries, 'st2131').map((entry) => entry.group), ['最近使用']);
  assert.deepEqual(values(filterEntries(entries, 'st2131')), ['ST2131']);
  assert.deepEqual(values(filterEntries(entries, '全部')), ['PC1101', 'GEA1000']);
  const flat = flattenOptions(entries);
  assert.equal(flat[0].group, '当前');
  assert.equal(flat.at(-1).group, '全部');
  assert.equal(isGroup(entries[0]), true);
  assert.equal(isGroup(entries[0].options[0]), false);
});

test('listRows numbers the options only, with headings between, and carries the level', () => {
  const rows = listRows([{ group: 'G', options: [course('a'), course('b', { level: 2 })] }, course('c')]);
  assert.deepEqual(rows.map((row) => row.type), ['group', 'option', 'option', 'option']);
  assert.deepEqual(rows.filter((row) => row.type === 'option').map((row) => [row.option.value, row.index, row.level]), [['a', 0, 1], ['b', 1, 2], ['c', 2, 1]]);
});

test('footer actions: shown by `when`, label a function of the typed text, never part of the options', () => {
  const calls = [];
  const actions = [
    { id: 'settings', label: '课程设置…', icon: 'settings', onSelect: (query) => calls.push(['settings', query]) },
    { id: 'create', label: (query) => `新建题组「${query}」`, icon: 'plus', when: (query) => !!query, onSelect: (query) => calls.push(['create', query]) },
  ];
  assert.deepEqual(resolveActions(actions, '').map((action) => action.id), ['settings']);
  const typed = resolveActions(actions, '  特征  ');
  assert.deepEqual(typed.map((action) => action.label), ['课程设置…', '新建题组「特征」'], 'the typed text is trimmed');
  typed[1].onSelect('特征');
  assert.deepEqual(calls, [['create', '特征']]);
  assert.deepEqual(resolveActions(undefined, 'x'), []);
});

test('findOption looks through groups and distinguishes "" from a missing value', () => {
  const entries = [{ group: 'G', options: [{ value: '', label: '暂不关联' }, { value: 'a', label: 'A' }] }];
  assert.equal(findOption(entries, '').label, '暂不关联');
  assert.equal(findOption(entries, 'a').group, 'G');
  assert.equal(findOption(entries, 'zzz'), undefined);
});

test('courseEntries: ranked tree with chapters at level 2, parked courses in a group of their own, last', () => {
  setUiLanguage('zh');
  const courses = [
    { name: 'ST2131 概率论' }, { name: 'MA1522 线性代数' }, { name: 'MA1522 线性代数 / 第 2 章 矩阵' }, { name: 'MA1522 线性代数 / 第 1 章 行列式' },
    { name: 'PC1101', active: false }, { name: '' },
  ];
  const entries = courseEntries({ courses, current: 'MA1522 线性代数' });
  const flat = flattenOptions(entries);
  assert.equal(flat[0].value, 'MA1522 线性代数', 'the current course leads');
  assert.deepEqual(flat.slice(0, 3).map((option) => [option.label, option.level ?? 1]), [['MA1522 线性代数', 1], ['第 1 章 行列式', 2], ['第 2 章 矩阵', 2]]);
  assert.equal(flat[1].value, 'MA1522 线性代数 / 第 1 章 行列式', 'a chapter keeps its full course name as the value');
  assert.match(flat[0].hint, /2/);
  assert.equal(flat.some((option) => option.value === ''), false, 'an unnamed course is not offered (the shared grouping skips it, as the old picker did)');
  const last = entries.at(-1);
  assert.equal(isGroup(last), true);
  assert.match(last.group, /1/);
  assert.deepEqual(last.options.map((option) => option.value), ['PC1101']);
  assert.equal(entries.filter(isGroup).length, 1);
});
