/* 复习全书 S1, 「⋯ 更多」 of the book bar (docs/review-book.md "More"): the menu's items for what the page has now (moreItems, pure), and the shared Menu's
   checkable item that 整章连着读 uses (a menuitemcheckbox with aria-checked and a check mark while on, reached by the same keys as the other items). Static
   markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { moreItems } from './ui/book/BookMore.jsx';
  export { Menu } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const ids = items => items.filter(item => !item.heading).map(item => item.id);
const headings = items => items.filter(item => item.heading).map(item => item.label);
const item = (items, id) => items.find(entry => entry.id === id);

test('更多: four groups; a fold item only where there are AI blocks, named by their state; 整章连着读 a check', () => {
  const plain = ui.moreItems({});
  assert.deepEqual(headings(plain), ['这个知识点', '阅读', '整本书', '期末一周']);
  assert.deepEqual(ids(plain), ['edit', 'create', 'code', 'scroll', 'flip', 'lookup', 'export', 'chat', 'mock'], 'no blocks, no plan, no settings: the plain items');
  assert.equal(item(plain, 'scroll').checked, false, '整章连着读 is a check, off');
  assert.equal(item(ui.moreItems({ scroll: true }), 'scroll').checked, true);
  assert.equal(item(plain, 'code').hint, undefined, '复制编号 says nothing more: a hint only where a rule is hidden');
  assert.equal(item(plain, 'chat').hint, '只填进输入框，不自动发送');
  const folds = ui.moreItems({ pointFold: { folded: false }, bookFold: { folded: true } });
  assert.equal(item(folds, 'fold-point').label, '收起这个知识点的 AI 段落');
  assert.equal(item(folds, 'fold-book').label, '展开全书的 AI 段落');
  assert.equal(item(ui.moreItems({ pointFold: { folded: true } }), 'fold-point').label, '展开这个知识点的 AI 段落');
  assert.equal(item(ui.moreItems({ bookFold: { folded: false } }), 'fold-book').label, '收起全书的 AI 段落');
});

test('更多: the export item names the pages (and the limit), the mock paper its scope, today only with a plan day', () => {
  assert.equal(item(ui.moreItems({}), 'export').hint, undefined, 'no estimate yet: no hint');
  assert.equal(item(ui.moreItems({ pages: 42 }), 'export').hint, '约 42 页');
  assert.equal(item(ui.moreItems({ pages: 42, pageLimit: 30 }), 'export').hint, '约 42 页 / 上限 30 页');
  assert.equal(item(ui.moreItems({}), 'mock').hint, '全书');
  assert.equal(item(ui.moreItems({ today: true, mockScope: 3 }), 'mock').hint, '今天的 3 个知识点');
  assert.equal(item(ui.moreItems({}), 'today'), undefined);
  assert.deepEqual(ids(ui.moreItems({ today: true })).slice(-2), ['today', 'mock']);
});

test('更多: the exam date item only without a date and with the course settings; a far date says when the final week starts', () => {
  assert.equal(item(ui.moreItems({ dateHint: { kind: 'none' } }), 'exam-date'), undefined, 'no way to the settings: no item');
  assert.equal(item(ui.moreItems({ dateHint: { kind: 'none' }, settings: true }), 'exam-date').hint, undefined, 'what the item is for is no hint');
  assert.equal(item(ui.moreItems({ dateHint: { kind: 'none' }, settings: true }), 'settings').hint, undefined);
  const later = ui.moreItems({ dateHint: { kind: 'later', window: 7 }, settings: true });
  assert.equal(item(later, 'exam-date'), undefined, 'a date: no 设置考试日期');
  assert.equal(item(later, 'settings').hint, '期末一周在考前 7 天开始');
  assert.equal(item(ui.moreItems({ settings: true }), 'settings').hint, undefined, 'inside the window: nothing to say');
});

test('更多 on 未归位: only 编辑这个知识点… in its group (no code the book tools match, no questions, no AI blocks of a point)', () => {
  const items = ui.moreItems({ unplaced: true, pointFold: { folded: false }, bookFold: { folded: false } });
  assert.deepEqual(ids(items).slice(0, 2), ['edit', 'scroll']);
  for (const id of ['create', 'code', 'fold-point']) assert.equal(item(items, id), undefined, `${id} is left out on 未归位`);
  assert.ok(item(items, 'fold-book'), 'the whole book\'s fold stays');
});

test('更多 in English: every item has its words', () => {
  ui.setUiLanguage('en');
  try {
    const items = ui.moreItems({ pointFold: { folded: false }, bookFold: { folded: false }, today: true, dateHint: { kind: 'none' }, settings: true, pages: 3 });
    for (const entry of items) assert.doesNotMatch(`${entry.label} ${entry.hint ?? ''}`, /[㐀-鿿]/, `${entry.id ?? entry.label} in English`);
  } finally { ui.setUiLanguage('zh'); }
});

test('Menu: a checked item is a menuitemcheckbox with aria-checked and a check mark while on; an unchecked one keeps the icon column; plain items stay menuitems', () => {
  const html = renderToStaticMarkup(h(ui.Menu, { label: 'More', defaultOpen: true, onSelect() {}, items: [
    { heading: true, label: 'Reading' }, { id: 'on', label: 'Whole chapters', checked: true }, { id: 'off', label: 'Flip', checked: false }, { id: 'plain', label: 'Lookup' }] }));
  const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g).filter(button => /role="menuitem/.test(button));
  assert.equal(buttons.length, 3);
  assert.match(buttons[0], /role="menuitemcheckbox"/);
  assert.match(buttons[0], /aria-checked="true"/);
  assert.match(buttons[0], /<svg/, 'a check mark while on');
  assert.match(buttons[1], /role="menuitemcheckbox"/);
  assert.match(buttons[1], /aria-checked="false"/);
  assert.doesNotMatch(buttons[1], /<svg/, 'no mark while off');
  assert.match(buttons[1], /sh-menu__gap/, 'its text lines up with the checked one');
  assert.match(buttons[2], /role="menuitem"/);
  assert.doesNotMatch(buttons[2], /aria-checked/);
  assert.match(buttons[2], /sh-menu__gap/);
  assert.match(html, /<p role="presentation" class="sh-menu__heading">Reading<\/p>/);
});
