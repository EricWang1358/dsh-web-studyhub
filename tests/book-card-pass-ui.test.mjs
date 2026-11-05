/* 补术语卡 on the book page (#710 S6): one quiet item in 「⋯ 更多」 › 整本书, there only while some points have no cards, its Tooltip saying what it does and
   about how many calls it takes (call counts, never prices); the shared Menu shows an item's `tip` in a Tooltip tied to the item, not a title=. Static
   markup, fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { moreItems } from './ui/book/BookMore.jsx';
  export { Menu } from './ui/components/index.js';
  export { cardPassWords } from './ui/book/use-card-pass.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const item = (items, id) => items.find(entry => entry.id === id);
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };

test('更多 › 整本书: 补术语卡 only while points lack cards; its Tooltip says what it does and the calls, no price', () => {
  assert.equal(item(ui.moreItems({}), 'cards'), undefined, 'no estimate: no item');
  assert.equal(item(ui.moreItems({ cardPass: { points: 0, calls: 0 } }), 'cards'), undefined, 'every point has its cards: no item');
  const items = ui.moreItems({ cardPass: { points: 283, calls: 29 } }), cards = item(items, 'cards');
  assert.equal(cards.label, '补术语卡');
  assert.equal(cards.hint, undefined, 'quiet: no hint, the words are in the Tooltip');
  assert.match(cards.tip, /283 个知识点/);
  assert.match(cards.tip, /约 29 次模型调用/);
  assert.match(cards.tip, /不改/, 'it says the explanations stay as they are');
  assert.doesNotMatch(cards.tip, /[$¥￥元]|price|价格|费用/i, 'calls, never prices');
  const ids = items.filter(entry => !entry.heading).map(entry => entry.id);
  assert.ok(ids.indexOf('cards') > ids.indexOf('export') && ids.indexOf('cards') < ids.indexOf('chat'), 'in the 整本书 group');
  const en = english(() => item(ui.moreItems({ cardPass: { points: 3, calls: 1 } }), 'cards'));
  assert.doesNotMatch(`${en.label} ${en.tip}`, /[㐀-鿿]/, 'every word in English');
  assert.match(en.tip, /about 1 model call/);
});

test('the started and nothing-to-do words of 补术语卡', () => {
  assert.match(ui.cardPassWords({ status: 'running' }), /任务页/);
  assert.match(ui.cardPassWords({ status: 'running', alreadyRunning: true }), /已经/);
  assert.match(ui.cardPassWords({ status: 'nothing' }), /都有术语卡/);
  english(() => { for (const status of ['running', 'nothing']) assert.doesNotMatch(ui.cardPassWords({ status }), /[㐀-鿿]/); });
});

test('Menu: an item with a tip is described by a Tooltip (aria-describedby), never by title=', () => {
  const html = renderToStaticMarkup(h(ui.Menu, { label: 'More', defaultOpen: true, onSelect() {}, items: [{ id: 'cards', label: 'Add term cards', tip: 'About 3 model calls.' },
    { id: 'plain', label: 'Lookup' }] }));
  const menu = html.slice(html.indexOf('role="menu"'));
  const [tipped, plain] = menu.match(/<button[^>]*>[\s\S]*?<\/button>/g);
  const described = /aria-describedby="([^"]+)"/.exec(tipped)?.[1];
  assert.ok(described, 'the item names its description');
  assert.match(html, new RegExp(`id="${described.replace(/[:]/g, '\\:')}"[^>]*role="tooltip"[^>]*>About 3 model calls\\.<`));
  assert.doesNotMatch(plain, /aria-describedby/);
  assert.doesNotMatch(menu, /\btitle=/, 'no title= on the menu\'s text');
});

test('更多 › 整本书: with every card made but some confusable pairs not compared, the same item compares them, in its own words (pairs and calls, no price)', () => {
  const only = item(ui.moreItems({ cardPass: { points: 0, pairs: 12, calls: 2 } }), 'cards');
  assert.equal(only.label, '补易混概念对照');
  assert.match(only.tip, /12 组易混概念/);
  assert.match(only.tip, /约 2 次模型调用/);
  assert.match(only.tip, /不改/);
  assert.doesNotMatch(only.tip, /[$¥￥元]|price|价格|费用/i);
  const both = item(ui.moreItems({ cardPass: { points: 5, pairs: 3, calls: 2 } }), 'cards');
  assert.equal(both.label, '补术语卡', 'cards missing: it is still the card pass');
  assert.match(both.tip, /5 个知识点没有术语卡/);
  assert.match(both.tip, /3 组易混概念/);
  const quiet = item(ui.moreItems({ cardPass: { points: 5, pairs: 0, calls: 1 } }), 'cards');
  assert.doesNotMatch(quiet.tip, /易混/, 'nothing to compare yet: not mentioned');
  const en = english(() => [item(ui.moreItems({ cardPass: { points: 0, pairs: 12, calls: 2 } }), 'cards'), item(ui.moreItems({ cardPass: { points: 5, pairs: 3, calls: 2 } }), 'cards')]);
  for (const each of en) assert.doesNotMatch(`${each.label} ${each.tip}`, /[㐀-鿿]/, 'every word in English');
  assert.match(en[0].tip, /12 confusable pairs/);
});
