import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `export {default as Exam} from './ui/Exam.jsx';
  export {default as Dashboard} from './ui/Dashboard.jsx'; export {default as WrongBook} from './ui/WrongBook.jsx';
  export {default as Skeleton} from './ui/Skeleton.jsx'; export {default as Graph} from './ui/Graph.jsx';
  export {default as LiveClass} from './ui/LiveClass.jsx'; export {setUiLanguage} from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Exam, Dashboard, WrongBook, Skeleton, Graph, LiveClass, setUiLanguage } = module.exports;
const noop = () => {};
const data = { root: 'scope-ui', decks: [{ id: 'a', course: 'A', title: 'A questions', examCount: 2, examQuizCount: 2, available: 2 },
  { id: 'b', course: 'B', title: 'B questions', examCount: 2, examQuizCount: 2, available: 2 }],
  focus: { course: 'A', courses: ['A', 'B', 'Empty'].map(name => ({ name })) }, skeletons: [], oralExams: [] };
const render = (Component, extra = {}) => renderToStaticMarkup(React.createElement(Component, { data, library: data, call: noop, ...extra }));

test('learning browsing pages expose their actual course and an all-courses escape', () => {
  for (const Component of [Dashboard, WrongBook, Skeleton, Graph]) {
    const html = render(Component);
    assert.match(html, /课程范围/);
    assert.match(html, /<option value="A" selected="">/);
    assert.match(html, /全部课程/);
  }
});

test('exam defaults to current-course questions and an empty course never preselects other courses', () => {
  const html = render(Exam);
  assert.match(html, /A questions/);
  assert.doesNotMatch(html, /B questions/);
  assert.match(html, /type="checkbox" checked=""/);
  const empty = render(Exam, { data: { ...data, focus: { ...data.focus, course: 'Empty' } } });
  assert.doesNotMatch(empty, /type="checkbox" checked=""/);
  assert.match(empty, /全部课程/);
});

test('live class shows an editable raw course choice and English scope copy is complete', () => {
  const html = render(LiveClass, { visible: true });
  assert.match(html, /课程归属/);
  assert.match(html, /value="A"/);
  const unassigned = render(LiveClass, { visible: true, data: { ...data, focus: { ...data.focus, course: '' } } });
  assert.doesNotMatch(unassigned, /value="未分类课程"/);
  try {
    setUiLanguage('en');
    for (const Component of [Exam, Dashboard, WrongBook, Skeleton, Graph])
      assert.match(render(Component), /Course scope/);
  } finally { setUiLanguage('zh'); }
});
