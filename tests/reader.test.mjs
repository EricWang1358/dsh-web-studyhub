/* The source reader (资料预览): reading settings, how plain text is set for
   reading, the outline, and search inside a document. The pure logic runs
   here; the layout is checked in the browser preview. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { READER_DEFAULTS, SIZES, READER_STORAGE_KEY, normalizeReaderSettings, stepSize, readerVars, loadReaderSettings, saveReaderSettings } from '../ui/document-preview/reader/settings.js';
import { looksLikeHeading, classifyParagraph, splitParagraphs, splitSegments, readingSections, lineBreakPieces } from '../ui/document-preview/reader/text-sections.js';
import { outlineFromSections, collectHeadings, pickActive, neighbours, readingProgress } from '../ui/document-preview/reader/outline.js';
import { foldWithMap, foldQuery, matchOffsets, findRanges, paintMatches } from '../ui/document-preview/reader/find.js';

/* ---------- settings ---------- */

test('reader settings: junk becomes the defaults, valid choices are kept', () => {
  assert.deepEqual(normalizeReaderSettings(undefined), READER_DEFAULTS);
  assert.deepEqual(normalizeReaderSettings('x'), READER_DEFAULTS);
  assert.deepEqual(normalizeReaderSettings({ size: 99, width: 'huge', face: 'comic', tone: 'neon', outline: 'yes', tools: 1 }), READER_DEFAULTS);
  const chosen = { size: 20, width: 'wide', face: 'serif', tone: 'paper', outline: false, tools: false };
  assert.deepEqual(normalizeReaderSettings(chosen), chosen);
  assert.deepEqual(normalizeReaderSettings({ size: '18' }), { ...READER_DEFAULTS, size: 18 }, 'a stored string size still counts');
});

test('reader settings: the size scale never goes below 15px and stops at its ends', () => {
  assert.equal(Math.min(...SIZES), 15);
  assert.equal(stepSize(16, 1), 17);
  assert.equal(stepSize(16, -1), 15);
  assert.equal(stepSize(15, -1), 15);
  assert.equal(stepSize(SIZES.at(-1), 1), SIZES.at(-1));
  assert.equal(stepSize(18, 5), 20, 'one step at a time');
});

test('reader settings: the column gets its size, measure and leading as CSS variables', () => {
  assert.deepEqual(readerVars(READER_DEFAULTS), { '--reader-size': '16px', '--reader-measure': '44em', '--reader-leading': '1.8' });
  assert.deepEqual(readerVars({ size: 22, width: 'wide' }), { '--reader-size': '22px', '--reader-measure': '56em', '--reader-leading': '1.7' });
  assert.equal(readerVars({ width: 'narrow' })['--reader-measure'], '36em');
});

test('reader settings are remembered, and a blocked or corrupt store only costs the defaults', () => {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(loadReaderSettings(storage), READER_DEFAULTS);
  saveReaderSettings({ ...READER_DEFAULTS, size: 18, tone: 'paper' }, storage);
  assert.deepEqual(loadReaderSettings(storage), { ...READER_DEFAULTS, size: 18, tone: 'paper' });
  store.set(READER_STORAGE_KEY, '{not json');
  assert.deepEqual(loadReaderSettings(storage), READER_DEFAULTS);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadReaderSettings(blocked), READER_DEFAULTS);
  assert.doesNotThrow(() => saveReaderSettings(READER_DEFAULTS, blocked));
  assert.deepEqual(loadReaderSettings(null), READER_DEFAULTS);
});

/* ---------- text sections ---------- */

test('a short line without sentence punctuation is a heading; lists, numbers in headings and sentences are not', () => {
  for (const line of ['数据库索引入门', '3.1 遗忘曲线', 'Chapter 3: Spaced repetition', '第 5 讲']) assert.equal(looksLikeHeading(line), true, line);
  for (const line of ['索引是一种额外维护的数据结构。', '1. 先看日志', '- 一个要点', '一、概述', 'a   b   c', '', 'x'.repeat(61)]) assert.equal(looksLikeHeading(line), false, line);
});

test('paragraphs reflow as prose, keep the breaks of a list, and keep the layout of tabs and gaps', () => {
  assert.equal(classifyParagraph(['索引是一种额外维护的数据结构，它让数据库在', '查询时不必逐行扫描整张表。']), 'prose');
  assert.equal(classifyParagraph(['1. 先看日志', '2. 再看事件']), 'lines');
  assert.equal(classifyParagraph(['- 记忆痕迹随时间衰减；', '- 相似内容会互相干扰；']), 'lines');
  assert.equal(classifyParagraph(['名称\t间隔', '第 1 次\t1 天']), 'layout');
  assert.equal(classifyParagraph(['| 次数 | 间隔 |', '| 1 | 1 天 |']), 'layout');
  assert.equal(classifyParagraph(['3.1 遗忘曲线', '本节说明为什么会忘']), 'prose', 'a numbered heading is not a list');
});

test('splitParagraphs: a page of extracted PDF text becomes a heading and two paragraphs, text unchanged', () => {
  const page = '数据库索引入门\n\n索引是一种额外维护的数据结构，它让数据库在查询时不必逐行扫\n描整张表。\n\n最常见的索引结构是平衡树，它能在对数时间内定位到某个键所在\n的位置。\n';
  const paragraphs = splitParagraphs(page);
  assert.deepEqual(paragraphs.map(item => item.kind), ['heading', 'prose', 'prose']);
  assert.equal(paragraphs[1].text, '索引是一种额外维护的数据结构，它让数据库在查询时不必逐行扫\n描整张表。', 'the hard line break stays in the text; CSS reflows it');
  assert.equal(paragraphs.map(item => item.text).join('').replace(/\s/g, ''), page.replace(/\s/g, ''), 'no characters are lost');
  assert.deepEqual(splitParagraphs('a\r\n\r\nb').map(item => item.text), ['a', 'b'], 'Windows line breaks');
  assert.deepEqual(splitParagraphs(' \n\n '), []);
});

test('splitParagraphs: only a title may be a lone short line; the last short line stays prose', () => {
  assert.deepEqual(splitParagraphs('标题\n\n正文第一段，写完整。\n\n结束').map(item => item.kind), ['heading', 'prose', 'prose']);
  assert.deepEqual(splitParagraphs('只有一行').map(item => item.kind), ['heading'], 'a slide with only a title');
  assert.deepEqual(splitParagraphs('正文第一段，写完整。\n\n页脚').map(item => item.kind), ['prose', 'prose']);
});

const transcript = ['开场白一句。', '【第一部分：容器基础】', '[Part 1: Containers]', '', '容器是进程。', '【第二部分：编排】', '', 'Pod 是最小单位。', '【第三部分：故障诊断】', '看日志。'].join('\n');

test('splitSegments cuts a transcript at its 【…】 labels and keeps the text before the first one', () => {
  const parts = splitSegments(transcript);
  assert.deepEqual(parts.map(part => part.title), ['', '第一部分：容器基础', '第二部分：编排', '第三部分：故障诊断']);
  assert.match(parts[0].text, /开场白/);
  assert.match(parts[1].text, /\[Part 1: Containers\]/);
  assert.doesNotMatch(parts[1].text, /【/, 'the label is the title, not body text');
  assert.equal(splitSegments('【第一部分】\n只有一个'), null, 'one label is not a structure');
  assert.equal(splitSegments('没有任何标记的一整段文字'), null);
  assert.equal(splitSegments('正文里提到【某个词】并不是标记\n【孤立】'), null);
});

test('readingSections: pages and slides one section each, transcripts one per part, other text one section', () => {
  const pages = readingSections({ paged: true, sources: [
    { id: 'p1', title: 'a.pdf · p.1', text: '索引入门\n\n正文一，写完整。', document: { page: 1 } },
    { id: 'p2', title: 'a.pdf · p.2', text: '没有标题的页面正文，写完整。\n\n又一段，写完整。', document: { page: 2 } }] });
  assert.deepEqual(pages.map(section => [section.kind, section.page, section.sourceId, section.heading]), [['page', 1, 'p1', '索引入门'], ['page', 2, 'p2', '']]);
  assert.equal(new Set(pages.map(section => section.id)).size, 2);
  const parts = readingSections({ text: transcript });
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(section => section.kind), ['part', 'part', 'part', 'part']);
  const plain = readingSections({ text: '一整段正文。\n\n又一段。' });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].paragraphs.length, 2);
  assert.deepEqual(readingSections({ paged: true, sources: [{ id: 's', text: 'x' }] })[0].page, 1, 'a page number is assumed from the position');
});

test('lineBreakPieces marks only the hard line breaks that fall between two CJK characters', () => {
  assert.deepEqual(lineBreakPieces('逐行扫\n描整张表。'), ['逐行扫', { join: true }, '描整张表。']);
  assert.deepEqual(lineBreakPieces('标点，\n继续\n再来'), ['标点，', { join: true }, '继续', { join: true }, '再来'], 'fullwidth punctuation counts as CJK');
  assert.deepEqual(lineBreakPieces('kubelet restarts\nthe container'), ['kubelet restarts\nthe container'], 'a Latin break is an ordinary space');
  assert.deepEqual(lineBreakPieces('中文\nEnglish'), ['中文\nEnglish'], 'one side Latin: still a space');
  assert.deepEqual(lineBreakPieces('没有换行'), ['没有换行']);
  assert.deepEqual(lineBreakPieces(''), []);
  const text = '索引是一种额外维护的数据结构，它让数据库在查询时不必逐行扫\n描整张表。';
  assert.equal(lineBreakPieces(text).map(piece => (typeof piece === 'string' ? piece : '\n')).join(''), text, 'no character is lost: the break stays in the text');
});

/* ---------- outline ---------- */

test('outlineFromSections lists pages with their heading and transcript parts by title, and nothing for one section', () => {
  const pages = readingSections({ paged: true, sources: [
    { id: 'p1', text: '索引入门\n\n正文一，写完整。', document: { page: 1 } }, { id: 'p2', text: '正文二，写完整。\n\n又一段。', document: { page: 2 } }] });
  const outline = outlineFromSections(pages);
  assert.deepEqual(outline.map(entry => [entry.title, entry.page]), [['索引入门', 1], ['', 2]], 'a page without a heading is still an entry; its label is made when drawn');
  const parts = outlineFromSections(readingSections({ text: transcript }));
  assert.deepEqual(parts.map(entry => entry.title), ['第一部分：容器基础', '第二部分：编排', '第三部分：故障诊断'], 'the untitled opening is not an entry');
  assert.deepEqual(outlineFromSections(readingSections({ text: '一整段正文。' })), []);
  assert.deepEqual(outlineFromSections([]), []);
});

const heading = (tag, text, closest = () => null) => ({ tagName: tag, textContent: text, closest, dataset: {} });

test('collectHeadings numbers h1–h4 relative to the shallowest one and tags each element', () => {
  const nodes = [heading('H2', '遗忘曲线'), heading('H3', ' 为什么   会忘 '), heading('H2', '间隔重复'), heading('H2', '   '), heading('H3', '被标记包住', () => ({}))];
  const items = collectHeadings({ querySelectorAll: () => nodes });
  assert.deepEqual(items.map(item => [item.level, item.title]), [[1, '遗忘曲线'], [2, '为什么 会忘'], [1, '间隔重复']]);
  assert.deepEqual(nodes.slice(0, 3).map(node => node.dataset.outlineId), ['h-0', 'h-1', 'h-2']);
  assert.equal(nodes[3].dataset.outlineId, undefined, 'an empty heading is skipped');
  assert.deepEqual(collectHeadings(null), []);
  assert.deepEqual(collectHeadings({ querySelectorAll: () => [] }), []);
});

test('pickActive follows the scroll position, neighbours give previous and next, progress is clamped', () => {
  const entries = [{ id: 'a', top: 300 }, { id: 'b', top: 900 }, { id: 'c', top: 1500 }];
  assert.equal(pickActive(entries), 'a', 'above the first heading the first entry is current');
  assert.equal(pickActive([{ id: 'a', top: -400 }, { id: 'b', top: 20 }, { id: 'c', top: 700 }]), 'b');
  assert.equal(pickActive([{ id: 'a', top: -400 }, { id: 'b', top: 25 }]), 'a', 'a heading just below the threshold is not current yet');
  assert.equal(pickActive([{ id: 'a', top: -900 }, { id: 'b', top: -20 }]), 'b');
  assert.equal(pickActive([]), null);
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(neighbours(items, 'b'), { previous: items[0], next: items[2] });
  assert.deepEqual(neighbours(items, 'a'), { previous: null, next: items[1] });
  assert.deepEqual(neighbours(items, 'c'), { previous: items[1], next: null });
  assert.deepEqual(neighbours(items, 'zzz'), { previous: null, next: null });
  assert.equal(readingProgress({ scrollTop: 0, clientHeight: 500, scrollHeight: 500 }), 0, 'it all fits');
  assert.equal(readingProgress({ scrollTop: 250, clientHeight: 500, scrollHeight: 1000 }), 0.5);
  assert.equal(readingProgress({ scrollTop: 999, clientHeight: 500, scrollHeight: 1000 }), 1);
  assert.equal(readingProgress({ scrollTop: -5, clientHeight: 500, scrollHeight: 1000 }), 0);
});

/* ---------- search in the document ---------- */

test('foldWithMap ignores case, width and extra whitespace and maps back to the original text', () => {
  assert.equal(foldWithMap('Hello  World').folded, 'hello world');
  assert.equal(foldWithMap('  \n a \t b ').folded, 'a b ', 'leading whitespace dropped, runs collapsed');
  const wide = foldWithMap('ＡＢ１');
  assert.equal(wide.folded, 'ab1');
  assert.deepEqual(wide.starts, [0, 1, 2]);
  const ligature = foldWithMap('ﬁx');
  assert.equal(ligature.folded, 'fix', 'a ligature expands');
  assert.deepEqual([ligature.starts, ligature.ends], [[0, 0, 1], [1, 1, 2]], 'both letters point back at the one original character');
  const emoji = foldWithMap('😀x');
  assert.deepEqual([emoji.starts, emoji.ends], [[0, 0, 2], [2, 2, 3]], 'a surrogate pair is one original character spanning UTF-16 units 0–2');
  assert.equal(foldQuery('  间隔   重复 '), '间隔 重复');
  assert.equal(foldQuery('   '), '');
});

test('matchOffsets finds every non-overlapping match up to the limit', () => {
  assert.deepEqual(matchOffsets('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(matchOffsets('abcabcabc', 'bc'), [1, 4, 7]);
  assert.deepEqual(matchOffsets('abcabcabc', 'bc', 2), [1, 4]);
  assert.deepEqual(matchOffsets('abc', ''), []);
});

/** A minimal DOM: text nodes in a row, with a tree walker and a range that records its ends. */
function fakeRoot(texts, { skip = [] } = {}) {
  const nodes = texts.map((text, index) => ({ textContent: text, parentElement: { closest: () => (skip.includes(index) ? {} : null) } }));
  const ownerDocument = {
    createTreeWalker() { let at = 0; return { nextNode: () => nodes[at++] ?? null }; },
    createRange() { const range = { setStart(node, offset) { range.start = [nodes.indexOf(node), offset]; }, setEnd(node, offset) { range.end = [nodes.indexOf(node), offset]; } }; return range; },
  };
  return { ownerDocument };
}

test('findRanges turns matches into DOM ranges, also across inline element boundaries', () => {
  const inside = findRanges(fakeRoot(['间隔重复很有效', '，间隔重复']), '间隔重复');
  assert.deepEqual(inside.map(range => [range.start, range.end]), [[[0, 0], [0, 4]], [[1, 1], [1, 5]]]);
  const across = findRanges(fakeRoot(['间隔', '重复很有效']), '间隔重复');
  assert.deepEqual([across[0].start, across[0].end], [[0, 0], [1, 2]], 'one match over two text nodes');
  assert.equal(findRanges(fakeRoot(['abc']), 'ABC').length, 1, 'case-insensitive');
  assert.equal(findRanges(fakeRoot(['a', 'b']), 'ab').length, 1);
  assert.deepEqual(findRanges(fakeRoot(['abc']), '   '), []);
  assert.deepEqual(findRanges(fakeRoot([]), 'x'), []);
  assert.deepEqual(findRanges(null, 'x'), []);
});

test('findRanges leaves out text inside passage marks, and matches words split by a line break', () => {
  const marked = findRanges(fakeRoot(['间隔', '[1]', '重复'], { skip: [1] }), '间隔重复');
  assert.deepEqual([marked[0].start, marked[0].end], [[0, 0], [2, 2]], 'the [1] mark is not part of the text');
  const wrapped = findRanges(fakeRoot(['间隔\n重复']), '间隔 重复');
  assert.equal(wrapped.length, 1, 'a hard line break matches a space');
  assert.equal(findRanges(fakeRoot(['aaaa']), 'a', { limit: 2 }).length, 2);
});

test('painting matches needs the Custom Highlight API; without it nothing happens', () => {
  assert.doesNotThrow(() => paintMatches([{}], 0)());
});
