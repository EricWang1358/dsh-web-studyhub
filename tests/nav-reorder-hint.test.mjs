import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* Issue 569: 「长按并拖动可调整顺序（键盘：Alt+↑/↓）」 closed every one of the sidebar's tooltips. It is now said once (ui/nav-reorder-hint.js), and
   kept where a learner looks for keys: the shortcut sheet, each row's aria-keyshortcuts, and 设置 › 引导. The hover itself is walked in a real
   browser by tests/nav-reorder-hint-browser.test.mjs. */
const m = await loadUi(`export * from './ui/nav-reorder-hint.js'; export * from './ui/guidance/registry.js';
  export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: (index) => [...map.keys()][index] ?? null, getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); }, removeItem: (key) => { map.delete(key); } };
}
const refusing = () => ({ get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });

test('one key remembers that the line was said; a blocked or damaged storage reads as "not yet" and never throws', () => {
  const local = memoryStorage();
  assert.equal(m.reorderHintTold(local), false);
  assert.equal(m.markReorderHintTold(local), true);
  assert.equal(local.getItem(m.NAV_REORDER_HINT_KEY), 'true');
  assert.equal(m.reorderHintTold(local), true);
  assert.equal(m.reorderHintTold(memoryStorage({ [m.NAV_REORDER_HINT_KEY]: '{oops' })), false);
  assert.equal(m.reorderHintTold(refusing()), false);
  assert.equal(m.markReorderHintTold(refusing()), false);
  assert.equal(m.reorderHintTold(null), false);
});

test('设置 › 引导 lists the line on the key the sidebar writes, and 再显示一次 forgets it', () => {
  const item = m.guidanceItem(m.NAV_REORDER_HINT_ID);
  assert.ok(item, 'registered');
  assert.deepEqual(m.entryProblems(item), []);
  assert.equal(item.memory.key, m.NAV_REORDER_HINT_KEY);
  assert.equal(item.proactive, false, 'part of a tooltip the learner opened: not a tip that appears by itself');
  const local = memoryStorage(), storages = { local, session: memoryStorage() };
  assert.equal(m.itemSeen(item, storages), false);
  m.markReorderHintTold(local);
  assert.equal(m.itemSeen(item, storages), true);
  assert.equal(m.clearItem(item, storages), true);
  assert.equal(m.reorderHintTold(local), false, 'so the next tooltip says it again');
});

test('the shortcut sheet lists the reorder keys, in both languages, on every page', () => {
  for (const page of ['library', 'review', 'book']) {
    m.setUiLanguage('zh');
    const zh = renderToStaticMarkup(React.createElement(m.ShortcutHelp, { page, onClose() {} }));
    assert.match(zh, /<kbd>Alt\+↑<\/kbd><kbd>Alt\+↓<\/kbd>/, page);
    assert.ok(zh.includes('长按并拖动'), `${page}: the mouse way is said with the keys`);
    m.setUiLanguage('en');
    const en = renderToStaticMarkup(React.createElement(m.ShortcutHelp, { page, onClose() {} }));
    assert.match(en, /Sidebar: move the focused entry up \/ down/);
    assert.doesNotMatch(en, han);
  }
  m.setUiLanguage('zh');
});

test('the sidebar says the line only while the hint is due, names the keys on every row, and no longer repeats the label', async () => {
  const sidebar = await read('ui/app/AppSidebar.jsx');
  assert.match(sidebar, /tail=\{reorderHint\.show \? ui\('长按并拖动可调整顺序（键盘：Alt\+↑\/↓）'\) : undefined\}/);
  assert.match(sidebar, /onTipChange=\{reorderHint\.tipChange\}/);
  assert.match(sidebar, /if \(navOrder\.lifted \|\| navOrder\.announce\) learned\(\)/, 'a learner who has reordered is not told how');
  assert.doesNotMatch(sidebar, /title=\{label\}|title=\{ui\('设置'\)\}/, 'the label is not said again in its own tooltip');
  for (const row of [/<ResumeNavItem[^>]*narrow=\{sidebarNarrow\}/, /<CoachNavItem[^>]*narrow=\{sidebarNarrow\}/, /purpose=\{ui\(PAGES\[id\]\.purpose\)\} narrow=\{sidebarNarrow\}/, /label=\{ui\('设置'\)\}[^>]*narrow=\{sidebarNarrow\}/]) assert.match(sidebar, row, 'in the rail each row names itself');
  const order = await read('ui/nav-order.js');
  assert.match(order, /"aria-keyshortcuts": "Alt\+ArrowUp Alt\+ArrowDown"/, 'a screen reader hears the keys on each row');
  assert.match(order, /setAnnounce\(\{ id, position: index \+ 1/, 'the keyboard move is still announced');
});
