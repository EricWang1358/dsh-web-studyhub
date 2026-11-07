import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { CLASSROOM_METHOD } from '../lib/course-method.js';

/* 学法 on the home (#775 S1c): one line saying which stage the learner is on, in the method's own words — the default package's words from the catalogue,
   a course's own words exactly as written. */
const m = await loadUi(`
  export { default as MethodLine } from './ui/study-map/MethodLine.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const draw = (method, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(h(m.MethodLine, { method })); } finally { m.setUiLanguage('zh'); }
};

test('the home line names the stage and its number, in the method\'s own words', () => {
  const own = { index: 1, total: 3, own: true, stage: { ...CLASSROOM_METHOD.stages[1], name: '只练错题' } };
  assert.match(text(draw(own)), /学法 · 第 2 阶段/);
  assert.match(text(draw(own)), /只练错题/);
  assert.match(text(draw({ index: 1, total: 3, own: false, stage: CLASSROOM_METHOD.stages[1] })), /按批练/, 'the default package is drawn from the catalogue');
  const english = text(draw({ index: 1, total: 3, own: false, stage: CLASSROOM_METHOD.stages[1] }, 'en'));
  assert.match(english, /Method · stage 2/);
  assert.doesNotMatch(english, /[\u3400-\u9fff]/, 'no Han in the English line: the default words are translated');
  assert.match(text(draw({ ...own, own: true }, 'en')), /只练错题/, 'a learner\'s own words are theirs, in any language');
  // #777 S3b: when the stage's check has passed, the line says the learner can move on.
  const ready = { ...own, gate: { total: 10, passed: 8, ready: true, checkPassed: true } };
  assert.match(text(draw(ready)), /可以进下一阶段/);
  assert.doesNotMatch(text(draw({ ...own, gate: { total: 10, passed: 5, ready: false } })), /可以进下一阶段/);
  assert.doesNotMatch(text(draw(own)), /可以进下一阶段/, 'no gate read: no suggestion');
  const englishReady = text(draw({ ...ready, own: false, stage: CLASSROOM_METHOD.stages[1] }, 'en'));
  assert.match(englishReady, /go on to the next one/);
  assert.doesNotMatch(englishReady, /[\u3400-\u9fff]/, 'the suggestion is translated too');
  assert.equal(draw(null), '');
  assert.equal(draw({}), '');
});
