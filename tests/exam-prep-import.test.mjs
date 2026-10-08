import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { nativeSelects } from './helpers/native-selects.mjs';

/* 备考补习 opens the add-materials dialog from its own form (openImport) and gets the ids of what the import made (onImported). The reference-question
   flow of 创建题组 keeps its own callback and notice. The page component is a stub: only the props the view hands it matter here. */

const stubExamPrep = { name: 'stub-exam-prep', setup(b) {
  b.onResolve({ filter: /exam-prep\/ExamPrep\.jsx$/ }, () => ({ path: 'ExamPrep', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function ExamPrep() { return null; }', loader: 'js' }));
} };
const compiled = await build({ stdin: { contents: `export { PAGE_VIEWS } from './ui/app/page-views.jsx';
  export { useSourceImport } from './ui/app/use-source-import.js'; export { AppContext } from './ui/app/app-context.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects, stubExamPrep],
  loader: { '.css': 'text' }, logLevel: 'silent' });
const require = createRequire(import.meta.url);
const context = { current: null };
// Hooks answer without a renderer: the context is the fake app, state stays at its initial value, effects do not run.
const hooks = { ...React, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useContext: () => context.current,
  useEffect: () => {}, useInsertionEffect: () => {}, useCallback: callback => callback, useMemo: read => read(), useRef: initial => ({ current: initial }) };
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), loaded, loaded.exports);
const { PAGE_VIEWS, useSourceImport } = loaded.exports;

function fakeApp(extra = {}) {
  const calls = { modal: [], settings: [], modelSettings: 0 };
  const app = { data: { root: 'r', features: { examBlueprint: true } }, nav: { show: { task: () => {} } }, learn: { openLearningTarget: () => {} },
    set: { setModal: modal => calls.modal.push(modal) },
    settingsEntry: { openSettings: section => calls.settings.push(section), openModelSettings: () => { calls.modelSettings += 1; } }, ...extra };
  return { app, calls };
}

test('the page gets openImport, which opens the add dialog for its course and hands the imported ids back', () => {
  const { app, calls } = fakeApp();
  context.current = app;
  const props = PAGE_VIEWS.examprep().props;
  assert.equal(typeof props.openImport, 'function');
  const onImported = () => {};
  props.openImport({ course: 'CS1010', onImported });
  assert.deepEqual(calls.modal, [{ type: 'add', course: 'CS1010', onImported }]);
  props.openImport({ onImported });
  assert.equal(calls.modal[1].course, '', 'no course presets the uncategorised choice');
  assert.equal('referenceQuestions' in calls.modal[1], false, 'it is not the reference flow');
});

test('the page gets openSettings(section); with no section it still opens the model settings, as the setup gate asks', () => {
  const { app, calls } = fakeApp();
  context.current = app;
  const props = PAGE_VIEWS.examprep().props;
  props.openSettings('settings-exam-prep');
  assert.deepEqual(calls.settings, ['settings-exam-prep']);
  props.openSettings({ type: 'click' });
  props.openSettings();
  assert.equal(calls.modelSettings, 2);
  assert.deepEqual(calls.settings, ['settings-exam-prep']);
});

/** The hook with a dialog open on `modal`; what finishImport did is recorded. */
function importHook(modal, page = 'examprep') {
  const seen = { closed: 0, notices: [], pages: [], gen: [], selected: [], drafts: [] };
  const lib = { state: { modal }, set: { setModal: next => { if (next === null) seen.closed += 1; }, setGen: update => seen.gen.push(update),
    setSelectedSources: update => seen.selected.push(update), setSourceHighlight: () => {} } };
  context.current = null;
  const sources = useSourceImport({ core: { notify: notice => seen.notices.push(notice) }, lib, nav: { page, show: { page: next => seen.pages.push(next) } },
    drafts: { openDraft: draft => seen.drafts.push(draft) }, intents: { goGenerate: () => {} }, data: { root: 'r' } });
  return { sources, seen };
}
const summary = (ids, more = {}) => ({ done: 1, failed: 0, decks: [], subtitles: [], sourceIds: ids,
  documents: ids.length ? [{ kind: 'document', title: 'Week 3', format: 'pdf', pages: ids.length, sourceIds: ids }] : [], ...more });

test('onImported receives the ids of what the import made, then the dialog closes with a plain notice', () => {
  const got = [];
  const { sources, seen } = importHook({ type: 'add', course: 'CS1010', onImported: ids => got.push(ids) });
  sources.finishImport(summary(['s1', 's2']));
  assert.deepEqual(got, [['s1', 's2']]);
  assert.equal(seen.closed, 1);
  assert.equal(seen.notices.length, 1);
  assert.match(seen.notices[0].text, /Week 3/);
  assert.doesNotMatch(seen.notices[0].text, /参考样题|样题/, 'the notice does not talk about reference questions');
  assert.deepEqual(seen.pages, [], 'the learner stays on the page that opened the dialog');
  assert.deepEqual([seen.gen, seen.selected], [[], []], 'the generate page state is not touched');
});

test('an import that made no material (a deck, a background job) closes the dialog and stays on the page', () => {
  const got = [];
  const { sources, seen } = importHook({ type: 'add', course: '', onImported: ids => got.push(ids) });
  sources.finishImport(summary([], { decks: [{ id: 'd', title: 'Quiz', cards: [{}] }] }));
  assert.deepEqual(got, []);
  assert.equal(seen.closed, 1);
  assert.deepEqual(seen.pages, []);
  assert.deepEqual(seen.drafts, []);
  assert.equal(seen.notices.length, 1);
});

test('an import with no caller callback behaves as before (the sources page opens)', () => {
  const { sources, seen } = importHook({ type: 'add', course: '' }, 'library');
  sources.finishImport(summary(['s1']));
  assert.deepEqual(seen.pages, ['sources']);
});

test('the reference flow is unchanged: its own callback and notice, or the generate page state when there is none', () => {
  const got = [];
  const withCallback = importHook({ type: 'add', referenceQuestions: true, onReferenceImported: ids => got.push(ids) }, 'generate');
  withCallback.sources.finishImport(summary(['r1']));
  assert.deepEqual(got, [['r1']]);
  assert.match(withCallback.seen.notices[0].text, /参考样题已保存/);
  assert.equal(withCallback.seen.closed, 1);
  const plain = importHook({ type: 'add', referenceQuestions: true }, 'generate');
  plain.sources.finishImport(summary(['r1']));
  assert.equal(plain.seen.gen.length, 1);
  assert.equal(plain.seen.selected.length, 1);
  assert.match(plain.seen.notices[0].text, /参考样题已保存/);
});

test('onImported also works for the reference flow, and an empty import falls through to the usual outcome', () => {
  const got = [];
  const generic = importHook({ type: 'add', referenceQuestions: true, onImported: ids => got.push(ids) }, 'generate');
  generic.sources.finishImport(summary(['r1']));
  assert.deepEqual(got, [['r1']]);
  assert.match(generic.seen.notices[0].text, /参考样题已保存/);
  const empty = importHook({ type: 'add', referenceQuestions: true, onReferenceImported: () => got.push('wrong') }, 'generate');
  empty.sources.finishImport(summary([]));
  assert.deepEqual(got, [['r1']]);
});
