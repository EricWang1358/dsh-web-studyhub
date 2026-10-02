/* The AI outline and re-segmentation are format-independent: the blocks come from whatever text the importers stored, the
   checked outline and the stored override are the same for every kind of document. One real import per format, then the same
   steps: ask (a fake model), keep, apply as chapters, read the chapters back through the accessor. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { segmentationViews, stampSegmentations } from '../lib/document-outline.js';
import { docxFile, para, pptxFile, shape, apara } from './helpers/office.mjs';

const CHAPTERS = [['Chapter 1 Processes', 'A process is the unit of resource allocation in an operating system.'],
  ['Chapter 2 Memory', 'Virtual memory gives every process its own address space to work in.'],
  ['Chapter 3 Files', 'A file system keeps persistent data organised on a disk for the user.']];

/** A careful model for these documents: a block that starts with "Chapter n" (after any Markdown marks) opens a chapter. */
const model = async (_system, prompt) => {
  const { blocks } = JSON.parse(prompt);
  return JSON.stringify({ outline: blocks.flatMap(block => {
    // a Markdown mark and a slide number may come first ("## 第 1 页 · Chapter 1 Processes"); "continued" slides are not chapters
    const found = /^(?:#{1,3}\s+)?(?:第 \d+ 页 · )?(Chapter \d+ [A-Z][a-z]+)$/.exec(block.text);
    return found ? [{ title: found[1], level: 1, startBlock: block.index }] : [];
  }) });
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'outline-formats-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}, request = {}) => ops.handlers[action](args, request);
  const items = async () => { const state = await store.read(); return groupSourcesByDocument(stampSegmentations(state.sources, segmentationViews(state))); };
  return { store, call, items };
}

/** The same steps for every document: the proposal is grounded in the stored text, applied it gives chapters, and nothing stored changes. */
async function through(t, { name, bytes, format, pages, unit }) {
  const { call, store, items } = await fixture(t);
  const imported = await call('materials.document.import', { dataBase64: Buffer.from(bytes).toString('base64'), filename: name, ...(format ? { format } : {}) });
  assert.equal(imported.sourceIds.length, pages, `${name}: sources`);
  const before = JSON.stringify((await store.read()).sources);
  const proposed = await call('materials.outline.suggest', { documentId: imported.documentId, mode: 'chapters' }, { complete: model });
  assert.equal(proposed.status, 'proposed', `${name}: ${proposed.message || ''}`);
  assert.deepEqual(proposed.entries.map(entry => entry.title), CHAPTERS.map(([title]) => title), name);
  const state = await store.read();
  for (const entry of proposed.entries) {
    const text = state.sources.find(source => source.id === entry.anchor.sourceId).text;
    assert.ok(text.slice(entry.anchor.offset).split('\n')[0].includes(entry.title), `${name}: the anchor of "${entry.title}" is the line of the stored text that holds it`);
  }
  assert.equal(proposed.coverage.sources, pages);
  await call('materials.outline.save', { documentId: imported.documentId, mode: 'chapters', entries: proposed.entries, segmentLevel: 1 });
  const [item] = await items();
  assert.deepEqual(item.chapters.map(chapter => chapter.title), CHAPTERS.map(([title]) => title), `${name}: chapters`);
  assert.equal(item.chapterUnit, unit, `${name}: unit`);
  // Several pages or files: every one is in exactly one chapter. One text: the chapters are places inside it and hold none.
  assert.deepEqual(item.chapters.flatMap(chapter => chapter.sourceIds).sort(), unit === 'text' ? [] : item.sourceIds.slice().sort(), `${name}: pages in chapters`);
  const kept = JSON.parse(JSON.stringify((await store.read()).sources.map(({ outline, ...source }) => source)));
  assert.equal(JSON.stringify(kept), before, `${name}: no stored text, id or page number changed`);
  return { call, items, item };
}

const markdown = CHAPTERS.map(([title, body]) => `## ${title}\n\n${body}\n`).join('\n');
const html = `<!doctype html><html><body>${CHAPTERS.map(([title, body]) => `<h2>${title}</h2><p>${body}</p>`).join('')}</body></html>`;
const plain = CHAPTERS.map(([title, body]) => `${title}\n${body}`).join('\n\n');
const marked = CHAPTERS.map(([title, body], index) => `<!-- page: ${index + 1} -->\n${title}\n${body}`).join('\n\n');

test('Markdown: blocks are the lines of the rendered text; the chapters are places inside one text', async t => {
  const { item } = await through(t, { name: 'lecture.md', bytes: markdown, pages: 1, unit: 'text' });
  assert.deepEqual(item.chapters.map(chapter => chapter.startOffset), [0, ...item.chapters.slice(1).map(chapter => chapter.startOffset)]);
  assert.ok(item.chapters.every(chapter => chapter.sourceIds.length === 0 && chapter.chars > 0));
});

test('HTML: the visible text of the page, chapters as one text', async t => {
  await through(t, { name: 'lecture.html', bytes: html, pages: 1, unit: 'text' });
});

test('TXT with blank-line paragraphs: blocks are paragraphs', async t => {
  await through(t, { name: 'lecture.txt', bytes: plain, pages: 1, unit: 'text' });
});

test('Word: paragraphs and headings, chapters as one text', async t => {
  const body = CHAPTERS.map(([title, text]) => para(title, { style: 'Heading1' }) + para(text)).join('');
  await through(t, { name: 'lecture.docx', bytes: docxFile(body), pages: 1, unit: 'text' });
});

test('PowerPoint: a source per slide, so a chapter holds whole slides', async t => {
  const slides = CHAPTERS.flatMap(([title, text], index) => [{ shapes: [shape([apara(title)], { ph: 'title' }), shape([apara(text)], { ph: 'body', id: 3 })] },
    { shapes: [shape([apara(`${title} continued`)], { ph: 'title' }), shape([apara(`${text} More about it on this second slide of the part.`)], { ph: 'body', id: 3 })] }]
    .map(slide => ({ ...slide, index })));
  const { item } = await through(t, { name: 'lecture.pptx', bytes: pptxFile(slides.map(({ shapes }) => ({ shapes }))), pages: 6, unit: 'page' });
  assert.deepEqual(item.chapters.map(chapter => chapter.sourceIds.length), [2, 2, 2]);
});

test('PDF text pages: a source per page, chapters cut at the pages where they start', async t => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [title, text] of CHAPTERS) {
    for (const lines of [[title, text, 'The text of this page goes on with more words so that it counts as a real page.'], [`Notes on ${title}`, text, 'And a second page of the same chapter, with enough words to be extracted.']]) {
      const page = doc.addPage([480, 600]);
      lines.forEach((line, index) => page.drawText(line, { x: 30, y: 540 - index * 24, size: 12, font }));
    }
  }
  const { item } = await through(t, { name: 'lecture.pdf', bytes: Buffer.from(await doc.save()), pages: 6, unit: 'page' });
  assert.deepEqual(item.chapters.map(chapter => [chapter.startPage, chapter.endPage]), [[1, 2], [3, 4], [5, 6]]);
});

test('a converted book (page markers, no original): one source per page like a PDF', async t => {
  const { item } = await through(t, { name: 'book.md', bytes: marked, pages: 3, unit: 'page' });
  assert.deepEqual(item.chapters.map(chapter => chapter.sourceIds.length), [1, 1, 1]);
});

test('an audio transcript with no document record: its 【】 parts are lines, the chapters are one text', async t => {
  const { call, store, items } = await fixture(t);
  const transcript = `【开场】\nChapter 1 Processes\n${CHAPTERS[0][1]}\n【正文】\nChapter 2 Memory\n${CHAPTERS[1][1]}\n【结尾】\nChapter 3 Files\n${CHAPTERS[2][1]}`;
  await store.update(state => { state.sources.push({ id: 'rec-1', title: '课堂录音', text: transcript, createdAt: '2026-09-01T00:00:00.000Z', audio: { filename: 'lecture.m4a' } }); });
  const proposed = await call('materials.outline.suggest', { sourceId: 'rec-1', mode: 'chapters' }, { complete: model });
  assert.equal(proposed.status, 'proposed');
  assert.deepEqual(proposed.entries.map(entry => entry.title), CHAPTERS.map(([title]) => title));
  await call('materials.outline.save', { sourceId: 'rec-1', mode: 'chapters', entries: proposed.entries, segmentLevel: 1 });
  const [item] = await items();
  assert.equal(item.format, 'audio');
  assert.deepEqual(item.chapters.map(chapter => chapter.title), ['', ...CHAPTERS.map(([title]) => title)], 'the 【开场】 line before the first chapter is front matter');
  assert.equal(item.chapterUnit, 'text');
});

test('pasted text and notes saved as sources work the same way, with one source or several', async t => {
  const { call, store, items } = await fixture(t);
  await store.update(state => { state.sources.push({ id: 'paste-1', title: 'Pasted', text: plain, createdAt: '2026-09-01T00:00:00.000Z' }); });
  const proposed = await call('materials.outline.suggest', { sourceId: 'paste-1' }, { complete: model });
  assert.equal(proposed.status, 'proposed');
  await call('materials.outline.save', { sourceId: 'paste-1', entries: proposed.entries, segmentLevel: 1 });
  assert.equal((await items())[0].chapters.length, 3);
  assert.equal((await call('materials.outline.segment', { sourceId: 'paste-1', level: 1 })).changed, 0, 'idempotent');
});

test('a text with no blank lines and CRLF line ends is still cut into blocks at real offsets', async t => {
  const { call, store } = await fixture(t);
  const text = CHAPTERS.map(([title, body]) => `${title}\r\n${body}`).join('\r\n');
  await store.update(state => { state.sources.push({ id: 'crlf-1', title: 'CRLF', text, createdAt: '2026-09-01T00:00:00.000Z' }); });
  const proposed = await call('materials.outline.suggest', { sourceId: 'crlf-1' }, { complete: model });
  assert.equal(proposed.status, 'proposed');
  for (const entry of proposed.entries) assert.equal(text.slice(entry.anchor.offset, entry.anchor.offset + entry.title.length), entry.title);
});
