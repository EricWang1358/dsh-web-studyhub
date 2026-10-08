import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* 创建题组 › 案例分析题 in the fewest presses: the form opens with the materials ticked on the page it came from, its picker is scoped to the course (选择当前范围 means this course's materials, not the
   library's), and a material imported from this tab goes into THIS form's selection (through the import dialog's own hand-off), not into the other tab's. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Generate } from './ui/Generate.jsx';
  export { default as CaseCreate } from './ui/CaseCreate.jsx';
  export * as form from './ui/generate-form.js';
  export { importHandoff } from './ui/app/import-handoff.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const noop = () => {};
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

const note = (id, title, course) => ({ id, title, text: `${title} 的内容。`.repeat(40), courses: course ? [course] : [], usedBy: [] });
const sources = [note('a', '索引', '数据库'), note('b', '事务', '数据库'), note('c', '路由', '网络'), note('d', '案例：旧案例', '数据库')];
const baseData = (extra = {}) => ({ root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, courses: [], focus: { course: '数据库', courses: [{ name: '数据库' }, { name: '网络' }] }, ...extra });
// the first picker of the form (the one of the evidence); the reference samples have their own below it
const firstPicker = html => html.split('参考样题')[0];
const rowsOf = html => [...firstPicker(html).matchAll(/data-document-key="([^"]+)"/g)].map(match => match[1]);
const ticked = html => [...firstPicker(html).matchAll(/<div class="source-picker__item is-selected" data-document-key="([^"]+)"/g)].map(match => match[1]);
const draw = (element, data = baseData()) => renderToStaticMarkup(inApp(m, element, { data }));

test('the picker is scoped to the form\'s course: only that course\'s materials are listed (and so selected by 选择当前范围)', () => {
  const html = draw(React.createElement(m.CaseCreate, { data: baseData(), openImport: noop, openReferenceImport: noop, openSettings: noop, onStarted: noop }));
  assert.deepEqual(rowsOf(html), ['source:a', 'source:b'], 'the other course and the case sources are not offered');
  assert.match(html, /class="page-scope"/, 'the scope is a control, so the learner can widen it');
  // another course on the form: its materials
  const other = draw(React.createElement(m.CaseCreate, { data: baseData(), openImport: noop, openReferenceImport: noop, openSettings: noop, onStarted: noop, initial: { course: '网络' } }));
  assert.deepEqual(rowsOf(other), ['source:c']);
  // no course known: everything (the old behaviour), nothing hidden
  const none = draw(React.createElement(m.CaseCreate, { data: baseData({ focus: { course: '*', courses: [] } }), openImport: noop, openReferenceImport: noop, openSettings: noop, onStarted: noop }));
  assert.deepEqual(rowsOf(none), ['source:a', 'source:b', 'source:c']);
});

test('the case form opens with the materials ticked on the tab it came from, and says so; with none ticked it asks as before', () => {
  const generate = (props = {}) => draw(React.createElement(m.Generate, { data: baseData(), busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, genSource: 'case', setGenSource: noop,
    gen: { kind: 'quiz', kinds: ['quiz'], count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' }, setGen: noop, selectedSources: ['a', 'b'], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...props }));
  const html = generate();
  assert.deepEqual(ticked(html), ['source:a', 'source:b']);
  assert.match(text(html), /已带入刚才选好的 2 份资料；不合适就在下面改。/, 'and the line says where they come from');
  // a caseInitial (from the reader) keeps its own selection and says nothing about the other tab
  const reader = generate({ caseInitial: { sourceIds: ['b'], focus: '事务的隔离级别' } });
  assert.deepEqual(ticked(reader), ['source:b']);
  assert.doesNotMatch(text(reader), /已带入刚才选好的/);
  // nothing ticked on the tab before: nothing is made up
  const empty = generate({ selectedSources: [] });
  assert.deepEqual(ticked(empty), []);
  assert.doesNotMatch(text(empty), /已带入刚才选好的/);
  // a reference sample or a case source is not evidence for a case: it is not carried over
  assert.deepEqual(ticked(generate({ selectedSources: ['a', 'd'] })), ['source:a']);
  inLanguage('en', () => assert.match(text(generate()), /Brought over the 2 materials you ticked a moment ago; change them below if they do not fit\./));
});

test('the import dialog opened from the case tab names the case form as the one to hand the new materials to', () => {
  const calls = [];
  const dialog = m.form.importDialog('数据库', { onImported: ids => calls.push(ids) });
  assert.equal(dialog.type, 'add');
  assert.equal(dialog.course, '数据库');
  assert.equal(typeof dialog.onImported, 'function');
  // the app's hand-off calls it with the new source ids (and says what was imported, not "已勾选")
  const handoff = m.importHandoff(dialog, { done: true, sourceIds: ['n1', 'n2'], documents: [{ title: '新讲义', format: 'md' }] });
  handoff.call(handoff.ids);
  assert.deepEqual(calls, [['n1', 'n2']]);
  assert.doesNotMatch(handoff.notice.text, /已勾选/);
  // a click handler passes an event, not options: no hand-off is invented
  assert.equal('onImported' in m.form.importDialog('', { target: {} }), false);
  assert.equal('onImported' in m.form.importDialog('', undefined), false);
});

test('what is imported joins the selection once, in order', () => {
  assert.deepEqual(m.form.takeImported(['a'], ['n1', 'n2']), ['a', 'n1', 'n2']);
  assert.deepEqual(m.form.takeImported(['a', 'n1'], ['n1', 'n2']), ['a', 'n1', 'n2'], 'no repeat');
  assert.deepEqual(m.form.takeImported([], []), []);
});
