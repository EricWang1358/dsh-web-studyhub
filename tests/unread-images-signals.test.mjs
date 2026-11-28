import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { withoutEmptied } from '../lib/converted-edit.js';
import { extractPptx } from '../lib/office/pptx.js';
import { readZip } from '../lib/office/zip.js';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { snapshotSources } from '../lib/source-query.js';
import { pptxFile, shape, apara, picture, slideTable } from './helpers/office.mjs';

/* Issue #1457: unread images / figures / charts / SmartArt signals across converters,
   PPTX extraction, material persistence, describe/list endpoints, and source grouping. */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'unread-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({
    root,
    read: async () => {
      const state = await store.read();
      return structuredClone({ sources: state.sources, documents: state.documents || [] });
    },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own);
      state.sources = own.sources;
      state.documents = own.documents;
      return result;
    }),
  });
  return { root, store, call: (action, args = {}) => ops.handlers[action](args) };
}

const base64 = value => (Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).toString('base64');

const chartXml = () =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="11" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>';

const smartArtXml = () =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="12" name="SmartArt"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId3"/></a:graphicData></a:graphic></p:graphicFrame>';

test('MinerU v1 detects omitted image blocks per page (captioned, uncaptioned, and image-only skipped pages)', () => {
  const content = [
    { type: 'text', text: '第一章 概述', text_level: 1, page_idx: 0 },
    { type: 'text', text: '纯文字页。', page_idx: 0 },
    { type: 'text', text: '第二章 结构图', text_level: 1, page_idx: 1 },
    { type: 'image', img_path: 'images/fig1.jpg', image_caption: ['图 1 系统架构'], page_idx: 1 },
    { type: 'image', img_path: 'images/fig2.jpg', page_idx: 1 },
    { type: 'image', img_path: 'images/only.jpg', page_idx: 2 },
    { type: 'text', text: '结论页。', page_idx: 3 },
  ];
  const book = parseConvertedDocument(JSON.stringify(content), { filename: 'mineru-v1.json' });
  assert.deepEqual(book.pages.map(p => p.page), [1, 2, 4]);
  assert.deepEqual(book.skippedPages, [3]);
  assert.deepEqual(book.imagePages, [2]);
  assert.equal(book.pages[0].hasImages, undefined);
  assert.equal(book.pages[0].imageCount, undefined);
  assert.equal(book.pages[1].hasImages, true);
  assert.equal(book.pages[1].imageCount, 2);
  assert.equal(book.pages[2].hasImages, undefined);
});

test('MinerU v2 detects image, figure, and img_path/image_source blocks per page while ignoring header/footer', () => {
  const v2 = [
    [
      { type: 'title', content: { title_content: [{ type: 'text', content: '概率论' }], level: 1 } },
      { type: 'header_image', img_path: 'images/logo.png' },
      { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '第一页没有内容图。' }] } },
    ],
    [
      { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '正态分布曲线如下。' }] } },
      { type: 'image', content: { image_source: { path: 'images/norm.png' } } },
      { type: 'figure', img_path: 'images/hist.png' },
    ],
    [
      { type: 'image', img_path: 'images/scan-only.png' },
    ],
    [
      { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '带来源字段的图块。' }] } },
      { type: 'custom_visual', image_source: 'images/extra.png' },
    ],
  ];
  const book = parseConvertedDocument(JSON.stringify(v2), { filename: 'mineru-v2.json' });
  assert.deepEqual(book.pages.map(p => p.page), [1, 2, 4]);
  assert.deepEqual(book.skippedPages, [3]);
  assert.deepEqual(book.imagePages, [2, 4]);
  assert.equal(book.pages[0].hasImages, undefined);
  assert.equal(book.pages[1].hasImages, true);
  assert.equal(book.pages[1].imageCount, 2);
  assert.equal(book.pages[2].hasImages, true);
  assert.equal(book.pages[2].imageCount, 1);
});

test('Docling JSON tracks kind === picture per page without losing page text or skipped pages', () => {
  const docling = {
    schema_name: 'DoclingDocument',
    name: 'vision-notes',
    body: {
      self_ref: '#/body',
      children: [
        { $ref: '#/texts/0' },
        { $ref: '#/pictures/0' },
        { $ref: '#/texts/1' },
        { $ref: '#/pictures/1' },
        { $ref: '#/texts/2' },
      ],
    },
    texts: [
      { self_ref: '#/texts/0', label: 'section_header', level: 1, text: 'Page 1 Intro', prov: [{ page_no: 1 }] },
      { self_ref: '#/texts/1', label: 'text', text: 'Page 2 text with diagram.', prov: [{ page_no: 2 }] },
      { self_ref: '#/texts/2', label: 'text', text: 'Page 4 summary.', prov: [{ page_no: 4 }] },
    ],
    pictures: [
      { self_ref: '#/pictures/0', label: 'picture', prov: [{ page_no: 2 }] },
      { self_ref: '#/pictures/1', label: 'picture', prov: [{ page_no: 3 }] },
    ],
    pages: { 1: { page_no: 1 }, 2: { page_no: 2 }, 3: { page_no: 3 }, 4: { page_no: 4 } },
  };
  const book = parseConvertedDocument(JSON.stringify(docling), { filename: 'docling.json' });
  assert.deepEqual(book.pages.map(p => p.page), [1, 2, 4]);
  assert.deepEqual(book.skippedPages, [3]);
  assert.deepEqual(book.imagePages, [2]);
  assert.equal(book.pages[0].hasImages, undefined);
  assert.equal(book.pages[1].hasImages, true);
  assert.equal(book.pages[1].imageCount, 1);
  assert.equal(book.pages[2].hasImages, undefined);
});

test('PaddleOCR detects stripped markdown images and image/figure/chart blocks without counting header/footer furniture', () => {
  const payload = {
    result: {
      dataInfo: { type: 'pdf', numPages: 4 },
      layoutParsingResults: [
        {
          markdown: { text: '# 第一章\n\n正文说明。\n\n<img src="imgs/a.jpg" />\n\n![chart](imgs/b.png)' },
          prunedResult: { parsing_res_list: [{ block_label: 'image', block_content: '' }] },
        },
        {
          markdown: { text: '<img src="imgs/only.jpg" />' },
          prunedResult: { parsing_res_list: [{ block_label: 'image', block_content: '' }] },
        },
        {
          prunedResult: {
            parsing_res_list: [
              { block_label: 'header_image', block_content: '' },
              { block_label: 'text', block_content: '第三页只有正文和页眉图。' },
            ],
          },
        },
        {
          prunedResult: {
            parsing_res_list: [
              { block_label: 'text', block_content: '第四页带图表。' },
              { block_label: 'chart', block_content: '' },
              { block_label: 'figure', block_content: '' },
            ],
          },
        },
      ],
    },
  };
  const book = parseConvertedDocument(JSON.stringify(payload), { filename: 'paddle.json' });
  assert.deepEqual(book.pages.map(p => p.page), [1, 3, 4]);
  assert.deepEqual(book.skippedPages, [2]);
  assert.deepEqual(book.imagePages, [1, 4]);
  assert.equal(book.pages[0].hasImages, true);
  assert.equal(book.pages[0].imageCount, 2);
  assert.equal(book.pages[1].hasImages, undefined);
  assert.equal(book.pages[2].hasImages, true);
  assert.equal(book.pages[2].imageCount, 2);
});

test('Marker and generic page-marked Markdown count stripped markdown and HTML images per page', () => {
  const dashes = '-'.repeat(48);
  const markerMd = [
    `{0}${dashes}`,
    '# First',
    'Clean page text.',
    `{1}${dashes}`,
    'See diagram below:',
    '![arch](fig-1.png)',
    '<img src="fig-2.jpg" alt="flow" />',
    `{2}${dashes}`,
    '![](only-picture.png)',
  ].join('\n');
  const markerBook = parseConvertedDocument(markerMd, { filename: 'marker.md' });
  assert.deepEqual(markerBook.pages.map(p => p.page), [1, 2]);
  assert.deepEqual(markerBook.skippedPages, [3]);
  assert.deepEqual(markerBook.imagePages, [2]);
  assert.equal(markerBook.pages[0].hasImages, undefined);
  assert.equal(markerBook.pages[1].hasImages, true);
  assert.equal(markerBook.pages[1].imageCount, 2);

  const genericMd = [
    '<!-- page: 1 -->',
    'Intro without images.',
    '<!-- page: 2 -->',
    'Text with figure.',
    '![curve](curve.png)',
  ].join('\n');
  const genericBook = parseConvertedDocument(genericMd, { filename: 'notes.md' });
  assert.deepEqual(genericBook.imagePages, [2]);
  assert.deepEqual(genericBook.skippedPages, []);
  assert.equal(genericBook.pages[1].hasImages, true);
  assert.equal(genericBook.pages[1].imageCount, 1);
});

test('extractPptx reports omittedVisuals per slide directly, including on textless slides', () => {
  const bytes = pptxFile([
    { shapes: [shape([apara('Title')], { ph: 'title' }), picture(), chartXml()] },
    { shapes: [smartArtXml()] },
    { shapes: [shape([apara('Table only')], { ph: 'title' }), slideTable([['K', 'V'], ['a', '1']])] },
  ]);
  const slides = extractPptx(readZip(bytes));
  assert.deepEqual(slides[0].omittedVisuals, ['image', 'chart']);
  assert.equal(slides[1].text, '');
  assert.deepEqual(slides[1].omittedVisuals, ['smartart']);
  assert.equal(slides[2].omittedVisuals, undefined);
});

test('end-to-end PPTX import -> get -> list -> groupSourcesByDocument preserves skippedPages, imagePages, omittedVisuals', async t => {
  const { call, store } = await fixture(t);
  const bytes = pptxFile([
    { shapes: [shape([apara('Overview')], { ph: 'title' }), shape([apara('Plain text')], { ph: 'body', id: 3 })] },
    { shapes: [shape([apara('Architecture')], { ph: 'title' }), picture(), chartXml()] },
    { shapes: [picture()] },
    { shapes: [shape([apara('Workflow')], { ph: 'title' }), smartArtXml()] },
  ], { title: 'Distributed Systems' });

  const imported = await call('materials.document.import', { dataBase64: base64(bytes), filename: 'ds.pptx', courses: ['DS'] });
  assert.deepEqual(imported.skippedPages, [3]);
  assert.deepEqual(imported.imagePages, [2, 4]);
  assert.deepEqual(imported.omittedVisuals, ['image', 'chart', 'smartart']);

  const got = await call('materials.document.get', { id: imported.documentId });
  assert.deepEqual(got.skippedPages, [3]);
  assert.deepEqual(got.imagePages, [2, 4]);
  assert.deepEqual(got.omittedVisuals, ['image', 'chart', 'smartart']);
  assert.equal(got.sources[0].document.hasImages, undefined);
  assert.equal(got.sources[1].document.hasImages, true);
  assert.deepEqual(got.sources[1].document.omittedVisuals, ['image', 'chart']);
  assert.equal(got.sources[2].document.hasImages, true);
  assert.deepEqual(got.sources[2].document.omittedVisuals, ['smartart']);

  const listed = await call('materials.document.list', {});
  assert.equal(listed.documents.length, 1);
  assert.deepEqual(listed.documents[0].skippedPages, [3]);
  assert.deepEqual(listed.documents[0].imagePages, [2, 4]);
  assert.deepEqual(listed.documents[0].omittedVisuals, ['image', 'chart', 'smartart']);

  const state = await store.read();
  const [grouped] = groupSourcesByDocument(state.sources, { documents: state.documents });
  assert.equal(grouped.hasImages, true);
  assert.deepEqual(grouped.imagePages, [2, 4]);
  assert.deepEqual(grouped.skippedPages, [3]);
  assert.deepEqual(grouped.omittedVisuals, ['image', 'chart', 'smartart']);

  // Without documents metadata, source-level image flags still aggregate and skippedPages falls back safely to [].
  const [groupedWithoutDocs] = groupSourcesByDocument(state.sources);
  assert.equal(groupedWithoutDocs.hasImages, true);
  assert.deepEqual(groupedWithoutDocs.imagePages, [2, 4]);
  assert.deepEqual(groupedWithoutDocs.skippedPages, []);
  assert.deepEqual(groupedWithoutDocs.omittedVisuals, ['image', 'chart', 'smartart']);
});

test('end-to-end converted document import persists imagePages & skippedPages through get, list, and groupSourcesByDocument', async t => {
  const { call, store } = await fixture(t);
  const content = [
    { type: 'text', text: '第一章', text_level: 1, page_idx: 0 },
    { type: 'text', text: '第一页文字。', page_idx: 0 },
    { type: 'image', img_path: 'img/1.png', image_caption: ['图 1'], page_idx: 0 },
    { type: 'image', img_path: 'img/2.png', page_idx: 1 },
    { type: 'text', text: '第二章', text_level: 1, page_idx: 2 },
    { type: 'text', text: '第三页纯文字。', page_idx: 2 },
  ];
  const imported = await call('materials.document.import', { dataBase64: base64(JSON.stringify(content)), filename: 'lecture.json' });
  assert.deepEqual(imported.skippedPages, [2]);
  assert.deepEqual(imported.imagePages, [1]);
  assert.deepEqual(imported.omittedVisuals, []);

  const got = await call('materials.document.get', { id: imported.documentId });
  assert.deepEqual(got.skippedPages, [2]);
  assert.deepEqual(got.imagePages, [1]);
  assert.deepEqual(got.omittedVisuals, []);
  assert.equal(got.sources[0].document.hasImages, true);
  assert.equal(got.sources[1].document.hasImages, undefined);

  const state = await store.read();
  assert.deepEqual(state.documents[0].versions[0].skippedPages, [2]);
  assert.deepEqual(state.documents[0].versions[0].imagePages, [1]);
  assert.equal(state.documents[0].versions[0].omittedVisuals, undefined, 'empty omittedVisuals is omitted from persisted version');

  const [grouped] = groupSourcesByDocument(state.sources, { documents: state.documents });
  assert.equal(grouped.hasImages, true);
  assert.deepEqual(grouped.imagePages, [1]);
  assert.deepEqual(grouped.skippedPages, [2]);
  assert.deepEqual(grouped.omittedVisuals, []);

  // Client snapshot path: Sources / SourcePicker call groupSourcesByDocument(data.sources) without { documents }.
  const snapshot = snapshotSources(state.sources, new Set(), state.documents);
  const [groupedFromSnapshot] = groupSourcesByDocument(snapshot);
  assert.equal(groupedFromSnapshot.hasImages, true);
  assert.deepEqual(groupedFromSnapshot.imagePages, [1]);
  assert.deepEqual(groupedFromSnapshot.skippedPages, [2]);
  assert.deepEqual(groupedFromSnapshot.omittedVisuals, []);
});

test('[C38] legacy stored document without new fields loads cleanly and does not falsely flag partial selectedPages imports', async t => {
  const { call, store } = await fixture(t);
  const sha = 'f'.repeat(64);
  const documentId = `document-${sha}-pdf`;
  const revision = `${sha}-pdf-text2`;
  const now = '2026-09-01T00:00:00.000Z';
  await store.update(state => {
    state.sources = [
      {
        id: `pdf-${sha}-text2-p1`,
        title: 'partial.pdf · p.1',
        text: 'First selected page text.',
        createdAt: now,
        importedAt: now,
        courses: ['CS'],
        document: { id: sha, filename: 'partial.pdf', page: 1, totalPages: 6, extractionVersion: 2, materialId: documentId, materialRevision: revision, format: 'pdf' },
      },
      {
        id: `pdf-${sha}-text2-p2`,
        title: 'partial.pdf · p.2',
        text: 'Second selected page text.',
        createdAt: now,
        importedAt: now,
        courses: ['CS'],
        document: { id: sha, filename: 'partial.pdf', page: 2, totalPages: 6, extractionVersion: 2, materialId: documentId, materialRevision: revision, format: 'pdf' },
      },
    ];
    state.documents = [
      {
        id: documentId,
        format: 'pdf',
        filename: 'partial.pdf',
        title: 'partial.pdf',
        currentRevision: revision,
        versions: [{ revision, attachment: null, sourceIds: [`pdf-${sha}-text2-p1`, `pdf-${sha}-text2-p2`], importedAt: now, totalPages: 6 }],
      },
    ];
  });

  const got = await call('materials.document.get', { id: documentId });
  assert.deepEqual(got.skippedPages, []);
  assert.deepEqual(got.imagePages, []);
  assert.deepEqual(got.omittedVisuals, []);

  const listed = await call('materials.document.list', {});
  assert.deepEqual(listed.documents[0].skippedPages, []);
  assert.deepEqual(listed.documents[0].imagePages, []);
  assert.deepEqual(listed.documents[0].omittedVisuals, []);

  const state = await store.read();
  const [grouped] = groupSourcesByDocument(state.sources, { documents: state.documents });
  assert.equal(grouped.hasImages, false);
  assert.deepEqual(grouped.imagePages, []);
  assert.deepEqual(grouped.skippedPages, [], 'partial selectedPages PDF without stored skippedPages must not falsely flag pages 3-6');
  assert.deepEqual(grouped.omittedVisuals, []);
});

test('withoutEmptied keeps imagePages consistent when supplied while preserving legacy return shape when omitted', () => {
  assert.deepEqual(withoutEmptied({ skippedPages: [2, 3], warnings: [] }, [3]), { skippedPages: [2], warnings: [] });
  assert.deepEqual(withoutEmptied({ skippedPages: [2, 3], imagePages: [1, 3, 4], warnings: [] }, [3]), { skippedPages: [2], imagePages: [1, 4], warnings: [] });
});
