import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #1073: the tick and cross of an answer, the marks of 对 / 错 and the flag are registry icons, not typed characters. */

const m = await loadUi(`
  export { default as AnswerState } from './ui/review/AnswerState.jsx';
  export { default as OptionMark } from './ui/OptionMark.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { ICON_PATHS } from './ui/components/icon-paths.js';
`);
const h = React.createElement;
const render = (element) => renderToStaticMarkup(element);
const svgs = (html) => (html.match(/<svg/g) || []).length;
const text = (html) => html.replace(/<[^>]+>/g, '');
const iconPath = (name) => [].concat(m.ICON_PATHS[name])[0];

test('an answered option: a tick before 已选 · 正确, a cross before 你的选择, plain words for the right one you did not pick, nothing for the rest', () => {
  const picked = render(h(m.AnswerState, { correct: true, picked: true }));
  assert.equal(text(picked), '已选 · 正确');
  assert.equal(svgs(picked), 1);
  assert.ok(picked.includes(iconPath('check').slice(0, 40)));
  const wrong = render(h(m.AnswerState, { correct: false, picked: true }));
  assert.equal(text(wrong), '你的选择');
  assert.ok(wrong.includes(iconPath('close').slice(0, 40)));
  const missed = render(h(m.AnswerState, { correct: true, picked: false }));
  assert.equal(text(missed), '正确答案');
  assert.equal(svgs(missed), 0);
  assert.equal(text(render(h(m.AnswerState, { correct: true, picked: false, multiple: true }))), '漏选 · 正确答案');
  assert.equal(text(render(h(m.AnswerState, { correct: false, picked: true, multiple: true }))), '已选 · 错选');
  assert.equal(text(render(h(m.AnswerState, { correct: false, picked: false }))), '');
  for (const html of [picked, wrong, missed]) assert.doesNotMatch(html, /[✓×✕]/);
});

test('English says the same without a typed mark', () => {
  m.setUiLanguage('en');
  try {
    const picked = render(h(m.AnswerState, { correct: true, picked: true }));
    const wrong = render(h(m.AnswerState, { correct: false, picked: true }));
    assert.equal(text(picked), 'Selected · correct');
    assert.equal(text(wrong), 'Your selection');
  } finally { m.setUiLanguage('zh'); }
});

test('a 判断题 option shows the registry tick or cross where the other kinds show a letter; a choice shows A. / A', () => {
  const trueFalse = { kind: 'truefalse' };
  const right = render(h(m.OptionMark, { card: trueFalse, option: { id: 'true' }, index: 0 }));
  const no = render(h(m.OptionMark, { card: trueFalse, option: { id: 'false' }, index: 1 }));
  assert.ok(right.includes(iconPath('check').slice(0, 40)));
  assert.ok(no.includes(iconPath('close').slice(0, 40)));
  assert.doesNotMatch(right + no, /[✓✕]/);
  const quiz = { kind: 'quiz' };
  assert.equal(render(h(m.OptionMark, { card: quiz, option: { id: 'b' }, index: 1 })), 'B');
  assert.equal(render(h(m.OptionMark, { card: quiz, option: { id: 'b' }, index: 1, dot: true })), 'B.');
});
