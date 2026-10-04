import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2 · WP-H: the last hand-made modals use Dialog (#75), the candidate picker too (#82), tooltips carry the nav details (#86).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as Dialog, needsOwnScope, ownScope } from './ui/components/Dialog.jsx';
  export { default as StudyImage } from './ui/StudyImage.jsx';
  export { NavItem } from './ui/SideNav.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));

test('Dialog knows when it sits outside every study surface and then wears its own scope (#75)', () => {
  const inside = { parentElement: { closest: (selector) => (/\.study-app/.test(selector) ? {} : null) } };
  const outside = { parentElement: { closest: () => null } };
  assert.equal(m.needsOwnScope(inside), false);
  assert.equal(m.needsOwnScope(outside), true);
  assert.equal(m.needsOwnScope({ parentElement: null }), true);
  const own = m.ownScope();
  assert.match(own.attrs['data-theme'], /^(dark|light)$/, 'the saved theme, never a hard-coded colour');
  assert.ok(Object.keys(own.attrs).every((key) => key.startsWith('data-')));
  assert.equal(typeof own.style, 'object');
  const source = read('ui/components/Dialog.jsx');
  assert.match(source, /study-app/);
  assert.match(source, /'media'/);
});

test('Dialog has a media size that fits its content and keeps images below 70dvh (#75)', () => {
  assert.match(html(m.Dialog, { title: '图', size: 'media', onClose() {} }, 'x'), /sh-dialog--media/);
  const css = read('ui/components/dialog-media.css');
  assert.match(css, /\.sh-dialog--media/);
  assert.match(css, /max-height:\s*70dvh/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  const base = read('ui/components/components.css');
  assert.match(base, /&\.sh-dialog\b/, 'the dialog rules also match a dialog that is itself the study surface');
});

test('StudyImage and the document tools open a Dialog: no private showModal, text close or violet fallback (#75 #83)', () => {
  const image = read('ui/StudyImage.jsx'), native = read('ui/document-preview/native.jsx');
  for (const [name, source] of [['StudyImage', image], ['native', native]]) {
    assert.doesNotMatch(source, /showModal|<dialog/, name);
    assert.match(source, /<Dialog/, name);
    assert.doesNotMatch(source, />×</, name);
  }
  assert.match(image, /size="media"/);
  assert.doesNotMatch(image, /en \? '|en \? "/, 'no language ternaries');
  assert.doesNotMatch(image, /md-image-close/);
  assert.doesNotMatch(read('ui/document-preview/document-preview.css'), /study-document-native-dialog|7284ef/);
});

test('the enlarge button still names the image and the unavailable fallback speaks both languages', () => {
  m.setUiLanguage('zh');
  const out = html(m.StudyImage, { src: 'https://example.org/a.png', alt: '示意图', interactive: false });
  assert.match(out, /class="md-image md-image-static"/);
  const missing = html(m.StudyImage, { src: 'javascript:alert(1)', alt: '示意图' });
  assert.match(missing, /aria-label="示意图: 图片不可用"/);
  m.setUiLanguage('en');
  assert.match(html(m.StudyImage, { src: 'javascript:alert(1)', alt: 'diagram' }), /aria-label="diagram: Image unavailable"/);
  m.setUiLanguage('zh');
});

test('the candidate picker is a Dialog: Escape, focus and an inert background come with it (#82)', () => {
  const source = read('ui/host/workspace.jsx');
  assert.match(source, /<Dialog[^>]*title=\{ui\("选择要打开的题目"\)\}/);
  assert.doesNotMatch(source, /role="dialog"|study-panel-candidates-head/);
  assert.match(source, /onClose=\{\(\) => deliverCandidates\(sessionId, null\)\}/, 'Escape and the close button cancel the choice');
  const css = read('ui/panel-bridge.css');
  assert.doesNotMatch(css, /inset:\s*0|position:\s*absolute|z-index/, 'no full-panel overlay any more');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('SideNav details are Tooltips: reachable by keyboard focus, tied by aria-describedby, in the top layer (#86)', () => {
  m.setUiLanguage('zh');
  const out = html(m.NavItem, { label: '资料', title: '资料\n长按并拖动可调整顺序', hint: 3, hintTitle: '2 项已逾期', glyph: 'sources', 'data-usage': 'nav.sources' });
  assert.doesNotMatch(out, /<button[^>]*\btitle=/, 'no native title on the row');
  const [, id] = out.match(/<button[^>]*aria-describedby="([^"]+)"/);
  assert.match(out, new RegExp(`<span[^>]*id="${id}"[^>]*role="tooltip"|<span[^>]*role="tooltip"[^>]*id="${id}"`));
  assert.match(out, /popover="manual"/);
  assert.match(out, /长按并拖动可调整顺序/);
  assert.match(out, /2 项已逾期/);
  assert.doesNotMatch(out, /<span class="nav-count"[^>]*title=/);
  const plain = html(m.NavItem, { label: '统计', glyph: 'dashboard' });
  assert.doesNotMatch(plain, /role="tooltip"/, 'a row with nothing to add stays a plain button');
});

test('the narrow spine strip names every station in a Tooltip, not a title attribute (#86)', () => {
  const source = read('ui/SkeletonSpine.jsx');
  assert.match(source, /tooltip:/);
  assert.doesNotMatch(source, /title: item\.term/);
  assert.match(read('ui/components/Tabs.jsx'), /<Tooltip/);
});
