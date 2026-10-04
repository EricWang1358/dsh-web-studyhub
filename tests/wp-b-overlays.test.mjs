import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 1, WP-B: one confirmation, popover, menu, tooltip and close control
// for every overlay (issues #68 #69 #70 #71 #72 #78 #80 #82 #83 #85 #86 #90).
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js';
  export { computePlacement } from './ui/components/use-dismiss.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const han = /[㐀-鿿]/;
const read = file => readFileSync(file, 'utf8');

test('ConfirmDialog puts a quiet cancel first and the confirm last, danger by default', () => {
  m.setUiLanguage('zh');
  const out = html(m.ConfirmDialog, { title: '删除这张卡片？', description: '删除后可撤销。', confirmLabel: '确认删除', onConfirm() {}, onClose() {} }, h('p', null, '读论文'));
  assert.match(out, /<dialog[^>]*sh-dialog--sm/);
  const footer = out.match(/<footer[^>]*>(.*)<\/footer>/s)[1];
  const buttons = [...footer.matchAll(/<button[^>]*>/g)].map(match => match[0]);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], /sh-btn--quiet/);
  assert.match(footer, /取消/);
  assert.match(buttons[1], /sh-btn--danger/);
  assert.ok(footer.indexOf('取消') < footer.indexOf('确认删除'), 'cancel before confirm');
  assert.match(out, /读论文/);
  assert.match(out, /删除后可撤销/);
  const primary = html(m.ConfirmDialog, { title: 't', tone: 'primary', confirmLabel: '继续', cancelLabel: '继续作答', onConfirm() {}, onClose() {} });
  assert.match(primary, /sh-btn--primary[^>]*>[^<]*继续/);
  assert.match(primary, /继续作答/);
});

test('ConfirmDialog is busy and non-dismissible while working, and blocked disables only the confirm', () => {
  const busy = html(m.ConfirmDialog, { title: 't', confirmLabel: '删除', busy: true, onConfirm() {}, onClose() {} });
  assert.match(busy, /<dialog[^>]*aria-busy="true"/);
  assert.match(busy, /sh-dialog__close[^>]*aria-disabled="true"|aria-disabled="true"[^>]*sh-dialog__close/);
  const blocked = html(m.ConfirmDialog, { title: 't', confirmLabel: '删除', blocked: true, onConfirm() {}, onClose() {} });
  const footer = blocked.match(/<footer[^>]*>(.*)<\/footer>/s)[1];
  const [cancel, confirm] = [...footer.matchAll(/<button[^>]*>/g)].map(match => match[0]);
  assert.doesNotMatch(cancel, /disabled/);
  assert.match(confirm, /disabled=""/);
});

test('Dialog busy implies non-dismissible: aria-busy, a disabled-looking close button that stays focusable', () => {
  const idle = html(m.Dialog, { title: '设置', onClose() {} });
  assert.doesNotMatch(idle, /aria-busy/);
  assert.doesNotMatch(idle, /aria-disabled/);
  const busy = html(m.Dialog, { title: '设置', busy: true, onClose() {} });
  const open = busy.match(/<dialog[^>]*>/)[0];
  assert.match(open, /aria-busy="true"/);
  const close = busy.match(/<button[^>]*sh-dialog__close[^>]*>/)[0];
  assert.match(close, /aria-disabled="true"/);
  assert.doesNotMatch(close, /\sdisabled=/, 'aria-disabled keeps it in the tab order and announced');
  assert.match(html(m.Dialog, { title: '设置', dismissible: false, onClose() {} }), /^(?!.*sh-dialog__close)/s, 'dismissible=false still hides the button');
});

test('InlineConfirm is a labelled group (never an alertdialog) with the same button order as ConfirmDialog', () => {
  m.setUiLanguage('zh');
  const out = html(m.InlineConfirm, { tone: 'danger', title: '删除这个工作流？', confirmLabel: '确认删除', onConfirm() {}, onCancel() {} }, '这个操作可以撤销。');
  assert.match(out, /role="group"/);
  assert.doesNotMatch(out, /alertdialog/);
  const id = out.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(out, new RegExp(`id="${id}"[^>]*>删除这个工作流？`));
  assert.match(out, /sh-inline--boxed/);
  assert.match(out, /这个操作可以撤销/);
  assert.ok(out.indexOf('取消') > 0 && out.indexOf('取消') < out.indexOf('确认删除'), 'cancel first, confirm last');
  assert.match(out, /sh-btn--quiet[^>]*>取消/);
  assert.match(out, /sh-btn--danger[^>]*>[^<]*确认删除/);
  const busy = html(m.InlineConfirm, { title: 't', confirmLabel: '确认', busy: true, onConfirm() {}, onCancel() {} });
  assert.match(busy, /aria-busy="true"/);
});

test('CloseButton is a small icon button named through ui()', () => {
  m.setUiLanguage('zh');
  const out = html(m.CloseButton, { onClick() {} });
  assert.match(out, /aria-label="关闭"/);
  assert.match(out, /sh-btn--sm/);
  assert.match(out, /sh-btn--icon/);
  assert.match(html(m.CloseButton, { label: '关闭快捷键' }), /aria-label="关闭快捷键"/);
  m.setUiLanguage('en');
  assert.match(html(m.CloseButton, {}), /aria-label="Close"/);
  m.setUiLanguage('zh');
});

test('Popover wires the trigger and a labelled non-modal dialog panel, never aria-pressed', () => {
  m.setUiLanguage('zh');
  const closed = html(m.Popover, { label: '显示设置', icon: 'type' }, h('p', null, '内容'));
  assert.match(closed, /aria-haspopup="dialog"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /aria-pressed/);
  assert.doesNotMatch(closed, /内容/, 'closed popovers render no panel');
  const open = html(m.Popover, { label: '显示设置', icon: 'type', defaultOpen: true }, h('p', null, '内容'));
  assert.match(open, /aria-expanded="true"/);
  const panelId = open.match(/aria-controls="([^"]+)"/)[1];
  const panel = open.match(/<div[^>]*>/g).find(tag => tag.includes(`id="${panelId}"`));
  assert.match(panel, /role="dialog"/);
  assert.match(panel, /sh-popover/);
  const labelId = panel.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(open, new RegExp(`id="${labelId}"[^>]*>显示设置`));
  assert.match(open, /内容/);
  assert.doesNotMatch(open, /aria-pressed/);
});

test('Popover accepts a text trigger through a render prop', () => {
  const out = html(m.Popover, { label: '更多', defaultOpen: true,
    trigger: ({ props, ref }) => h('button', { ...props, ref, type: 'button' }, '更多') }, '面板');
  assert.match(out, /<button[^>]*aria-haspopup="dialog"[^>]*>更多<\/button>/);
});

test('Menu keeps its API, uses sh-menu classes and needs no board icon set', () => {
  const items = [{ id: 'edit', label: '编辑', icon: 'plus' }, { heading: true, label: '移到' }, { id: 'delete', label: '删除', danger: true, hint: '不可恢复' },
    { id: 'off', label: '停用', disabled: true }];
  const out = html(m.Menu, { label: '更多操作', items, onSelect() {}, defaultOpen: true });
  assert.match(out, /aria-haspopup="menu"/);
  assert.match(out, /role="menu"[^>]*aria-label="更多操作"/);
  assert.match(out, /class="sh-menu"/);
  assert.match(out, /sh-menu__item is-danger/);
  assert.match(out, /sh-menu__heading[^>]*>移到/);
  assert.match(out, /sh-menu__hint[^>]*>不可恢复/);
  assert.match(out, /<button[^>]*role="menuitem"[^>]*disabled=""[^>]*>/);
  assert.doesNotMatch(out, /board-menu/);
  const text = html(m.Menu, { label: '整理与添加', items, onSelect() {}, trigger: ({ props, ref, open }) => h('button', { ...props, ref, type: 'button' }, `整理与添加${open ? '▲' : ''}`) });
  assert.match(text, /<button[^>]*aria-haspopup="menu"[^>]*>整理与添加<\/button>/);
  assert.doesNotMatch(read('ui/components/Menu.jsx'), /board\/icons|BIcon/);
});

test('the board uses the shared Menu itself: the icon names are the registry\'s, no wrapper (#145)', () => {
  assert.equal(existsSync('ui/board/Menu.jsx'), false);
  for (const file of ['ui/Board.jsx', 'ui/board/Card.jsx']) assert.match(read(file), /\bMenu\b[^;]*from ['"]\.{1,2}\/(components\/)?(index\.js|components\/index\.js)['"]/, file);
});

test('Tooltip describes its trigger through aria-describedby and works with focus as well as hover', () => {
  const out = html(m.Tooltip, { content: '本周三 14:00 截止' }, h('button', { type: 'button' }, '日期'));
  const id = out.match(/<button[^>]*aria-describedby="([^"]+)"/)[1];
  assert.match(out, new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*role="tooltip"|<[a-z]+[^>]*role="tooltip"[^>]*id="${id}"`));
  assert.match(out, /hidden=""/, 'closed tooltips stay in the DOM, hidden, so the description resolves');
  assert.match(out, /sh-popover/);
  assert.match(out, /本周三 14:00 截止/);
});

test('computePlacement flips to the roomier side, clamps into the bounds and limits the height', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 600 };
  const below = m.computePlacement({ anchor: { left: 880, right: 920, top: 40, bottom: 72 }, size: { width: 200, height: 120 }, bounds, placement: 'bottom-end' });
  assert.equal(below.placement, 'bottom-end');
  assert.equal(below.top, 76);
  assert.equal(below.left, 720);
  const flipped = m.computePlacement({ anchor: { left: 100, right: 140, top: 540, bottom: 572 }, size: { width: 200, height: 120 }, bounds, placement: 'bottom-end' });
  assert.equal(flipped.placement, 'top-end');
  assert.equal(flipped.top, 540 - 4 - 120);
  assert.equal(flipped.left, 8, 'clamped to the left margin');
  const noFlip = m.computePlacement({ anchor: { left: 100, right: 140, top: 540, bottom: 572 }, size: { width: 200, height: 120 }, bounds, placement: 'bottom-end', flip: false });
  assert.equal(noFlip.placement, 'bottom-end');
  assert.equal(noFlip.maxHeight, 600 - 8 - 576, 'the panel is limited to the room that is left');
  const right = m.computePlacement({ anchor: { left: 960, right: 990, top: 40, bottom: 72 }, size: { width: 300, height: 50 }, bounds, placement: 'bottom-start' });
  assert.equal(right.left, 1000 - 8 - 300);
});

test('an undo toast may leave on its own but a plain action toast may not', () => {
  assert.equal(m.shouldAutoDismiss({ tone: 'success', action: { label: '撤销', onClick() {} }, undo: true }), true);
  assert.equal(m.shouldAutoDismiss({ tone: 'success', action: { label: '撤销', onClick() {} } }), false);
  assert.equal(m.shouldAutoDismiss({ tone: 'success', undo: true, persistent: true }), false);
  assert.equal(m.shouldAutoDismiss({ tone: 'error', undo: true }), false);
});

test('the component stylesheet for overlays uses tokens, not raw values', () => {
  const css = read('ui/components/overlays.css');
  assert.match(css, /\.sh-popover\s*\{[^}]*var\(--shadow-md\)/s);
  assert.match(css, /\.sh-popover\s*\{[^}]*var\(--line-strong\)/s);
  assert.match(css, /\.sh-popover\s*\{[^}]*var\(--bg-raised\)/s);
  assert.match(css, /\.sh-menu\s*\{/);
  assert.match(css, /\.sh-menu__item\.is-danger/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no raw colours');
  assert.doesNotMatch(css, /font-size:\s*\d+px/, 'no px font sizes');
  assert.match(css, /prefers-reduced-motion/);
});

test('the overlay copy lives in its own locale file and has English for every key', () => {
  const copy = JSON.parse(read('ui/locales/en.overlays.json'));
  assert.ok(Object.keys(copy).length > 0);
  for (const [key, value] of Object.entries(copy)) { assert.match(key, han); assert.doesNotMatch(value, han, key); }
  m.setUiLanguage('en');
  assert.doesNotMatch(html(m.ConfirmDialog, { title: 'Delete?', confirmLabel: 'Delete', onConfirm() {}, onClose() {} }), han);
  assert.doesNotMatch(html(m.InlineConfirm, { title: 'Delete?', confirmLabel: 'Delete', onConfirm() {}, onCancel() {} }), han);
  m.setUiLanguage('zh');
});

test('Confirmations are documented in DESIGN.md', () => {
  const design = read('ui/DESIGN.md');
  assert.match(design, /^#+ Confirmations/m);
  assert.match(design, /ConfirmDialog/);
  assert.match(design, /InlineConfirm/);
});

test('index.js exports the new primitives', () => {
  for (const name of ['ConfirmDialog', 'InlineConfirm', 'Popover', 'Menu', 'Tooltip', 'CloseButton', 'useDismiss', 'useAnchoredPosition'])
    assert.ok(typeof m[name] === 'function' || typeof m[name]?.render === 'function', name);
});
