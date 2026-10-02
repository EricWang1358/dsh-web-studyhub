import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* 课程准备 on the library home: one component, the state from lib/course-setup.js. A full card while the course is being
   set up, one quiet line once the first questions exist or the course is in use, a one-time "done" note, nothing otherwise.
   Each step has one primary action that reuses an existing page or dialog, a "later" and its place in n/m. */
const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { default as SetupChecklist, stepAction, readSetupLater, writeSetupLater, setupDoneSeen, markSetupDone } from './ui/SetupChecklist.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { SetupChecklist, stepAction, readSetupLater, writeSetupLater, setupDoneSeen, markSetupDone, setUiLanguage } = mod.exports;
const h = React.createElement;
const COURSE = 'Cloud Native';
const note = (id = 's1') => ({ id, title: `Note ${id}`, text: 'a note', courses: [COURSE] });
const deck = (id = 'd1') => ({ id, title: id, course: COURSE, count: 3, available: 3, archived: false });
const library = (extra = {}) => ({ root: '/lib', focus: { mode: 'class', course: COURSE, courseId: 'course-1', courses: [{ name: COURSE }] },
  sources: [], decks: [], drafts: [], courses: [{ id: 'course-1', name: COURSE }], skeletons: [], progress: {}, model: { ready: true }, ...extra });
const render = (data, props = {}) => renderToStaticMarkup(h(SetupChecklist, { data, busy: false, on: {}, ...props }));
const newCourseInUse = () => library({ focus: { mode: 'class', course: 'New course', courseId: 'course-2', courses: [{ name: COURSE }, { name: 'New course' }] },
  sources: [{ ...note('n1'), courses: ['New course'] }], decks: [deck()], progress: { d1: { total: 3, counts: { mastered: 0, familiar: 0, learning: 1, weak: 0, new: 2 } } } });

test('a course being set up shows the card: n/m, the course, every step with its status, the next step marked, no competing primary button', () => {
  setUiLanguage('zh');
  const markup = render(newCourseInUse());
  assert.match(markup, /data-setup-checklist="" data-mode="full"/);
  assert.match(markup, /课程准备/);
  assert.match(markup, /New course/);
  assert.match(markup, /1\/2/, 'one of two steps is done');
  assert.match(markup, /<li[^>]*data-step="materials"[^>]*data-status="done"/);
  assert.match(markup, /<li[^>]*data-step="deck"[^>]*data-status="todo"/);
  // The home's one filled button is its today card; the checklist marks its next step instead of adding a second one.
  assert.equal((markup.match(/sh-btn--primary/g) || []).length, 0, 'no second primary action on the home');
  assert.equal((markup.match(/data-next="true"/g) || []).length, 1, 'the next step is marked');
  assert.match(markup, /<li[^>]*data-step="deck"[^>]*data-next="true"/);
  assert.match(markup, /用这门课的资料出题/);
  assert.match(markup, /稍后/);
  assert.doesNotMatch(markup, /aria-expanded/, 'the full card is not a disclosure');
});

test('materials only in a library without questions: one quiet line that opens the list', () => {
  setUiLanguage('zh');
  const markup = render(library({ sources: [note()] }));
  assert.match(markup, /data-mode="chip"/);
  assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*>[^<]*课程准备[^<]*1\/2[^<]*查看/);
  assert.doesNotMatch(markup, /setup-steps/, 'the list stays closed until it is asked for');
  const open = render(library({ sources: [note()] }), { initialOpen: true });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /setup-steps/);
});

test('a course with practised cards is a quiet line, and a completed course says so once', () => {
  setUiLanguage('zh');
  const used = library({ sources: [note()], decks: [deck()], progress: { d1: { total: 3, counts: { mastered: 0, familiar: 0, learning: 2, weak: 0, new: 1 } } } });
  assert.match(render(used), /data-mode="chip"/);
  const complete = library({ ...used, skeletons: [{ id: 'k', deckIds: ['d1'] }], courses: [{ id: 'course-1', name: COURSE, exam: { date: '2026-12-01', sections: [] } }] });
  const first = render(complete, { doneSeen: false });
  assert.match(first, /data-mode="done"/);
  assert.match(first, /课程准备已完成/);
  assert.equal(render(complete, { doneSeen: true }), '', 'once seen, nothing is drawn');
  assert.equal(render(library()), '', 'an empty library is the welcome page\'s business');
});

test('putting steps off keeps them out of the list, and they can be brought back', () => {
  setUiLanguage('zh');
  const used = library({ sources: [note()], decks: [deck()], progress: { d1: { total: 3, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 3 } } } });
  const markup = render(used, { initialOpen: true, later: ['goal'] });
  assert.doesNotMatch(markup, /data-step="goal"/);
  assert.match(markup, /恢复已推后的 1 项/);
});

test('every step has one action that reuses an existing page or dialog, and the first questions open with the course filled in', () => {
  const calls = [];
  const on = { import: (...args) => calls.push(['import', ...args]), sources: () => calls.push(['sources']), index: () => calls.push(['index']),
    generate: (...args) => calls.push(['generate', ...args]), draft: (...args) => calls.push(['draft', ...args]), course: (...args) => calls.push(['course', ...args]), skeleton: () => calls.push(['skeleton']) };
  const setup = { course: COURSE };
  const cases = [
    [{ id: 'materials', action: 'import', detail: {} }, ['import', COURSE]],
    [{ id: 'convert', action: 'sources', detail: {} }, ['sources']],
    [{ id: 'index', action: 'index', detail: {} }, ['index']],
    [{ id: 'originals', action: 'sources', detail: {} }, ['sources']],
    [{ id: 'deck', action: 'generate', detail: {} }, ['generate', COURSE]],
    [{ id: 'deck', action: 'draft', detail: { draftId: 'dr1' } }, ['draft', 'dr1']],
    [{ id: 'goal', action: 'course', detail: { courseId: 'course-1' } }, ['course', 'course-1']],
    [{ id: 'skeleton', action: 'skeleton', detail: {} }, ['skeleton']],
  ];
  for (const [step, expected] of cases) {
    calls.length = 0;
    const action = stepAction(step, setup, on);
    assert.ok(action.label, `${step.id}/${step.action} has a label`);
    assert.equal(action.disabled, false);
    action.run();
    assert.deepEqual(calls[0], expected);
  }
  assert.equal(stepAction({ id: 'deck', action: 'generate', detail: {}, blockedBy: 'materials' }, setup, on).disabled, true, 'the questions wait for a material');
  assert.equal(stepAction({ id: 'index', action: 'index', detail: {} }, setup, {}).disabled, true, 'no handler, no button');
});

test('what was put off and which course was told it is complete are remembered per viewer; a blocked storage changes nothing', () => {
  const store = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) } });
    assert.deepEqual(readSetupLater('/lib', COURSE), []);
    writeSetupLater('/lib', COURSE, ['goal', 'skeleton']);
    assert.deepEqual(readSetupLater('/lib', COURSE), ['goal', 'skeleton']);
    assert.deepEqual(readSetupLater('/lib', 'Other'), [], 'per course');
    assert.deepEqual(readSetupLater('/elsewhere', COURSE), [], 'per library');
    store.set([...store.keys()][0], '{"bad": true}');
    assert.deepEqual(readSetupLater('/lib', COURSE), [], 'a damaged value is nothing');
    writeSetupLater('/lib', COURSE, []);
    assert.equal(store.size, 0, 'nothing put off, nothing kept');
    assert.equal(setupDoneSeen('/lib', COURSE), false);
    markSetupDone('/lib', COURSE);
    assert.equal(setupDoneSeen('/lib', COURSE), true);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } } });
    assert.deepEqual(readSetupLater('/lib', COURSE), []);
    assert.doesNotThrow(() => writeSetupLater('/lib', COURSE, ['goal']));
    assert.equal(setupDoneSeen('/lib', COURSE), false);
    assert.doesNotThrow(() => markSetupDone('/lib', COURSE));
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});

test('English renders without Han outside the course name, in the card, the line and the done note', () => {
  setUiLanguage('en');
  try {
    const used = library({ sources: [note()], decks: [deck()], progress: { d1: { total: 3, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 3 } } } });
    const complete = library({ ...used, skeletons: [{ id: 'k', deckIds: ['d1'] }], courses: [{ id: 'course-1', name: COURSE, exam: { date: '2026-12-01', sections: [] } }] });
    const book = Array.from({ length: 320 }, (_, i) => ({ id: `b${i}`, title: `Book · p.${i + 1}`, text: 'x', courses: ['新课程'],
      document: { id: 'a'.repeat(64), format: 'pdf', page: i + 1, totalPages: 320, extractionVersion: 1 } }));
    const markups = [render(newCourseInUse()), render(library({ sources: [note()] }), { initialOpen: true }), render(used, { initialOpen: true }), render(complete, { doneSeen: false }),
      render({ ...library({ sources: book, decks: [{ ...deck(), course: '新课程' }] }), focus: { mode: 'class', course: '新课程', courseId: 'course-9', courses: [{ name: '新课程' }] } }, { initialOpen: true })];
    for (const markup of markups) assert.doesNotMatch(markup.replace(/新课程/g, ''), han);
    assert.match(markups[0], /Course setup/);
    assert.match(markups[1], /Course setup[^<]*1\/2/);
    assert.match(markups[3], /Course setup is complete/);
  } finally { setUiLanguage('zh'); }
});

test('the card is injected with its own stylesheet and App mounts it inside the library page, never in the way of the welcome page', async () => {
  const [app, map, css] = await Promise.all(['App.jsx', 'StudyMap.jsx', 'setup-checklist.css'].map(async (name) => (await readFile(new URL(`../ui/${name}`, import.meta.url), 'utf8')).replace(/\r/g, '')));
  assert.match(map, /<SetupChecklist\b/);
  assert.match(app, /setupHandlers|setupOn/);
  assert.match(css, /\.setup-card/);
  assert.match(css, /\.setup-chip/);
  assert.match(css, /@container study|@media/, 'it has a narrow layout');
});
