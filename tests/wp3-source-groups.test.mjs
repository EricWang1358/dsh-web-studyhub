import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSourcesByDocument, documentSourceIds, countDocuments, sourceFormat, isLegacyExtraction } from '../lib/source-groups.js';

/* P18: a PDF is one material, not one material per page. Fixtures copy the
   shapes written by materials.document.import (lib/contexts/materials/
   operations.js + lib/documents.js) and the older source.import path. */
const SHA = 'a'.repeat(64), OTHER = 'b'.repeat(64), MD = 'c'.repeat(64);
const materialId = `document-${SHA}-pdf`;
const imported = '2026-09-30T08:00:00.000Z';
const pdfPage = (page, extra = {}) => ({
  id: `pdf-${SHA}-text2-p${page}`, title: `lecture5-memory.pdf · p.${page}`, text: `第 ${page} 页：内存管理与分页。`.repeat(page),
  createdAt: imported, importedAt: imported, courses: ['操作系统'], coursesInferred: false, usedBy: [],
  document: { id: SHA, filename: 'lecture5-memory.pdf', page, totalPages: 6, extractionVersion: 2, sparseText: false, warnings: [],
    materialId, materialRevision: `${SHA}-pdf-text2`, format: 'pdf' },
  ...extra,
});
// source.import (legacy PdfImport) writes the same ids and document.id, but no material record.
const legacyImportPage = (page, extra = {}) => ({
  id: `pdf-${SHA}-text2-p${page}`, title: `lecture5-memory.pdf · p.${page}`, text: `旧路径导入的第 ${page} 页。`,
  createdAt: '2026-09-28T10:00:00.000Z', courses: ['操作系统'], usedBy: [],
  document: { id: SHA, filename: 'lecture5-memory.pdf', page, totalPages: 6, extractionVersion: 2, sparseText: false, warnings: [] },
  ...extra,
});
const markdown = {
  id: `document-${MD}-md-${MD}-md-text1-s1`, title: 'os-scheduling.md', text: '# 调度\n先来先服务、时间片轮转。',
  createdAt: imported, importedAt: imported, courses: ['操作系统'], usedBy: [],
  document: { materialId: `document-${MD}-md`, materialRevision: `${MD}-md-text1`, format: 'md', filename: 'os-scheduling.md' },
};
const pasted = { id: 'src-pasted', title: '进程与线程 · 第 3 周', text: '进程是资源分配单位，线程是调度单位。', createdAt: '2026-09-29T09:00:00.000Z', courses: [], usedBy: [] };
const audio = (index) => ({
  id: `audio-batch-B1${index ? `-p${index + 1}` : ''}`, title: `Lecture 7 · 中英对照逐字稿 (${index + 1}/2)`, text: 'transcript '.repeat(index + 3),
  createdAt: imported, courses: ['操作系统'], usedBy: [],
  audio: { importedAt: imported, sourceIds: ['audio-batch-B1', 'audio-batch-B1-p2'], batch: { id: 'B1', title: 'Lecture 7', volume: index + 1, volumes: 2 } },
});

test('a PDF imported page by page becomes one document with an ordered page list', () => {
  const groups = groupSourcesByDocument([pdfPage(3), pasted, pdfPage(1), pdfPage(2, { usedBy: [{ id: 'd1', title: 'Paging', kind: 'deck' }] })]);
  assert.equal(groups.length, 2);
  const [pdf, text] = groups;
  assert.equal(pdf.format, 'pdf');
  assert.equal(pdf.title, 'lecture5-memory.pdf');
  assert.equal(pdf.documentId, materialId);
  assert.deepEqual(pdf.sourceIds, [1, 2, 3].map(page => `pdf-${SHA}-text2-p${page}`));
  assert.deepEqual(pdf.pages.map(page => page.page), [1, 2, 3]);
  assert.deepEqual(pdf.pages.map(page => page.sourceId), pdf.sourceIds);
  assert.equal(pdf.pages[1].chars, pdfPage(2).text.length);
  assert.equal(pdf.chars, [1, 2, 3].reduce((sum, page) => sum + pdfPage(page).text.length, 0));
  assert.equal(pdf.totalPages, 6);
  assert.equal(pdf.createdAt, imported);
  assert.deepEqual(pdf.courses, ['操作系统']);
  assert.deepEqual(pdf.usedBy.map(deck => deck.id), ['d1']);
  assert.deepEqual(pdf.warnings, []);
  assert.equal(text.format, 'text');
  assert.equal(text.title, pasted.title);
  assert.deepEqual(text.sourceIds, ['src-pasted']);
  assert.equal(text.documentId, null);
});

test('materials.document.import and legacy source.import pages of one PDF group into one item', () => {
  const groups = groupSourcesByDocument([legacyImportPage(4), pdfPage(1), pdfPage(2)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].pages.map(page => page.page), [1, 2, 4]);
  assert.equal(groups[0].documentId, materialId, 'the material record wins over the legacy id');
  assert.equal(groups[0].createdAt, imported, 'the newest import date dates the document');
  const legacyOnly = groupSourcesByDocument([legacyImportPage(1), legacyImportPage(2)]);
  assert.equal(legacyOnly.length, 1);
  assert.equal(legacyOnly[0].documentId, `legacy-${SHA}`);
  assert.equal(legacyOnly[0].title, 'lecture5-memory.pdf');
});

test('pages extracted by the first parser are flagged instead of counted twice silently', () => {
  const old = { id: `pdf-${SHA}-p1`, title: 'lecture5-memory.pdf · p.1', text: 'old parser text', createdAt: '2026-09-01T00:00:00.000Z',
    document: { id: SHA, filename: 'lecture5-memory.pdf', page: 1, totalPages: 6 } };
  const [item] = groupSourcesByDocument([pdfPage(1), old]);
  assert.deepEqual(item.pages.map(page => [page.page, !!page.legacy]), [[1, false], [1, true]]);
  assert.ok(item.warnings.includes('legacy-extraction'));
  assert.equal(isLegacyExtraction(old), true);
  assert.equal(isLegacyExtraction(pdfPage(1)), false);
});

test('fresh Markdown, HTML and TXT documents are never legacy extractions (P22)', () => {
  for (const format of ['md', 'html', 'txt']) {
    const source = { ...markdown, document: { ...markdown.document, format } };
    assert.equal(isLegacyExtraction(source), false, format);
    assert.equal(sourceFormat(source), format);
    const [item] = groupSourcesByDocument([source]);
    assert.equal(item.format, format);
    assert.deepEqual(item.warnings, []);
    assert.equal(item.documentId, markdown.document.materialId);
  }
});

test('layout and sparse-text warnings surface on the document', () => {
  const [item] = groupSourcesByDocument([pdfPage(1), pdfPage(2, { document: { ...pdfPage(2).document, sparseText: true, warnings: ['rotated'] } })]);
  assert.deepEqual([...item.warnings].sort(), ['layout', 'sparse']);
});

test('non-document sources stay single items; a split transcript is one recording', () => {
  const json = { id: 'json-1', title: 'JSON 导入：期中复习', text: '{}', provenance: 'json-card-self-reference', createdAt: imported };
  const groups = groupSourcesByDocument([pasted, audio(1), json, audio(0), markdown]);
  assert.deepEqual(groups.map(group => group.format), ['text', 'audio', 'json', 'md']);
  const recording = groups[1];
  assert.equal(recording.title, 'Lecture 7');
  assert.deepEqual(recording.sourceIds, ['audio-batch-B1', 'audio-batch-B1-p2']);
  assert.deepEqual(recording.pages.map(page => page.page), [1, 2]);
});

test('grouping is stable, tolerant and keeps keys unique', () => {
  const input = [pdfPage(2), markdown, pasted, pdfPage(1)];
  assert.deepEqual(groupSourcesByDocument(input), groupSourcesByDocument(input));
  assert.deepEqual(groupSourcesByDocument([...input].reverse()).map(group => group.key).sort(), groupSourcesByDocument(input).map(group => group.key).sort());
  const keys = groupSourcesByDocument(input).map(group => group.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(groupSourcesByDocument(undefined), []);
  assert.deepEqual(groupSourcesByDocument([]), []);
  // source.list summaries carry chars instead of text.
  const [summary] = groupSourcesByDocument([{ id: 'x', title: 'Summary', chars: 42 }]);
  assert.equal(summary.chars, 42);
  const other = { ...pdfPage(1), id: `pdf-${OTHER}-text2-p1`, document: { ...pdfPage(1).document, id: OTHER, materialId: `document-${OTHER}-pdf` } };
  assert.equal(groupSourcesByDocument([pdfPage(1), other]).length, 2, 'different PDFs never merge');
});

test('sample material is marked; helpers count documents and expand one page to its document', () => {
  const sample = { ...pasted, id: 'sample-memento', sample: true };
  const groups = groupSourcesByDocument([sample, pasted]);
  assert.equal(groups[0].sample, true);
  assert.equal('sample' in groups[1], false);
  const sources = [pdfPage(1), pdfPage(2), pdfPage(3), markdown, pasted];
  assert.equal(countDocuments(sources), 3);
  assert.equal(countDocuments(undefined), 0);
  assert.deepEqual(documentSourceIds(sources, `pdf-${SHA}-text2-p2`), [1, 2, 3].map(page => `pdf-${SHA}-text2-p${page}`));
  assert.deepEqual(documentSourceIds(sources, 'src-pasted'), ['src-pasted']);
  assert.deepEqual(documentSourceIds(sources, 'missing'), ['missing']);
});
