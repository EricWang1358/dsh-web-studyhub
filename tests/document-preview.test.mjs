import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { locateQuote, locateVisibleQuote, selectionRequest, sessionFileAddress, groupPassageLinks } from '../ui/document-preview/selection.js';

test('citation navigation does not choose the first repeated passage', () => {
  assert.equal(locateQuote('same passage; same passage', 'same passage').status, 'ambiguous');
  assert.deepEqual(locateQuote('same passage; same passage', 'same passage', { start: 14 }), { status: 'resolved', start: 14, end: 26 });
  assert.equal(locateQuote('edited passage', 'same passage', { start: 0 }).status, 'missing');
  assert.equal(locateQuote('new prefix; same passage', 'same passage', { start: 0 }).status, 'stale');
});

test('a selected passage carries its revision and page without inventing a byte offset', () => {
  assert.deepEqual(selectionRequest({ documentId: 'm1', revision: 'r2' }, { quote: 'visible words', prefix: 'before ', suffix: ' after', page: 3 }),
    { documentId: 'm1', revision: 'r2', quote: 'visible words', prefix: 'before ', suffix: ' after', page: 3 });
  assert.equal(selectionRequest({ documentId: 'm1', revision: 'r2' }, { quote: '   ' }), null);
});

test('host file resource addresses encode filename and session while retaining Windows drive', () => {
  assert.equal(sessionFileAddress('session 1', 'D:\\Notes\\资料 #1.pdf'), 'dsh-resource://file/session/session%201/D:/Notes/%E8%B5%84%E6%96%99%20%231.pdf');
});

test('one passage groups all related cards across decks without hiding stale links', () => {
  const selection = { documentId: 'm1', revision: 'r1', sourceId: 's1', start: 2, end: 7, quote: 'words' };
  const links = [{ deckId: 'a', cardId: 'q1', selection, status: 'resolved' }, { deckId: 'b', cardId: 'q2', selection, status: 'stale' }];
  const groups = groupPassageLinks(links);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].links.length, 2);
  assert.equal(groups[0].links[1].status, 'stale');
});

test('legacy extracted material selections retain the source identity', () => {
  assert.equal(selectionRequest({ documentId: 'source-old', sourceId: 'old', revision: 'r1' }, { quote: 'old notes' }).sourceId, 'old');
});

test('rendered table marks use context across source separators and keep repeated passages ambiguous', () => {
  assert.deepEqual(locateVisibleQuote('Headingleft rightEnding', { quote: 'left\tright', prefix: 'Heading\n', suffix: '\nEnding' }), { status: 'resolved', start: 7, end: 17 });
  assert.equal(locateVisibleQuote('left right; left right', { quote: 'left\tright' }).status, 'ambiguous');
});

const compiled = await build({ stdin: { contents: `export { registerDocumentLearning } from './ui/document-preview/native.jsx';
  export { default as CitationDisclosure } from './ui/CitationDisclosure.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { registerDocumentLearning, CitationDisclosure } = module.exports;

test('native document extension uses the public toolbar and renderer registrations and disposes both', () => {
  const registrations = [], definitions = [], effects = [], disposed = [];
  const slots = { inject: (_name, initialize) => initialize(), register: (definition, component) => {
    registrations.push({ definition, component }); return () => disposed.push(definition.name);
  } };
  const ctx = { slots, effect: initialize => { const dispose = initialize(); if (dispose) effects.push(dispose); },
    inject: (_dependencies, initialize) => {
      const dispose = initialize({ slots, documentPreviews: { register: definition => {
        definitions.push(definition); return () => disposed.push(definition.id);
      } } }); effects.push(dispose);
    } };
  globalThis.window = { document: { createElement: () => ({ remove: () => disposed.push('style') }), head: { append: () => {} } } };
  try {
    registerDocumentLearning(ctx, () => {}, () => {});
    assert.deepEqual(registrations.map(item => item.definition.name), ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document']);
    assert.deepEqual(definitions[0].extensions, ['html', 'htm']);
    assert.equal(definitions[0].loading, 'text-pages');
    effects.reverse().forEach(dispose => dispose());
    assert.ok(disposed.includes('study-html'));
    assert.ok(disposed.includes('sidebar.right.tab.document.actions'));
    assert.ok(disposed.includes('sidebar.right.tab.document'));
  } finally { delete globalThis.window; }
});

test('card selections expose a source entry', () => {
  const citations = renderToStaticMarkup(React.createElement(CitationDisclosure, { card: { selections: [{ sourceId: 's1', quote: 'passage', revision: 'r1' }] },
    sources: [{ id: 's1', text: 'passage' }], onOpenSource: () => {} }));
  assert.match(citations, /引用与来源核对/);
  assert.match(citations, /1.*条/);
  const selection = { sourceId: 's1', quote: 'passage', revision: 'r1' };
  const copied = renderToStaticMarkup(React.createElement(CitationDisclosure, { card: { selections: [selection], citations: [{ sourceId: 's1', quote: 'passage', selection: structuredClone(selection) }] }, sources: [], onOpenSource: () => {} }));
  assert.match(copied, /1.*条/);
});

/* #456: the page a question in 原始 PDF is about comes from the page the reader's own controls show. */
test('the page scope names the page source, a page without saved text, and the page selection without a quote', async () => {
  const { pageScopeOf, pageSelection, pageCount, clampPage, pageKey } = await import('../ui/document-preview/page-scope.js');
  const sources = [{ id: 'p1', text: 'One', document: { page: 1, totalPages: 4 } }, { id: 'p2', text: '  \n', document: { page: 2, totalPages: 4 } },
    { id: 'p4', text: 'Four', document: { page: 4, totalPages: 4 } }];
  assert.deepEqual(pageScopeOf(sources, 1), { kind: 'page', page: 1, sourceId: 'p1', empty: false });
  assert.equal(pageScopeOf(sources, 2).empty, true, 'a page of blanks has nothing to answer from');
  assert.deepEqual(pageScopeOf(sources, 3), { kind: 'page', page: 3, sourceId: '', empty: true }, 'a page skipped on import');
  assert.equal(pageScopeOf([{ id: 'c', chars: 40, document: { page: 1 } }], 1).empty, false, 'a converted page without its text still counts its characters');
  assert.equal(pageCount(sources), 4); assert.equal(pageCount([{ id: 'a' }, { id: 'b' }]), 2);
  const document = { documentId: 'doc', revision: 'r1' };
  assert.deepEqual(pageSelection(document, pageScopeOf(sources, 4)), { documentId: 'doc', revision: 'r1', sourceId: 'p4', page: 4 });
  assert.equal(pageSelection(document, pageScopeOf(sources, 3)), null);
  assert.equal(pageSelection(document, null), null);
  assert.equal(clampPage('3', 4), 3); assert.equal(clampPage(9, 4), 4); assert.equal(clampPage(0, 4), 1); assert.equal(clampPage('2.6', 4), 3);
  assert.equal(clampPage('', 4), null); assert.equal(clampPage('abc', 4), null);
  assert.notEqual(pageKey({ documentId: 'doc', revision: 'r1', sourceId: 'p1', page: 1 }), pageKey({ documentId: 'doc', revision: 'r1', sourceId: 'p4', page: 4 }));
});

test('原始 PDF: a selection is never captured or shown there, the reading panel is kept for the way back, and the frame follows the page controls', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../ui/document-preview/DocumentViewer.jsx', import.meta.url), 'utf8');
  assert.match(viewer, /if \(localMode \|\| view === 'original'\) return;/, 'select() ignores the PDF view');
  assert.doesNotMatch(viewer, /setCapture\(null\); \}, \[view\]/, 'the selection of 阅读 is not dropped by a visit to 原始 PDF (it comes back with its thread)');
  // Two panels: the reading one keeps its selection, its thread and a question still being answered (kept as 批注), only hidden in 原始 PDF;
  // the page one is its own, so a page turn never resets the reading thread.
  assert.match(viewer, /<div className="reader-learning" data-scope="selection" hidden=\{view === 'original'\}>\s*<DocumentLearning call=\{call\} document=\{learningDocument\} capture=\{capture\} data=\{data\} annotation=\{annotation\}/);
  assert.match(viewer, /<div className="reader-learning" data-scope="page" hidden=\{view !== 'original'\}>\s*<DocumentLearning call=\{call\} document=\{learningDocument\} capture=\{null\} scope=\{pageScope\}/);
  assert.match(viewer, /\{view !== 'original' && <Button className="study-document-wide" icon="plus"[^\n]*使用当前选区/, '使用当前选区 is not offered there');
  assert.match(viewer, /\{onCaseFromPassage && view !== 'original' && <Button/, '围绕这段出案例题 is not offered there');
  assert.match(viewer, /if \(view === 'original'\) setMode\('read'\); \/\/ a kept passage is shown where it can be selected/, 'a kept annotation opened from the links goes back to 阅读');
  assert.match(viewer, /\{!toolsOn && <> <Button variant="link" size="sm" onClick=\{\(\) => toggle\('tools'\)\}>\{ui\('问这一页'\)\}<\/Button><\/>\}/, '「问这一页」 opens a closed panel');
  assert.match(viewer, /<PdfPageBar page=\{pdfPage\} total=\{totalPages\} onPage=\{goToPage\} \/>[\s\S]{0,240}<iframe key=\{pdfPage\} src=\{`\$\{fileUrl\}#page=\$\{pdfPage\}`\}/, 'a new frame per page: a changed #page= alone is ignored by the PDF viewer');
  assert.doesNotMatch(viewer, /要选中文字提问或补题，请切换到「阅读」。'\)\}<\/p>/, 'the old dead-end hint is gone');
});

test('原始 PDF: a page answer keeps its page scope on 重试 and its cut note when the page comes back', async () => {
  const { readFile } = await import('node:fs/promises');
  const learning = await readFile(new URL('../ui/document-preview/DocumentLearning.jsx', import.meta.url), 'utf8');
  // The scope of a run is the panel's own, never read from a resolution the server may have replaced.
  assert.match(learning, /held = threadKey\(resolution\), page = pageMode;/);
  assert.match(learning, /if \(page\) setPageRefusal\(value\); else setResolution\(value\);/, 'a refusal is held beside the page, the page resolution stays');
  assert.match(learning, /setPageCut\(cuts\.current\.get\(pageKey\(selection\)\) \|\| null\)/, 'the cut note returns with the held thread of its page');
  assert.match(learning, /const listed = !pageMode && available\('generation', 'selection\.jobs'\);/, 'the page panel does not follow the jobs a second time');
});
