import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// #107: one sentence is one catalogue key even when it has markup inside, so the English can reorder it.
const m = await loadUi(`export * from './ui/i18n-rich.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;

test('uiRich puts elements where the placeholders are', () => {
  m.setUiLanguage('zh');
  assert.equal(renderToStaticMarkup(h('p', null, m.uiRich('答对 {0} / {1} 道。', h('strong', null, 3), 5))), '<p>答对 <strong>3</strong> / 5 道。</p>');
});

test('a placeholder without a value stays as it is, and a value can appear twice', () => {
  m.setUiLanguage('zh');
  assert.equal(renderToStaticMarkup(h('p', null, m.uiRich('{0} 和 {1}', '甲'))), '<p>甲 和 {1}</p>');
  assert.equal(renderToStaticMarkup(h('p', null, m.uiRich('{0}，{0}', '甲'))), '<p>甲，甲</p>');
});

test('the English of a catalogue sentence can reorder its parts', () => {
  m.setUiLanguage('en');
  try {
    const out = renderToStaticMarkup(h('p', null, m.uiRich('本步练完了：答对 {0} / {1} 道。', h('strong', null, 3), 5)));
    assert.equal(out, '<p>Step practice finished: <strong>3</strong> of 5 correct.</p>');
  } finally { m.setUiLanguage('zh'); }
});
