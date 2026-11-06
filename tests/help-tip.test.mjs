import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* HelpTip (ui/components/HelpTip.jsx): the one small 「?」 that holds an explanation the page used to print. A keyboard-focusable button with an accessible
   name, whose words are in a layered, interactive Tooltip (in the DOM, tied by aria-describedby, shown on hover / focus / long press), never a title attribute. */
const m = await loadUi(`export { HelpTip } from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`);
const html = (props, ...children) => renderToStaticMarkup(React.createElement(m.HelpTip, props, ...children));

test('HelpTip is a real button with a name, the words behind it and no title attribute', () => {
  m.setUiLanguage('zh');
  const out = html({}, '这一页只有提取出的文字。');
  const button = out.match(/<button[^>]*>/)[0];
  assert.match(button, /type="button"/);
  assert.match(button, /aria-label="说明"/);
  assert.match(button, /class="sh-help-tip"/);
  assert.doesNotMatch(button, /tabindex="-1"/, 'it is reachable by keyboard');
  assert.doesNotMatch(out, /\stitle="/, 'no title attribute');
  assert.match(out, /role="tooltip"[^>]*popover="manual"/, 'the words are in a layered tooltip');
  assert.match(out, /sh-tooltip--interactive/, 'the pointer may rest on the card');
  assert.match(out, /这一页只有提取出的文字。/);
  const id = out.match(/id="([^"]+)" role="tooltip"/)?.[1];
  assert.ok(id && button.includes(`aria-describedby="${id}"`), 'the button is described by the tooltip');
});

test('HelpTip takes its own label, and draws nothing without words', () => {
  m.setUiLanguage('zh');
  assert.match(html({ label: '这是什么？' }, '说明'), /aria-label="这是什么？"/);
  assert.equal(html({}), '');
  assert.equal(html({}, ''), '');
});
