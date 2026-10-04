import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2 · WP-H: the Tabs and DisclosureToggle primitives (#144 #146).
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const items = [{ value: 'a', label: '甲', note: '第一' }, { value: 'b', label: '乙' }, { value: 'c', label: '丙', disabled: true }, { value: 'd', label: '丁' }];

test('Tabs is a labelled tablist with one tab stop and aria-controls on the selected tab', () => {
  m.setUiLanguage('zh');
  const out = html(m.Tabs, { id: 'demo', label: '创建方式', value: 'b', items, onChange() {} });
  assert.match(out, /role="tablist"[^>]*aria-label="创建方式"|aria-label="创建方式"[^>]*role="tablist"/);
  assert.equal((out.match(/role="tab"/g) || []).length, 4);
  assert.equal((out.match(/aria-selected="true"/g) || []).length, 1);
  assert.equal((out.match(/tabindex="0"/g) || []).length, 1, 'roving tab stop');
  assert.match(out, /<button[^>]*id="demo-tab-b"[^>]*>/);
  assert.match(out, /<button[^>]*aria-controls="demo-panel-b"[^>]*>/);
  assert.equal((out.match(/aria-controls=/g) || []).length, 1, 'only the selected tab points at a panel that exists');
  assert.match(out, /<button[^>]*aria-selected="false"[^>]*tabindex="-1"|<button[^>]*tabindex="-1"[^>]*aria-selected="false"/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>[^]*?丙/);
  assert.match(out, /第一/, 'a note renders inside its tab');
});

test('TabPanel points back at its tab and exists for the selected tab', () => {
  const tabs = html(m.Tabs, { id: 'demo', label: 'x', value: 'b', items, onChange() {} });
  const panel = html(m.TabPanel, { id: 'demo', value: 'b', selected: 'b' }, '内容');
  assert.match(panel, /role="tabpanel"/);
  assert.match(panel, /id="demo-panel-b"/);
  assert.match(panel, /aria-labelledby="demo-tab-b"/);
  assert.match(panel, /内容/);
  const [, controls] = tabs.match(/aria-controls="([^"]+)"/);
  assert.match(panel, new RegExp(`id="${controls}"`), 'aria-controls resolves to the rendered panel');
  assert.equal(html(m.TabPanel, { id: 'demo', value: 'a', selected: 'b' }, '别的'), '', 'an inactive panel is not rendered');
  assert.match(html(m.TabPanel, { id: 'demo', value: 'a', selected: 'b', keepMounted: true }, '别的'), /hidden=""/);
});

test('Arrow, Home and End move between enabled tabs', () => {
  const next = (from, key, options) => m.nextTabIndex(items, from, key, options);
  assert.equal(next(0, 'ArrowRight'), 1);
  assert.equal(next(1, 'ArrowRight'), 3, 'a disabled tab is skipped');
  assert.equal(next(3, 'ArrowRight'), 0, 'wraps by default');
  assert.equal(next(0, 'ArrowLeft'), 3);
  assert.equal(next(1, 'ArrowDown'), 3);
  assert.equal(next(3, 'ArrowUp'), 1);
  assert.equal(next(3, 'Home'), 0);
  assert.equal(next(0, 'End'), 3);
  assert.equal(next(0, 'a'), -1);
  assert.equal(next(3, 'ArrowRight', { wrap: false }), -1, 'the ends stay put without wrapping');
  assert.equal(next(0, 'ArrowLeft', { wrap: false }), -1);
  assert.equal(next(0, 'ArrowRight', { wrap: false }), 1);
  assert.equal(next(0, 'End', { wrap: false }), 3);
});

test('Tabs hand custom content and classes to their buttons', () => {
  const out = html(m.Tabs, { id: 'x', label: 'x', value: 'a', onChange() {}, className: 'row', itemClassName: 'tab-skin',
    items: [{ value: 'a', label: '甲', ariaLabel: '1. 甲', title: '甲站', content: h('span', { className: 'marker' }, '1') }, { value: 'b', label: '乙' }] });
  assert.match(out, /class="[^"]*sh-tabs[^"]*row/);
  assert.match(out, /class="[^"]*sh-tab[^"]*tab-skin[^"]*is-active/);
  assert.match(out, /aria-label="1\. 甲"/);
  assert.match(out, /title="甲站"/);
  assert.match(out, /<span class="marker">1<\/span>/);
});

test('DisclosureToggle is a named icon button that reports its state', () => {
  m.setUiLanguage('zh');
  const open = html(m.DisclosureToggle, { open: true, onToggle() {}, label: '收起 数据结构' });
  assert.match(open, /<button[^>]*aria-expanded="true"/);
  assert.match(open, /aria-label="收起 数据结构"/);
  assert.match(open, /sh-disclosure-toggle/);
  assert.match(open, /<svg/);
  assert.doesNotMatch(open, /[▾▸]/);
  const shut = html(m.DisclosureToggle, { open: false, onToggle() {}, label: '展开 数据结构', controls: 'rows' });
  assert.match(shut, /aria-expanded="false"/);
  assert.match(shut, /aria-controls="rows"/);
});

test('the icon registry has the glyph replacements wave 2 needs', () => {
  for (const name of ['caret', 'minus', 'play', 'chevron-left']) assert.ok(m.ICON_NAMES.includes(name), name);
});

test('the stylesheet rotates the caret and tokens carry every colour', () => {
  const css = readFileSync(new URL('../ui/components/disclosure.css', import.meta.url), 'utf8');
  assert.match(css, /\[aria-expanded="true"\][^{]*\{[^}]*rotate\(90deg\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

const files = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.jsx$/.test(name)) out.push(path);
  }
  return out;
};

test('role="tab" lives in components/Tabs.jsx; the remaining hand-written tablists are listed work for other packages (#144)', () => {
  const owners = files(join(process.cwd(), 'ui')).filter(file => /role=["']tab["']/.test(readFileSync(file, 'utf8')))
    .map(file => file.replace(/\\/g, '/').replace(/^.*\/ui\//, 'ui/')).sort();
  // Generate.jsx belongs to WP-M (its tablist moves to <Tabs> there).
  assert.deepEqual(owners, ['ui/Generate.jsx', 'ui/components/Tabs.jsx']);
});
