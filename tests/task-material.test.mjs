import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { taskMaterial } from '../ui/tasks/task-material.js';

// 打开资料 in the header of a task: shown only when the task concerns ONE material (one row of the 资料 list: a PDF's pages, a recording's parts or a merged batch are one).
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { materialOpener, resultOpener } from './ui/tasks/task-actions.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const page = (hash, n, extra = {}) => ({ id: `${hash.slice(0, 1)}-p${n}`, title: `Book ${hash.slice(0, 1)}.pdf · p.${n}`, text: 'x', document: { id: hash, format: 'pdf', page: n, filename: `Book ${hash.slice(0, 1)}.pdf` }, ...extra });
const part = (batch, volume, volumes) => ({ id: `${batch}-v${volume}`, title: `Lecture (${volume}/${volumes})`, text: 'x', audio: { batch: { id: batch, title: 'Lecture', volume, volumes } } });
const note = (id, title = 'My note') => ({ id, title, text: 'x' });
const library = [page(HASH_A, 1), page(HASH_A, 2), page(HASH_A, 3), page(HASH_B, 1), part('batch-1', 1, 2), part('batch-1', 2, 2), note('n1')];
const job = (extra) => ({ id: 'j1', status: 'complete', startedAt: '2026-10-05T10:00:00.000Z', ...extra });
const question = (sourceIds, extra) => job({ kind: 'quiz', deckTitle: 'Deck', sourceIds, ...extra });

test('a question run on the pages of ONE PDF concerns that one material, opened at its first page', () => {
  const found = taskMaterial(question(['a-p3', 'a-p1', 'a-p2']), library);
  assert.equal(found.key, `pdf:${HASH_A}`);
  assert.equal(found.title, 'Book a');
  assert.equal(found.openId, 'a-p1', 'the same source the 资料 row opens: the first page in reading order');
});

test('a run on two PDFs concerns no single material', () => {
  assert.equal(taskMaterial(question(['a-p1', 'b-p1']), library), null);
});

test('a merged recording batch is ONE material; a single note is one', () => {
  assert.equal(taskMaterial(job({ type: 'audio-import', filename: 'Lecture', sourceIds: ['batch-1-v1', 'batch-1-v2'] }), library).key, 'audio:batch-1');
  assert.equal(taskMaterial(question(['n1']), library).key, 'source:n1');
});

test('a top-up or supplement reads the sources of the run (its extra sources are in them)', () => {
  const top = job({ type: 'supplement', deckTitle: 'Deck', draftId: 'd1', continued: true, extraSources: 1, sourceIds: ['a-p1', 'a-p2', 'a-p3'] });
  assert.equal(taskMaterial(top, library).key, `pdf:${HASH_A}`);
});

test('a conversion, a transcript, a translation: the material it created or read, from job.sourceIds and the contract refs', () => {
  assert.equal(taskMaterial(job({ type: 'pdf-convert', filename: 'Book a.pdf', sourceIds: ['a-p1', 'a-p2'] }), library).key, `pdf:${HASH_A}`);
  assert.equal(taskMaterial(job({ type: 'translation', targetTitle: 'Book b.pdf', sourceIds: ['b-p1'], documentId: 'legacy-x' }), library).key, `pdf:${HASH_B}`);
  // An archived record keeps only its contract: the refs of the source it made are enough.
  const archived = { id: 'old', archived: { at: '2026-10-06T10:00:00.000Z' }, contract: { jobId: 'old', kind: 'audio-import', status: 'complete', result: { refs: [{ kind: 'source', id: 'n1' }] }, detail: {}, actions: {}, calls: [], events: [] } };
  assert.equal(taskMaterial(archived, library).key, 'source:n1');
});

test('nothing when the material was deleted or archived, when the sources are unknown, or for a daily or a coach job', () => {
  assert.equal(taskMaterial(question(['gone-1']), library), null, 'deleted');
  assert.equal(taskMaterial(question(['a-p1', 'gone-1']), library), null, 'a recorded source is gone: not the one material the run read');
  assert.equal(taskMaterial(question(['n1']), library.map((s) => (s.id === 'n1' ? { ...s, archived: true } : s))), null, 'archived material');
  assert.equal(taskMaterial(question([]), library), null);
  assert.equal(taskMaterial(question(undefined), library), null);
  assert.equal(taskMaterial(question(['a-p1']), undefined), null, 'no library at hand');
  assert.equal(taskMaterial({ id: 'old', archived: { at: 'x' }, contract: { jobId: 'old', kind: 'generation', status: 'complete', result: { refs: [] }, detail: {}, actions: {}, calls: [], events: [] } }, library), null, 'an archived run does not know its sources');
  assert.equal(taskMaterial(job({ type: 'coach-daily', date: '2026-10-05', sourceIds: ['n1'] }), library), null);
});

// ---- the header ----
const at = (n) => new Date(Date.UTC(2026, 9, 5, 10, n)).toISOString();
const data = (jobs, extra = {}) => ({ jobs, drafts: [], decks: [], sources: library, ...extra });
const draw = (jobs, { language = 'zh', materialOf, resultOf = () => null, drafts = [] } = {}) => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: data(jobs, { drafts }), openers: { resultOf, ...(materialOf ? { materialOf } : {}) } }), { data: data(jobs), app: { lib: { taskFocus: null } } }));
  } finally { m.setUiLanguage('zh'); }
};
const run = (extra) => ({ id: 'g1', kind: 'quiz', status: 'complete', deckTitle: 'Deck', sourceIds: ['a-p1'], startedAt: at(1), finishedAt: at(5), draftId: 'd1', ...extra });
const opener = (calls = []) => (task) => ({ key: 'pdf:x', title: 'Book a', run: () => calls.push(task.id) });

test('the header shows 打开资料 next to 打开草稿 and nowhere else when the task concerns one material', () => {
  const draft = { id: 'd1', title: 'Deck', cards: [], draftVersion: 1 };
  const withDraft = (materialOf) => draw([run()], { materialOf, drafts: [draft], resultOf: () => ({ label: '打开草稿', run() {} }) });
  const html = withDraft(opener());
  const actions = html.slice(html.indexOf('class="tc-head__actions"'), html.indexOf('</header>'));
  assert.match(actions, /data-task-material[^>]*>打开资料</);
  assert.ok(actions.indexOf('打开草稿') < actions.indexOf('data-task-material'), 'right after 打开草稿');
  assert.ok(actions.indexOf('全屏') < actions.indexOf('data-task-material'));
  assert.match(actions, /aria-label="打开「Book a」"/, 'the accessible name has the title');
  assert.doesNotMatch(actions, /<(?:span|a|button)[^>]* title="[^"]*"[^>]*data-task-material/);
  assert.doesNotMatch(withDraft(() => null).slice(html.indexOf('class="tc-head__actions"')), /data-task-material/, 'hidden, not disabled, when there is no single material');
  assert.doesNotMatch(draw([run()]), /data-task-material/, 'an app without the opener has no button');
});

test('the button reads in English and clicking it carries the right opener', () => {
  const html = draw([run()], { language: 'en', materialOf: opener() });
  assert.match(html, /data-task-material[^>]*>Open the material</);
  assert.match(html, /aria-label="Open “Book a”"/);
  assert.doesNotMatch(html.slice(html.indexOf('class="tc-head__actions"'), html.indexOf('</header>')), /[㐀-鿿]/, 'no Chinese left in the header');
});

test('the opener of the app opens the reader on the first source of the material, like a row of the 资料 page', () => {
  const opened = [];
  const app = { data: { sources: library }, learn: { openAudioSources: (ids) => opened.push(ids) } };
  const found = m.materialOpener(question(['a-p2', 'a-p1']), app);
  assert.equal(found.title, 'Book a');
  found.run();
  assert.deepEqual(opened, [['a-p1']]);
  assert.equal(m.materialOpener(question(['a-p1', 'b-p1']), app), null);
  assert.equal(m.materialOpener(question(['a-p1']), { data: { sources: library } }), null, 'no navigation, no button');
});

test('a finished conversion has ONE 打开资料 (the material button replaces the result button of the same source)', () => {
  const jobs = [{ id: 'c1', type: 'pdf-convert', filename: 'Book a.pdf', status: 'complete', sourceIds: ['a-p1', 'a-p2'], startedAt: at(1), finishedAt: at(2) }];
  const app = { data: { sources: library, decks: [], drafts: [] }, learn: { openAudioSources() {} } };
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: data(jobs), openers: { resultOf: (j) => m.resultOpener(j, app), materialOf: (j) => m.materialOpener(j, app) } }),
    { data: data(jobs), app: { lib: { taskFocus: null } } }));
  const actions = html.slice(html.indexOf('class="tc-head__actions"'), html.indexOf('</header>'));
  assert.equal((actions.match(/打开资料/g) || []).length, 1);
  assert.match(actions, /data-task-material/);
});
