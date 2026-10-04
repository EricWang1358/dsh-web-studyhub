import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { documentBytes } from '../lib/contexts/materials/files.js';
import { importError } from '../lib/import-errors.js';
import { classifyImportFailure } from '../lib/large-documents.js';

// UI wave 2, WP-M: the import hub reads one set of limits and formats, and classifies failures by code (#120 #121 #122 #127).
const read = file => readFileSync(file, 'utf8');
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };
const require = createRequire(import.meta.url);
const MB = 1024 * 1024;

/** ImportHub bundled with some limit constants rewritten, to prove the copy follows the constants and not a literal. */
async function load(patches = []) {
  const plugin = { name: 'patch-limits', setup(b) {
    b.onLoad({ filter: /lib[\\/](office[\\/]limits|large-documents)\.js$/ }, async args => {
      let text = read(args.path);
      for (const [from, to] of patches) text = text.replace(from, to);
      return { contents: text, loader: 'js' };
    });
  } };
  const out = await build({ stdin: { contents: `export * from './ui/ImportHub.jsx'; export { default } from './ui/ImportHub.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent', plugins: [plugin] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const hub = await load();
const failure = (code, limit, message = 'x') => Object.assign(new Error(message), { code, ...(limit === undefined ? {} : { details: { limit } }) });

test('the backend names its import failures: a code and the limit it enforced (#122)', async () => {
  const error = importError('Document exceeds 8 MB', 'document-too-large', 8 * MB);
  assert.equal(error.message, 'Document exceeds 8 MB');
  assert.equal(error.code, 'document-too-large');
  assert.equal(error.limit, 8 * MB);
  assert.equal(importError('x', 'pdf-invalid').limit, undefined);
  const big = 'A'.repeat(Math.ceil(8 * MB / 3) * 4 + 4);
  await assert.rejects(documentBytes({ dataBase64: big }, 'pdf'), e => e.code === 'document-too-large' && e.limit === 8 * MB && /exceeds 8 MB/.test(e.message));
  await assert.rejects(documentBytes({ dataBase64: 'A'.repeat(Math.ceil(40 * MB / 3) * 4 + 4) }, 'docx'), e => e.code === 'office-too-large' && e.limit === 40 * MB);
  has('lib/documents.js', /pdf-too-many-pages|TOO_MANY_PAGES/);
  has('lib/office/index.js', /text-too-long|TEXT_TOO_LONG/);
  has('lib/host.js', /details:[^\n]*limit/);
});

test('the large-document advice reads the code before it reads the words (#122)', () => {
  assert.equal(classifyImportFailure(failure('pdf-too-many-pages', 200, 'anything')), 'pdf-pages');
  assert.equal(classifyImportFailure(failure('text-too-long', 600000, 'anything')), 'text-chars');
  assert.equal(classifyImportFailure(failure('office-too-large', 40 * MB, 'anything')), 'office-size');
  assert.equal(classifyImportFailure(failure('document-too-large', 8 * MB, 'anything')), 'pdf-size');
  assert.equal(classifyImportFailure(new Error('Document exceeds 8 MB')), 'pdf-size', 'an older host still gets the wording fallback');
  assert.equal(classifyImportFailure(failure('pdf-invalid', 8 * MB, 'not a valid PDF')), null);
});

test('import failures are explained by code, with the number the host sent (#122)', () => {
  hub.setUiLanguage('zh');
  assert.match(hub.plainImportError(failure('document-too-large', 8 * MB)), /文件超过 8 MB。请按章节拆分/);
  assert.match(hub.plainImportError(failure('document-too-large', 10 * MB)), /文件超过 10 MB/);
  assert.match(hub.plainImportError(failure('office-too-large', 40 * MB)), /文件超过 40 MB。请压缩图片/);
  assert.match(hub.plainImportError(failure('pdf-too-many-pages', 150)), /PDF 超过 150 页/);
  assert.match(hub.plainImportError(failure('text-too-long', 500000)), /超过 500,000 字符/);
  assert.match(hub.plainImportError(failure('text-too-long', 600000)), /超过 600,000 字符/);
  assert.match(hub.plainImportError(failure('pdf-invalid', 8 * MB)), /这个 PDF 读不出来.*8 MB/);
  assert.match(hub.plainImportError(failure('text-not-utf8')), /UTF-8/);
  assert.match(hub.plainImportError(failure('encrypted')), /密码保护/);
  assert.match(hub.plainImportError(failure('zip64')), /展开后太大/);
  assert.match(hub.plainImportError(failure('format-unsupported')), /不支持这种文件/);
  assert.match(hub.plainImportError(failure('upload-incomplete')), /没能完整读取/);
  for (const code of ['document-too-large', 'office-too-large', 'pdf-too-many-pages', 'text-too-long', 'pdf-invalid', 'text-not-utf8', 'encrypted', 'ole', 'zip64', 'bomb', 'too-many-entries', 'format-unsupported'])
    assert.equal(hub.isPermanentImportError(failure(code, 1)), true, code);
  assert.equal(hub.isPermanentImportError(failure('upload-incomplete')), false);
  assert.equal(hub.plainImportError(failure('corrupt'), { format: 'docx' }).includes('Word'), true);
  assert.equal(hub.plainImportError(failure('invalid'), { format: 'pptx' }).includes('PowerPoint'), true);
  hub.setUiLanguage('en');
  try {
    assert.match(hub.plainImportError(failure('document-too-large', 10 * MB)), /larger than 10 MB/);
    assert.doesNotMatch(hub.plainImportError(failure('pdf-too-many-pages', 150)), /[㐀-鿿]/);
  } finally { hub.setUiLanguage('zh'); }
});

test('an older host that sends words and no code still gets the same explanation (#122 fallback)', () => {
  hub.setUiLanguage('zh');
  assert.match(hub.plainImportError(new Error('Document exceeds 8 MB')), /文件超过 8 MB/);
  assert.match(hub.plainImportError(new Error('Document exceeds 40 MB')), /文件超过 40 MB/);
  assert.match(hub.plainImportError(new Error('PDF 超过 200 页，请先按章节拆分')), /PDF 超过 200 页/);
  assert.match(hub.plainImportError(new Error('Extracted text exceeds 600,000 characters')), /600,000 字符/);
  assert.match(hub.plainImportError(new Error('Text documents must use UTF-8 encoding')), /UTF-8/);
  assert.equal(hub.plainImportError(new Error('Something else broke')), 'Something else broke');
  assert.equal(hub.isPermanentImportError(new Error('Document exceeds 8 MB')), true);
});

test('changing a limit constant changes the number the learner reads (#122 #121)', async () => {
  const patched = await load([[/MAX_TEXT_DOCUMENT_BYTES = 8 \* MB/, 'MAX_TEXT_DOCUMENT_BYTES = 10 * MB'], [/pdfPages: 200/, 'pdfPages: 150'], [/selectionChars: 600000/, 'selectionChars: 500000']]);
  patched.setUiLanguage('zh');
  const file = { name: 'book.pdf', size: 11 * MB };
  const results = await patched.runImport([file], { call: async () => { throw new Error('must not reach the host'); } });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /文件超过 10 MB。请按章节拆分/);
  assert.equal(results[0].permanent, true);
  // The same constant feeds the hint under the drop zone and the paste box (maxlength and the counter).
  const html = renderToStaticMarkup(React.createElement(patched.default, { data: { focus: {} }, call: async () => ({}), initialTab: 'paste' }));
  assert.match(html, /maxLength="500000"|maxlength="500000"/i);
  assert.match(html, /0 \/ 500,000 字符/);
  const files = renderToStaticMarkup(React.createElement(patched.default, { data: { focus: {} }, call: async () => ({}) }));
  assert.match(files, /PDF 与文本最大 10 MB/);
  patched.setUiLanguage('en');
  try {
    const english = renderToStaticMarkup(React.createElement(patched.default, { data: { focus: {} }, call: async () => ({}), initialTab: 'paste' }));
    assert.match(english, /0 \/ 500,000 characters/);
  } finally { patched.setUiLanguage('zh'); }
});

test('the hub keeps no private copy of what a shared module already says (#120 #121 #127)', () => {
  lacks('ui/ImportHub.jsx', /const MB = /, /const extensionOf/, /const AUDIO_EXTENSIONS = \[/, /MAX_SUBTITLE_BYTES = /, /maxLength=\{600000\}/, /\/ 600,000/, /toLocaleString\(/,
    /async function fileToBase64/, /createDialogDropGuard/, /closest\('dialog'\)/);
  has('ui/ImportHub.jsx', /from '\.\/upload\.js'/, /from '\.\/file-names\.js'/, /from '\.\.\/lib\/audio-formats\.js'/, /SELECTION_CHARS/, /formatNumber/);
  has('ui/app/modals/AddSourceDialog.jsx', /guardDrops/);
  assert.equal(typeof hub.fileToBase64, 'undefined', 'the one Base64 lives in ui/upload.js');
  assert.equal(typeof hub.createDialogDropGuard, 'undefined');
});

test('the hub still routes files by extension from the shared lists (#120)', () => {
  assert.equal(hub.routeImportFile({ name: 'a.MP3' }, { audio: true }), 'audio');
  assert.equal(hub.routeImportFile({ name: 'a.mp3' }), null);
  assert.equal(hub.routeImportFile({ name: 'a.vtt' }, { audio: true }), 'subtitle');
  assert.equal(hub.routeImportFile({ name: 'a.srt' }), null);
  assert.equal(hub.routeImportFile({ name: 'recording' }, { audio: true }), null, 'a name without a dot is not its last letter');
  assert.equal(hub.routeImportFile({ name: 'notes.docx' }), 'document');
  assert.equal(hub.routeImportFile({ name: 'old.doc' }), 'legacy');
  assert.ok(hub.importAccept({ audio: true }).includes('.flac'));
  assert.ok(!hub.importAccept().includes('.flac'));
});
