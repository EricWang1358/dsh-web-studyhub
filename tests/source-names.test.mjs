import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as titles from '../lib/document-title.js';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

/* #229: one display-name function (lib/document-title.js displayTitle) names a material on the 资料 page, in the picker of 创建题组, in a draft's
   coverage list and in the reader's header; the 资料 page keeps the index badge's line from the first paint, re-renders only the rows whose own
   data changed, and says how materials made from one file belong together. */

const NOISY = 'Distributed Systems (Mark Richards) (z-library.sk, 1lib.sk, z-lib.sk).pdf';
const CLEAN = 'Distributed Systems (Mark Richards)';
const HOST_PATH = 'C:\\Users\\Eric1\\.dsh\\attachments\\v1\\files\\15\\15dd8b13a5318c2f6e1d\\01. Introduction to Solution Architecture v2.1.pdf';
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('one function cleans a displayed name: the directory, the site noise and the extension, nothing that names the work', () => {
  assert.equal(titles.displayTitle(NOISY), CLEAN);
  assert.equal(titles.displayTitle(HOST_PATH), '01. Introduction to Solution Architecture v2.1');
  assert.equal(titles.displayTitle(`${HOST_PATH} · p.3`), '01. Introduction to Solution Architecture v2.1 · p.3', 'a page suffix stays');
  assert.equal(titles.displayTitle('Week 3 / Replication'), 'Week 3 / Replication', 'a slash inside a normal title is not a path');
  assert.equal(titles.displayTitle('/etc notes'), '/etc notes');
  assert.equal(titles.displayTitle('Lecture 3 (diagram-normalized text)'), 'Lecture 3 (diagram-normalized text)');
  assert.equal(titles.displayTitle('第 3 讲 一致性.pdf'), '第 3 讲 一致性');
  assert.equal(titles.displayTitle(''), '');
});

test('the other name functions are gone, and the storage keeps only the file name', async () => {
  assert.equal(titles.cleanDocumentName, undefined, 'merged into displayTitle');
  assert.equal(titles.fileNameOf(HOST_PATH), '01. Introduction to Solution Architecture v2.1.pdf', 'a stored title is the file name, nothing more is thrown away');
  assert.equal(titles.fileNameOf(NOISY), NOISY);
  // No second implementation of the site-noise pattern anywhere in lib/ or ui/.
  const root = fileURLToPath(new URL('..', import.meta.url)), found = [];
  const scan = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'locales') await scan(path); }
      else if (/\.(js|jsx)$/.test(entry.name) && /1lib\|libgen/i.test(await readFile(path, 'utf8'))) found.push(path.slice(root.length).replaceAll('\\', '/'));
    }
  };
  await scan(join(root, 'lib')); await scan(join(root, 'ui'));
  assert.deepEqual(found, ['lib/document-title.js']);
});

const SHA = 'c'.repeat(64);
const at = '2026-10-01T10:00:00.000Z';
const pdfPage = (n) => ({ id: `pdf-${n}`, title: `${NOISY} · p.${n}`, text: `Page ${n}: replication and consensus.`, createdAt: at, courses: [],
  document: { id: SHA, filename: NOISY, bookTitle: NOISY, page: n, totalPages: 2, extractionVersion: 2, format: 'pdf', materialId: `document-${SHA}-pdf` } });
const derived = { id: 'txt', title: `${NOISY.replace(/\.pdf$/, '')} (diagram-normalized text)`, text: 'Replication: leader, followers, quorum.', createdAt: at, courses: [] };
const sources = [pdfPage(1), pdfPage(2), derived];

async function surfaces() {
  const ui = await loadUi(`
    export { default as Sources } from './ui/Sources.jsx';
    export { default as SourcePicker } from './ui/SourcePicker.jsx';
    export { coverageGroups } from './ui/coverage-groups.js';
    export { ReaderHeading } from './ui/document-preview/RenameTitle.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';`);
  return ui;
}

test('the same material has the same name on the 资料 page, in the picker, in the coverage list and in the reader', async () => {
  const ui = await surfaces();
  const data = { root: 'lib', sources, decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [] }, modelReady: true };
  const sourcesPage = withStudy(ui.StudyServicesContext, React.createElement(ui.Sources, { data, setModal: noop, onGenerate: noop }), { call: undefined });
  const page = renderToStaticMarkup(sourcesPage);
  const pageNames = [...page.matchAll(/<strong class="source-title"[^>]*>([^<]*)/g)].map((match) => match[1]);
  const picker = renderToStaticMarkup(React.createElement(ui.SourcePicker, { sources, selected: [], onChange: noop }));
  const pickerNames = [...picker.matchAll(/<strong title="[^"]*">([^<]*)<\/strong>/g)].map((match) => match[1]);
  const coverage = ui.coverageGroups(sources.map((source) => ({ id: source.id, title: source.title, planned: 1, accepted: 1 })), sources).map((group) => group.title);
  const reader = text(renderToStaticMarkup(React.createElement(ui.ReaderHeading, { data, source: sources[0] })));
  assert.deepEqual([...pageNames].sort(), [CLEAN, `${CLEAN} (diagram-normalized text)`].sort(), 'the 资料 page');
  assert.deepEqual([...pickerNames].sort(), [...pageNames].sort(), 'the picker');
  assert.deepEqual([...coverage].sort(), [...pageNames].sort(), 'the coverage list');
  assert.equal(reader.trim(), CLEAN, 'the reader header');
  assert.doesNotMatch(page.replace(/title="[^"]*"/g, ''), /z-library|1lib/, 'no site noise in what is drawn (a tooltip may keep the file\'s own name)');
});

test('the 资料 page says how materials made from one file belong together (#207 for the 资料 page)', async () => {
  const ui = await surfaces();
  const data = { root: 'lib', sources, decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [] }, modelReady: true };
  const page = text(renderToStaticMarkup(withStudy(ui.StudyServicesContext, React.createElement(ui.Sources, { data, setModal: noop, onGenerate: noop }), { call: undefined })));
  assert.match(page, new RegExp(`派生自 ${CLEAN.replace(/[()]/g, '\\$&')}(?! \\()`), 'the text version points at the original, named as everywhere');
  assert.match(page, /另有 1 份派生资料/, 'the original says it has a derived material');
  ui.setUiLanguage('en');
  try {
    const english = text(renderToStaticMarkup(withStudy(ui.StudyServicesContext, React.createElement(ui.Sources, { data, setModal: noop, onGenerate: noop }), { call: undefined })));
    assert.match(english, /Derived from Distributed Systems \(Mark Richards\)/);
    assert.match(english, /1 derived materials?/);
  } finally { ui.setUiLanguage('zh'); }
  const alone = text(renderToStaticMarkup(withStudy(ui.StudyServicesContext, React.createElement(ui.Sources, { data: { ...data, sources: [pdfPage(1), pdfPage(2)] }, setModal: noop, onGenerate: noop }), { call: undefined })));
  assert.doesNotMatch(alone, /派生/, 'a material with no relatives says nothing');
});

test('the 资料 page keeps the index badge\'s line from the first paint, like the picker', async () => {
  const ui = await surfaces();
  const data = { root: 'lib', sources, decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [] }, modelReady: true };
  const render = (call) => renderToStaticMarkup(withStudy(ui.StudyServicesContext, React.createElement(ui.Sources, { data, setModal: noop, onGenerate: noop }), { call }));
  const waiting = render(async () => new Promise(() => {}));
  assert.equal((waiting.match(/<article[^>]*class="source-row source-doc/g) || []).length, 2, 'two materials');
  assert.equal((waiting.match(/class="source-doc__index"/g) || []).length, 2, 'every row has its badge line before the coverage is known');
  assert.doesNotMatch(waiting, /class="sh-badge[^"]*index-badge/, 'and no badge yet');
  assert.doesNotMatch(render(undefined), /source-doc__index/, 'a host that cannot say draws no line');
});

test('a coverage answer re-renders only the rows whose own data changed', async () => {
  const { sourceRowPropsEqual } = await loadUi(`export { sourceRowPropsEqual } from './ui/Sources.jsx';`);
  const item = { key: 'a', sourceIds: ['a1'] }, source = { id: 'a1' };
  const info = { state: 'indexed', indexed: 1, stale: 0, total: 1 };
  const base = { item, source, isNew: false, organizing: false, selected: false, mastery: undefined, indexInfo: info, canIndex: true, slot: true, relation: null, advice: false,
    retrieval: null, courses: [], defaultCourse: '', canGenerate: true, canSegment: true, canRename: true, actions: {}, onOpenSettings: noop };
  assert.equal(sourceRowPropsEqual(base, { ...base }), true);
  assert.equal(sourceRowPropsEqual(base, { ...base, indexInfo: { ...info } }), true, 'a new coverage object of equal content re-renders nothing');
  assert.equal(sourceRowPropsEqual(base, { ...base, relation: null }), true);
  assert.equal(sourceRowPropsEqual(base, { ...base, indexInfo: { ...info, state: 'partial', indexed: 0 } }), false, 'its own coverage changes it');
  assert.equal(sourceRowPropsEqual({ ...base, indexInfo: null }, base), false, 'a badge arriving changes it');
  assert.equal(sourceRowPropsEqual(base, { ...base, relation: { role: 'derived', of: 'x' } }), false);
  assert.equal(sourceRowPropsEqual({ ...base, relation: { role: 'derived', of: 'x' } }, { ...base, relation: { role: 'derived', of: 'x' } }), true, 'an equal relation is no change');
  assert.equal(sourceRowPropsEqual(base, { ...base, selected: true }), false);
  assert.equal(sourceRowPropsEqual(base, { ...base, item: { ...item } }), false);
  assert.equal(sourceRowPropsEqual(base, { ...base, slot: false }), false);
});
