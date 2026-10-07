import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The real Select (not the native stand-in of the other render tests) closed: the trigger of 「跟随当前会话」 says only the short words, its sentence rides in a
   tooltip on the trigger (not a title attribute), and an option list with no such words draws no tooltip anchor at all. What the popup shows (the whole
   label, wrapped) and how the row holds at every width is in tests/follow-label-fit-browser.test.mjs. */

const compiled = await build({
  stdin: { contents: `export { Select } from './ui/components/Select.jsx'; export { hasTips, wrapsLabels } from './ui/components/option-parts.jsx';
    export { followOption } from './ui/follow-session.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Select, hasTips, wrapsLabels, followOption, setUiLanguage } = module.exports;

const SESSION = { provider: 'cn', model: 'cn:deepseek-v4.1-flash', reasoningEffort: 'high' };
const options = (session) => [followOption(session), { value: 'low', label: '低' }, { value: 'high', label: '高' }];
const draw = (props) => renderToStaticMarkup(React.createElement(Select, { 'aria-label': 'Planning reasoning', onChange: () => {}, ...props }));
const text = (html) => html.replace(/<[^>]*>/g, '');

test('the closed select says the short words and the tooltip has the sentence', () => {
  const html = draw({ options: options(SESSION), value: 'follow' });
  const trigger = html.match(/<button[^>]*role="combobox"[^>]*>.*?<\/button>/s)[0];
  assert.equal(text(trigger), '跟随当前会话', 'not the model, not the level: they are the option and the tooltip');
  assert.doesNotMatch(trigger, /cn:deepseek/);
  const tip = html.match(/<span id="([^"]+)" role="tooltip"[^>]*>([^<]*)<\/span>/);
  assert.equal(tip[2], '跟随当前会话：现在是 cn:deepseek-v4.1-flash，推理档位 high。会话换了模型，这里也跟着换。');
  assert.match(trigger, new RegExp(`aria-describedby="[^"]*${tip[1]}`), 'the trigger is described by it (keyboard focus and screen readers, not only the pointer)');
  assert.doesNotMatch(html, /\btitle="/, 'a tooltip, never a title attribute (ui-guardrails)');
  assert.match(html, /<span class="sh-popover-anchor sh-select__tip">/);
  assert.match(html, /popover="manual"/, 'in the top layer, so nothing clips it');
});

test('another choice keeps the anchor (the trigger is not remounted) and says nothing', () => {
  const html = draw({ options: options(SESSION), value: 'low' });
  assert.equal(text(html.match(/<button[^>]*role="combobox"[^>]*>.*?<\/button>/s)[0]), '低');
  assert.match(html, /<span class="sh-popover-anchor sh-select__tip">/, 'the same wrapper as with 「跟随当前会话」 chosen');
  assert.match(html, /role="tooltip"[^>]*><\/span>/, 'an empty card is never shown (Tooltip draws none for empty words)');
});

test('with no known session model the select is the plain one, and the anchor is still there for when it is known', () => {
  const html = draw({ options: options(undefined), value: 'follow' });
  assert.equal(text(html.match(/<button[^>]*role="combobox"[^>]*>.*?<\/button>/s)[0]), '跟随当前会话');
  assert.match(html, /sh-select__tip/);
  assert.match(html, /role="tooltip"[^>]*><\/span>/);
});

test('a list without tips has no tooltip anchor, and the popup only widens for labels that wrap', () => {
  const html = draw({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a' });
  assert.doesNotMatch(html, /sh-popover-anchor|role="tooltip"/);
  assert.equal(hasTips([{ label: 'A' }]), false);
  assert.equal(hasTips([{ label: 'A', tip: '' }]), true, 'the empty string counts: it keeps the anchor');
  assert.equal(wrapsLabels([{ label: 'A' }]), false);
  assert.equal(wrapsLabels([{ label: 'A' }, followOption(SESSION)]), true);
});

test('English: the trigger says Follow session and the sentence is English', () => {
  setUiLanguage('en');
  try {
    const html = draw({ options: options(SESSION), value: 'follow' });
    assert.equal(text(html.match(/<button[^>]*role="combobox"[^>]*>.*?<\/button>/s)[0]), 'Follow session');
    assert.match(html, /role="tooltip"[^>]*>Follows the current session: right now cn:deepseek-v4\.1-flash, reasoning level high\./);
    assert.doesNotMatch(html, /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});
