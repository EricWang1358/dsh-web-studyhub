import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf, sectionsBySource, sectionsInRange, sectionAt, leavesOf, windowRanges, chaptersOfOutline, isPartHeading, isSectionLabel, zhNumberValue, isLabelTitle, WINDOW_CHARS } from '../lib/sections.js';
import { chaptersOfOutline as keptChapters } from '../lib/document-outline.js';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { buildDocuments } from '../lib/transcript.js';

// The one definition of a source's sections (lib/sections.js), on the audited merged transcript (80 real parts, two volumes), PDF pages, Markdown, plain text and a kept outline.

const world = mergedTranscript();
const PART_LINE = /^【第.+部分：.*】$/gm;
const count = (text, pattern) => (text.match(pattern) || []).length;

/** The sections of one source tile its text: they start at 0, each starts where the previous one ends, the last ends at the end. */
function assertTiles(sections, text, label = 'sections') {
  assert.ok(sections.length > 0, `${label}: some`);
  assert.equal(sections[0].start, 0, `${label}: the first starts at 0`);
  sections.forEach((section, index) => {
    assert.ok(section.end >= section.start, `${label}[${index}] is not backwards`);
    assert.equal(section.chars, section.end - section.start);
    if (index) assert.equal(section.start, sections[index - 1].end, `${label}[${index}] starts where the one before ends`);
  });
  assert.equal(sections.at(-1).end, text.length, `${label}: the last ends at the end`);
}

test('the merged transcript: 60 + 20 real parts in two volumes, five recordings, and no label is a section', () => {
  assert.equal(world.volumes.length, 2);
  const [first, second] = world.volumes, all = sectionsOf(world.sources);
  const headed = [count(first, PART_LINE), count(second, PART_LINE)];
  assert.equal(headed[0] + headed[1], 80, 'the audit\'s 80 parts');
  const bySource = sectionsBySource(all);
  for (const [index, source] of world.sources.entries()) {
    const sections = bySource.get(source.id);
    assert.equal(sections.filter(section => section.kind === 'part' && !section.continued).length, headed[index], `volume ${index + 1}: one part section per part heading`);
    assertTiles(sections, source.text, `volume ${index + 1}`);
  }
  assert.ok(all.every(section => !/英文原句|中文对照|中文原文|英文对照|English original|Chinese translation/.test(section.title)), 'a label is never a section');
  assert.ok(all.every(section => !/^=+$/.test(section.title) && !/全量中英对照/.test(section.title)), 'the furniture is never a section');
  // Every part section starts with its own heading line; its title is the heading's words.
  const sample = bySource.get(world.sources[0].id).find(section => section.kind === 'part');
  assert.equal(world.sources[0].text.slice(sample.heading.start, sample.heading.end), `【${sample.title}】`);
  assert.equal(sample.title, '第一部分：预览段落 1');
  assert.equal(sample.recording, 1);
  assert.equal(sample.part, 1);
});

test('recordings are the first level with their file name, parts the second, and a recording split across two volumes is in both with the same number', () => {
  const sections = sectionsOf(world.sources);
  const recordings = sections.filter(section => section.kind === 'recording');
  assert.deepEqual(recordings.map(section => [section.sourceId, section.recording]), [['audio-batch-vol1', 1], ['audio-batch-vol1', 2], ['audio-batch-vol1', 3], ['audio-batch-vol1', 4], ['audio-batch-vol2', 4], ['audio-batch-vol2', 5]]);
  assert.deepEqual(recordings.map(section => section.title), ['API应用与产品策略培训.mp3', '平台框架培训-第二天.mp3', '平台框架培训-第一天.mp3', '产品策略答疑录音.wav', '产品策略答疑录音.wav', 'API治理与复用设计.mp3']);
  assert.ok(recordings.every(section => section.level === 1));
  assert.ok(sections.filter(section => section.kind === 'part').every(section => section.level === 2 && Number.isInteger(section.recording)));
  // The second volume opens with the tail of recording 4's last part: a continuation, which carries that part's number and title.
  const second = sectionsBySource(sections).get('audio-batch-vol2'), carried = second.find(section => section.continued);
  const lastOfFirst = sectionsBySource(sections).get('audio-batch-vol1').filter(section => section.kind === 'part').at(-1);
  assert.equal(carried.recording, 4);
  assert.equal(carried.part, lastOfFirst.part);
  assert.equal(carried.title, lastOfFirst.title);
  assert.equal(lastOfFirst.recording, 4);
  // Part numbers restart at 1 in every recording and are not ambiguous because every part knows its recording.
  const firstParts = sections.filter(section => section.kind === 'part' && section.part === 1);
  assert.deepEqual(firstParts.map(section => section.recording), [1, 2, 3, 4, 5]);
});

test('only the leaves are counted: a recording that has parts is not a leaf, and leaves are what the parts and the text give', () => {
  const sections = sectionsOf(world.sources), leaves = leavesOf(sections);
  assert.ok(leaves.every(section => section.kind === 'part'), 'recordings that hold parts are parents');
  assert.equal(leaves.filter(section => !section.continued).length, 80);
  assert.equal(leaves.filter(section => section.continued).length, 1);
});

test('ids are unique in a source and stable: the same text gives the same ids, a different offset does not change them', () => {
  const again = sectionsOf(world.sources).map(section => [section.sourceId, section.id]), first = sectionsOf(world.sources).map(section => [section.sourceId, section.id]);
  assert.deepEqual(again, first);
  for (const ids of Object.values(Object.groupBy(first, ([source]) => source))) assert.equal(new Set(ids.map(([, id]) => id)).size, ids.length, 'unique within a source');
  // A correction inside the first part moves every offset after it, never an id.
  const corrected = world.sources.map((source, index) => index ? source : { ...source, text: source.text.replace('Recording 1, part 1, point 1', 'Recording 1, part 1, a longer correction point 1') });
  assert.deepEqual(sectionsOf(corrected).map(section => [section.sourceId, section.id]), first);
  // Alone or with its other volume, a volume has the same ids.
  assert.deepEqual(sectionsOf(world.sources[0]).map(section => section.id), sectionsOf(world.sources).filter(section => section.sourceId === 'audio-batch-vol1').map(section => section.id));
  assert.deepEqual(sectionsOf(world.sources[1]).map(section => section.id).filter(id => !id.endsWith('.cont')), sectionsOf(world.sources).filter(section => section.sourceId === 'audio-batch-vol2' && !section.continued).map(section => section.id));
});

test('a source alone, without its other volume, still finds the carried-on text of a recording (it opens without the recording\'s furniture)', () => {
  const alone = sectionsOf(world.sources[1]);
  const continued = alone.find(section => section.continued);
  assert.ok(continued, 'the tail is its own section');
  assert.equal(continued.recording, 4);
  assert.equal(continued.title, '', 'the title of the part it carries on is only known from the first volume');
  assertTiles(alone, world.sources[1].text);
});

test('a 560k-character, 80-part transcript is divided in well under 100 ms', () => {
  sectionsOf(world.sources);
  const times = [];
  for (let run = 0; run < 5; run += 1) { const t0 = performance.now(); const result = sectionsOf(world.sources); times.push(performance.now() - t0); assert.ok(result.length > 80); }
  assert.ok(Math.min(...times) < 100, `fastest of five runs: ${Math.min(...times).toFixed(1)} ms`);
});

test('the English transcript: [Part N: title] lines are the parts, [English original] and [Chinese translation] are labels', () => {
  const [text] = buildDocuments({ filename: 'a.mp3', titleEn: 'T', language: 'en', parts: Array.from({ length: 4 }, (_, index) => ({ titleZh: `段${index + 1}`, titleEn: `Passage ${index + 1}`, english: ['e1', 'e2'], chinese: ['c1', 'c2'] })) });
  const sections = sectionsOf({ id: 's', text });
  assert.deepEqual(sections.map(section => [section.kind, section.title, section.part]), [1, 2, 3, 4].map(n => ['part', `Part ${n}: Passage ${n}`, n]));
  assert.ok(sections.every(section => section.level === 1), 'no recordings: parts are the top level');
  assertTiles(sections, text);
});

test('the Chinese part line is followed by the English [Part N: …] subtitle, which is not a part of its own', () => {
  const text = '【第一部分：容器基础】\n[Part 1: Containers]\n\n【英文原句】\ne\n\n【中文对照】\nc\n\n---\n\n【第二部分：编排】\n[Part 2: Orchestration]\n\n【英文原句】\ne2';
  const sections = sectionsOf({ id: 's', text });
  assert.deepEqual(sections.map(section => section.title), ['第一部分：容器基础', '第二部分：编排']);
  assertTiles(sections, text);
});

test('the parts of one text with no recordings and an untitled opening: the opening belongs to the first part', () => {
  const text = '开场白一句。\n【第一部分：容器基础】\n[Part 1: Containers]\n\n容器是进程。\n【第二部分：编排】\n\nPod 是最小单位。\n【第三部分：故障诊断】\n看日志。';
  const sections = sectionsOf({ id: 's', text });
  assert.equal(sections.length, 3);
  assert.equal(sections[0].start, 0);
  assert.equal(text.slice(sections[0].heading.start, sections[0].heading.end), '【第一部分：容器基础】');
  assert.ok(sections[0].heading.start > sections[0].start, 'the section starts above its heading');
  assertTiles(sections, text);
});

test('what is not a part heading is not a section: other 【…】 lines, a single part, a numbered Markdown heading', () => {
  assert.equal(isPartHeading('【第三部分：故障诊断】'), true);
  assert.equal(isPartHeading('【第三部分】'), true);
  assert.equal(isPartHeading('[Part 3: Debugging]'), true);
  assert.equal(isPartHeading('【英文原句】'), false);
  assert.equal(isPartHeading('正文里提到【第三部分：x】并不是标记'), false);
  assert.equal(isSectionLabel('【英文原句】'), true);
  assert.equal(isSectionLabel('[Chinese translation]'), true);
  assert.equal(isSectionLabel('【第三部分：故障诊断】'), false);
  const notes = '【注意】\n不是章节。\n\n【提示】\n也不是。\n\n' + '一段话。\n\n'.repeat(5);
  assert.ok(sectionsOf({ id: 'n', text: notes }).every(section => section.kind === 'window'));
  assert.deepEqual(sectionsOf({ id: 'n', text: '【第一部分：只有一个】\n' + '正文。\n\n'.repeat(5) }).map(section => section.kind), ['window'], 'one part is no structure');
  const guide = '# Guide\n\n## 1. Install\n\nrun it\n\n## 2. Use\n\nuse it';
  assert.deepEqual(sectionsOf({ id: 'g', text: guide }).map(section => [section.kind, section.title]), [['heading', 'Guide'], ['heading', '1. Install'], ['heading', '2. Use']], 'numbered h2 headings of a guide are not recordings');
});

test('zhNumberValue reads the numbers a transcript writes', () => {
  assert.deepEqual(['一', '九', '十', '十二', '二十', '二十三', '九十九', '一百零五', '7', '第'].map(zhNumberValue), [1, 9, 10, 12, 20, 23, 99, 105, 7, null]);
});

/* ---------- pages ---------- */

const page = (n, extra = {}) => ({ id: `p${n}`, title: `Book · 第 ${n} 页`, text: `第 ${n} 页的正文。\n\n又一段。`, document: { page: n, format: 'pdf', ...extra } });

test('PDF pages: one section per page, the page number, the text of each page whole', () => {
  const pages = [page(1), page(2), page(3)], sections = sectionsOf(pages);
  assert.deepEqual(sections.map(section => [section.sourceId, section.kind, section.page, section.start, section.end]), pages.map((item, index) => [item.id, 'page', index + 1, 0, item.text.length]));
  assert.ok(sections.every(section => section.leaf && section.level === 1));
  assert.deepEqual(sectionsOf(pages[0]).map(section => section.id), ['pg1']);
});

test('pages of a converted book carry their chapter, and a PowerPoint slide is a page too', () => {
  const sections = sectionsOf([page(1, { chapter: { index: 0, title: '绪论', level: 1 } }), page(2, { chapter: { index: 1, title: '进程', level: 1 } }), { id: 'sl', text: 'slide', document: { page: 1, format: 'pptx' } }]);
  assert.deepEqual(sections.map(section => section.chapter), [{ index: 0, title: '绪论', level: 1 }, { index: 1, title: '进程', level: 1 }, undefined]);
  assert.ok(sections.every(section => section.kind === 'page'));
});

/* ---------- Markdown ---------- */

test('Markdown headings (h1–h4) are the sections, levels relative to the shallowest, code fences ignored, the lead above the first heading kept', () => {
  const text = '前言一句。\n\n## 遗忘曲线\n\n正文。\n\n```\n# 代码里的井号\n```\n\n### 为什么会忘\n\n再说。\n\n##### 太深\n\n## 间隔重复 ##\n\n结束。';
  const sections = sectionsOf({ id: 'm', text });
  assert.deepEqual(sections.map(section => [section.kind, section.level, section.title]), [['heading', 1, '遗忘曲线'], ['heading', 2, '为什么会忘'], ['heading', 1, '间隔重复']]);
  assert.deepEqual(sections.map(section => section.leaf), [false, true, true]);
  assert.equal(sections[0].start, 0, 'the lead is the first section\'s');
  assertTiles(sections, text);
  assert.deepEqual(sections.map(section => section.id), ['h0', 'h1', 'h2']);
});

test('a Markdown bilingual transcript: 英文原句 / 中文对照 headings are labels, the parts stay', () => {
  const text = ['# 课堂', '', ...[1, 2, 3].flatMap(n => [`## 第${'一二三'[n - 1]}部分：主题${n}`, '', '### 英文原句', '', `english ${n}`, '', '### 中文对照', '', `中文 ${n}`, ''])].join('\n');
  const sections = sectionsOf({ id: 'm', text });
  assert.deepEqual(sections.map(section => section.title), ['课堂', '第一部分：主题1', '第二部分：主题2', '第三部分：主题3']);
  assert.equal(isLabelTitle('英文原句'), true);
  assert.equal(isLabelTitle('Original'), false, 'only the labels transcripts write');
  assertTiles(sections, text);
});

/* ---------- windows ---------- */

test('text without structure is cut into windows of about 8k characters at paragraph boundaries', () => {
  const paragraph = '这是一个段落，写得足够长以便切分。'.repeat(20) + '\n\n';
  const text = paragraph.repeat(160), sections = sectionsOf({ id: 'long', text });
  assert.ok(sections.length >= text.length / (WINDOW_CHARS * 1.3) && sections.length <= text.length / (WINDOW_CHARS * 0.45), `${sections.length} windows for ${text.length} characters`);
  assert.ok(sections.every(section => section.kind === 'window' && section.leaf && section.level === 1));
  assert.deepEqual(sections.map(section => section.n), sections.map((_, index) => index + 1));
  assert.deepEqual(sections.map(section => section.id), sections.map((_, index) => `w${index + 1}`));
  assertTiles(sections, text);
  for (const section of sections.slice(0, -1)) assert.ok(text.slice(section.start, section.end).endsWith('\n\n'), 'cut after a paragraph break');
  assert.ok(sections.every(section => section.chars <= WINDOW_CHARS * 1.25 + 1));
});

test('windows without a paragraph break are cut at line breaks, and then at the limit; a surrogate pair is never split', () => {
  const lines = ('一行文字。\n').repeat(4000), cut = sectionsOf({ id: 'l', text: lines });
  assertTiles(cut, lines);
  assert.ok(cut.slice(0, -1).every(section => lines[section.end - 1] === '\n'));
  const wide = '😀'.repeat(9000), rough = windowRanges(wide);
  assert.ok(rough.length > 1);
  for (const [, end] of rough.slice(0, -1)) assert.ok(!/[\uDC00-\uDFFF]/.test(wide[end]), 'not between the two halves of a character');
  assert.deepEqual(rough.at(-1)[1], wide.length);
});

test('empty and short text: nothing for nothing, one window for a short note, an unknown input is no sections', () => {
  assert.deepEqual(sectionsOf({ id: 'e', text: '' }), []);
  assert.deepEqual(sectionsOf({ id: 'e', text: ' \n\n ' }), []);
  assert.deepEqual(sectionsOf({ id: 'e' }), []);
  assert.deepEqual(sectionsOf([]), []);
  assert.deepEqual(sectionsOf(undefined), []);
  assert.deepEqual(sectionsOf(null), []);
  const short = sectionsOf({ id: 's', text: '一句话。' });
  assert.deepEqual(short.map(section => [section.kind, section.start, section.end, section.leaf]), [['window', 0, 4, true]]);
  assert.equal(sectionsOf({ id: 'a', text: 'x'.repeat(WINDOW_CHARS * 1.2) }).length, 1, 'not a tiny second window');
  assert.deepEqual(sectionsOf({ id: 'e2', text: '' }, { windows: false }), []);
  assert.deepEqual(sectionsOf({ id: 'p', text: 'plain text '.repeat(2000) }, { windows: false }), [], 'a reader asks for no windows');
});

test('a source with CRLF line breaks is divided the same way', () => {
  const text = '# 标题\r\n\r\n## A\r\n\r\n正文\r\n\r\n## B\r\n\r\n正文二';
  const sections = sectionsOf({ id: 'c', text });
  assert.deepEqual(sections.map(section => section.title), ['标题', 'A', 'B']);
  assertTiles(sections, text);
});

/* ---------- a kept outline ---------- */

const outline = (entries, level) => ({ revision: 'r', entries, segmentation: { level } });
const entry = (title, level, sourceId, offset) => ({ title, level, anchor: { sourceId, offset } });

test('a kept outline wins over the text\'s own structure: its chapters at the applied level, each from its anchor', () => {
  const text = 'a'.repeat(100) + '\n\n' + 'b'.repeat(100) + '\n\n' + 'c'.repeat(100), source = { id: 't', text };
  const kept = outline([entry('第一章', 1, 't', 0), entry('第一节', 2, 't', 50), entry('第二章', 1, 't', 102), entry('第三章', 1, 't', 204)], 1);
  const sections = sectionsOf(source, { outline: kept });
  assert.deepEqual(sections.map(section => [section.kind, section.title, section.start, section.end]), [['chapter', '第一章', 0, 102], ['chapter', '第二章', 102, 204], ['chapter', '第三章', 204, text.length]]);
  assertTiles(sections, text);
  assert.deepEqual(sections.map(section => section.id), ['c0', 'c1', 'c2'], 'the id is the chapter\'s own number');
  const deeper = sectionsOf(source, { outline: outline(kept.entries, 2) });
  assert.deepEqual(deeper.map(section => [section.title, section.level, section.leaf]), [['第一章', 1, false], ['第一节', 2, true], ['第二章', 1, true], ['第三章', 1, true]]);
  assert.deepEqual(chaptersOfOutline(kept, 1), keptChapters(kept, 1), 'one definition: lib/document-outline.js re-exports it');
});

test('a kept outline over a PDF: a chapter runs on into the next pages as a continuation, and pages before the first chapter are front matter', () => {
  const pages = [page(1), page(2), page(3), page(4)];
  const kept = outline([entry('绪论', 1, 'p2', 3), entry('进程', 1, 'p4', 0)], 1), sections = sectionsOf(pages, { outline: kept });
  assert.deepEqual(sections.map(section => [section.sourceId, section.title, section.front || false, section.continued || false, section.start, section.end]), [
    ['p1', '', true, false, 0, pages[0].text.length],
    ['p2', '绪论', false, false, 0, pages[1].text.length],
    ['p3', '绪论', false, true, 0, pages[2].text.length],
    ['p4', '进程', false, false, 0, pages[3].text.length]]);
  for (const item of pages) assertTiles(sectionsBySource(sections).get(item.id), item.text, item.id);
  assert.deepEqual(sectionsOf(pages, { outline: { entries: [] } }).map(section => section.kind), ['page', 'page', 'page', 'page'], 'an outline with no chapters is no outline');
  assert.deepEqual(sectionsOf(pages, { outline: outline([entry('x', 1, 'elsewhere', 0)], 1) }).map(section => section.kind), ['page', 'page', 'page', 'page'], 'chapters of other sources are ignored');
});

/* ---------- helpers ---------- */

test('sectionAt and sectionsInRange find the sections of a range of one source', () => {
  const list = sectionsBySource(sectionsOf(world.sources)).get('audio-batch-vol1'), text = world.sources[0].text;
  const at = text.indexOf('【第三部分：预览段落 3】');
  assert.equal(sectionAt(list, at).title, '第三部分：预览段落 3');
  assert.equal(sectionAt(list, at - 1).title, '第二部分：预览段落 2');
  assert.equal(sectionAt(list, 0).kind, 'recording');
  assert.equal(sectionAt(list, text.length).id, list.at(-1).id);
  assert.equal(sectionAt([], 5), null);
  const second = list.find(section => section.title.startsWith('第二部分')), third = list.find(section => section.title.startsWith('第三部分'));
  assert.deepEqual(sectionsInRange(list, second.start, third.end).map(section => section.title).filter(Boolean), [second.title, third.title]);
  assert.deepEqual(sectionsInRange(list, second.start, second.end).map(section => section.id), [second.id], 'a range that ends where the next section starts does not touch it');
  assert.deepEqual(sectionsInRange(list, at, at).map(section => section.id), [third.id], 'a point is in the section it sits in');
});
