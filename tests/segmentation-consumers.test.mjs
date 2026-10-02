/* The chapters a learner chose (a kept outline applied) as every chapter consumer meets them: the 资料 page, the picker that
   scopes generation, the reader's previous / next section and the dialogs that offer and apply them. Each reads the chapters
   through groupSourcesByDocument, so each is checked with the same stamped sources the snapshot hands over. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { chaptersOfOutline, stampSegmentations } from '../lib/document-outline.js';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/SourcePicker.jsx'; export { default as SourcePicker } from './ui/SourcePicker.jsx';
  export { default as Sources, ChapterList, RowMenuItems } from './ui/Sources.jsx';
  export { SegmentPreview } from './ui/document-preview/reader/SegmentDialog.jsx';
  export { OutlineDialogBody } from './ui/document-preview/reader/OutlineDialog.jsx';
  export { structureOutline, chapterNeighbours } from './ui/document-preview/reader/outline.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { SourcePicker, Sources, ChapterList, RowMenuItems, chapterLabel, SegmentPreview, OutlineDialogBody, structureOutline, chapterNeighbours, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const HASH = 'b'.repeat(64);
const page = n => ({ id: `p${n}`, title: `Notes · p.${n}`, text: `Page ${n} text. `.repeat(8), createdAt: '2026-10-01T08:00:00.000Z', courses: ['OS'],
  document: { id: HASH, page: n, totalPages: 6, format: 'pdf', extractionVersion: 2, materialId: `document-${HASH}-pdf` } });
const pages = Array.from({ length: 6 }, (_, index) => page(index + 1));
const entry = (title, level, sourceId, offset = 0) => ({ title, level, startBlock: 0, kind: 'quoted', anchor: { sourceId, offset, quote: 'x', ordinal: 0 } });
const outline = { revision: 'r', savedAt: '2026-10-01T09:00:00.000Z', entries: [entry('Basics', 1, 'p1'), entry('Details', 2, 'p2'), entry('Memory', 1, 'p3'), entry('Paging', 2, 'p5', 40), entry('Wrap-up', 1, 'p6')] };
const stamped = level => stampSegmentations(pages, [{ documentId: 'd', revision: 'r', sourceIds: pages.map(source => source.id), level, chapters: chaptersOfOutline(outline, level), savedAt: outline.savedAt }]);
const [segmented] = groupSourcesByDocument(stamped(2));

/* ---------- the 资料 page ---------- */

test('the 资料 page offers the chapters of a PDF that never had any: 查看 N 章 instead of 查看 N 页', () => {
  const data = { root: '/lib', sources: stamped(2), focus: { courses: ['OS'] }, contexts: ['materials'] };
  const html = render(h(Sources, { data, busy: false, act() {}, call() {}, setModal() {}, onGenerate() {} }));
  assert.match(html, /查看 5 章/);
  assert.doesNotMatch(html, /查看 6 页/);
  const plain = render(h(Sources, { data: { ...data, sources: pages }, busy: false, act() {}, call() {}, setModal() {}, onGenerate() {} }));
  assert.match(plain, /查看 6 页/, 'without a segmentation it is the page list as before');
});

test('the chapter list: where each chapter lies, its own 出题 button when it holds whole pages, and none when it starts and ends inside one', () => {
  const opened = [], generated = [];
  const html = render(h(ChapterList, { item: segmented, busy: false, onOpen: (id, ...rest) => opened.push([id, ...rest]), onGenerate: ids => generated.push(ids), listId: 'l' }));
  assert.equal((html.match(/data-chapter-index=/g) || []).length, 5);
  assert.match(html, /Basics · 第 1 页/);
  assert.match(html, /Memory · 第 3–5 页/);
  assert.match(html, /Paging · 第 5 页/);
  const paging = html.split('data-chapter-index="3"')[1].split('</li>')[0];
  assert.match(paging, /从页中间开始/, 'the chapter that starts mid-page says so');
  assert.match(paging, /disabled/, 'it holds no whole page, so generation cannot be scoped to it');
  const memory = html.split('data-chapter-index="2"')[1].split('</li>')[0];
  assert.doesNotMatch(memory, /disabled/);
  assert.equal((html.match(/从这一章出题/g) || []).length, 5);
  assert.doesNotMatch(render(h(ChapterList, { item: segmented, busy: false, onOpen() {}, listId: 'l' })), /从这一章出题/);
  assert.doesNotMatch(render(h(ChapterList, { item: segmented, busy: false, onOpen() {}, onGenerate() {}, listId: 'l' }), 'en'), han.source === '' ? /^$/ : /[㐀-鿿]/);
});

test('chapters of files and of one text are labelled by what they are: parts, or just their title', () => {
  const [recording] = groupSourcesByDocument(stampSegmentations(['a', 'b', 'c'].map((id, index) => ({ id: `r-${id}`, title: `PE1 (${index + 1}/3)`, text: `Part ${index + 1}. `.repeat(4), createdAt: '2026-10-01T00:00:00.000Z',
    audio: { batch: { id: 'b', title: 'PE1', volume: index + 1, volumes: 3 }, sourceIds: ['r-a', 'r-b', 'r-c'] } })), [{ documentId: 'd', revision: 'r', sourceIds: ['r-a', 'r-b', 'r-c'], level: 1,
    chapters: [{ index: 0, title: 'Intro', level: 1, sourceId: 'r-a', offset: 0 }, { index: 1, title: 'Main', level: 1, sourceId: 'r-b', offset: 0 }], savedAt: '' }]));
  assert.equal(chapterLabel(recording.chapters[0], recording.chapterUnit), 'Intro · 第 1 部分');
  assert.equal(chapterLabel(recording.chapters[1], recording.chapterUnit), 'Main · 第 2–3 部分');
  const [text] = groupSourcesByDocument(stampSegmentations([{ id: 't', title: 'Lecture', text: 'Intro\nbody\nSecond\nbody', createdAt: '2026-10-01T00:00:00.000Z', format: 'md' }],
    [{ documentId: 'd', revision: 'r', sourceIds: ['t'], level: 1, chapters: [{ index: 0, title: 'Intro', level: 1, sourceId: 't', offset: 0 }, { index: 1, title: 'Second', level: 1, sourceId: 't', offset: 11 }], savedAt: '' }]));
  assert.equal(chapterLabel(text.chapters[1], text.chapterUnit), 'Second');
  assert.equal(chapterLabel(segmented.chapters[0], segmented.chapterUnit), 'Basics · 第 1 页');
  assert.equal(chapterLabel({ title: 'Old', startPage: 1, endPage: 2 }), 'Old · 第 1–2 页', 'callers that pass no unit keep the page wording');
  const html = render(h(ChapterList, { item: text, busy: false, onOpen() {}, onGenerate() {}, listId: 'l' }));
  assert.equal((html.match(/data-chapter-index=/g) || []).length, 2);
  assert.match(html.split('data-chapter-index="1"')[1], /整份资料|文字/, 'a chapter inside one text says generation stays whole-document');
});

test('every row of the 资料 page offers AI 重新分段… in its 更多 menu, in both languages', () => {
  const [item] = groupSourcesByDocument(pages);
  const markup = render(h(RowMenuItems, { item, busy: false, onChangeCourse() {}, onRemove() {}, onSegment() {} }));
  assert.match(markup, /AI 重新分段…/);
  assert.match(markup, /改课程…/);
  assert.match(markup, /移除/);
  const english = render(h(RowMenuItems, { item, busy: false, onChangeCourse() {}, onRemove() {}, onSegment() {} }), 'en');
  assert.match(english, /Re-segment with AI…/);
  assert.doesNotMatch(render(h(RowMenuItems, { item, busy: false, onChangeCourse() {}, onRemove() {} })), /重新分段/, 'without a handler there is no entry');
  assert.match(render(h(RowMenuItems, { item, busy: true, onChangeCourse() {}, onRemove() {}, onSegment() {} })), /disabled=""[^>]*>AI 重新分段/);
});

/* ---------- the picker that scopes generation ---------- */

test('the picker chooses by the learner’s chapters: a chapter selects exactly its pages; a chapter inside a page is shown but not choosable', () => {
  const picker = selected => render(h(SourcePicker, { sources: stamped(2), selected, onChange() {}, defaultOpenKey: segmented.key }));
  const html = picker([]);
  assert.match(render(h(SourcePicker, { sources: stamped(2), selected: [], onChange() {} })), /选择章节/);
  assert.equal((html.match(/data-chapter-index=/g) || []).length, 5);
  assert.match(html, /Memory · 第 3–5 页/);
  const paging = html.split('data-chapter-index="3"')[1].split('</li>')[0];
  assert.match(paging, /disabled/);
  assert.match(paging, /不能单独选择|同一页/);
  assert.match(picker(['p3', 'p4']), /已选 2 \/ 6 页/);
  assert.doesNotMatch(render(h(SourcePicker, { sources: stamped(2), selected: [], onChange() {} })), /data-chapter-index/, 'folded until asked for');
});

/* ---------- the reader's previous / next section ---------- */

test('previous and next follow the chapters when a segmentation is applied, whichever deeper heading the reader is in', () => {
  const tree = structureOutline([{ id: 'a', level: 1, title: 'A' }, { id: 'a1', level: 2, title: 'A.1' }, { id: 'a2', level: 2, title: 'A.2' }, { id: 'b', level: 1, title: 'B' }, { id: 'b1', level: 2, title: 'B.1' }, { id: 'c', level: 1, title: 'C' }], { fold: false });
  const around = (id, level) => { const value = chapterNeighbours(tree, id, level); return [value.previous?.title ?? null, value.next?.title ?? null]; };
  assert.deepEqual(around('a2', 1), [null, 'B'], 'inside A: the chapters are A, B, C');
  assert.deepEqual(around('b1', 1), ['A', 'C']);
  assert.deepEqual(around('b', 1), ['A', 'C']);
  assert.deepEqual(around('a1', 2), ['A', 'A.2'], 'at level 2 every heading is a chapter');
  assert.deepEqual(around('c', 3), ['B.1', null]);
  assert.deepEqual(around('zzz', 1), [null, null]);
});

/* ---------- the dialogs ---------- */

const levels = {
  1: { count: 3, partialCount: 0, chapters: [{ index: 0, title: 'Chapter 1 Processes', level: 1, front: false, startPage: 1, endPage: 2, sources: 2, chars: 120, partial: false }, { index: 1, title: 'Chapter 2 Memory', level: 1, front: false, startPage: 3, endPage: 5, sources: 3, chars: 190, partial: false }, { index: 2, title: 'Chapter 3 Files', level: 1, front: false, startPage: 6, endPage: 6, sources: 1, chars: 60, partial: false }] },
  2: { count: 5, partialCount: 1, chapters: [{ index: 0, title: 'Chapter 1 Processes', level: 1, front: false, startPage: 1, endPage: 1, sources: 1, chars: 60, partial: false }, { index: 1, title: 'Section 2.1 Paging', level: 2, front: false, startPage: 4, endPage: 5, sources: 1, chars: 60, partial: true, startOffset: 51 }] },
  3: { count: 5, partialCount: 1, chapters: [] },
};
const preview = { status: 'preview', applied: null, unit: 'page', current: { count: 0, source: 'none' }, levels };

test('the segmentation preview: a level picker with the counts, the page ranges, and what a chapter inside a page means', () => {
  const html = render(h(SegmentPreview, { preview, level: 1, onLevel() {} }));
  assert.match(html, /第 1 级 · 3 章/);
  assert.match(html, /第 2 级 · 5 章/);
  assert.match(html, /第 3 级 · 5 章/);
  assert.match(html, /Chapter 2 Memory · 第 3–5 页/);
  assert.match(html, /现在：没有章节/);
  assert.match(html, /type="radio"/);
  assert.match(html, /checked=""[^>]*value="1"|value="1"[^>]*checked=""/);
  const two = render(h(SegmentPreview, { preview, level: 2, onLevel() {} }));
  assert.match(two, /1 章从页中间开始/);
  assert.match(two, /Section 2.1 Paging/);
  assert.match(two, /从页中间开始/);
  assert.match(render(h(SegmentPreview, { preview: { ...preview, current: { count: 3, source: 'converted' } }, level: 1, onLevel() {} })), /转换.*3 章/);
  assert.match(render(h(SegmentPreview, { preview: { ...preview, applied: 2, current: { count: 5, source: 'segmentation' } }, level: 2, onLevel() {} })), /已按 AI 目录分成 5 章/);
  assert.match(render(h(SegmentPreview, { preview: { ...preview, unit: 'text' }, level: 1, onLevel() {} })), /整份资料为单位/);
  assert.match(html, /不会改动/, 'it says the text, pages and citations stay');
});

test('the segmentation preview in English has no Chinese outside the learner’s own chapter titles', () => {
  const english = render(h(SegmentPreview, { preview: { ...preview, applied: 2, current: { count: 5, source: 'segmentation' } }, level: 2, onLevel() {} }), 'en');
  assert.doesNotMatch(english.replace(/Chapter \d [A-Za-z]+|Section 2\.1 Paging/g, ''), han);
  assert.match(english, /Level 1 · 3 chapters/);
  assert.match(english, /starts mid-page/);
  for (const source of ['none', 'converted', 'segmentation']) assert.doesNotMatch(render(h(SegmentPreview, { preview: { ...preview, current: { count: 3, source } }, level: 1, onLevel() {} }), 'en'), han, source);
  for (const unit of ['part', 'text']) assert.doesNotMatch(render(h(SegmentPreview, { preview: { ...preview, unit }, level: 2, onLevel() {} }), 'en'), han, unit);
});

test('the dialog behind a row’s menu entry: what it will do, the two ways to ask, and that nothing in the text changes', () => {
  const [item] = groupSourcesByDocument(pages);
  const html = render(h(OutlineDialogBody, { item, call() {} }));
  assert.match(html, /找出章节/);
  assert.match(html, /原文、页码、引用和题目都不会改变/);
  assert.match(html, /让 AI 找出章节/);
  assert.match(html, /让 AI 整理完整目录/);
  const english = render(h(OutlineDialogBody, { item, call() {} }), 'en');
  assert.doesNotMatch(english.replace(/Notes · p\.1/g, ''), han);
  assert.match(english, /Find chapters with AI/);
});
