import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as ImportHub, routeImportFile, importAccept, documentLimit, runImport, itemDetail, plainImportError, MAX_DOCUMENT_BYTES } from './ui/ImportHub.jsx';
      export { describeAccept } from './ui/components/FileDrop.jsx';
      export { sourceFormatLabel } from './ui/SourcePicker.jsx';
      export { default as DocumentViewer, originalHandling, sourceTextClass, viewerFormat } from './ui/document-preview/DocumentViewer.jsx';
      export { splitParagraphs } from './ui/document-preview/reader/text-sections.js';
      export { collectHeadings } from './ui/document-preview/reader/outline.js';
      export { diagnosticText } from './ui/diagnostics.js';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const {
  ImportHub, routeImportFile, importAccept, documentLimit, runImport, itemDetail, plainImportError, MAX_DOCUMENT_BYTES,
  describeAccept, sourceFormatLabel, DocumentViewer, originalHandling, sourceTextClass, viewerFormat,
  splitParagraphs, collectHeadings, diagnosticText, setUiLanguage,
} = mod.exports;

const han = /[\u3400-\u9fff]/;

test('ImportHub, FileDrop and SourcePicker accept and label LaTeX (.tex, .ltx, .latex) in Chinese and English', async () => {
  for (const name of ['lec04.tex', 'HANDOUT.TEX', 'chapter.ltx', 'paper.latex']) {
    assert.equal(routeImportFile({ name }, { audio: false }), 'document', name);
    assert.equal(routeImportFile({ name }, { audio: true }), 'document', name);
    assert.equal(documentLimit(name), MAX_DOCUMENT_BYTES, name);
  }
  const accept = importAccept({ audio: true });
  for (const ext of ['.tex', '.ltx', '.latex']) assert.ok(accept.includes(ext), ext);
  assert.equal(new Set(accept).size, accept.length);
  assert.equal(describeAccept(['.pdf', '.tex', '.ltx', '.latex']), 'PDF · LaTeX');

  const texSource = { id: 's1', title: 'Lecture 4', text: '# Convex Sets\n\nLet $x \\in \\mathbb{R}^n$.', courses: ['CS3230'],
    document: { id: 'h'.repeat(64), materialId: 'document-h-tex', format: 'tex', filename: 'lec04.tex' } };
  assert.equal(sourceFormatLabel(texSource), 'LaTeX');
  assert.equal(sourceFormatLabel({ format: 'tex', sourceIds: ['s1'] }), 'LaTeX');

  const data = { root: 'lib', sources: [], decks: [], drafts: [], focus: { course: 'CS3230', courses: [{ name: 'CS3230' }] } };
  setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(React.createElement(ImportHub, { data, call: async () => ({}), course: 'CS3230', onCourseChange() {} }));
  assert.match(zhHtml, /Markdown · LaTeX · HTML · TXT/);
  assert.match(plainImportError(Object.assign(new Error('bad'), { code: 'format-unsupported' })), /LaTeX/);

  const fakeFile = { name: 'lec04.tex', size: 128, arrayBuffer: async () => Buffer.from('\\section{Intro}\nHello').buffer, text: async () => '' };
  const results = await runImport([fakeFile], {
    courses: ['CS3230'],
    call: async (action, args) => {
      assert.equal(action, 'materials.document.import');
      assert.equal(args.filename, 'lec04.tex');
      return { documentId: 'document-1-tex', sourceIds: ['s1'], document: { title: 'Lecture 4', format: 'tex' } };
    },
  });
  assert.equal(results[0].status, 'done');
  assert.equal(itemDetail(results[0]), 'LaTeX · 已保存到资料');

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(ImportHub, { data, call: async () => ({}), course: 'CS3230', onCourseChange() {} })).replace(/<[^>]+>/g, ' ');
    assert.match(enHtml, /Markdown · LaTeX · HTML · TXT/);
    assert.doesNotMatch(enHtml, han);
    assert.equal(itemDetail(results[0]), 'LaTeX · saved to Sources');
    assert.match(plainImportError(Object.assign(new Error('bad'), { code: 'format-unsupported' })), /LaTeX/);
  } finally {
    setUiLanguage('zh');
  }
});

test('DocumentViewer handles .tex originals as downloadable files while rendering extracted sections and formulas', () => {
  assert.equal(originalHandling({ originalAvailable: true, format: 'tex' }), 'download');
  assert.equal(originalHandling({ originalAvailable: false, format: 'tex' }), 'none');
  assert.match(sourceTextClass({ format: 'tex' }), /source-text--reading/);
  const texSource = {
    id: 'tex-1',
    title: 'Lecture 4',
    text: '# Convex Sets\n\nWe work in $\\mathbb{R}^d$.\n\n## Subgradients\n\nEvery convex function has subgradients.',
    courses: [],
    document: { id: 'a'.repeat(64), materialId: 'document-a-tex', filename: 'lec04.tex', format: 'tex' },
  };
  assert.equal(viewerFormat(null, texSource), 'tex');
  const html = renderToStaticMarkup(React.createElement(DocumentViewer, { source: texSource, call: async () => ({}), data: { decks: [] } }));
  assert.match(html, /Convex Sets/);
  assert.match(html, /reader-math__source/);

  // Verify markedOnly heading collection strips hidden `# ` brackets and preserves relative hierarchy (1 -> 2).
  const makeHeading = (mark, title) => ({
    tagName: 'H4',
    dataset: {},
    textContent: `${mark}${title}`,
    closest: () => null,
    querySelector: sel => sel === '.reader-bracket' ? { textContent: mark } : sel === '[data-study-marker]' ? null : null,
    cloneNode: () => ({
      textContent: title,
      querySelectorAll: () => [],
    }),
  });
  const plainShortHeading = {
    tagName: 'H4',
    dataset: {},
    textContent: 'Short Plain Line',
    closest: () => null,
    querySelector: () => null,
    cloneNode: () => ({ textContent: 'Short Plain Line', querySelectorAll: () => [] }),
  };
  const fakeRoot = { querySelectorAll: () => [makeHeading('# ', 'Convex Sets'), makeHeading('## ', 'Subgradients'), plainShortHeading] };
  const collected = collectHeadings(fakeRoot, { markedOnly: true });
  assert.deepEqual(collected, [
    { id: 'h-0', level: 1, title: 'Convex Sets' },
    { id: 'h-1', level: 2, title: 'Subgradients' },
  ]);
});

test('splitParagraphs keeps norms and aligned gaps inside formulas as prose while preserving pipe tables as layout', () => {
  const proseWithNorm = 'For any convex $f: \\mathbb{R}^d \\to \\mathbb{R}$,\n\\begin{equation}\nx^\\star \\in \\operatorname*{arg\\,min}_{x} f(x) + \\lambda \\|x\\|_2^2.\n\\end{equation}\n\n| Method | Rate |\n| --- | --- |\n| GD | $O(1/k)$ |';
  const paragraphs = splitParagraphs(proseWithNorm);
  assert.deepEqual(paragraphs.map(p => p.kind), ['prose', 'layout']);
});

test('diagnostics redacts learner .tex, .ltx and .latex filenames in engine-shaped messages', () => {
  for (const message of ['secret_handout.tex is not a function', 'chapter1.ltx is not iterable', 'thesis.latex is not a constructor']) {
    const text = diagnosticText({ version: '4.7.5', language: 'en', page: 'sources', error: new TypeError(message) });
    assert.doesNotMatch(text, /secret_handout|chapter1|thesis/, message);
    assert.match(text, /not copied:/, message);
  }
});
