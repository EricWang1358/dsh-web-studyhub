import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterIndexForPage, chaptersFromOutline, detectConvertedFormat, parseConvertedDocument, looksLikeConvertedJson } from '../lib/converted-document.js';

/* WP28: output of a PDF converter becomes one paged document. The fixtures
   below are written in the shapes the converters' documentation describes. */

const generic = [
  '# 设计模式教程', '', '<!-- page: 1 -->', '# 第 1 章 绪论', '设计模式是对常见问题的可复用解法。', '',
  '<!-- page: 2 -->', '## 1.1 为什么需要模式', '没有模式时，团队会重复发明轮子。', '',
  '<!-- page: 3 -->', '# 第 2 章 创建型模式', '工厂方法把创建延迟到子类。', '',
  '<!-- page: 4 -->', '', '<!-- page: 5 -->', '## 2.1 单例', '单例保证只有一个实例。',
].join('\n');

test('generic Markdown with page markers: one page per marker, empty pages listed, headings become the outline', () => {
  assert.equal(detectConvertedFormat(generic), 'page-markers');
  const book = parseConvertedDocument(generic, { filename: '设计模式.md' });
  assert.equal(book.converter, 'generic');
  assert.equal(book.totalPages, 5);
  assert.deepEqual(book.pages.map(page => page.page), [1, 2, 3, 5]);
  assert.deepEqual(book.skippedPages, [4]);
  assert.match(book.pages[0].text, /设计模式是对常见问题/);
  assert.doesNotMatch(book.pages[0].text, /<!--/);
  assert.deepEqual(book.outline.map(entry => [entry.level, entry.title, entry.page]),
    [[1, '设计模式教程', 1], [1, '第 1 章 绪论', 1], [2, '1.1 为什么需要模式', 2], [1, '第 2 章 创建型模式', 3], [2, '2.1 单例', 5]]);
  assert.match(book.title, /设计模式/);
});

test('marker variants: spacing and the short form are accepted; text before the first marker is kept on page 1', () => {
  const text = ['封面文字', '<!--page:1-->', 'A', '<!--  page : 2  -->', 'B'].join('\n');
  const book = parseConvertedDocument(text, { filename: 'x.md' });
  assert.deepEqual(book.pages.map(page => page.page), [1, 2]);
  assert.match(book.pages[0].text, /封面文字/);
});

test('plain Markdown without markers, deck JSON and subtitles are not converter output', () => {
  assert.equal(detectConvertedFormat('# 标题\n\n正文'), null);
  assert.equal(detectConvertedFormat(JSON.stringify({ title: 'deck', cards: [{ prompt: 'q' }] })), null);
  assert.equal(detectConvertedFormat(JSON.stringify({ body: [{ from: 0, to: 1, content: 'hi' }] })), null);
  assert.equal(looksLikeConvertedJson('not json'), false);
  assert.throws(() => parseConvertedDocument('# 标题\n\n正文', { filename: 'x.md' }), /page markers|分页/i);
});

test('Marker --paginate_output: the {N}---- line starts page N (0-based) of the output', () => {
  const dashes = '-'.repeat(48);
  const text = [`{0}${dashes}`, '', '# Calculus', 'Limits come first.', '', `{1}${dashes}`, '', '## Derivatives', 'The slope of a curve.'].join('\n');
  assert.equal(detectConvertedFormat(text), 'marker-paginated');
  const book = parseConvertedDocument(text, { filename: 'calc.md' });
  assert.equal(book.converter, 'marker');
  assert.deepEqual(book.pages.map(page => page.page), [1, 2]);
  assert.match(book.pages[1].text, /slope of a curve/);
  assert.doesNotMatch(book.pages[0].text, /-{20,}/);
});

const mineru = [
  { type: 'text', text: '第一章 线性代数', text_level: 1, page_idx: 0, bbox: [1, 2, 3, 4] },
  { type: 'text', text: '向量空间是满足八条公理的集合。', page_idx: 0 },
  { type: 'equation', text: 'a+b=b+a', text_format: 'latex', page_idx: 0 },
  { type: 'header', text: '线性代数讲义', page_idx: 1 },
  { type: 'text', text: '1.1 矩阵', text_level: 2, page_idx: 1 },
  { type: 'table', table_caption: ['表 1 矩阵类型'], table_body: '<table><tr><th>名称</th><th>性质</th></tr><tr><td>对称</td><td>A=A^T</td></tr></table>', page_idx: 1 },
  { type: 'image', img_path: 'images/a.jpg', image_caption: ['图 1 线性变换'], page_idx: 1 },
  { type: 'page_number', text: '2', page_idx: 1 },
  { type: 'text', text: '第二章 特征值', text_level: 1, page_idx: 3 },
  { type: 'list', sub_type: 'text', list_items: ['特征向量', '特征多项式'], page_idx: 3 },
];

test('MinerU content_list (v1, flat, 0-based page_idx): pages, headings by text_level, tables, equations; headers and page numbers dropped', () => {
  assert.equal(detectConvertedFormat(JSON.stringify(mineru)), 'mineru-content-list');
  const book = parseConvertedDocument(JSON.stringify(mineru), { filename: 'la.json' });
  assert.equal(book.converter, 'mineru');
  assert.equal(book.totalPages, 4);
  assert.deepEqual(book.pages.map(page => page.page), [1, 2, 4]);
  assert.deepEqual(book.skippedPages, [3]);
  assert.match(book.pages[0].text, /^# 第一章 线性代数/);
  assert.match(book.pages[0].text, /\$\$\s*a\+b=b\+a\s*\$\$/);
  assert.match(book.pages[1].text, /^## 1\.1 矩阵/m);
  assert.match(book.pages[1].text, /\| 名称 \| 性质 \|/);
  assert.match(book.pages[1].text, /表 1 矩阵类型/);
  assert.match(book.pages[1].text, /图 1 线性变换/);
  assert.doesNotMatch(book.pages[1].text, /线性代数讲义/);
  assert.doesNotMatch(book.pages[1].text, /^2$/m);
  assert.match(book.pages[2].text, /- 特征向量/);
  assert.deepEqual(book.outline.map(entry => [entry.level, entry.page]), [[1, 1], [2, 2], [1, 4]]);
});

test('MinerU content_list v2 (grouped by page) is read page by page, tolerantly', () => {
  const v2 = [
    [{ type: 'title', content: { title_content: [{ type: 'text', content: '概率论' }], level: 1 } },
      { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '概率是对不确定性的度量。' }] } }],
    [{ type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '条件概率的定义。' }] } }],
  ];
  assert.equal(detectConvertedFormat(JSON.stringify(v2)), 'mineru-content-list-v2');
  const book = parseConvertedDocument(JSON.stringify(v2), { filename: 'p.json' });
  assert.equal(book.converter, 'mineru');
  assert.equal(book.totalPages, 2);
  assert.match(book.pages[0].text, /^# 概率论/);
  assert.match(book.pages[0].text, /不确定性的度量/);
  assert.match(book.pages[1].text, /条件概率的定义/);
});

const docling = {
  schema_name: 'DoclingDocument', version: '1.0.0', name: 'ml-book',
  body: { self_ref: '#/body', children: [{ $ref: '#/texts/0' }, { $ref: '#/texts/1' }, { $ref: '#/groups/0' }, { $ref: '#/tables/0' }, { $ref: '#/texts/4' }] },
  groups: [{ self_ref: '#/groups/0', label: 'list', children: [{ $ref: '#/texts/2' }, { $ref: '#/texts/3' }] }],
  texts: [
    { self_ref: '#/texts/0', label: 'section_header', level: 1, text: 'Chapter 1 Learning', prov: [{ page_no: 1 }] },
    { self_ref: '#/texts/1', label: 'text', text: 'Machine learning fits models to data.', prov: [{ page_no: 1 }] },
    { self_ref: '#/texts/2', label: 'list_item', text: 'Supervised', prov: [{ page_no: 2 }] },
    { self_ref: '#/texts/3', label: 'list_item', text: 'Unsupervised', prov: [{ page_no: 2 }] },
    { self_ref: '#/texts/4', label: 'section_header', level: 1, text: 'Chapter 2 Models', prov: [{ page_no: 3 }] },
    { self_ref: '#/texts/5', label: 'page_footer', text: 'footer 7', prov: [{ page_no: 2 }] },
  ],
  tables: [{ self_ref: '#/tables/0', label: 'table', prov: [{ page_no: 2 }],
    data: { num_rows: 2, num_cols: 2, table_cells: [
      { text: 'Name', start_row_offset_idx: 0, start_col_offset_idx: 0 }, { text: 'Kind', start_row_offset_idx: 0, start_col_offset_idx: 1 },
      { text: 'SVM', start_row_offset_idx: 1, start_col_offset_idx: 0 }, { text: 'supervised', start_row_offset_idx: 1, start_col_offset_idx: 1 }] } }],
  pages: { 1: { page_no: 1 }, 2: { page_no: 2 }, 3: { page_no: 3 } },
};

test('DoclingDocument JSON: body tree in reading order, prov.page_no (1-based), section levels, tables and lists; furniture left out', () => {
  assert.equal(detectConvertedFormat(JSON.stringify(docling)), 'docling-json');
  const book = parseConvertedDocument(JSON.stringify(docling), { filename: 'ml.json' });
  assert.equal(book.converter, 'docling');
  assert.equal(book.totalPages, 3);
  assert.deepEqual(book.pages.map(page => page.page), [1, 2, 3]);
  assert.match(book.pages[0].text, /^## Chapter 1 Learning/);
  assert.match(book.pages[1].text, /- Supervised\n- Unsupervised/);
  assert.match(book.pages[1].text, /\| Name \| Kind \|/);
  assert.match(book.pages[1].text, /\| SVM \| supervised \|/);
  assert.doesNotMatch(book.pages[1].text, /footer 7/);
  assert.deepEqual(book.outline.map(entry => [entry.level, entry.page]), [[2, 1], [2, 3]]);
  assert.equal(book.title, 'ml-book');
});

test('unreadable JSON or a converter file without text is refused in plain words', () => {
  assert.throws(() => parseConvertedDocument('{"a":1}', { filename: 'x.json' }), /MinerU|Docling|not.*converter|转换/i);
  assert.throws(() => parseConvertedDocument(JSON.stringify([{ type: 'image', page_idx: 0 }]), { filename: 'x.json' }), /text|文字/i);
});

test('chapters come from the shallowest heading level that splits the book; a lone title does not count', () => {
  const outline = [{ level: 1, title: '全书', page: 1 }, { level: 2, title: '第一章', page: 1 }, { level: 3, title: '1.1', page: 2 },
    { level: 2, title: '第二章', page: 5 }, { level: 2, title: '第三章', page: 9 }];
  const chapters = chaptersFromOutline(outline, 12);
  assert.deepEqual(chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage, chapter.level]),
    [['第一章', 1, 4, 2], ['第二章', 5, 8, 2], ['第三章', 9, 12, 2]]);
  assert.equal(chapterIndexForPage(chapters, 6), 1);
  assert.equal(chapterIndexForPage(chapters, 12), 2);
  assert.deepEqual(chaptersFromOutline([{ level: 1, title: '只有一个', page: 1 }], 10), []);
  assert.deepEqual(chaptersFromOutline([], 10), []);
  // Pages before the first chapter are front matter.
  assert.equal(chapterIndexForPage(chaptersFromOutline([{ level: 1, title: 'A', page: 3 }, { level: 1, title: 'B', page: 6 }], 8), 1), -1);
});

test('parsed pages carry the chapter they fall in', () => {
  const book = parseConvertedDocument(generic.replace('# 设计模式教程\n\n', ''), { filename: 'x.md' });
  assert.deepEqual(book.chapters.map(chapter => chapter.title), ['第 1 章 绪论', '第 2 章 创建型模式']);
  assert.deepEqual(book.pages.map(page => page.chapter), [0, 0, 1, 1]);
});

test('a 1,200-page book is not capped at import (the 600,000-character selection limit applies to generation)', () => {
  const pages = Array.from({ length: 1200 }, (_, i) => `<!-- page: ${i + 1} -->\n# 章节 ${Math.floor(i / 40) + 1}${i % 40 ? '' : ' 开始'}\n${'知识点内容。'.repeat(200)}`);
  const book = parseConvertedDocument(pages.join('\n'), { filename: 'big.md' });
  assert.equal(book.pages.length, 1200);
  assert.ok(book.pages.reduce((sum, page) => sum + page.text.length, 0) > 600000);
});
