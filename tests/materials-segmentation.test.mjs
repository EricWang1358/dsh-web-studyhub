/* AI re-segmentation (materials.outline.segment and the chapters-only mode of materials.outline.suggest): a kept outline
   applied as the document's chapters, for a paged book, a recording of several files and a single text. A VIEW over the
   stored text: nothing is rewritten, and one accessor serves the 资料 page, the picker and the snapshot. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { planOutline, outlinePrompt, validateOutline } from '../lib/contexts/materials/outline.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { segmentationViews, stampSegmentations } from '../lib/document-outline.js';
import { reportUsage } from '../lib/usage-scope.js';

const marked = pages => pages.map(([page, body]) => `<!-- page: ${page} -->\n${body}`).join('\n\n');
/* A book with no Markdown headings: the converter finds no chapters in it, the lines say where they start. Page 4 holds a section mid-page. */
const book = marked([
  [1, 'Chapter 1 Processes\nA process is the unit of resource allocation.'], [2, 'Section 1.1 Threads\nA thread is the unit of scheduling.'],
  [3, 'Chapter 2 Memory\nVirtual memory gives each process its own address space.'],
  [4, 'A page table maps virtual pages to physical frames.\nSection 2.1 Paging\nPaging cuts the address space into fixed-size pages.'],
  [5, 'The TLB caches recently used page table entries.'], [6, 'Chapter 3 Files\nThe file system manages persistent data.']]);
/* The same book with real headings: the converter makes chapters of it by itself. */
const headed = marked([
  [1, '# 第一章 进程\n进程是资源分配的单位。'], [2, '## 1.1 线程\n线程是调度的单位。'], [3, '# 第二章 内存\n虚拟内存给每个进程独立的地址空间。'],
  [4, '页表把虚拟页映射到物理帧。\n## 2.1 分页\n分页把地址空间切成固定大小的页。'], [5, 'TLB 缓存最近用到的页表项。'], [6, '# 第三章 文件\n文件系统管理持久数据。']]);

/** A careful model: lines that start like a chapter are level 1, like a section level 2; with the chapters prompt it keeps level 1 only. */
function outlineOf(prompt, system = '') {
  const { blocks } = JSON.parse(prompt), onlyChapters = /chapter boundaries/i.test(system);
  return JSON.stringify({ outline: blocks.flatMap(block => {
    const hash = /^(#{1,3})\s+(.+)$/.exec(block.text), named = /^(Chapter \d+|Topic [A-Z])\b/.exec(block.text), section = /^Section \d+\.\d+/.exec(block.text);
    const entry = hash ? { title: hash[2], level: hash[1].length } : named ? { title: block.text, level: 1 } : section ? { title: block.text, level: 2 } : null;
    return entry && (!onlyChapters || entry.level === 1) ? [{ ...entry, startBlock: block.index }] : [];
  }) });
}
const usage = { uncachedInputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 };
const model = async (system, prompt) => { reportUsage(usage); return outlineOf(prompt, system); };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'materials-segmentation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}, request = {}) => ops.handlers[action](args, request);
  const importBook = async (text = book) => call('materials.document.import', { dataBase64: Buffer.from(text).toString('base64'), filename: 'os-book.md' });
  /** The 资料 page's view of the library: documents with their effective chapters. */
  const items = async () => { const state = await store.read(); return groupSourcesByDocument(stampSegmentations(state.sources, segmentationViews(state))); };
  return { root, store, call, importBook, items };
}
const rows = chapters => chapters.map(chapter => [chapter.title, chapter.sourceIds.length, chapter.startPage, chapter.endPage]);
const previewRows = chapters => chapters.map(chapter => [chapter.title, chapter.sources, chapter.startPage, chapter.endPage]);
const PARTS = { chapter1: 'Chapter 1 Processes', section11: 'Section 1.1 Threads', chapter2: 'Chapter 2 Memory', section21: 'Section 2.1 Paging', chapter3: 'Chapter 3 Files' };

/* ---------- chapters only ---------- */

test('chapters-only mode asks for chapter boundaries only: a lower price, one call, every entry at level 1', async t => {
  const { call, importBook } = await fixture(t);
  const { documentId } = await importBook();
  const full = await call('materials.outline.suggest', { documentId, estimate: true }, { complete: model });
  const chapters = await call('materials.outline.suggest', { documentId, mode: 'chapters', estimate: true }, { complete: model });
  assert.ok(chapters.estimate.outputTokens.high < full.estimate.outputTokens.high, 'fewer entries are asked for, so less is written');
  const seen = [];
  const proposed = await call('materials.outline.suggest', { documentId, mode: 'chapters' }, { complete: async (system, prompt) => { seen.push(system); reportUsage(usage); return outlineOf(prompt); } });
  assert.equal(seen.length, 1, 'one call');
  assert.match(seen[0], /chapter boundaries/i);
  assert.match(seen[0], /only/i);
  assert.equal(proposed.status, 'proposed');
  assert.deepEqual(proposed.entries.map(entry => entry.level), proposed.entries.map(() => 1), 'sections the model returned anyway are folded to the chapter level');
  assert.ok(proposed.warnings.includes('levels-adjusted'));
  assert.equal(proposed.mode, 'chapters');
  assert.deepEqual(proposed.usage, { ...usage, calls: 1 });
});

test('the chapters prompt and check: boundaries only, at most 60, one level', () => {
  const plan = planOutline([{ id: 's', text: 'Chapter 1\nbody\nChapter 2\nbody' }]);
  assert.match(outlinePrompt(plan, { mode: 'chapters' }).system, /chapter boundaries/i);
  assert.doesNotMatch(outlinePrompt(plan).system, /chapter boundaries/i);
  assert.equal(validateOutline(JSON.stringify([{ title: 'Chapter 1', level: 2, startBlock: 0 }]), plan, { mode: 'chapters' }).entries[0].level, 1);
  assert.equal(validateOutline(JSON.stringify(Array.from({ length: 61 }, (_, n) => ({ title: `Chapter ${n}`, level: 1, startBlock: 0 }))), plan, { mode: 'chapters' }).code, 'too-many');
  assert.equal(validateOutline(JSON.stringify([{ title: 'Chapter 1', level: 0, startBlock: 0 }]), plan, { mode: 'chapters' }).code, 'bad-level');
});

test('accepting chapters keeps the outline and applies it as the segmentation in one step, the book’s pages untouched', async t => {
  const { call, store, importBook, items } = await fixture(t);
  const { documentId } = await importBook();
  assert.equal((await items())[0].chapters, undefined, 'the converter found no chapters in this book');
  const before = JSON.stringify((await store.read()).sources);
  const proposed = await call('materials.outline.suggest', { documentId, mode: 'chapters' }, { complete: model });
  const saved = await call('materials.outline.save', { documentId, mode: 'chapters', entries: proposed.entries, usage: proposed.usage, segmentLevel: 1 });
  assert.equal(saved.outline.mode, 'chapters');
  assert.equal(saved.outline.segmentation.level, 1);
  const [item] = await items();
  assert.deepEqual(rows(item.chapters), [[PARTS.chapter1, 2, 1, 2], [PARTS.chapter2, 3, 3, 5], [PARTS.chapter3, 1, 6, 6]]);
  assert.equal(item.segmentation.level, 1);
  assert.equal(JSON.stringify((await store.read()).sources), before, 'no page text, id or number changed');
});

/* ---------- apply, change the level, restore ---------- */

test('preview shows each level’s chapters with page ranges before anything is applied; a chapter that starts mid-page is called out', async t => {
  const { call, importBook, items } = await fixture(t);
  const { documentId } = await importBook();
  const proposed = await call('materials.outline.suggest', { documentId }, { complete: model });
  await call('materials.outline.save', { documentId, entries: proposed.entries });
  const preview = await call('materials.outline.segment', { documentId, preview: true });
  assert.equal(preview.status, 'preview');
  assert.deepEqual([1, 2, 3].map(level => preview.levels[level].count), [3, 5, 5]);
  assert.deepEqual(previewRows(preview.levels[1].chapters), [[PARTS.chapter1, 2, 1, 2], [PARTS.chapter2, 3, 3, 5], [PARTS.chapter3, 1, 6, 6]]);
  assert.deepEqual(previewRows(preview.levels[2].chapters), [[PARTS.chapter1, 1, 1, 1], [PARTS.section11, 1, 2, 2], [PARTS.chapter2, 2, 3, 4], [PARTS.section21, 1, 4, 5], [PARTS.chapter3, 1, 6, 6]]);
  assert.equal(preview.levels[2].chapters[3].partial, true);
  assert.equal(preview.levels[2].partialCount, 1);
  assert.equal(preview.levels[1].partialCount, 0);
  assert.deepEqual([preview.current.count, preview.current.source, preview.unit], [0, 'none', 'page'], 'the book had no chapters of its own');
  assert.equal(preview.applied, null);
  assert.equal((await items())[0].chapters, undefined, 'a preview changes nothing');
});

test('apply: the chapters follow, changed counts what moved, applying again changes nothing, and another level replaces it', async t => {
  const { call, importBook, items } = await fixture(t);
  const { documentId } = await importBook();
  const proposed = await call('materials.outline.suggest', { documentId }, { complete: model });
  await call('materials.outline.save', { documentId, entries: proposed.entries });
  const one = await call('materials.outline.segment', { documentId, level: 1 });
  assert.deepEqual([one.applied, one.level, one.chapters, one.changed, one.previous, one.removed], [true, 1, 3, 3, 0, 0]);
  assert.deepEqual(rows((await items())[0].chapters), [[PARTS.chapter1, 2, 1, 2], [PARTS.chapter2, 3, 3, 5], [PARTS.chapter3, 1, 6, 6]]);
  const again = await call('materials.outline.segment', { documentId, level: 1 });
  assert.deepEqual([again.chapters, again.changed, again.removed], [3, 0, 0], 'idempotent');
  const two = await call('materials.outline.segment', { documentId, level: 2 });
  assert.deepEqual([two.chapters, two.previous, two.changed, two.removed], [5, 3, 4, 2], 'Chapter 3 stays as it was; the four others are new; two of level 1 are gone');
  assert.equal((await call('materials.document.get', { documentId })).outline.segmentation.level, 2);
  assert.equal((await call('materials.outline.segment', { documentId, preview: true })).applied, 2);
});

test('a segmentation replaces the converter’s own chapters, and restoring brings them back', async t => {
  const { call, importBook, items } = await fixture(t);
  const { documentId } = await importBook(headed);
  assert.deepEqual((await items())[0].chapters.map(chapter => chapter.title), ['第一章 进程', '第二章 内存', '第三章 文件'], 'the converter’s chapters');
  const proposed = await call('materials.outline.suggest', { documentId }, { complete: model });
  await call('materials.outline.save', { documentId, entries: proposed.entries, segmentLevel: 2 });
  const [item] = await items();
  assert.deepEqual(item.chapters.map(chapter => chapter.title), ['第一章 进程', '1.1 线程', '第二章 内存', '2.1 分页', '第三章 文件']);
  const preview = await call('materials.outline.segment', { documentId, preview: true });
  assert.deepEqual([preview.current.source, preview.levels[1].count], ['segmentation', 3]);
  await call('materials.outline.segment', { documentId, level: null });
  assert.deepEqual((await items())[0].chapters.map(chapter => chapter.title), ['第一章 进程', '第二章 内存', '第三章 文件']);
});

test('restoring the automatic chapters keeps the outline; restoring the automatic outline drops both', async t => {
  const { call, importBook, items } = await fixture(t);
  const { documentId } = await importBook();
  const proposed = await call('materials.outline.suggest', { documentId }, { complete: model });
  await call('materials.outline.save', { documentId, entries: proposed.entries, segmentLevel: 2 });
  assert.equal((await items())[0].chapters.length, 5);
  const cleared = await call('materials.outline.segment', { documentId, level: null });
  assert.deepEqual([cleared.applied, cleared.cleared, cleared.changed, cleared.removed], [false, true, 0, 5]);
  assert.equal((await items())[0].chapters, undefined);
  assert.equal((await call('materials.document.get', { documentId })).outline.entries.length, proposed.entries.length, 'the outline is still kept');
  assert.equal((await call('materials.outline.segment', { documentId, level: null })).cleared, false, 'nothing left to clear');
  await call('materials.outline.segment', { documentId, level: 1 });
  const dropped = await call('materials.outline.clear', { documentId });
  assert.deepEqual([dropped.cleared, dropped.hadSegmentation], [true, true]);
  assert.equal((await items())[0].chapters, undefined);
});

test('segmenting needs a kept outline and a level from 1 to 3; saving a new outline ends the old segmentation', async t => {
  const { call, importBook, items } = await fixture(t);
  const { documentId } = await importBook();
  await assert.rejects(call('materials.outline.segment', { documentId, level: 1 }), /outline/i);
  const proposed = await call('materials.outline.suggest', { documentId }, { complete: model });
  await call('materials.outline.save', { documentId, entries: proposed.entries });
  for (const level of [0, 0.5, 4, 'one']) await assert.rejects(call('materials.outline.segment', { documentId, level }), /level/i, String(level));
  await assert.rejects(call('materials.outline.save', { documentId, entries: proposed.entries, segmentLevel: 7 }), /level/i);
  await assert.rejects(call('materials.outline.suggest', { documentId, mode: 'everything' }), /mode/i);
  await call('materials.outline.segment', { documentId, level: 1 });
  assert.equal((await items())[0].chapters.length, 3);
  await call('materials.outline.save', { documentId, entries: proposed.entries.slice(0, 3) });
  assert.equal((await items())[0].chapters, undefined, 'the new outline has no segmentation until it is applied');
});

test('a new revision of the document does not inherit the chapters; the old revision keeps them for its citations', async t => {
  const { call, importBook, items } = await fixture(t);
  const { documentId, revision } = await importBook();
  const proposed = await call('materials.outline.suggest', { documentId }, { complete: model });
  await call('materials.outline.save', { documentId, entries: proposed.entries, segmentLevel: 1 });
  assert.equal((await items())[0].chapters.length, 3);
  await call('materials.document.attach', { documentId, format: 'md', dataBase64: Buffer.from(book + '\n\n<!-- page: 7 -->\nChapter 4 Networks\nSockets.').toString('base64'), filename: 'os-book.md' });
  const current = await call('materials.document.get', { documentId });
  assert.notEqual(current.revision, revision);
  assert.equal(current.outline, undefined);
  assert.equal(current.outlineStale.entries, proposed.entries.length);
  await assert.rejects(call('materials.outline.segment', { documentId, preview: true }), /outline/i, 'there is nothing to segment by on the new revision');
  assert.equal((await items()).find(item => item.documentId === documentId).chapters, undefined, 'the new revision has no chapters until it is segmented again');
  const old = await call('materials.document.get', { documentId, revision });
  assert.equal(old.outline.segmentation.level, 1, 'a citation opened at the old revision still sees them');
});

/* ---------- other kinds of document ---------- */

const volumes = [
  'Welcome to the lecture.\nTopic A\nWe start with A.',
  'More about A.\nTopic B\nNow B begins.',
  'B continues.\nThanks for listening.'].map((text, index) => ({ id: `pe1-${index + 1}`, title: `PE1 (${index + 1}/3)`, text, createdAt: '2026-09-01T00:00:00.000Z', courses: [],
  audio: { batch: { id: 'b1', title: 'PE1', volume: index + 1, volumes: 3 }, sourceIds: ['pe1-1', 'pe1-2', 'pe1-3'] } }));

test('a recording of several files is one document: the prompt is the whole recording in reading order, the chapters run across the files', async t => {
  const { call, store, items } = await fixture(t);
  await store.update(state => { state.sources.push(...volumes); });
  const asked = [];
  const proposed = await call('materials.outline.suggest', { sourceId: 'pe1-2' }, { complete: async (system, prompt) => { asked.push(JSON.parse(prompt)); return outlineOf(prompt, system); } });
  assert.equal(proposed.status, 'proposed');
  assert.equal(asked[0].blocks.length, 8, 'all three files: 3 + 3 + 2 lines');
  assert.deepEqual(asked[0].blocks.map(block => block.text).filter(text => text.startsWith('Topic')), ['Topic A', 'Topic B']);
  assert.deepEqual(proposed.entries.map(entry => [entry.title, entry.anchor.sourceId]), [['Topic A', 'pe1-1'], ['Topic B', 'pe1-2']]);
  assert.equal(proposed.coverage.sources, 3);
  await call('materials.outline.save', { sourceId: 'pe1-3', entries: proposed.entries, segmentLevel: 1 });
  const [item] = await items();
  assert.deepEqual(rows(item.chapters), [['', 1, 1, 1], ['Topic A', 1, 1, 2], ['Topic B', 1, 2, 3]], 'Topic A starts inside file 1 and Topic B inside file 2, so each file belongs to the chapter before');
  assert.deepEqual(item.chapters.map(chapter => chapter.sourceIds), [['pe1-1'], ['pe1-2'], ['pe1-3']]);
  assert.equal(item.chapterUnit, 'part');
  assert.equal((await call('materials.document.get', { sourceId: 'pe1-1' })).outline.entries.length, 2, 'the outline is the group’s, whichever file opens it');
  assert.equal((await store.read()).documents?.length ?? 0, 0, 'no document record was invented');
});

test('a single pasted text gains chapters too; they say where they start, and only the first holds the source', async t => {
  const { call, store, items } = await fixture(t);
  const text = 'Chapter 1\nFirst body line.\nChapter 2\nSecond body line.\nChapter 3\nThird body line.';
  await store.update(state => { state.sources.push({ id: 'note-1', title: 'Pasted notes', text, createdAt: '2026-09-01T00:00:00.000Z' }); });
  const proposed = await call('materials.outline.suggest', { sourceId: 'note-1', mode: 'chapters' }, { complete: model });
  await call('materials.outline.save', { sourceId: 'note-1', mode: 'chapters', entries: proposed.entries, segmentLevel: 1 });
  const [item] = await items();
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.sourceIds.length, chapter.startOffset]), [['Chapter 1', 1, 0], ['Chapter 2', 0, text.indexOf('Chapter 2')], ['Chapter 3', 0, text.indexOf('Chapter 3')]]);
  assert.equal(item.chapterUnit, 'text');
  assert.equal(text.slice(item.chapters[1].startOffset, item.chapters[1].startOffset + 9), 'Chapter 2', 'the offset is a real place in the stored text');
  const preview = await call('materials.outline.segment', { sourceId: 'note-1', preview: true });
  assert.deepEqual(preview.levels[1].chapters.map(chapter => chapter.partial), [false, true, true]);
  assert.equal(preview.unit, 'text');
});

/* ---------- through the runtime ---------- */

test('the panel’s snapshot carries the chapters: the 资料 page and the picker read them through the same accessor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'materials-segmentation-runtime-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  const services = { complete: model };
  const imported = await runtime.call('materials.document.import', { dataBase64: Buffer.from(book).toString('base64'), filename: 'os-book.md' });
  const proposed = await runtime.call('materials.outline.suggest', { documentId: imported.documentId }, services);
  await runtime.call('materials.outline.save', { documentId: imported.documentId, entries: proposed.entries });
  assert.equal(groupSourcesByDocument((await runtime.call('snapshot')).sources)[0].chapters, undefined, 'a kept outline alone changes no chapters');
  const applied = await runtime.call('materials.outline.segment', { documentId: imported.documentId, level: 1 });
  assert.equal(applied.chapters, 3);
  const snapshot = await runtime.call('snapshot');
  assert.deepEqual(rows(groupSourcesByDocument(snapshot.sources)[0].chapters), [[PARTS.chapter1, 2, 1, 2], [PARTS.chapter2, 3, 3, 5], [PARTS.chapter3, 1, 6, 6]]);
  const compact = await runtime.call('snapshot', { compact: true });
  assert.ok(compact.sources.every(source => source.segmentation === undefined), 'agents get summaries, not views');
  assert.equal((await runtime.call('materials.document.list', {})).documents[0].outline, undefined);
  await runtime.call('materials.outline.segment', { documentId: imported.documentId, level: null });
  assert.equal(groupSourcesByDocument((await runtime.call('snapshot')).sources)[0].chapters, undefined);
});

test('a document with no record: its kept outline never reaches the snapshot as part of a source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'materials-segmentation-legacy-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.call('source.add', { title: 'Pasted notes', text: 'Chapter 1\nFirst body line.\nChapter 2\nSecond body line.' });
  const id = (await runtime.call('snapshot')).sources[0].id;
  const proposed = await runtime.call('materials.outline.suggest', { sourceId: id, mode: 'chapters' }, { complete: model });
  await runtime.call('materials.outline.save', { sourceId: id, mode: 'chapters', entries: proposed.entries, segmentLevel: 1 });
  const [source] = (await runtime.call('snapshot')).sources;
  assert.equal(source.outline, undefined);
  assert.deepEqual(groupSourcesByDocument([source])[0].chapters.map(chapter => chapter.title), ['Chapter 1', 'Chapter 2']);
});
