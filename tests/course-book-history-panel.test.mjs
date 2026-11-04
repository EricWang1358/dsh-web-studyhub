/* 复习全书 #489 Item 8: read-only version & structure history panel.
   Verifies:
   - Provenance (`by`: program / learner / ai) recorded on file versions across generator refresh, learner saves, and main-chat `book.write`,
   - `course.book.revision { history: true, file }` returns file counts, version metadata + text, and structure change summaries (`rename`, `move`, `delete`, `place`) with `undoable` / `active`,
   - `course.book.revert { file, entryVersion, at }` non-destructively restores an older version without dropping intermediate versions or the replaced live version,
   - `diffLines` & `formatHistoryTime` compute compact contextual diffs,
   - `BookHistory`, `BookEditor` (`版本历史`), and `HistoryDialog` render cleanly in both Chinese and English with zero Han leakage in English. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { diffLines, formatHistoryTime } from '../ui/book/book-diff.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookHistory } from './ui/book/BookHistory.jsx';
  export { default as BookEditor } from './ui/book/BookEditor.jsx';
  export { HistoryDialog } from './ui/book/book-views.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);

const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function library() {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  state.sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
  state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } })) }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  return state;
}

const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));

async function service(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-history-panel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const state = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  return { study, root };
}

test('course.book.revision { history: true } tracks file provenance (program / learner / ai), structure changes, and non-destructive version restore', async t => {
  const { study } = await service(t);
  let book = await study.call('course.book.open');
  const [what, who] = leaves(book.nodes);
  const genFile = what.files.gen, mineFile = what.files.mine;

  // 1. Program regenerates `what` -> initial v1 of genFile is recorded with by === 'program'.
  await study.store.update(own => {
    const notes = own.sources.find(s => s.provenance === 'course-outline-notes');
    notes.courseNotes.leaves[0].body = { ...notes.courseNotes.leaves[0].body, explain: 'Program refreshed explanation.' };
  });
  book = await study.call('course.book.open');
  const genHist = await study.call('course.book.revision', { course: COURSE, history: true, file: genFile });
  assert.equal(genHist.versions.length, 1);
  assert.equal(genHist.versions[0].by, 'program');

  // 2. Learner saves v1 -> v2, AI writes v2 -> v3 via book.write, Learner saves v3 -> v4.
  book = await study.call('course.book.save', { course: COURSE, file: mineFile, text: 'Learner draft v2.', version: book.files[mineFile].version });
  await study.call('book.write', { course: COURSE, hid: what.hid, file: 'mine', markdown: 'AI synthesis v3.' });
  book = await study.call('course.book.open');
  book = await study.call('course.book.save', { course: COURSE, file: mineFile, text: 'Learner polished v4.', version: book.files[mineFile].version });

  const mineHist = await study.call('course.book.revision', { course: COURSE, history: true, file: mineFile });
  // Replaced versions newest-first: v3 (by ai), v2 (by learner), v1 (initial empty, by program).
  assert.deepEqual(mineHist.versions.map(v => [v.version, v.by, v.text]), [
    [3, 'ai', 'AI synthesis v3.'],
    [2, 'learner', 'Learner draft v2.'],
    [1, 'program', ''],
  ]);
  assert.equal(mineHist.versions[0].chars, 'AI synthesis v3.'.length);

  // 3. Non-destructive restore of v2 from v4: v4 is kept in history, v3 stays in history, live text becomes 'Learner draft v2.'.
  const targetV2 = mineHist.versions.find(v => v.version === 2);
  book = await study.call('course.book.revert', { course: COURSE, file: mineFile, entryVersion: targetV2.version, at: targetV2.at });
  assert.equal(leaves(book.nodes)[0].mine, 'Learner draft v2.');
  const afterRestore = await study.call('course.book.revision', { course: COURSE, history: true, file: mineFile });
  assert.deepEqual(afterRestore.versions.map(v => [v.version, v.by, v.redo, v.text]), [
    [4, 'learner', false, 'Learner polished v4.'],
    [3, 'ai', false, 'AI synthesis v3.'],
    [1, 'program', false, ''],
  ]);

  // 4. Structure changes: rename + move + place from 未归位 -> newest is undoable, older is active but not undoable.
  await study.call('course.book.save', { course: COURSE, file: book.unplaced.file, text: '## Lost note\n\nCarried over.', version: book.files[book.unplaced.file].version });
  book = await study.call('course.book.open');
  await study.call('course.book.rename', { course: COURSE, hid: what.hid, title: 'Architect Roles', version: book.structureVersion });
  book = await study.call('course.book.open');
  await study.call('course.book.move', { course: COURSE, hid: who.hid, beforeHid: what.hid, version: book.structureVersion });
  book = await study.call('course.book.open');
  await study.call('course.book.place', { course: COURSE, section: book.unplaced.sections[0].id, toHid: what.hid, version: book.structureVersion });
  book = await study.call('course.book.open');

  const structHist = await study.call('course.book.revision', { course: COURSE, history: true, file: mineFile });
  assert.equal(structHist.structure.length, 3);
  assert.equal(structHist.structure[0].kind, 'place');
  assert.equal(structHist.structure[0].undoable, true);
  assert.equal(structHist.structure[0].active, true);
  assert.equal(structHist.structure[1].kind, 'move');
  assert.equal(structHist.structure[1].undoable, false);
  assert.equal(structHist.structure[1].active, true);
  assert.equal(structHist.structure[2].kind, 'rename');
  assert.equal(structHist.structure[2].fromTitle, 'What architects do');
  assert.equal(structHist.structure[2].title, 'Architect Roles');
});

test('diffLines & formatHistoryTime: contextual line diffs collapse long unchanged runs and mark additions/deletions', () => {
  assert.equal(diffLines('same\ntext', 'same\ntext').identical, true);
  const oldText = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'old 6', 'line 7'].join('\n');
  const newText = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'new 6', 'line 7'].join('\n');
  const diff = diffLines(oldText, newText);
  assert.equal(diff.identical, false);
  assert.equal(diff.rows[0].kind, 'skip');
  assert.equal(diff.rows[0].count, 3);
  assert.ok(diff.rows.some(r => r.kind === 'del' && r.text === 'old 6'));
  assert.ok(diff.rows.some(r => r.kind === 'add' && r.text === 'new 6'));
  assert.match(formatHistoryTime('2026-10-09T08:05:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatHistoryTime('not-a-date'), '');
});

test('BookHistory, BookEditor (版本历史) & HistoryDialog render in Chinese and English without Han leakage', () => {
  const sampleBook = {
    status: 'ok', course: COURSE, revision: 5, structureVersion: 3, title: '复习全书 · SA',
    unplaced: { title: '未归位', text: '', file: 'unplaced.md' },
    history: { 'p1.mine.md': 2 },
    files: {
      'p1.gen.md': { version: 1, forked: false, suggestions: [] },
      'p1.mine.md': { version: 3, forked: false, suggestions: [] },
      'unplaced.md': { version: 1, forked: false, suggestions: [] },
    },
    nodes: [{
      hid: 'h2', key: 'bk:p1', title: 'Entropy', number: '1', depth: 1, leaf: true,
      gen: 'Generated.', mine: 'Line A\nCurrent line B', files: { gen: 'p1.gen.md', mine: 'p1.mine.md' },
      questionTotal: 0, questions: [], children: [],
    }],
  };
  const initialData = {
    course: COURSE,
    revision: 5,
    files: { 'p1.mine.md': 3 },
    versions: [
      { version: 2, at: '2026-10-09T09:30:00.000Z', chars: 19, by: 'ai', redo: false, text: 'Line A\nOlder AI line' },
      { version: 3, at: '2026-10-09T09:45:00.000Z', chars: 12, by: 'learner', redo: true, text: 'Before revert' },
      { version: 1, at: '2026-10-09T09:00:00.000Z', chars: 0, by: 'program', redo: false, text: '' },
    ],
    structure: [
      { version: 2, at: '2026-10-09T10:00:00.000Z', kind: 'rename', hid: 'h2', fromTitle: 'Old Point', title: 'Entropy', active: true, undoable: true },
      { version: 1, at: '2026-10-09T09:50:00.000Z', kind: 'move', hid: 'h2', title: 'Old Point', active: true, undoable: false },
      { version: 0, at: '2026-10-08T08:00:00.000Z', kind: 'delete', hid: 'h9', title: 'Legacy', active: false, undoable: false },
    ],
  };

  const zhMarkup = render(h(ui.BookHistory, { course: COURSE, book: sampleBook, file: 'p1.mine.md', dirty: true, initialData }));
  const zhPanel = textOf(zhMarkup);
  assert.match(zhMarkup, /aria-label="版本历史"/);
  assert.match(zhPanel, /当前文件的历史版本/);
  assert.match(zhPanel, /来源：AI/);
  assert.match(zhPanel, /来源：你/);
  assert.match(zhPanel, /来源：程序/);
  assert.match(zhPanel, /回退前留存/);
  assert.match(zhPanel, /改名：「Old Point」→「Entropy」/);
  assert.match(zhPanel, /撤销这次目录改动/);
  assert.match(zhPanel, /更早的改动（只能撤最近一次）/);
  assert.match(zhPanel, /总纲已重建，不再可撤/);
  assert.match(zhPanel, /先保存或放弃当前未保存的改动，再恢复历史版本。/);

  const zhEditor = textOf(render(h(ui.BookEditor, { book: sampleBook, file: 'p1.mine.md', onPick: noop, onChanged: noop })));
  assert.match(zhEditor, /版本历史/);

  english(() => {
    const enPanel = textOf(render(h(ui.BookHistory, { course: COURSE, book: sampleBook, file: 'p1.mine.md', dirty: true, initialData })));
    const enDialog = textOf(render(h(ui.HistoryDialog, { book: sampleBook, step: { hid: 'h2', node: sampleBook.nodes[0] }, onChanged: noop, onClose: noop })));
    assert.equal(han.test(enPanel), false, `enPanel leaked Han: ${enPanel}`);
    const ownDialog = enDialog.replace(/未归位/g, '');
    assert.equal(han.test(ownDialog), false, `enDialog leaked Han: ${ownDialog}`);
    assert.match(enPanel, /By AI/);
    assert.match(enPanel, /By you/);
    assert.match(enPanel, /By StudyHub/);
    assert.match(enPanel, /Saved before revert/);
    assert.match(enPanel, /Undo this outline change/);
    assert.match(enPanel, /Restore this version/);
  });
});
