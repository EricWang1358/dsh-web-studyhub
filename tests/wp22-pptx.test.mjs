import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOffice } from '../lib/office/index.js';
import { readZip } from '../lib/office/zip.js';
import { pptxFile, shape, apara, slideTable, picture, group, zipFiles } from './helpers/office.mjs';

const extract = (slides, options) => extractOffice(pptxFile(slides, options), { format: 'pptx', filename: 'deck.pptx' });

test('slides come out in presentation order (sldIdLst + rels), not file order', async () => {
  const result = await extract([
    { file: 'slide1.xml', shapes: [shape([apara('Alpha')], { ph: 'title' })] },
    { file: 'slide2.xml', shapes: [shape([apara('Beta')], { ph: 'title' })] },
    { file: 'slide10.xml', shapes: [shape([apara('Gamma')], { ph: 'title' })] },
  ], { order: [2, 0, 1] });
  assert.deepEqual(result.sources.map(source => source.document.page), [1, 2, 3]);
  assert.deepEqual(result.sources.map(source => source.text.split('\n')[0]), ['## 第 1 页 · Gamma', '## 第 2 页 · Alpha', '## 第 3 页 · Beta']);
  assert.equal(result.totalPages, 3);
});

test('each slide is one page-located source: title heading, bullets with indent levels', async () => {
  const result = await extract([{ shapes: [
    shape([apara('Paging')], { ph: 'title' }),
    shape([apara('Frames and pages'), apara('Page size', { lvl: 1 }), apara('4 KB typical', { lvl: 2 }), apara('Page table')], { ph: 'body', id: 3 }),
  ] }], { title: 'Operating Systems' });
  const [source] = result.sources;
  assert.equal(source.text, '## 第 1 页 · Paging\n\n- Frames and pages\n  - Page size\n    - 4 KB typical\n- Page table');
  assert.deepEqual(source.document, { page: 1, totalPages: 1 });
  assert.equal(source.title, 'Operating Systems · p.1');
  assert.equal(result.title, 'Operating Systems');
});

test('source titles fall back to the filename and use the PDF page-title shape', async () => {
  const result = await extract([{ shapes: [shape([apara('T')], { ph: 'title' })] }, { shapes: [shape([apara('U')], { ph: 'title' })] }]);
  assert.deepEqual(result.sources.map(source => source.title), ['deck.pptx · p.1', 'deck.pptx · p.2']);
  assert.equal(result.title, undefined);
});

test('title placeholders (ctrTitle too) come first even when they are last in the XML', async () => {
  const result = await extract([{ shapes: [
    shape([apara('Body line')], { ph: 'body', id: 3 }),
    shape([apara('Welcome')], { ph: 'ctrTitle', id: 2 }),
    shape([apara('Speaker, 2026')], { ph: 'subTitle', id: 4 }),
  ] }]);
  assert.equal(result.sources[0].text, '## 第 1 页 · Welcome\n\n- Body line\n\nSpeaker, 2026');
});

test('text boxes are plain lines; explicit bullets and numbers are honoured; buNone suppresses', async () => {
  const result = await extract([{ shapes: [
    shape([apara('Heading')], { ph: 'title' }),
    shape([apara('Free text box')]),
    shape([apara('numbered one', { bullet: 'num' }), apara('numbered two', { bullet: 'num' }), apara('dash', { bullet: 'char' })]),
    shape([apara('no bullet here', { bullet: 'none' })], { ph: 'body', id: 5 }),
  ] }]);
  assert.equal(result.sources[0].text, ['## 第 1 页 · Heading', '', 'Free text box', '', '1. numbered one', '2. numbered two', '- dash', '', 'no bullet here'].join('\n'));
});

test('line breaks inside a paragraph, entities and Chinese text', async () => {
  const result = await extract([{ shapes: [shape([apara('进程 & 线程')], { ph: 'title' }), shape([apara('第一行\n第二行 <b>')], { ph: 'body', id: 3 })] }]);
  assert.equal(result.sources[0].text, '## 第 1 页 · 进程 & 线程\n\n- 第一行\n  第二行 <b>');
});

test('tables become Markdown tables, groups are descended, pictures are ignored', async () => {
  const result = await extract([{ shapes: [
    shape([apara('Data')], { ph: 'title' }),
    slideTable([['Name', 'Value'], ['a | b', { text: 'merged', span: 1 }]]),
    group(shape([apara('Inside a group')], { id: 30 })),
    picture(),
  ] }]);
  assert.equal(result.sources[0].text, ['## 第 1 页 · Data', '', '| Name | Value |', '| --- | --- |', '| a \\| b | merged |', '', 'Inside a group'].join('\n'));
});

test('merged table cells are padded', async () => {
  const result = await extract([{ shapes: [slideTable([[{ text: 'Wide', span: 2 }, { hMerge: true }, 'C'], ['a', 'b', 'c']])] }]);
  assert.equal(result.sources[0].text, ['## 第 1 页', '', '| Wide |  | C |', '| --- | --- | --- |', '| a | b | c |'].join('\n'));
});

test('speaker notes are appended under 备注：, without the slide image or number placeholders', async () => {
  const result = await extract([
    { shapes: [shape([apara('One')], { ph: 'title' })], notes: 'Remember the demo.\n\nAsk for questions.' },
    { shapes: [shape([apara('Two')], { ph: 'title' })] },
  ]);
  assert.equal(result.sources[0].text, '## 第 1 页 · One\n\n备注：\nRemember the demo.\nAsk for questions.');
  assert.equal(result.sources[1].text, '## 第 2 页 · Two');
});

test('slides without any text are skipped but keep their numbering; hidden slides stay', async () => {
  const result = await extract([
    { shapes: [shape([apara('First')], { ph: 'title' })] },
    { shapes: [picture()] },
    { shapes: [shape([apara('Third')], { ph: 'title' })], hidden: true },
  ]);
  assert.deepEqual(result.sources.map(source => source.document.page), [1, 3]);
  assert.deepEqual(result.skippedPages, [2]);
  assert.equal(result.totalPages, 3);
  assert.ok(result.warnings.some(warning => /2/.test(warning)));
});

test('a deck with no text at all is reported as unavailable, not an error', async () => {
  const result = await extract([{ shapes: [picture()] }]);
  assert.equal(result.sources.length, 0);
  assert.equal(result.projectionUnavailable, true);
  assert.deepEqual(result.skippedPages, [1]);
});

test('slide number and date fields are not text', async () => {
  const field = type => `<a:p><a:fld id="{1}" type="${type}"><a:t>${type === 'slidenum' ? '7' : '2026-01-01'}</a:t></a:fld></a:p>`;
  const result = await extract([{ shapes: [shape([apara('Real')], { ph: 'title' }), shape([field('slidenum'), field('datetime1')], { ph: 'sldNum', id: 6 })] }]);
  assert.equal(result.sources[0].text, '## 第 1 页 · Real');
});

test('a missing presentation part is not a valid PPTX', async () => {
  await assert.rejects(extractOffice(zipFiles([{ name: 'word/document.xml', data: '<w/>' }]), { format: 'pptx' }), /not a valid PPTX/i);
});

test('a slide referenced in the order list but missing from the package is reported', async () => {
  const bytes = pptxFile([{ shapes: [shape([apara('Here')], { ph: 'title' })] }, { shapes: [shape([apara('Gone')], { ph: 'title' })] }]);
  const zip = readZip(bytes);
  const broken = zipFiles(zip.names().filter(name => name !== 'ppt/slides/slide2.xml').map(name => ({ name, data: zip.read(name) })));
  await assert.rejects(extractOffice(broken, { format: 'pptx' }), /not a valid PPTX/i);
});

test('the text cap applies to the whole deck', async () => {
  const slides = Array.from({ length: 700 }, (_, index) => ({ shapes: [shape([apara(`${index} ${'x'.repeat(1000)}`)], { ph: 'title' })] }));
  await assert.rejects(extract(slides), /Extracted text exceeds 600,000 characters/);
});
