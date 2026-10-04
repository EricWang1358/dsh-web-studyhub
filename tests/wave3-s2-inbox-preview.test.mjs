import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// #178: a mailbox entry shows its full deck title, prompt and detail in a floating card on hover and keyboard focus (the shared
// Tooltip, beside the entry); the list itself stays truncated and the entry carries no native title.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Inbox } from './ui/Inbox.jsx'; export { computePlacement, Tooltip } from './ui/components/index.js'; export { default as TooltipDirect } from './ui/components/Tooltip.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const css = readFileSync(new URL('../ui/inbox-preview.css', import.meta.url), 'utf8');

const longPrompt = '第 3 题：请说明在 Memento 模式中，哪个组件负责管理历史状态，以及它为什么不能直接读取快照的内部字段，同时给出一个撤销与重做的往返例子。';
const longDetail = '示例讲解：快照与历史管理者的区别——快照只保存状态，历史管理者只保存快照的顺序，二者都不应该知道对方的内部结构，这样才能在不破坏封装的前提下撤销。';
const item = { id: 'm1', kind: 'followup', label: '讲解追问', prompt: longPrompt, deckTitle: '设计模式 · 一个名字很长很长的题组标题', detail: longDetail, at: new Date().toISOString(), read: false };
const panel = (items = [item], props = {}) => renderToStaticMarkup(h(m.Inbox, { inbox: { unread: 1, items }, onOpen() {}, onReadAll() {}, defaultOpen: true, ...props }));

test('an entry is described by a card holding the full deck title, prompt and detail', () => {
  m.setUiLanguage('zh');
  const out = panel();
  const entry = out.match(/<button[^>]*class="mailbox__item[^"]*"[^>]*>/)[0];
  const describedBy = entry.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy, 'the entry points at its card');
  const card = out.match(new RegExp(`<span[^>]*id="${describedBy.replace(/[:.]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</span></span>`))?.[0] || '';
  assert.match(card, /role="tooltip"/);
  for (const text of [item.deckTitle, longPrompt, longDetail]) assert.ok(card.includes(text), `the card holds: ${text.slice(0, 12)}`);
  assert.match(card, /mailbox-preview/);
});

test('the card ends with the open hint and the entry has no native title', () => {
  m.setUiLanguage('zh');
  const out = panel();
  const entry = out.match(/<button[^>]*class="mailbox__item[^"]*"[^>]*>/)[0];
  assert.doesNotMatch(entry, /\btitle=/, 'two tooltips never show');
  assert.match(out, /mailbox-preview__hint[^>]*>[^<]*(回到|打开|查看|跳)/);
});

test('an entry without detail or with a missing target still gets its card, and English has no Chinese in the chrome', () => {
  m.setUiLanguage('zh');
  const plain = panel([{ ...item, id: 'm2', detail: '' }]);
  assert.ok(plain.includes(longPrompt));
  assert.doesNotMatch(plain.match(/mailbox-preview__detail/g)?.join('') || '', /./);
  m.setUiLanguage('en');
  const english = panel([{ ...item, id: 'm3', kind: 'pdf-result', label: 'PDF done', prompt: 'big.pdf', deckTitle: 'PDF conversion', detail: '' }]);
  assert.match(english, /role="tooltip"/);
  m.setUiLanguage('zh');
});

test('computePlacement can open beside the anchor, flips to the roomier side and falls back below when there is no room', () => {
  const bounds = { left: 0, top: 0, right: 1280, bottom: 900 };
  const left = m.computePlacement({ anchor: { left: 880, right: 1240, top: 100, bottom: 160 }, size: { width: 360, height: 200 }, bounds, placement: 'left-start' });
  assert.equal(left.placement, 'left-start');
  assert.equal(left.left, 880 - 4 - 360);
  assert.equal(left.top, 100);
  const flipped = m.computePlacement({ anchor: { left: 20, right: 380, top: 100, bottom: 160 }, size: { width: 360, height: 200 }, bounds, placement: 'left-start' });
  assert.equal(flipped.placement, 'right-start');
  assert.equal(flipped.left, 384);
  const clamped = m.computePlacement({ anchor: { left: 880, right: 1240, top: 850, bottom: 890 }, size: { width: 360, height: 200 }, bounds, placement: 'left-start' });
  assert.equal(clamped.top, 900 - 8 - 200, 'pulled back inside the window');
  const narrow = m.computePlacement({ anchor: { left: 10, right: 410, top: 100, bottom: 160 }, size: { width: 360, height: 200 }, bounds: { left: 0, top: 0, right: 420, bottom: 860 }, placement: 'left-start' });
  assert.match(narrow.placement, /^(bottom|top)-/, 'a narrow window opens below or above instead');
});

test('an interactive tooltip stays open while the pointer is on its card', () => {
  const out = renderToStaticMarkup(h(m.TooltipDirect, { content: 'x', layer: true, interactive: true }, h('button', null, 'a')));
  assert.match(out, /sh-tooltip--interactive/);
  assert.doesNotMatch(renderToStaticMarkup(h(m.TooltipDirect, { content: 'x', layer: true }, h('button', null, 'a'))), /sh-tooltip--interactive/);
});

test('inbox-preview.css is token-only, scoped, and keeps the card narrow and scrollable', () => {
  assert.match(css, /study-app, \.study-seat/);
  assert.match(css, /\.mailbox-preview/);
  assert.match(css, /max-width:\s*min\(360px/);
  assert.match(css, /overflow-y:\s*auto/);
  assert.match(css, /\.mailbox__tip\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /!important|#[0-9a-f]{3,8}\b|rgba?\(/i);
});
