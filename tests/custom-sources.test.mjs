/* 深度定制 (4.4 S3): which sources a chapter scope reads, the one function (lib/custom-sources.js) the questions of a 定制方案 are asked from. A chapter named by the
   materials (`<document key>#<index>`) is the pages the library holds for it; a chapter named by the outline (a top-level node) is the pages its points' anchors
   stand for; a whole-course scope is every taught chapter (no sample paper, no copy). A chapter inside one text, which no page holds, can only be read whole: it says so. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { courseSkeleton } from '../lib/custom-skeleton.js';
import { scopeUnits } from '../lib/custom-sources.js';
import { groupRevision } from '../lib/document-outline.js';
import { COURSE, LECTURES, outlineLibrary } from './helpers/course-outline-library.mjs';
import { COURSE as BOOK_COURSE, service as bookService } from './helpers/crunch-library.mjs';

async function open(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { sources, decks } = outlineLibrary({ paper: true });
  await study.store.update(own => { own.sources.push(...sources); own.decks.push(...decks); });
  return study;
}
const lecture3 = skeleton => skeleton.documents.find(doc => doc.title.includes(LECTURES[2].title) && !doc.copyOf && doc.chapters.length === 3);
const read = async (study, scope, course = COURSE) => { const state = await study.store.read(); return scopeUnits(state, course, courseSkeleton(state, course), scope); };

test('chapters of the materials: each chapter is its own pages, in the order asked', async t => {
  const study = await open(t), state = await study.store.read(), doc = lecture3(courseSkeleton(state, COURSE));
  const { units, unknown } = await read(study, { kind: 'chapters', chapters: [doc.chapters[1].id, doc.chapters[0].id] });
  assert.deepEqual(unknown, []);
  assert.deepEqual(units.map(unit => unit.id), [doc.chapters[1].id, doc.chapters[0].id]);
  assert.deepEqual(units.map(unit => unit.sourceIds), [['document-l3-p3', 'document-l3-p4'], ['document-l3-p1', 'document-l3-p2']]);
  assert.deepEqual(units.map(unit => unit.title), ['Microservices', 'Layers']);
  assert.ok(units.every(unit => unit.chars > 0 && unit.cut === true));
});

test('a chapter that names nothing is reported, not read', async t => {
  const study = await open(t), doc = lecture3(courseSkeleton(await study.store.read(), COURSE));
  const { units, unknown } = await read(study, { kind: 'chapters', chapters: [doc.chapters[0].id, 'gone#9'] });
  assert.equal(units.length, 1);
  assert.deepEqual(unknown, ['gone#9']);
});

test('a whole-course scope is every taught chapter once: no sample paper, no second import of the same lecture', async t => {
  const study = await open(t), state = await study.store.read(), skeleton = courseSkeleton(state, COURSE);
  const { units } = await read(study, { kind: 'all' });
  const paper = skeleton.documents.find(doc => doc.paper), copy = skeleton.documents.find(doc => doc.copyOf);
  const ids = new Set(units.flatMap(unit => unit.sourceIds));
  assert.ok(units.length > 18, 'every lecture chapter and every loose material');
  assert.ok(!paper.chapters.some(chapter => units.some(unit => unit.id === chapter.id)), 'the paper is not taught');
  assert.ok(!copy.chapters.some(chapter => units.some(unit => unit.id === chapter.id)), 'a copy is counted once');
  assert.ok(ids.has('document-l3-p1') && !ids.has('document-l1-again-p1'));
});

test('a chapter that starts inside a page is read with that page whole, and says so', async t => {
  const study = await open(t), HASH = 'c'.repeat(64), OS = 'OS';
  const pages = Array.from({ length: 6 }, (_, index) => ({ id: `os-p${index + 1}`, title: `Notes · p.${index + 1}`, text: `Page ${index + 1} text. `.repeat(8), createdAt: '2026-10-01T08:00:00.000Z',
    courses: [OS], document: { id: HASH, page: index + 1, totalPages: 6, format: 'pdf', extractionVersion: 2, materialId: `document-${HASH}-pdf` } }));
  const entry = (title, level, sourceId, offset = 0) => ({ title, level, startBlock: 0, kind: 'quoted', anchor: { sourceId, offset, quote: 'x', ordinal: 0 } });
  const entries = [entry('Basics', 1, 'os-p1'), entry('Memory', 1, 'os-p3'), entry('Paging', 2, 'os-p5', 40), entry('Wrap-up', 1, 'os-p6')];
  pages[0].outline = { revision: groupRevision(pages), savedAt: '2026-10-01T09:00:00.000Z', entries, segmentation: { level: 2 } };
  await study.store.update(own => { own.sources.push(...pages); });
  const state = await study.store.read(), skeleton = courseSkeleton(state, OS);
  const [doc] = skeleton.documents;
  assert.deepEqual(doc.chapters.map(chapter => chapter.title), ['Basics', 'Memory', 'Paging', 'Wrap-up']);
  const { units } = scopeUnits(state, OS, skeleton, { kind: 'chapters', chapters: doc.chapters.map(chapter => chapter.id) });
  const byTitle = Object.fromEntries(units.map(unit => [unit.title, unit]));
  assert.deepEqual(byTitle.Basics.sourceIds, ['os-p1', 'os-p2']);
  assert.equal(byTitle.Basics.cut, true);
  assert.deepEqual(byTitle.Memory.sourceIds, ['os-p3', 'os-p4', 'os-p5'], 'it ends inside page 5');
  assert.equal(byTitle.Memory.cut, false, 'page 5 is read whole: the chapter after it starts in the middle of it');
  assert.equal(byTitle.Paging.cut, false);
});

test('chapters of the outline: the pages the anchors of its points stand for', async t => {
  const { study } = await bookService(t);
  const state = await study.store.read(), skeleton = courseSkeleton(state, BOOK_COURSE);
  assert.equal(skeleton.basis, 'outline');
  const { units, unknown } = scopeUnits(state, BOOK_COURSE, skeleton, { kind: 'chapters', chapters: ['c1'] });
  assert.deepEqual(unknown, []);
  assert.equal(units.length, 1);
  assert.equal(units[0].title, 'Introduction');
  assert.deepEqual(units[0].sourceIds, ['document-l1-p1', 'document-l1-p2', 'document-l1-p3', 'document-l1-p4']);
});
