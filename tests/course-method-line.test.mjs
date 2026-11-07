import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { CLASSROOM_METHOD } from '../lib/course-method.js';

/* 学法 on the home (#775 S1c): one line saying which stage of a course's own method the learner is on, in the learner's words; a course on the default
   package gets no line (its home stays as it was). */
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

test("the home line names the stage of a course's own method, in its own words, and opens the course settings", () => {
  const own = { index: 1, total: 3, own: true, stage: { ...CLASSROOM_METHOD.stages[1], name: '只练错题' } };
  assert.match(text(draw(own)), /学法 · 第 2 阶段 只练错题/);
  assert.match(draw(own), /<button/, 'it is the way to the whole method, like the 重点 line');
  assert.match(text(draw(own, 'en')), /Method · stage 2 只练错题/, "a learner's own words are theirs, in any language");
  assert.doesNotMatch(text(draw(own, 'en')).replace(/只练错题/g, ''), /[㐀-鿿]/, 'the rest of the line is English');
  assert.match(draw(own, 'en'), /aria-label="Method: stage 2, 只练错题\. Opens the course settings with the whole method"/);
  // The default package is today's flow: the home of a course nobody customised stays as it was (#775 acceptance), its 学法 is on the course settings.
  assert.equal(draw({ index: 1, total: 3, own: false, stage: CLASSROOM_METHOD.stages[1] }), '');
  assert.equal(draw(null), '');
  assert.equal(draw({}), '');
});
