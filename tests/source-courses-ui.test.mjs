import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `export {default as Sources, CourseDialog, courseAssignments, saveDocumentCourses} from './ui/Sources.jsx';
  export {default as Generate} from './ui/Generate.jsx'; export {default as ImportHub} from './ui/ImportHub.jsx';
  export {usePageScope} from './ui/PageScope.jsx'; export {setUiLanguage} from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Sources, CourseDialog, courseAssignments, saveDocumentCourses, Generate, ImportHub, usePageScope, setUiLanguage } = module.exports;
const data = { root: 'library-A', decks: [], drafts: [], sources: [{ id: 'a', title: 'Database notes', text: 'Transactions keep changes consistent.', courses: ['Databases'], createdAt: '2026-09-30' }],
  focus: { course: 'Systems', courses: [{ name: 'Databases' }, { name: 'Systems' }] }, jobs: [], modelReady: true };
const noop = () => {};

test('source organization and import forms expose local course choices in English', () => {
  try {
    setUiLanguage('en');
    const sources = renderToStaticMarkup(React.createElement(Sources, { data, act: noop, setModal: noop }));
    assert.match(sources, /Organize courses/);
    assert.match(sources, /All courses/);
    assert.match(sources, /Uncategorised/);
    assert.doesNotMatch(sources, /Apply suggestions/);
    assert.match(sources, /Suggest with AI/);
    assert.doesNotMatch(sources, /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});

test('generation displays the source course ahead of global focus and sends an editable destination', () => {
  try {
    setUiLanguage('en');
    const html = renderToStaticMarkup(React.createElement(Generate, { data, genSource: 'files', gen: { kind: 'flashcard', count: 5, difficulty: 'mixed', language: 'English', focus: '', role: '' },
      selectedSources: ['a'], setSelectedSources: noop, setGen: noop, act: noop, setModal: noop }));
    assert.match(html, /value="Databases"/);
    assert.match(html, /Your selection includes sources from other scopes/);
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ''), /[㐀-鿿]/);
    const pdf = renderToStaticMarkup(React.createElement(ImportHub, { data, call: noop }));
    assert.match(pdf, /value="Systems"/);
    assert.doesNotMatch(pdf, /[㐀-鿿]/);
    const local = renderToStaticMarkup(React.createElement(ImportHub, { data, call: noop, course: 'Databases', onCourseChange: noop }));
    assert.match(local, /placeholder="Leave blank for unassigned" value="Databases"/);
    const all = renderToStaticMarkup(React.createElement(ImportHub, { data, call: noop, course: '', onCourseChange: noop }));
    assert.match(all, /placeholder="Leave blank for unassigned" value=""/);
  } finally { setUiLanguage('zh'); }
});

test('page scope remembers explicit all and unassigned per library while unset pages follow their visible default', () => {
  const storage = new Map();
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  function Probe({ root, choice, fallback }) {
    const [value, setValue] = usePageScope(root, 'sources', fallback);
    if (choice !== undefined && value !== choice) setValue(choice);
    return React.createElement('span', null, JSON.stringify(value));
  }
  const render = props => renderToStaticMarkup(React.createElement(Probe, props));
  try {
    assert.match(render({ root: 'A', fallback: 'Course A', choice: '*' }), /&quot;\*&quot;/);
    assert.match(render({ root: 'A', fallback: 'Course B' }), /&quot;\*&quot;/);
    assert.match(render({ root: 'A', fallback: 'Course B', choice: '' }), /&quot;&quot;/);
    assert.match(render({ root: 'B', fallback: 'Course B' }), /Course B/);
    assert.match(render({ root: 'A', fallback: 'Course A' }), /&quot;&quot;/);
  } finally { delete globalThis.sessionStorage; }
});

test('each source row offers 改课程 in its More menu, so a wrong course can be fixed where it is shown', () => {
  try {
    const here = { ...data, focus: { ...data.focus, course: 'Databases' } };
    const zh = renderToStaticMarkup(React.createElement(Sources, { data: here, act: noop, setModal: noop }));
    assert.match(zh, /<button[^>]*>改课程…<\/button>/);
    setUiLanguage('en');
    const en = renderToStaticMarkup(React.createElement(Sources, { data: here, act: noop, setModal: noop }));
    assert.match(en, /<button[^>]*>Change course…<\/button>/);
    assert.doesNotMatch(en, /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});

test('the course dialog starts from the current course and applies it through the same source.courses.set as the organizer', () => {
  try {
    const item = { key: 'doc-1', title: 'PE1.m4a + 2', sourceIds: ['a', 'b'], courses: ['Cloud Native Solution Design / 07 微服务设计'], usedBy: [], pages: [] };
    const byId = new Map([['a', { id: 'a', courses: ['Cloud Native Solution Design / 07 微服务设计'] }], ['b', { id: 'b' }]]);
    const html = renderToStaticMarkup(React.createElement(CourseDialog, { item, items: [item], byId, courses: [{ name: 'Databases' }, { name: 'Systems' }], busy: false, act: noop, onClose: noop }));
    assert.match(html, /修改「PE1\.m4a \+ 2」的课程/);
    assert.match(html, /Cloud Native Solution Design \/ 07 微服务设计/);
    assert.match(html, /保存课程/);
    assert.deepEqual(courseAssignments([item], ['doc-1'], ['Databases'], byId),
      [{ id: 'a', courses: ['Databases'], expectedCourses: ['Cloud Native Solution Design / 07 微服务设计'] }, { id: 'b', courses: ['Databases'], expectedCourses: [] }]);
    setUiLanguage('en');
    const en = renderToStaticMarkup(React.createElement(CourseDialog, { item: { ...item, title: 'PE1.m4a + 2', courses: [] }, items: [item], byId, courses: [{ name: 'Databases' }], busy: false, act: noop, onClose: noop }));
    assert.match(en, /Save course/);
    assert.doesNotMatch(en, /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});

test('the row menu lists its actions in one stacked menu instead of putting every button at the same spot', async () => {
  const { readFileSync } = await import('node:fs');
  const here = { ...data, focus: { ...data.focus, course: 'Databases' } };
  const html = renderToStaticMarkup(React.createElement(Sources, { data: here, act: noop, setModal: noop }));
  const menu = /<details class="source-row-actions"><summary>[^<]*<\/summary>(<div class="source-row-menu"[^>]*>(.*?)<\/div>)<\/details>/.exec(html);
  assert.ok(menu, 'the buttons sit inside one .source-row-menu container');
  assert.deepEqual([...menu[2].matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]), ['重命名…', '改课程…', '归档']);
  const css = readFileSync(new URL('../ui/sources.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /source-row-actions\[open\]\s*>\s*button/, 'a rule that makes every direct button absolute stacks them on top of each other');
  const rule = /\.source-row-actions\[open\]\s*>\s*\.source-row-menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /position:\s*absolute/); assert.match(rule, /display:\s*grid/);
});

test('a failed course save is said inside the dialog and never raises the global notice that covers its buttons', async () => {
  const calls = [];
  const failing = async (action, args, after, options) => { calls.push({ action, args, options }); if (options?.rethrow) throw new Error('请选择 1–5000 份资料'); };
  assert.equal(await saveDocumentCourses(failing, [{ id: 'a', courses: ['X'] }], noop), '请选择 1–5000 份资料');
  assert.equal(calls[0].action, 'source.courses.set');
  assert.equal(calls[0].options.rethrow, true, 'the error comes back to the dialog instead of the app-wide notice');
  let closed = 0;
  const working = async (action, args, after) => { await after({ updated: 1 }); return { updated: 1 }; };
  assert.equal(await saveDocumentCourses(working, [{ id: 'a', courses: ['X'] }], () => { closed += 1; }), '');
  assert.equal(closed, 1);
});

test('a long course path is not cut without a trace: the field shows an ellipsis and the whole path as its title', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../ui/course-field.css', import.meta.url), 'utf8'), /course-field__control > input \{[^}]*text-overflow:\s*ellipsis/);
  const item = { key: 'doc-1', title: 'Book', sourceIds: ['a'], courses: ['Cloud Native Solution Design / 07 微服务设计：边界、通信、发现与兼容演进'], usedBy: [], pages: [] };
  const html = renderToStaticMarkup(React.createElement(CourseDialog, { item, items: [item], byId: new Map([['a', { id: 'a', courses: item.courses }]]), courses: [{ name: 'Databases' }], busy: false, act: noop, onClose: noop }));
  assert.match(html, /title="Cloud Native Solution Design \/ 07 微服务设计：边界、通信、发现与兼容演进"/);
});
