/* 深度定制 S2: a first build of only some chapters of a big book, with no outline (generation.courseBook.build { chapters } with the chapter ids of the materials,
   lib/custom-skeleton.js basis 'documents'). The inventory reads only the pages of those chapters, the outline is built for them (the other chapters are listed as
   未生成 with their titles), their points are written; a later pick of another chapter extends the same outline and never touches a written point. A fake
   converted book of 500 pages in 10 chapters (tests/helpers/big-book-library.mjs) and the fake model; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { BIG_COURSE, BOOK_CHAPTERS, chapterTitle } from './helpers/big-book-library.mjs';
import { bigBookWorld as world, leavesOf, pointTitles, readOnly, topicsOf, written } from './helpers/big-book-world.mjs';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { courseRanges, inventoryCalls } from '../lib/contexts/generation/inventory/ranges.js';

/** The inventory calls a whole-book read makes (the book's ranges, read once each): what a pick saves against. */
async function wholeBookCalls(service) {
  const state = await service.store.read();
  return inventoryCalls(courseRanges(state, buildOutlineIndex(state, { course: BIG_COURSE }).allDocuments, { language: 'en' }).ranges).length;
}

test('chapters 3 and 4 with no outline: only their pages are read, the outline holds them and lists the rest as 未生成; chapter 5 later extends it and leaves 3–4 as they were', async t => {
  const w = await world(t);
  const preview = await w.service.call('course.custom.preview', { course: BIG_COURSE });
  assert.equal(preview.skeleton.basis, 'documents', 'no outline yet: the chapters of the material');
  const ids = preview.skeleton.documents[0].chapters.map(chapter => chapter.id);
  assert.equal(ids.length, BOOK_CHAPTERS);
  await w.service.call('course.save', { name: BIG_COURSE, custom: { version: 1, purpose: 'follow', scope: { kind: 'chapters', chapters: [ids[2], ids[3]] },
    book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'formulas'] }, questions: { make: false, kinds: [], strength: 'standard', variants: false },
    plan: { make: false, by: 'weekly' }, sampleFirst: true } });
  const whole = await wholeBookCalls(w.service);

  const first = await w.build({ chapters: [ids[2], ids[3]] });
  const inventory = w.fake.of('inventory');
  readOnly(inventory, [3, 4]);
  assert.ok(inventory.length * 4 <= whole, `a fifth of the book reads about a fifth of its calls (${inventory.length} of ${whole})`);
  t.diagnostic(`inventory calls: chapters 3–4 ${inventory.length}, whole book ${whole}`);
  assert.deepEqual(pointTitles(w.fake.calls), topicsOf([3, 4]), 'the points of chapters 3 and 4 are written, nothing else');
  assert.ok(first.calls.some(call => call.kind === 'inventory' && /Chapter 3/.test(call.file ?? '')), 'the console names the chapter a call reads');

  const outline = await w.outline(), notes = await w.notes();
  assert.deepEqual(outline.courseOutline.nodes.map(node => node.title), [chapterTitle(3), chapterTitle(4)], 'the outline holds the two chapters, by their own titles');
  assert.deepEqual(outline.courseOutline.parts.map(part => part.key), [ids[2], ids[3]], 'and which chapter of the material each one is');
  assert.equal(written(notes).length, leavesOf(outline.courseOutline.nodes).length);
  const shown = (await w.service.call('course.outline', { course: BIG_COURSE })).book;
  assert.equal(shown.stale, false, 'an outline of some chapters is not out of date');
  assert.equal(shown.notes.stale, false);
  assert.deepEqual(shown.parts.map(part => part.title), Array.from({ length: BOOK_CHAPTERS }, (_, at) => chapterTitle(at + 1)), 'the whole book\'s shape');
  assert.deepEqual(shown.parts.filter(part => part.written).map(part => part.title), [chapterTitle(3), chapterTitle(4)]);
  assert.deepEqual(shown.parts.filter(part => part.pending).map(part => part.id), ids.filter((_, at) => at !== 2 && at !== 3), '未生成, named by the chapter ids of the material');
  assert.deepEqual(shown.nodes.map(node => node.title), shown.parts.map(part => part.title), 'the outline page lists every chapter in the book\'s order');
  assert.deepEqual((await w.service.call('course.custom.preview', { course: BIG_COURSE })).unknownChapters, [], 'the saved 定制方案 still names its chapters');

  const before = new Map(written(notes).map(leaf => [leaf.id, leaf])), nodes = structuredClone(outline.courseOutline.nodes);
  const mark = w.fake.calls.length;
  await w.build({ chapters: [ids[4]] });
  readOnly(w.since(mark).filter(call => call.stage === 'inventory'), [5]);
  assert.deepEqual(pointTitles(w.since(mark)), topicsOf([5]), 'chapter 5 only');
  const extended = await w.outline(), after = await w.notes();
  assert.notEqual(extended.id, outline.id, 'a new record of the same outline');
  assert.deepEqual(extended.courseOutline.nodes.slice(0, 2), nodes, 'chapters 3 and 4 as they were');
  assert.equal(extended.courseOutline.nodes[2].title, chapterTitle(5));
  for (const [id, leaf] of before) assert.deepEqual(after.courseNotes.leaves.find(each => each.id === id), leaf, `${leaf.title} is unchanged`);

  // A chapter already built, named by its material id: mapped to its node, nothing is read or written again.
  const again = w.fake.calls.length;
  const job = await w.ask({ chapters: [ids[2]] });
  if (job.jobId) await settleJob(w.service, job.jobId);
  assert.deepEqual(w.since(again).map(call => call.stage), [], 'no call');
});

test('the scale of a pick with no outline counts the inventory of those chapters only, and the preview the same calls', async t => {
  const w = await world(t);
  const ids = (await w.service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents[0].chapters.map(chapter => chapter.id);
  const pick = await w.ask({ chapters: [ids[2], ids[3]], estimate: true });
  assert.equal(pick.status, 'estimate');
  assert.equal(w.fake.calls.length, 0, 'no call');
  const whole = await wholeBookCalls(w.service);
  assert.ok(pick.scale.inventory > 0 && pick.scale.inventory * 4 <= whole, `${pick.scale.inventory} of ${whole}`);
  assert.equal(pick.scale.chapters, 2);
  const custom = { version: 1, purpose: 'follow', scope: { kind: 'chapters', chapters: [ids[2], ids[3]] }, book: { make: true, coverage: 'standard', parts: ['explain'] },
    questions: { make: false, kinds: [], strength: 'standard', variants: false }, plan: { make: false, by: 'weekly' }, sampleFirst: true };
  const preview = await w.service.call('course.custom.preview', { course: BIG_COURSE, custom });
  assert.equal(preview.estimate.book.inventory, pick.scale.inventory, 'the preview counts the same inventory calls as the build');
});
