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
