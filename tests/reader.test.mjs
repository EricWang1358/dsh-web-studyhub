/* The source reader (资料预览): reading settings, how plain text is set for
   reading, the outline, and search inside a document. The pure logic runs
   here; the layout is checked in the browser preview. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { READER_DEFAULTS, SIZES, UNDERLINES, READER_STORAGE_KEY, normalizeReaderSettings, stepSize, readerVars, loadReaderSettings, saveReaderSettings, resetReaderSettings, underlineShown } from '../ui/document-preview/reader/settings.js';
import { looksLikeHeading, classifyParagraph, splitParagraphs, readingSections, lineBreakPieces } from '../ui/document-preview/reader/text-sections.js';
import { outlineFromSections, collectHeadings, pickActive, neighbours, readingProgress } from '../ui/document-preview/reader/outline.js';
import { foldWithMap, foldQuery, matchOffsets, findRanges, textHits, paintMatches } from '../ui/document-preview/reader/find.js';

/* ---------- settings ---------- */

test('reader settings: junk becomes the defaults, valid choices are kept', () => {
  assert.deepEqual(normalizeReaderSettings(undefined), READER_DEFAULTS);
  assert.deepEqual(normalizeReaderSettings('x'), READER_DEFAULTS);
  assert.deepEqual(normalizeReaderSettings({ size: 99, width: 'huge', face: 'comic', tone: 'neon', outline: 'yes', tools: 1, underline: 'maybe', weight: 'heavy', leading: 1, gap: '2em' }), READER_DEFAULTS);
  const chosen = { ...READER_DEFAULTS, size: 20, width: 'wide', face: 'serif', tone: 'paper', outline: false, tools: false, underline: 'hide', weight: 'bold', leading: 'loose', gap: 'tight' };
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

test('link underlines: shown by default, hidden only by an explicit choice, and an unknown or older stored value shows them', () => {
  assert.deepEqual(UNDERLINES, ['show', 'hide']);
  assert.equal(READER_DEFAULTS.underline, 'show');
  assert.equal(normalizeReaderSettings({}).underline, 'show', 'settings saved before this option existed');
  assert.equal(normalizeReaderSettings({ underline: 'hide' }).underline, 'hide');
  for (const odd of ['SHOW', 'off', '', null, 0, false, true, {}]) assert.equal(normalizeReaderSettings({ underline: odd }).underline, 'show', String(odd));
  assert.equal(underlineShown({ underline: 'show' }), true);
  assert.equal(underlineShown({ underline: 'hide' }), false);
  assert.equal(underlineShown(undefined), true);
});

test('link underlines are remembered per browser like the other settings, and an older stored object keeps its other choices', () => {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  saveReaderSettings({ ...READER_DEFAULTS, underline: 'hide', size: 18 }, storage);
  assert.equal(JSON.parse(store.get(READER_STORAGE_KEY)).underline, 'hide');
  assert.deepEqual(loadReaderSettings(storage), { ...READER_DEFAULTS, underline: 'hide', size: 18 });
  store.set(READER_STORAGE_KEY, JSON.stringify({ size: 20, width: 'wide', face: 'serif', tone: 'paper', outline: false, tools: true }));
  assert.deepEqual(loadReaderSettings(storage), { ...READER_DEFAULTS, size: 20, width: 'wide', face: 'serif', tone: 'paper', outline: false, tools: true, underline: 'show' });
  store.set(READER_STORAGE_KEY, JSON.stringify({ underline: 'sideways' }));
  assert.equal(loadReaderSettings(storage).underline, 'show');
});

test('restoring the defaults brings the underlines back and leaves the open panels as they are', () => {
  const current = { size: 22, width: 'wide', face: 'serif', tone: 'paper', outline: false, tools: false, underline: 'hide' };
  assert.deepEqual(resetReaderSettings(current), { ...READER_DEFAULTS, outline: false, tools: false });
  assert.equal(resetReaderSettings(current).underline, 'show');
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

test('a transcript is cut at its part headings (the sections of lib/sections.js) and keeps the text before the first one as its opening', () => {
  const parts = readingSections({ text: transcript });
  assert.deepEqual(parts.map(part => part.title), ['', '第一部分：容器基础', '第二部分：编排', '第三部分：故障诊断']);
  assert.deepEqual(parts.map(part => part.kind), ['lead', 'part', 'part', 'part']);
  assert.match(parts[0].paragraphs[0].text, /开场白/);
  assert.match(parts[1].paragraphs.map(paragraph => paragraph.text).join('\n'), /\[Part 1: Containers\]/);
  assert.ok(parts.every(part => part.paragraphs.every(paragraph => !/^【第/.test(paragraph.text))), 'the heading is the title, not body text');
  assert.equal(readingSections({ text: '【第一部分】\n只有一个' }).length, 1, 'one part is not a structure');
  assert.equal(readingSections({ text: '没有任何标记的一整段文字' }).length, 1);
  assert.equal(readingSections({ text: '正文里提到【某个词】并不是标记\n【孤立】' }).length, 1);
  assert.equal(readingSections({ text: '【第一部分：甲】\n正文。\n\n【英文原句】\n正文。' }).length, 1, 'a label is not a part');
});

test('readingSections: pages and slides one section each, transcripts one per part, other text one section', () => {
  const pages = readingSections({ paged: true, sources: [
    { id: 'p1', title: 'a.pdf · p.1', text: '索引入门\n\n正文一，写完整。', document: { page: 1 } },
    { id: 'p2', title: 'a.pdf · p.2', text: '没有标题的页面正文，写完整。\n\n又一段，写完整。', document: { page: 2 } }] });
  assert.deepEqual(pages.map(section => [section.kind, section.page, section.sourceId, section.heading]), [['page', 1, 'p1', '索引入门'], ['page', 2, 'p2', '']]);
  assert.equal(new Set(pages.map(section => section.id)).size, 2);
  const parts = readingSections({ text: transcript });
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(section => section.kind), ['lead', 'part', 'part', 'part']);
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

test('collectHeadings titles a heading with a formula by its stored text, not the drawn glyphs', () => {
  const drawn = { remove() { drawn.removed = true; } };
  const node = { ...heading('H2', '激活 $\sigma(z)$σ(z)σ(z)'), querySelector: () => drawn,
    cloneNode: () => ({ querySelectorAll: () => [drawn], get textContent() { return drawn.removed ? '激活 $\sigma(z)$' : 'junk'; } }) };
  assert.deepEqual(collectHeadings({ querySelectorAll: () => [node] }).map(item => item.title), ['激活 $\sigma(z)$']);
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

test('#56 findRanges & textHits respect caseSensitive and isolate per-root caches', () => {
  const mixed = fakeRoot(['AbC abc ABC']);
  assert.equal(findRanges(mixed, 'AbC').length, 3, 'default search ignores case');
  const exact = findRanges(mixed, 'AbC', { caseSensitive: true });
  assert.equal(exact.length, 1, 'caseSensitive matches exact case only');
  assert.deepEqual([exact[0].start, exact[0].end], [[0, 0], [0, 3]]);

  assert.equal(foldQuery('AbC', { caseSensitive: true }), 'AbC');
  const groups = [{ key: 'ch-1', parts: [{ page: 1, sourceId: 's1', text: 'AbC abc ABC AbC' }] }];
  assert.equal(textHits(groups, 'AbC')[0].count, 4);
  // Second query on the SAME `groups` instance proves separate caseSensitive WeakMap cache.
  assert.equal(textHits(groups, 'AbC', { caseSensitive: true })[0].count, 2);
  assert.equal(textHits(groups, 'aBc', { caseSensitive: true }).length, 0);
});

test('#13 PdfPageBar pageBoxKey & zoom double-click, #56 FindBar Aa/Alt+C, #60 RereadBar 上一段', async () => {
  let hooks = [], cursor = 0, pendingEffects = [];
  const h = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: h, memo: c => c,
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useReducer(reducer, init, initFn) { const i = cursor++; if (!(i in hooks)) hooks[i] = initFn ? initFn(init) : init; return [hooks[i], a => { hooks[i] = reducer(hooks[i], a); }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useEffect(fn, deps) { const i = cursor++, prev = hooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) { hooks[i] = { deps }; pendingEffects.push(fn); } },
    useInsertionEffect() {},
    useCallback: fn => fn,
    useSyncExternalStore: (_s, snap) => snap(),
  };
  reactShim.default = reactShim;
  globalThis.__READER_COMP_REACT__ = reactShim;
  const expand = node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    if (typeof node.$$type === 'function') return expand(node.$$type(node.props || {}));
    const kids = Array.isArray(node.props?.children) ? node.props.children.map(expand) : expand(node.props?.children);
    return { ...node, props: { ...(node.props || {}), children: kids } };
  };
  const findAll = (node, pred, out = [], seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(item => findAll(item, pred, out, seen)); return out; }
    if (node.$$type && pred(node)) out.push(node);
    if (node.props?.children !== undefined) findAll(node.props.children, pred, out, seen);
    return out;
  };
  try {
    const built = await build({
      stdin: {
        contents: `
          export { default as PdfPageBar, pageBoxKey } from './ui/document-preview/reader/PdfPageBar.jsx';
          export { default as FindBar } from './ui/document-preview/reader/FindBar.jsx';
          export { default as RereadBar } from './ui/document-preview/RereadBar.jsx';
          export { setUiLanguage } from './ui/i18n.js';`,
        resolveDir: process.cwd(),
      },
      bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
      plugins: [{
        name: 'shim-reader-comp',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'rc' }));
          builder.onLoad({ filter: /.*/, namespace: 'rc' }, () => ({
            contents: `const R = globalThis.__READER_COMP_REACT__; export default R; export const { Fragment, createElement, memo, useState, useRef, useEffect, useInsertionEffect, useCallback, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'rcc' }));
          builder.onLoad({ filter: /.*/, namespace: 'rcc' }, () => ({
            contents: `const R = globalThis.__READER_COMP_REACT__;
              export const Button = p => R.createElement('button', p, p.children);
              export const IconButton = p => R.createElement('button', { ...p, 'data-icon': p.icon, 'aria-label': p.label });
              export const Icon = p => R.createElement('span', { 'data-icon': p.name, className: p.className });
              export const NumberInput = p => R.createElement('input', { ...p, 'data-comp': 'NumberInput' });
              export const Tooltip = p => R.createElement('span', { 'data-tooltip': p.content }, p.children);`,
            loader: 'js',
          }));
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { PdfPageBar, pageBoxKey, FindBar, RereadBar, setUiLanguage } = mod.exports;
    setUiLanguage('zh');

    // #13 pageBoxKey ArrowUp / ArrowDown (+/-1, Shift +/-10)
    const steps = [];
    let prevented = 0;
    const ev = (key, shiftKey = false) => ({ key, shiftKey, preventDefault: () => { prevented += 1; }, stopPropagation: () => {} });
    assert.equal(pageBoxKey(ev('ArrowUp'), { apply: () => {}, reset: () => {}, step: d => steps.push(d) }), true);
    assert.equal(pageBoxKey(ev('ArrowUp', true), { apply: () => {}, reset: () => {}, step: d => steps.push(d) }), true);
    assert.equal(pageBoxKey(ev('ArrowDown'), { apply: () => {}, reset: () => {}, step: d => steps.push(d) }), true);
    assert.equal(pageBoxKey(ev('ArrowDown', true), { apply: () => {}, reset: () => {}, step: d => steps.push(d) }), true);
    assert.deepEqual(steps, [1, 10, -1, -10]);
    assert.equal(prevented, 4);

    // #13 PdfPageBar step clamping & zoom double-click
    const pages = [], zooms = [];
    const renderPdfBar = props => {
      cursor = 0; pendingEffects = [];
      const tree = expand(h(PdfPageBar, props));
      pendingEffects.splice(0).forEach(fn => fn());
      return tree;
    };
    hooks = [];
    let bar = renderPdfBar({ page: 5, total: 25, onPage: p => pages.push(p), zoom: 1, onZoom: z => zooms.push(z) });
    const box = findAll(bar, n => n.props?.className === 'reader-pdf-bar__input')[0];
    box.props.onKeyDown(ev('ArrowUp', true));
    box.props.onKeyDown(ev('ArrowDown'));
    assert.deepEqual(pages, [15, 14]);
    const zoomOut1 = findAll(bar, n => n.props?.className === 'reader-pdf-bar__zoom')[0];
    assert.equal(findAll(bar, n => n.props?.['data-tooltip'] === '双击切换适合宽度与放大').length, 1);
    zoomOut1.props.onDoubleClick();
    bar = renderPdfBar({ page: 5, total: 25, onPage: p => pages.push(p), zoom: 1.5, onZoom: z => zooms.push(z) });
    const zoomOut2 = findAll(bar, n => n.props?.className === 'reader-pdf-bar__zoom')[0];
    zoomOut2.props.onDoubleClick();
    assert.deepEqual(zooms, [1, 0]);

    // #56 FindBar case-sensitivity toggle button & Alt+C shortcut
    const caseCalls = [];
    hooks = [];
    cursor = 0;
    const fTree = expand(h(FindBar, { query: 'Word', onQuery: () => {}, total: 2, index: 0, onStep: () => {}, onClose: () => {}, caseSensitive: false, onCaseSensitive: v => caseCalls.push(v) }));
    const caseBtn = findAll(fTree, n => String(n.props?.className || '').includes('reader-find__case'))[0];
    assert.equal(caseBtn.props['aria-pressed'], false);
    assert.equal(caseBtn.props['aria-keyshortcuts'], 'Alt+C');
    assert.equal(findAll(fTree, n => n.props?.['data-tooltip'] === '区分大小写（Alt+C）').length, 1);
    caseBtn.props.onClick();
    const findRoot = findAll(fTree, n => n.props?.className === 'reader-find')[0];
    let altStopped = false, altPrevented = false;
    findRoot.props.onKeyDown({ altKey: true, ctrlKey: false, metaKey: false, key: 'c', preventDefault: () => { altPrevented = true; }, stopPropagation: () => { altStopped = true; } });
    assert.deepEqual(caseCalls, [true, true]);
    assert.equal(altPrevented && altStopped, true);

    // #60 RereadBar 上一段
    let prevClicks = 0;
    hooks = []; cursor = 0;
    const rTreeWithPrev = expand(h(RereadBar, { reread: { position: 2, total: 3, onDone: () => {}, onPrev: () => { prevClicks += 1; } } }));
    const prevBtn = findAll(rTreeWithPrev, n => n.props?.['data-reread'] === 'prev')[0];
    assert.ok(prevBtn, 'renders 上一段 button when reread.onPrev is provided');
    prevBtn.props.onClick();
    assert.equal(prevClicks, 1);
    hooks = []; cursor = 0;
    const rTreeWithoutPrev = expand(h(RereadBar, { reread: { position: 1, total: 3, onDone: () => {} } }));
    assert.equal(findAll(rTreeWithoutPrev, n => n.props?.['data-reread'] === 'prev').length, 0);
  } finally {
    delete globalThis.__READER_COMP_REACT__;
  }
});

test('#12, #56, #60 DocumentViewer: jump-back pill + Alt+ArrowLeft + 8s expiry, FindBar case toggle, Alt+Enter reread done', async () => {
  const prevWin = globalThis.window, prevDoc = globalThis.document, prevLS = globalThis.localStorage;
  const prevRaf = globalThis.requestAnimationFrame, prevSetTimeout = globalThis.setTimeout, prevClearTimeout = globalThis.clearTimeout;
  const hooksByPath = new Map();
  let curHooks = [], cursor = 0, pendingEffects = [], rafQueue = [], timers = [], nextTimerId = 1;
  const h = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const domNode = extra => ({
    scrollTop: 0, clientHeight: 500, focus: () => {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }), scrollTo({ top }) { this.scrollTop = top; },
    ...extra,
  });
  let scrollerObj = null;
  const eff = (fn, deps) => {
    const bucket = curHooks, i = cursor++, prev = bucket[i];
    if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) {
      bucket[i] = { deps, cleanup: prev?.cleanup };
      pendingEffects.push(() => { bucket[i].cleanup?.(); bucket[i].cleanup = fn(); });
    }
  };
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: h, cloneElement: (el, p, ...ch) => ({ ...el, props: { ...(el?.props || {}), ...(p || {}), ...(ch.length ? { children: ch.length === 1 ? ch[0] : ch } : {}) } }),
    isValidElement: x => !!x && typeof x === 'object' && '$$type' in x,
    Children: { toArray: c => (Array.isArray(c) ? c.flat(Infinity) : c == null ? [] : [c]), map: (c, fn) => (Array.isArray(c) ? c : [c]).map(fn) },
    memo: c => c, forwardRef: fn => (props => fn(props, props?.ref)),
    Suspense: p => p.children, lazy: () => () => null,
    createContext: def => { const ctx = { _def: def, _val: def }; ctx.Provider = Object.assign(({ value, children }) => { ctx._val = value; return children; }, { $$providerCtx: ctx }); return ctx; },
    useContext: ctx => ctx?._val ?? ctx?._def,
    useState(init) { const bucket = curHooks, i = cursor++; if (!(i in bucket)) bucket[i] = typeof init === 'function' ? init() : init; return [bucket[i], v => { bucket[i] = typeof v === 'function' ? v(bucket[i]) : v; }]; },
    useReducer(reducer, init, initFn) { const bucket = curHooks, i = cursor++; if (!(i in bucket)) bucket[i] = initFn ? initFn(init) : init; return [bucket[i], a => { bucket[i] = reducer(bucket[i], a); }]; },
    useRef(init) { const i = cursor++; if (!(i in curHooks)) curHooks[i] = { current: init }; return curHooks[i]; },
    useId() { const i = cursor++; if (!(i in curHooks)) curHooks[i] = `:id${i}:`; return curHooks[i]; },
    useDeferredValue: v => v,
    useCallback: fn => fn,
    useImperativeHandle() {},
    useMemo(fn, deps) { const i = cursor++, prev = curHooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) curHooks[i] = { val: fn(), deps }; return curHooks[i].val; },
    useEffect: eff,
    useLayoutEffect: eff,
    useInsertionEffect() {},
    useSyncExternalStore: (_s, snap) => snap(),
  };
  reactShim.default = reactShim;
  globalThis.__DV_REACT__ = reactShim;
  const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.localStorage = ls;
  globalThis.window = {
    getSelection: () => null, addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), localStorage: ls,
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute: () => {} }), head: { appendChild: () => {} } };
  globalThis.requestAnimationFrame = fn => { rafQueue.push(fn); return rafQueue.length; };
  globalThis.setTimeout = (fn, ms, ...args) => { const id = nextTimerId++; timers.push({ id, fn, ms, args, cleared: false }); return id; };
  globalThis.clearTimeout = id => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; };

  const scrollHistory = [];
  scrollerObj = domNode({
    scrollTo({ top }) { scrollerObj.scrollTop = top; scrollHistory.push(top); },
  });
  const bodyObj = domNode({ ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) } });
  const attachRef = node => {
    const ref = node.props?.ref;
    if (!ref || typeof ref !== 'object') return;
    if (String(node.props?.className || '').includes('reader-scroll')) ref.current = scrollerObj;
    else if (String(node.props?.className || '').includes('study-document-body')) ref.current = bodyObj;
    else if (!ref.current) ref.current = domNode();
  };
  const withBucket = (path, fn) => {
    let bucket = hooksByPath.get(path);
    if (!bucket) { bucket = []; hooksByPath.set(path, bucket); }
    const prevH = curHooks, prevC = cursor;
    curHooks = bucket; cursor = 0;
    try { return fn(); } finally { curHooks = prevH; cursor = prevC; }
  };
  const expand = (node, path = '0') => {
    if (Array.isArray(node)) return node.map((item, idx) => expand(item, `${path}[${idx}]`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$$type === 'symbol') return expand(node.props?.children, `${path}:F`);
    if (node.$$type?.$$providerCtx) {
      node.$$type.$$providerCtx._val = node.props?.value;
      return expand(node.props?.children, `${path}:P`);
    }
    if (typeof node.$$type === 'function') {
      const slot = `${path}/${node.$$type.name || 'fn'}${node.props?.key != null ? `#${node.props.key}` : ''}`;
      const rendered = withBucket(slot, () => node.$$type(node.props || {}));
      return expand(rendered, slot);
    }
    attachRef(node);
    const kids = expand(node.props?.children, `${path}:c`);
    return { ...node, props: { ...(node.props || {}), children: kids } };
  };
  const findAll = (node, pred, out = [], seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(item => findAll(item, pred, out, seen)); return out; }
    if (node.$$type && pred(node)) out.push(node);
    if (node.props?.children !== undefined) findAll(node.props.children, pred, out, seen);
    return out;
  };
  try {
    const built = await build({
      stdin: {
        contents: `
          export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
          export { setUiLanguage } from './ui/i18n.js';`,
        resolveDir: process.cwd(),
      },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-dv',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'dvr' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvr' }, () => ({
            contents: `const R = globalThis.__DV_REACT__; export default R; export const { Fragment, createElement, cloneElement, isValidElement, Children, memo, forwardRef, Suspense, lazy, createContext, useContext, useState, useReducer, useRef, useId, useDeferredValue, useCallback, useImperativeHandle, useMemo, useEffect, useLayoutEffect, useInsertionEffect, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /^dompurify$/ }, () => ({ path: 'dp', namespace: 'dvdp' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvdp' }, () => ({ contents: `export default { sanitize: s => s };`, loader: 'js' }));
          builder.onResolve({ filter: /^katex$|^katex\// }, () => ({ path: 'kt', namespace: 'dvkt' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvkt' }, () => ({ contents: `const k = { renderToString: s => s, __defineMacro: () => {} }; export default k;`, loader: 'js' }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'dvc' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvc' }, () => ({
            contents: `const R = globalThis.__DV_REACT__;
              const stub = tag => p => R.createElement(tag, p, p.children);
              export const Button = stub('button');
              export const IconButton = p => R.createElement('button', { ...p, 'data-icon': p.icon, 'aria-label': p.label });
              export const Icon = p => R.createElement('span', { 'data-icon': p.name, className: p.className });
              export const ICON_NAMES = new Set();
              export const IconBox = stub('span');
              export const InlineMessage = stub('div');
              export const LoadingState = p => R.createElement('div', p, p.label);
              export const SegmentedControl = stub('div');
              export const Tooltip = p => R.createElement('span', { 'data-tooltip': p.content }, p.children);
              export const focusQuietly = el => el?.focus?.();
              export const Disclosure = stub('div');
              export const PANEL_TONES = {};
              export const Banner = stub('div');
              export const Hint = stub('div');
              export const SetupRequired = stub('div');
              export const HelpTip = stub('div');
              export const Panel = stub('div');
              export const Dialog = stub('div');
              export const useTopDialog = () => false;
              export const ConfirmDialog = stub('div');
              export const InlineConfirm = stub('div');
              export const Popover = stub('div');
              export const Menu = stub('div');
              export const ContextMenu = stub('div');
              export const CloseButton = stub('button');
              export const Badge = stub('span');
              export const Chip = stub('button');
              export const ProgressBar = stub('div');
              export const StackedBar = stub('div');
              export const Spinner = stub('span');
              export const ErrorState = stub('div');
              export const CrashFallback = stub('div');
              export const CopyDiagnosticsButton = stub('button');
              export const errorText = e => String(e || '');
              export const EmptyState = stub('div');
              export const AddSourceButton = stub('button');
              export const addSourceAction = onClick => ({ label: '', icon: '', onClick });
              export const ADD_SOURCE_ICON = 'upload';
              export const PageHeader = stub('div');
              export const FileDrop = stub('div');
              export const partitionFiles = f => ({ accepted: f, rejected: [] });
              export const formatBytes = n => String(n);
              export const describeAccept = () => '';
              export const createDropHandlers = () => ({});
              export const guardFileDrag = () => {};
              export const ScrollWindow = stub('div');
              export const ChunkedRows = stub('div');
              export const filterItems = a => a;
              export const scrollWindowCount = () => 0;
              export const scrollEdges = () => ({});
              export const edgeTracker = () => ({});
              export const Field = stub('div');
              export const TextInput = stub('input');
              export const TextArea = stub('textarea');
              export const Select = stub('select');
              export const NumberInput = stub('input');
              export const Combobox = stub('div');
              export const flattenOptions = o => o;
              export const filterEntries = e => e;
              export const matchRanges = () => [];
              export const highlightParts = t => [{ text: t, hit: false }];
              export const resolveActions = a => a;
              export const Checkbox = stub('input');
              export const CheckboxInput = stub('input');
              export const Switch = stub('button');
              export const RadioCard = stub('div');
              export const RadioCardGroup = stub('div');
              export const SettingsSection = stub('div');
              export const ProviderCard = stub('div');
              export const ProviderGrid = stub('div');
              export const StepList = stub('div');
              export const Tabs = stub('div');
              export const TabPanel = stub('div');
              export const nextTabIndex = () => 0;
              export const tabIds = () => ({});
              export const DisclosureToggle = stub('button');
              export const foldLabel = () => '';
              export const JobRow = stub('div');
              export const jobAnnouncement = () => '';
              export const useNow = () => Date.now();
              export const createClock = () => ({ now: () => Date.now() });
              export const TONES = {};
              export const toneOf = () => 'neutral';
              export const TONE_ICONS = {};
              export const useDismiss = () => {};
              export const useAnchoredPosition = () => ({});
              export const computePlacement = () => ({});
              export const placeInHost = () => ({});
              export const SecretKeyForm = stub('div');
              export const Toast = stub('div');
              export const ToastRegion = stub('div');
              export const ToastContext = R.createContext(null);
              export const shouldAutoDismiss = () => true;
              export const TOAST_TIMEOUT = 3000;
              export const createToastApi = () => ({ show: () => {}, success: () => {}, info: () => {}, warning: () => {}, error: () => {} });
              export const useToast = () => ({ show: () => {}, success: () => {}, info: () => {}, warning: () => {}, error: () => {} });
              export const useInjectCss = () => {};`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/css\.js$/ }, () => ({ path: 'compcss', namespace: 'dvccss' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvccss' }, () => ({ contents: `export const useInjectCss = () => {}; export const useComponentCss = () => {};`, loader: 'js' }));
          builder.onResolve({ filter: /app-context\.js$/ }, () => ({ path: 'appctx', namespace: 'dva' }));
          builder.onLoad({ filter: /.*/, namespace: 'dva' }, () => ({ contents: `const R = globalThis.__DV_REACT__; export const AppContext = R.createContext({}); export const useApp = () => ({ data: { contexts: [], capabilities: [], settings: {} }, core: {}, host: {}, nav: {}, learn: {}, intents: {}, drafts: {}, dailyPlan: null, selectionNotices: { subscribe: () => () => {} }, settingsEntry: {}, set: {}, session: {} });`, loader: 'js' }));
          builder.onResolve({ filter: /useReadingPosition\.js$/ }, () => ({ path: 'pos', namespace: 'dvp' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvp' }, () => ({
            contents: `export const scrollToNode = (root, node) => globalThis.__DV_JUMP__?.('node', root, node);
              export const useReadingPosition = () => [{ activeId: globalThis.__DV_ACTIVE_ID__ ?? 'p1', progress: 0.1 }, id => globalThis.__DV_JUMP__?.('outline', id)];`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /OutlinePanel\.jsx$|PdfOriginal\.jsx$|PagePeek\.jsx$|DocumentLearning\.jsx$/ }, args => ({ path: args.path, namespace: 'dvcomp' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvcomp' }, args => {
            if (args.path.endsWith('OutlinePanel.jsx')) return { contents: `const R = globalThis.__DV_REACT__; export default p => R.createElement('aside', { ...p, 'data-comp': 'OutlinePanel' });`, loader: 'js' };
            return { contents: `export default () => null;`, loader: 'js' };
          });
          builder.onResolve({ filter: /useReadingLoop\.jsx$|useReaderMarks\.jsx$|useBilingual\.jsx$|usePassageLinkLayer\.js$|RereadBar\.jsx$/ }, args => ({ path: args.path, namespace: 'dvhook' }));
          builder.onLoad({ filter: /.*/, namespace: 'dvhook' }, args => {
            if (args.path.endsWith('RereadBar.jsx')) return { contents: `const R = globalThis.__DV_REACT__; export default p => R.createElement('div', { 'data-comp': 'RereadBar', ...p });`, loader: 'js' };
            if (args.path.endsWith('useReadingLoop.jsx')) return { contents: `export const useReadingLoop = () => ({ status: 'idle', open: false, setOpen: () => {}, cards: [], meters: new Map(), here: () => null, start: () => {}, generateIds: () => [], upgradedIds: new Set(), coverage: null, outlineCoverage: null, resumeNote: null });`, loader: 'js' };
            if (args.path.endsWith('useReaderMarks.jsx')) return { contents: `export const useReaderMarks = () => ({ chip: null, moreItems: [], menu: null, onContextMenu: () => {} });`, loader: 'js' };
            if (args.path.endsWith('useBilingual.jsx')) return { contents: `const useBilingual = () => ({ supported: false, notice: null, displayRow: null, layer: null, dialog: null, openDialog: () => {} }); export default useBilingual; export { useBilingual };`, loader: 'js' };
            return { contents: `export const usePassageLinkLayer = () => {};`, loader: 'js' };
          });
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { DocumentViewer, setUiLanguage } = mod.exports;
    setUiLanguage('zh');

    const pages = Array.from({ length: 24 }, (_, idx) => ({
      id: `p${idx + 1}`,
      title: `Page ${idx + 1}`,
      text: `Page ${idx + 1} content`,
      document: { materialId: 'doc-1', page: idx + 1, format: 'pdf', title: 'Book' },
    }));
    const doc = { id: 'doc-1', documentId: 'doc-1', revision: 'r1', format: 'pdf', originalAvailable: false, sources: pages };
    const call = async name => {
      if (name === 'materials.document.get') return doc;
      if (name === 'materials.links.list') return { links: [] };
      if (name === 'materials.annotation.list') return { items: [], stale: [] };
      return {};
    };
    let doneCount = 0;
    const baseProps = { source: pages[0], call, data: { sources: pages, root: 'r', contexts: [], capabilities: [] }, reread: { position: 1, total: 2, onDone: () => { doneCount += 1; } } };
    const render = (props = baseProps) => {
      pendingEffects = [];
      const tree = expand(h(DocumentViewer, props), 'root');
      pendingEffects.splice(0).forEach(fn => fn());
      return tree;
    };
    const flushRaf = () => {
      for (let pass = 0; pass < 4 && rafQueue.length; pass++) {
        const q = rafQueue.splice(0);
        q.forEach(fn => fn());
      }
    };

    render();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    let tree = render();
    const outline = findAll(tree, n => n.props?.['data-comp'] === 'OutlinePanel')[0];
    assert.ok(outline && outline.props.items.length >= 2, 'outline has >=2 chapter items');

    // #12 short same-chapter jump (< 1.5 * clientHeight = 750) should NOT show jump-back pill
    scrollerObj.scrollTop = 40;
    globalThis.__DV_JUMP__ = () => { scrollerObj.scrollTop = 300; };
    outline.props.onJump({ id: 'p2', page: 2 });
    flushRaf();
    tree = render();
    assert.equal(findAll(tree, n => String(n.props?.className || '').includes('reader-jump-back')).length, 0);

    // #12 long same-chapter jump (>= 750) shows .reader-jump-back & Alt+ArrowLeft jumps back
    scrollerObj.scrollTop = 40;
    scrollHistory.length = 0;
    globalThis.__DV_JUMP__ = () => { scrollerObj.scrollTop = 900; };
    outline.props.onJump({ id: 'p10', page: 10 });
    flushRaf();
    tree = render();
    const pill = findAll(tree, n => String(n.props?.className || '').includes('reader-jump-back'))[0];
    assert.ok(pill, 'long distance jump shows reader-jump-back pill');
    assert.ok(String(pill.props.children).startsWith('回到'));
    assert.equal(pill.props.icon, 'arrow-left', 'the way back draws the registry arrow, on the left');
    const viewerDiv = findAll(tree, n => String(n.props?.className || '').includes('study-document-viewer'))[0];
    let backPrevented = false;
    viewerDiv.props.onKeyDown({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowLeft', target: {}, preventDefault: () => { backPrevented = true; } });
    assert.equal(backPrevented, true);
    assert.equal(scrollerObj.scrollTop, 40);
    tree = render();
    assert.equal(findAll(tree, n => String(n.props?.className || '').includes('reader-jump-back')).length, 0);

    // #12 cross-chapter jump sets returnSpot & 8000ms timer clears it
    const chapter2 = outline.props.items.find(item => item.kind === 'chapter' && item.id !== 'block-0');
    assert.ok(chapter2, 'has second chapter in outline');
    timers.length = 0;
    outline.props.onJump(chapter2);
    tree = render();
    flushRaf();
    tree = render();
    assert.equal(findAll(tree, n => String(n.props?.className || '').includes('reader-jump-back')).length, 1);
    const expiryTimer = timers.find(t => !t.cleared && t.ms === 8000);
    assert.ok(expiryTimer, 'schedules 8000ms auto-expiry timer');
    expiryTimer.fn();
    tree = render();
    assert.equal(findAll(tree, n => String(n.props?.className || '').includes('reader-jump-back')).length, 0);

    // #60 Alt+Enter calls reread.onDone()
    let altEnterPrevented = false;
    findAll(tree, n => String(n.props?.className || '').includes('study-document-viewer'))[0]
      .props.onKeyDown({ altKey: true, ctrlKey: false, metaKey: false, key: 'Enter', target: {}, preventDefault: () => { altEnterPrevented = true; } });
    assert.equal(altEnterPrevented, true);
    assert.equal(doneCount, 1);

    // #56 Ctrl+F opens FindBar, Alt+C toggles caseSensitive state in DocumentViewer
    findAll(tree, n => String(n.props?.className || '').includes('study-document-viewer'))[0]
      .props.onKeyDown({ ctrlKey: true, altKey: false, key: 'f', target: {}, preventDefault: () => {} });
    tree = render();
    let findBarRoot = findAll(tree, n => n.props?.className === 'reader-find')[0];
    assert.ok(findBarRoot);
    assert.equal(findAll(tree, n => String(n.props?.className || '').includes('reader-find__case'))[0].props['aria-pressed'], false);
    findBarRoot.props.onKeyDown({ altKey: true, ctrlKey: false, metaKey: false, key: 'c', preventDefault: () => {}, stopPropagation: () => {} });
    tree = render();
    assert.equal(findAll(tree, n => String(n.props?.className || '').includes('reader-find__case'))[0].props['aria-pressed'], true);
  } finally {
    delete globalThis.__DV_REACT__;
    delete globalThis.__DV_JUMP__;
    delete globalThis.__DV_ACTIVE_ID__;
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLS;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
  }
});
