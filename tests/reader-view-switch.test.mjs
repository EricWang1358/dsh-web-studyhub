/* #1001, the two rules of the reader toolbar and the 公式乱码 notice, beside originalHandling in DocumentViewer.jsx: the 文字 | 原始 PDF switch is there
   only for an original shown in place (a PDF whose file is here; .tex and Office originals are download-only), and 用 MinerU 重新转换 is offered only
   when the reader can hand the whole PDF to the 添加资料 › PDF 解析 entry (not for a book MinerU made, not for an original served page by page). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { showsViewSwitch, offersReconvert } from './ui/document-preview/DocumentViewer.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { showsViewSwitch, offersReconvert } = mod.exports;

test('the 文字 | 原始 PDF switch is only for a PDF original that is here (gate review of #1021)', () => {
  const pdf = { originalAvailable: true, format: 'pdf' };
  assert.equal(showsViewSwitch({ document: pdf, fileUrl: 'blob:pdf' }), true);
  assert.equal(showsViewSwitch({ document: pdf, fileUrl: '' }), false, 'no file yet (or none): no switch, 补全原文件 as before');
  assert.equal(showsViewSwitch({ document: pdf, fileUrl: 'blob:pdf', localMode: true }), false, 'saved writing');
  assert.equal(showsViewSwitch({ document: { originalAvailable: false, format: 'pdf' }, fileUrl: 'blob:pdf' }), false, 'the original is not kept');
  for (const format of ['tex', 'docx', 'pptx', 'xlsx']) {
    assert.equal(showsViewSwitch({ document: { originalAvailable: true, format }, fileUrl: 'blob:x' }), false, `${format}: the original is download-only`);
  }
  assert.equal(showsViewSwitch({ document: { originalAvailable: true, format: 'md' }, fileUrl: 'blob:x' }), false, 'a text original is not a PDF view');
});

test('用 MinerU 重新转换 is offered only when the whole PDF can go to PDF 解析 (gate review of #1021)', () => {
  const base = { onReconvert: () => {}, canImport: true, converter: 'pdfjs', fileUrl: 'blob:pdf' };
  assert.equal(offersReconvert(base), true);
  assert.equal(offersReconvert({ ...base, onReconvert: undefined }), false, 'no entry to open');
  assert.equal(offersReconvert({ ...base, canImport: false }), false, 'PDF 解析 is not available here');
  assert.equal(offersReconvert({ ...base, converter: 'mineru' }), false, 'MinerU made this book already');
  assert.equal(offersReconvert({ ...base, fileUrl: '' }), false, 'no file');
  assert.equal(offersReconvert({ ...base, fileUrl: 'studyhub-pages:document-d:rev-1' }), false, 'served page by page: the dialog would open without the file');
});
