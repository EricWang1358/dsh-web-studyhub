import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOffice } from '../lib/office/index.js';
import { OfficeFileError } from '../lib/office/zip.js';
import { docxFile, para, run, table, row, cell, zipFiles } from './helpers/office.mjs';

const extract = (body, options) => extractOffice(docxFile(body, options), { format: 'docx', filename: 'lecture.docx' });
const textOf = async (body, options) => (await extract(body, options)).sources[0].text;

test('headings follow style names, the base style chain and outline levels', async () => {
  const text = await textOf([
    para('Course Notes', { style: 'Title' }),
    para('Memory', { style: 'Heading1' }),
    para('Paging', { style: 'Heading2' }),
    para('Page tables', { style: 'Heading3' }),
    para('A chapter', { style: 'Chapter' }),
    para('Outline only', { outline: 1 }),
    para('Plain paragraph.'),
  ].join(''));
  assert.equal(text, ['# Course Notes', '# Memory', '## Paging', '### Page tables', '# A chapter', '## Outline only', 'Plain paragraph.'].join('\n\n'));
});

test('localized heading style names and table-of-contents lines', async () => {
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:styleId="a1"><w:name w:val="标题 2"/></w:style>
    <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style></w:styles>`;
  const text = await textOf(para('目录项 1', { style: 'TOC1' }) + para('虚拟内存', { style: 'a1' }) + para('正文'), { styles });
  assert.equal(text, '## 虚拟内存\n\n正文');
});

test('headings keep the full text of every run, tabs and line breaks', async () => {
  const text = await textOf(
    '<w:p><w:r><w:t>Line one</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Line two</w:t><w:tab/><w:t>after tab</w:t></w:r><w:r><w:cr/></w:r><w:r><w:t>Three</w:t></w:r></w:p>');
  assert.equal(text, 'Line one\nLine two\tafter tab\nThree');
});

test('w:t whitespace honours xml:space and entities are decoded', async () => {
  const text = await textOf(`<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r><w:r><w:t> &amp; &lt;b&gt;</w:t></w:r></w:p>`);
  assert.equal(text, 'Hello world& <b>');
});

test('hyperlink text, insertions, content controls and fields are kept; deleted text is not', async () => {
  const text = await textOf(`<w:p>
    <w:hyperlink r:id="rId5"><w:r><w:t>linked text</w:t></w:r></w:hyperlink>
    <w:ins w:id="1"><w:r><w:t xml:space="preserve"> inserted</w:t></w:r></w:ins>
    <w:del w:id="2"><w:r><w:delText>deleted</w:delText></w:r></w:del>
    <w:sdt><w:sdtContent><w:r><w:t xml:space="preserve"> control</w:t></w:r></w:sdtContent></w:sdt>
    <w:fldSimple w:instr="PAGE"><w:r><w:t xml:space="preserve"> 7</w:t></w:r></w:fldSimple>
    <w:r><w:instrText>HYPERLINK "http://x"</w:instrText></w:r></w:p>`);
  assert.equal(text, 'linked text inserted control 7');
});

test('lists use numbering definitions: bullets, decimals, nesting and restarts', async () => {
  const text = await textOf([
    para('Intro'),
    para('first bullet', { list: { numId: 1 } }),
    para('nested bullet', { list: { numId: 1, ilvl: 1 } }),
    para('second bullet', { list: { numId: 1 } }),
    para('step one', { list: { numId: 2 } }),
    para('step two', { list: { numId: 2 } }),
    para('sub a', { list: { numId: 2, ilvl: 1 } }),
    para('sub b', { list: { numId: 2, ilvl: 1 } }),
    para('step three', { list: { numId: 2 } }),
    para('sub a again', { list: { numId: 2, ilvl: 1 } }),
    para('styled bullet', { style: 'ListBullet' }),
    para('Outro'),
  ].join(''));
  assert.equal(text, ['Intro', '', '- first bullet', '  - nested bullet', '- second bullet', '', '1. step one', '2. step two', '  a. sub a', '  b. sub b', '3. step three', '  a. sub a again', '', '- styled bullet', '', 'Outro'].join('\n'));
});

test('lists without numbering.xml fall back to bullets', async () => {
  const text = await textOf(para('item', { list: { numId: 9 } }), { numbering: null });
  assert.equal(text, '- item');
});

test('tables become Markdown tables with escaped pipes and multi-paragraph cells', async () => {
  const text = await textOf([
    para('Before'),
    table([
      row([cell('Name'), cell('Cost')]),
      row([cell('a | b'), cell([para('line1'), para('line2')])]),
      row([cell('plain'), cell('9')]),
    ]),
    para('After'),
  ].join(''));
  assert.equal(text, ['Before', '', '| Name | Cost |', '| --- | --- |', '| a \\| b | line1 line2 |', '| plain | 9 |', '', 'After'].join('\n'));
});

test('merged cells are padded best-effort: gridSpan and vMerge', async () => {
  const text = await textOf(table([
    row([cell('Header', { span: 2 }), cell('X')]),
    row([cell('r1', { vMerge: 'restart' }), cell('a'), cell('b')]),
    row([cell('', { vMerge: 'continue' }), cell('c'), cell('d')]),
  ]));
  assert.equal(text, ['| Header |  | X |', '| --- | --- | --- |', '| r1 | a | b |', '|  | c | d |'].join('\n'));
});

test('footnotes and endnotes are numbered at the reference and appended', async () => {
  const body = para(`${run('Claim')}<w:r><w:footnoteReference w:id="2"/></w:r>${run(' and more')}<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r>`);
  const text = await textOf(body, { footnotes: [[1, 'Second in file'], [2, 'First reference']], endnotes: [[1, 'Ending']] });
  assert.equal(text, ['Claim[^1] and more[^2][^e1]', '', '## 脚注', '', '[^1]: First reference', '[^2]: Second in file', '', '## 尾注', '', '[^e1]: Ending'].join('\n'));
});

test('images, text boxes and empty paragraphs are skipped', async () => {
  const text = await textOf(`<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p><w:p/>${para('Kept')}<w:p><w:r><w:pict/></w:r></w:p>`);
  assert.equal(text, 'Kept');
});

test('the core title is used when it is meaningful; filenames otherwise', async () => {
  const good = await extract(para('Body text here for the document'), { title: 'Operating Systems — Lecture 3' });
  assert.equal(good.title, 'Operating Systems — Lecture 3');
  for (const junk of ['Microsoft Word - 文档1', 'Document1', '', '  ']) {
    const result = await extract(para('Body text'), { title: junk });
    assert.equal(result.title, undefined, junk);
  }
  const none = await extract(para('Body text'));
  assert.equal(none.title, undefined);
});

test('Chinese and mixed-script text survive unchanged', async () => {
  const text = await textOf(para('操作系统 · Operating System：进程与线程', { style: 'Heading1' }) + para('进程是资源分配的基本单位。'));
  assert.equal(text, '# 操作系统 · Operating System：进程与线程\n\n进程是资源分配的基本单位。');
});

test('result shape: one source, no pages, warnings for empty documents', async () => {
  const result = await extract(para('Hello'));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].document, undefined);
  assert.deepEqual(result.warnings, []);
  const empty = await extract(para('') + '<w:p><w:r><w:drawing/></w:r></w:p>');
  assert.equal(empty.sources.length, 0);
  assert.equal(empty.projectionUnavailable, true);
  assert.ok(empty.warnings.length);
});

test('invalid containers fail with a clear error', async () => {
  await assert.rejects(extractOffice(Buffer.from('nope'), { format: 'docx' }), OfficeFileError);
  const pptxAsDocx = zipFiles([{ name: 'ppt/presentation.xml', data: '<p/>' }]);
  await assert.rejects(extractOffice(pptxAsDocx, { format: 'docx' }), /not a valid DOCX/i);
  const broken = zipFiles([{ name: 'word/document.xml', data: '<w:document><w:body></w:document>' }]);
  await assert.rejects(extractOffice(broken, { format: 'docx' }), OfficeFileError);
});

test('very large documents are refused with the shared 600,000 character message', async () => {
  const body = Array.from({ length: 700 }, () => para('x'.repeat(1000))).join('');
  await assert.rejects(extract(body), /Extracted text exceeds 600,000 characters/);
});

test('stored (uncompressed) packages read the same as deflated ones', async () => {
  const body = para('Stored', { style: 'Heading1' }) + para('a < b');
  assert.equal(await textOf(body, { method: 'stored' }), await textOf(body));
});
