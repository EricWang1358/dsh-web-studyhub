/* A kept outline as the document's chapters (re-segmentation): a VIEW over the stored text. The one accessor every chapter
   consumer reads (groupSourcesByDocument), the views the snapshot hands to the 资料 page and the picker, and the staleness
   rules. The text, the source ids, the page numbers and the card links never change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { chaptersOfOutline, segmentationViews, stampSegmentations, groupRevision } from '../lib/document-outline.js';
import { textRevision } from '../lib/contexts/materials/files.js';

const page = (n, extra = {}) => ({ id: `p${n}`, title: `Book · p.${n}`, text: `Page ${n} text. `.repeat(8), createdAt: '2026-09-01T00:00:00.000Z',
  document: { id: 'h'.repeat(64), page: n, totalPages: 6, format: 'pdf', extractionVersion: 2, materialId: `document-${'h'.repeat(64)}-pdf`, ...extra } });
const pages = Array.from({ length: 6 }, (_, index) => page(index + 1));
const entry = (title, level, sourceId, offset = 0) => ({ title, level, startBlock: 0, kind: 'quoted', anchor: { sourceId, offset, quote: 'x', ordinal: 0 } });
const outline = { revision: 'r1', entries: [entry('Basics', 1, 'p1'), entry('Details', 2, 'p2'), entry('Memory', 1, 'p3'), entry('Paging', 2, 'p5', 40), entry('Wrap-up', 1, 'p6')] };
const view = (level, extra = {}) => ({ documentId: 'doc', revision: 'r1', sourceIds: pages.map(source => source.id), level, chapters: chaptersOfOutline(outline, level), ...extra });
const withView = (sources, segmentation) => sources.map((source, index) => index === 0 ? { ...source, segmentation } : source);

test('chapters of an outline: the entries down to the chosen level, numbered in order, each with its place', () => {
  assert.deepEqual(chaptersOfOutline(outline, 1).map(chapter => [chapter.index, chapter.title, chapter.level, chapter.sourceId, chapter.offset]),
    [[0, 'Basics', 1, 'p1', 0], [1, 'Memory', 1, 'p3', 0], [2, 'Wrap-up', 1, 'p6', 0]]);
  assert.equal(chaptersOfOutline(outline, 2).length, 5, 'both levels');
  assert.equal(chaptersOfOutline({ entries: [...outline.entries, entry('Deep', 3, 'p4')] }, 2).length, 5, 'a level-3 entry is not a chapter at level 2');
  assert.equal(chaptersOfOutline({ entries: [...outline.entries, entry('Deep', 3, 'p4')] }, 3).length, 6);
  assert.deepEqual(chaptersOfOutline({ entries: [] }, 1), []);
  assert.deepEqual(chaptersOfOutline(null, 1), []);
});

test('the accessor: pages follow the chapter that contains their start; a chapter that starts mid-page leaves that page to the one before', () => {
  const [item] = groupSourcesByDocument(withView(pages, view(2)));
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.sourceIds.join(','), chapter.startPage, chapter.endPage]),
    [['Basics', 'p1', 1, 1], ['Details', 'p2', 2, 2], ['Memory', 'p3,p4,p5', 3, 5], ['Paging', '', 5, 5], ['Wrap-up', 'p6', 6, 6]]);
  const byTitle = Object.fromEntries(item.chapters.map(chapter => [chapter.title, chapter]));
  assert.deepEqual(byTitle.Memory.sourceIds, ['p3', 'p4', 'p5'], 'page 5 starts inside Memory, so it belongs to Memory');
  assert.equal(byTitle.Paging.partial, true, 'Paging starts in the middle of page 5');
  assert.equal(byTitle.Paging.startOffset, 40);
  assert.equal(byTitle.Paging.startSourceId, 'p5');
  assert.deepEqual(byTitle.Paging.sourceIds, [], 'it holds no whole page of its own; the reader opens it at the offset');
  assert.equal(byTitle.Paging.startPage, 5);
  assert.equal(item.segmentation.level, 2);
});

test('a level of 1 gives fewer, longer chapters; the pages are the same pages, every one in exactly one chapter', () => {
  const [item] = groupSourcesByDocument(withView(pages, view(1)));
  assert.deepEqual(item.chapters.map(chapter => chapter.title), ['Basics', 'Memory', 'Wrap-up']);
  assert.deepEqual(item.chapters.flatMap(chapter => chapter.sourceIds).sort(), pages.map(source => source.id).sort());
  assert.equal(item.chapters.reduce((sum, chapter) => sum + chapter.chars, 0), pages.reduce((sum, source) => sum + source.text.length, 0), 'no character is lost or counted twice');
  assert.deepEqual(item.sourceIds, pages.map(source => source.id), 'the pages themselves are untouched');
});

test('pages before the first chapter are front matter; a segmentation overrides the converter’s own chapters', () => {
  const late = { revision: 'r1', entries: [entry('Chapter A', 1, 'p3'), entry('Chapter B', 1, 'p5')] };
  const [item] = groupSourcesByDocument(withView(pages, { ...view(1), chapters: chaptersOfOutline(late, 1) }));
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.front === true, chapter.sourceIds.length]), [['', true, 2], ['Chapter A', false, 2], ['Chapter B', false, 2]]);
  const converted = pages.map((source, index) => ({ ...source, document: { ...source.document, origin: 'converted', converter: 'generic', chapter: { index: index < 3 ? 0 : 1, title: `Old ${index < 3 ? 1 : 2}`, level: 1 } } }));
  assert.deepEqual(groupSourcesByDocument(converted)[0].chapters.map(chapter => chapter.title), ['Old 1', 'Old 2']);
  assert.deepEqual(groupSourcesByDocument(withView(converted, view(1)))[0].chapters.map(chapter => chapter.title), ['Basics', 'Memory', 'Wrap-up'], 'the learner’s segmentation wins');
});

test('a segmentation of other pages is stale and ignored; the heuristic chapters (or none) apply again', () => {
  const stale = view(1, { sourceIds: ['p1', 'p2', 'p3', 'p4', 'p5'] });
  assert.equal(groupSourcesByDocument(withView(pages, stale))[0].chapters, undefined);
  assert.equal(groupSourcesByDocument(withView(pages, stale))[0].segmentation, undefined);
  assert.equal(groupSourcesByDocument(pages)[0].chapters, undefined, 'a PDF with no stored segmentation has no chapters');
  assert.equal(groupSourcesByDocument(withView(pages, { ...view(1), chapters: [] }))[0].chapters, undefined, 'an empty segmentation is no segmentation');
});

test('a document that is one source (Markdown, Word, a transcript) gains chapters: they list where each starts, only the first holds the source', () => {
  const single = { id: 'doc-s1', title: 'Lecture', text: 'Intro line\nBody one\nSecond part\nBody two\n', createdAt: '2026-09-01T00:00:00.000Z', format: 'md' };
  const seg = { documentId: 'x', revision: 'r', sourceIds: ['doc-s1'], level: 1, chapters: [
    { index: 0, title: 'Intro', level: 1, sourceId: 'doc-s1', offset: 0 }, { index: 1, title: 'Second', level: 1, sourceId: 'doc-s1', offset: 21 }] };
  const [item] = groupSourcesByDocument([{ ...single, segmentation: seg }]);
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.sourceIds, chapter.partial === true]), [['Intro', ['doc-s1'], false], ['Second', [], true]]);
  assert.equal(item.chapters[1].startOffset, 21);
  assert.equal(item.chapterUnit, 'text');
  assert.equal(groupSourcesByDocument([single])[0].chapters, undefined);
});

test('the volumes of one recording are one document: the chapters run across them in reading order', () => {
  const batch = { id: 'b1', title: 'PE1' };
  const volume = (n, text) => ({ id: `pe1-${n}`, title: `PE1 (${n}/3)`, text, createdAt: '2026-09-01T00:00:00.000Z', audio: { batch: { ...batch, volume: n, volumes: 3 }, sourceIds: ['pe1-1', 'pe1-2', 'pe1-3'] } });
  const volumes = [volume(1, 'Welcome to the lecture.\nTopic A starts.'), volume(2, 'More on topic A.\nTopic B starts here.'), volume(3, 'Topic B continues.\nGoodbye.')];
  const seg = { documentId: 'x', revision: 'r', sourceIds: ['pe1-1', 'pe1-2', 'pe1-3'], level: 1, chapters: [
    { index: 0, title: 'Topic A', level: 1, sourceId: 'pe1-1', offset: 24 }, { index: 1, title: 'Topic B', level: 1, sourceId: 'pe1-2', offset: 17 }] };
  const [item] = groupSourcesByDocument(withView(volumes, seg));
  assert.equal(groupSourcesByDocument(volumes).length, 1);
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.front === true, chapter.sourceIds.join(',')]), [['', true, 'pe1-1'], ['Topic A', false, 'pe1-2'], ['Topic B', false, 'pe1-3']]);
  assert.equal(item.chapterUnit, 'part');
});

test('a segmentation view is read from the stored record: current revision only, and only while its pages are the document’s pages', () => {
  const record = { revision: 'rev-2', savedAt: '2026-10-01T00:00:00.000Z', source: 'ai', mode: 'outline', entries: outline.entries, segmentation: { level: 1, appliedAt: '2026-10-01T00:00:01.000Z' } };
  const stored = sourceIds => ({ sources: pages.filter(source => sourceIds.includes(source.id)), documents: [{ id: 'doc', currentRevision: 'rev-2', versions: [
    { revision: 'rev-1', sourceIds: ['old'], outline: { ...record, revision: 'rev-1' } }, { revision: 'rev-2', sourceIds, outline: record }] }] });
  const [only] = segmentationViews(stored(pages.map(source => source.id)));
  assert.deepEqual([only.documentId, only.revision, only.level, only.chapters.length, only.sourceIds.length], ['doc', 'rev-2', 1, 3, 6]);
  assert.deepEqual(segmentationViews({ ...stored(['p1']), documents: [{ ...stored(['p1']).documents[0], currentRevision: 'rev-3' }] }), [], 'the current revision has no outline of its own');
  const unsegmented = stored(pages.map(source => source.id));
  delete unsegmented.documents[0].versions[1].outline.segmentation;
  assert.deepEqual(segmentationViews(unsegmented), [], 'a kept outline alone is not a segmentation');
  assert.deepEqual(segmentationViews({ sources: [], documents: [] }), []);
  assert.deepEqual(segmentationViews({}), []);
});

test('for a document with no record the view lives on its first source, valid while the group still has the same text', () => {
  const volumes = ['pe1-1', 'pe1-2'].map((id, index) => ({ id, title: `PE1 (${index + 1}/2)`, text: `Volume ${index + 1} text.`, createdAt: '2026-09-01T00:00:00.000Z',
    audio: { batch: { id: 'b1', title: 'PE1', volume: index + 1, volumes: 2 }, sourceIds: ['pe1-1', 'pe1-2'] } }));
  const kept = { revision: groupRevision(volumes), savedAt: '2026-10-01T00:00:00.000Z', entries: [entry('One', 1, 'pe1-1'), entry('Two', 1, 'pe1-2')], segmentation: { level: 1 }, sourceIds: ['pe1-1', 'pe1-2'] };
  const state = { documents: [], sources: [{ ...volumes[0], outline: kept }, volumes[1]] };
  const [only] = segmentationViews(state);
  assert.deepEqual([only.revision === kept.revision, only.sourceIds, only.chapters.map(chapter => chapter.title)], [true, ['pe1-1', 'pe1-2'], ['One', 'Two']]);
  assert.deepEqual(segmentationViews({ ...state, sources: [{ ...volumes[0], outline: { ...kept, revision: 'someone-else' } }, volumes[1]] }), [], 'another text, another revision');
  assert.deepEqual(segmentationViews({ ...state, sources: [{ ...volumes[0], outline: kept }] }), [], 'the group lost a volume');
  assert.equal(groupRevision([volumes[0]]), textRevision(volumes[0].text), 'one source: the same revision materials.document uses');
  assert.equal(groupRevision(volumes), textRevision(JSON.stringify(volumes.map(source => [source.id, source.text]))));
});

test('stamping hands the view to the first page of the document and leaves every other record as it was', () => {
  const views = [view(1)];
  const stamped = stampSegmentations(pages, views);
  assert.equal(stamped.length, pages.length);
  assert.deepEqual(stamped[0].segmentation.chapters.map(chapter => chapter.title), ['Basics', 'Memory', 'Wrap-up']);
  assert.equal(stamped[1], pages[1], 'untouched records are the same objects');
  assert.equal(pages[0].segmentation, undefined, 'and the input is not changed');
  assert.deepEqual(groupSourcesByDocument(stamped)[0].chapters.map(chapter => chapter.title), ['Basics', 'Memory', 'Wrap-up']);
  assert.deepEqual(stampSegmentations(pages, []), pages);
});
