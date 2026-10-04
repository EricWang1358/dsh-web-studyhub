/* global window, document, getComputedStyle */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inboxView, notify } from '../lib/inbox.js';
import { launchChromium } from '../scripts/qa/browser.mjs';

// #181: the mailbox preview card holds the full text, at most one card is open at a time, and it sits outside the panel.
const longPrompt = `第 3 题：${'请说明在 Memento 模式中，哪个组件负责管理历史状态，以及它为什么不能直接读取快照的内部字段。'.repeat(3)}`;
const longDetail = `示例讲解：${'快照与历史管理者的区别——快照只保存状态，历史管理者只保存快照的顺序，二者都不应该知道对方的内部结构。'.repeat(4)}`;

test('the inbox view keeps the whole prompt and detail next to the clipped list text (#181)', () => {
  assert.ok(longPrompt.length > 90 && longDetail.length > 160);
  const state = { decks: [{ id: 'd', title: 'D', cards: [{ id: 'c', prompt: longPrompt }] }], inbox: [] };
  notify(state, { kind: 'followup', deckId: 'd', cardId: 'c', detail: longDetail });
  const [item] = inboxView(state).items;
  assert.ok(item.prompt.length <= 90 && item.prompt.endsWith('…'), 'the list line stays clipped');
  assert.ok(item.detail.length <= 160 && item.detail.endsWith('…'));
  assert.equal(item.promptFull, longPrompt);
  assert.equal(item.detailFull, longDetail);
  const short = { decks: [{ id: 'd', title: 'D', cards: [{ id: 'c', prompt: 'Short?' }] }], inbox: [] };
  notify(short, { kind: 'followup', deckId: 'd', cardId: 'c', detail: 'ok' });
  assert.equal(inboxView(short).items[0].promptFull, 'Short?');
});

test('a long improvement reason can still be reverted: the clipped list text is what is compared (#181)', () => {
  const reason = '补充提示：'.repeat(60);
  const state = { decks: [{ id: 'd', title: 'D', cards: [{ id: 'c', prompt: 'P?', revisions: [{ reason }] }] }], inbox: [] };
  notify(state, { kind: 'improve', deckId: 'd', cardId: 'c', detail: reason });
  assert.equal(inboxView(state).items[0].canRevert, true);
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Inbox } from './ui/Inbox.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);

test('the preview card shows the full text while the list line keeps the clipped one (#181)', () => {
  module.exports.setUiLanguage('zh');
  const item = { id: 'm1', kind: 'followup', label: '讲解追问', prompt: `${longPrompt.slice(0, 89)}…`, promptFull: longPrompt, detail: `${longDetail.slice(0, 159)}…`, detailFull: longDetail,
    deckTitle: '设计模式', at: new Date().toISOString(), read: false };
  const out = renderToStaticMarkup(React.createElement(module.exports.Inbox, { inbox: { unread: 1, items: [item] }, onOpen() {}, onReadAll() {}, defaultOpen: true }));
  const card = /<span[^>]*role="tooltip"[\s\S]*$/.exec(out)[0];
  assert.ok(card.includes(longPrompt), 'full prompt in the card');
  assert.ok(card.includes(longDetail), 'full detail in the card');
  assert.ok(out.includes(`${longPrompt.slice(0, 89)}…`), 'the list keeps the clipped line');
});

// Browser: two entries hovered in a row leave one card, and on a wide screen the card does not touch the panel.
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import Inbox from './ui/Inbox.jsx';
  import styleCss from './ui/styles.js';
  const sheet = document.createElement('style'); sheet.textContent = styleCss; document.head.append(sheet);
  const bar = document.createElement('style'); bar.textContent = '.mailbox { position: relative; }'; document.head.append(bar);
  const at = new Date().toISOString();
  const items = ['a', 'b', 'c'].map((id, i) => ({ id, kind: 'followup', label: '讲解追问', prompt: ${JSON.stringify(longPrompt.slice(0, 89))} + '…' + i, promptFull: ${JSON.stringify(longPrompt)},
    detail: 'detail', detailFull: ${JSON.stringify(longDetail)}, deckTitle: '题组 ' + id, at, read: false }));
  createRoot(document.getElementById('root')).render(<div className="study-app" style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}>
    <Inbox inbox={{ unread: 3, items }} onOpen={() => {}} onReadAll={() => {}} defaultOpen /></div>);
  window.harnessReady = true;` },
bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const script = bundle.outputFiles[0].text;
let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
after(() => browser?.close());

async function open(t, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: 'zh-CN' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => window.harnessReady);
  await page.locator('.mailbox__panel').waitFor();
  return page;
}
const openCards = page => page.evaluate(() => [...document.querySelectorAll('.mailbox-preview')].filter(card => card.matches(':popover-open')).length);

test('hovering one entry after another leaves exactly one card, at every moment (#181)', { skip: unavailable }, async t => {
  const page = await open(t);
  await page.evaluate(() => { window.maxCards = 0; const tick = () => { const n = [...document.querySelectorAll('.mailbox-preview')].filter(c => c.matches(':popover-open')).length; window.maxCards = Math.max(window.maxCards, n); window.requestAnimationFrame(tick); }; tick(); });
  const items = page.locator('.mailbox__item');
  await items.nth(0).hover();
  await page.waitForFunction(() => document.querySelectorAll('.mailbox-preview:popover-open').length === 1);
  await items.nth(1).hover();
  await page.waitForTimeout(60);
  assert.equal(await openCards(page), 0, 'the first card closes the moment the pointer enters the next entry, not after the leave delay');
  await page.waitForTimeout(640);
  await items.nth(2).hover();
  await page.waitForTimeout(700);
  assert.equal(await openCards(page), 1);
  assert.equal(await page.evaluate(() => window.maxCards), 1, 'never two cards at once');
  const owner = await page.evaluate(() => document.querySelector('.mailbox-preview:popover-open').closest('.mailbox__tip').querySelector('.mailbox__deck').textContent);
  assert.equal(owner, '题组 c');
});

test('on a wide screen the card sits outside the panel, level with its entry (#181)', { skip: unavailable }, async t => {
  const page = await open(t);
  const item = page.locator('.mailbox__item').nth(1);
  await item.hover();
  await page.waitForFunction(() => document.querySelectorAll('.mailbox-preview:popover-open').length === 1);
  const boxes = await page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    return { card: rect(document.querySelector('.mailbox-preview:popover-open')), panel: rect(document.querySelector('.mailbox__panel')), entry: rect(document.querySelectorAll('.mailbox__item')[1]) };
  });
  assert.ok(boxes.card.right <= boxes.panel.left, `card ${boxes.card.right} is left of the panel ${boxes.panel.left}`);
  assert.ok(boxes.card.top <= boxes.entry.bottom && boxes.card.bottom >= boxes.entry.top, 'level with the entry');
});

test('a card that is not open takes no room: nothing of it shows inside the panel (#181)', { skip: unavailable }, async t => {
  const page = await open(t);
  await page.locator('.mailbox__item').nth(0).hover();
  await page.waitForFunction(() => document.querySelectorAll('.mailbox-preview:popover-open').length === 1);
  const shown = await page.evaluate(() => [...document.querySelectorAll('.mailbox-preview')].filter(card => !card.matches(':popover-open')).map(card => getComputedStyle(card).display));
  assert.equal(shown.length, 2);
  assert.deepEqual(shown, ['none', 'none'], 'closed cards stay display:none');
});

test('the card scrolls inside itself when the text is very long (#181)', { skip: unavailable }, async t => {
  const page = await open(t);
  await page.locator('.mailbox__item').nth(0).hover();
  await page.waitForFunction(() => document.querySelectorAll('.mailbox-preview:popover-open').length === 1);
  const box = await page.evaluate(() => { const card = document.querySelector('.mailbox-preview:popover-open'); return { scroll: card.scrollHeight, client: card.clientHeight, overflow: getComputedStyle(card).overflowY }; });
  assert.equal(box.overflow, 'auto');
  assert.ok(box.scroll >= box.client);
});
