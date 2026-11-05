/* 深度定制 S2, the book built by chapters LATER (the gate review of #735): an edit to a chapter not built yet changes nothing; an edit to a built chapter makes only
   that chapter again (never every chapter of the book); a plan without 讲解 keeps every written explanation; the sample paper is placed over every built chapter
   when a chapter is added; a material converted again (its chapters numbered anew, or one gone) keeps each built chapter by its title and pages, and says
   which one it cannot find instead of dropping it. The 500-page fake book (tests/helpers/big-book-library.mjs) and the fake model; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { BIG_COURSE, bookPaper, chapterTitle, topicOf } from './helpers/big-book-library.mjs';
import { bigBookWorld as world, leavesOf, pointTitles, readOnly, topicsOf, written } from './helpers/big-book-world.mjs';
import { planBook } from '../lib/contexts/generation/book/plan.js';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { partState } from './ui/outline/BookPick.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);

const plan = book => ({ version: 1, purpose: 'review', scope: { kind: 'all' }, book: { make: true, ...book }, questions: { make: false, kinds: [], strength: 'standard', variants: false },
  plan: { make: false, by: 'exam' }, sampleFirst: false });
const edit = (w, page, words) => w.service.store.update(state => { const source = state.sources.find(each => each.id === `big-p${page}`); source.text += ` ${words}`; });
const run = async (w, args) => { const job = await w.ask(args); if (job.jobId) await settleJob(w.service, job.jobId); };

test('an edit to a chapter not built yet leaves the book as it is; an edit to a built chapter makes that chapter again, alone', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  await edit(w, 380, 'Atoms Basics fact 99999: a small edit.');
  const shown = await w.shown();
  assert.equal(shown.stale, false, 'chapter 8 is not built: its edit is no change of this book');
  assert.equal(shown.notes.stale, false);

  const nodes = structuredClone((await w.outline()).courseOutline.nodes), before = new Map(written(await w.notes()).map(leaf => [leaf.id, leaf]));
  await edit(w, 120, 'Heat Laws fact 99999: a small edit.');
  assert.equal((await w.shown()).stale, true, 'chapter 3 is built: its edit is');
  const update = planBook(await w.service.store.read(), { course: BIG_COURSE, language: 'en' });
  assert.equal(update.mode, 'part');
  assert.deepEqual(update.part.adds.map(row => row.id), [ids[2]], '更新 makes chapter 3 again, and no chapter not built');
  const mark = w.fake.calls.length;
  await w.build({ sample: 'skip' });
  readOnly(w.since(mark).filter(call => call.stage === 'inventory'), [3]);
  assert.ok(w.since(mark).filter(call => call.stage === 'inventory').length <= 2, 'only the range that changed is read again');
  // Chapter 3 is grouped again (its items are; a batch boundary may move), so a point of it may be written again; never one of chapter 4.
  const again = pointTitles(w.since(mark));
  assert.ok(again.includes(topicOf(120)) && again.every(title => topicsOf([3]).includes(title)), `chapter 3 only, its changed point too (${again.join(', ')})`);
  const after = await w.outline(), notes = await w.notes();
  assert.deepEqual(after.courseOutline.nodes.map(node => node.title), [chapterTitle(3), chapterTitle(4)], 'still the two chapters');
  assert.deepEqual(after.courseOutline.nodes[1], nodes[1], 'chapter 4 exactly as it was');
  for (const leaf of leavesOf([nodes[1]])) assert.deepEqual(notes.courseNotes.leaves.find(each => each.id === leaf.id), before.get(leaf.id), `${leaf.title} kept`);
  assert.equal((await w.shown()).stale, false);
});

test('a plan without 讲解 keeps every written explanation, and turning it back on writes none again', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  const bodies = new Map(written(await w.notes()).map(leaf => [leaf.id, leaf.body]));
  assert.equal(bodies.size, 10);
  await w.service.call('course.save', { name: BIG_COURSE, custom: plan({ coverage: 'brief', parts: ['answerKit'] }) });
  await run(w, { chapters: [ids[2], ids[3]] });
  const kept = written(await w.notes());
  assert.equal(kept.length, 10, 'no explanation is dropped');
  for (const leaf of kept) assert.deepEqual(leaf.body, bodies.get(leaf.id), `${leaf.title}: the same text`);
  await w.service.call('course.save', { name: BIG_COURSE, custom: plan({ coverage: 'standard', parts: ['explain'] }) });
  const mark = w.fake.calls.length;
  await run(w, { chapters: [ids[2], ids[3]], sample: 'skip' });
  assert.equal(w.since(mark).filter(call => call.stage === 'write').length, 0, 'nothing paid again');
  assert.equal(written(await w.notes()).length, 10);
});

test('a chapter added after the sample paper: the paper is placed over every built chapter, the kept ones too', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  await w.service.store.update(state => { state.sources.push(bookPaper(['Explain Heat Basics with an example.', 'State Forces Laws and use them.'])); });
  await w.build({ chapters: [ids[4]], sample: 'skip' });
  const leaves = leavesOf((await w.outline()).courseOutline.nodes);
  const tested = leaves.filter(leaf => leaf.exam?.evidence?.length).map(leaf => leaf.title).sort();
  assert.deepEqual(tested, ['Forces Laws', 'Heat Basics'], 'chapter 3 kept, and its point is marked by the paper too');
  assert.equal((await w.shown()).papers, 1);
});

test('the material converted again with its chapters numbered anew: each built chapter is found by its title, nothing is built twice or refused', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  const nodes = (await w.outline()).courseOutline.nodes;
  // A front chapter now comes first: every chapter's index moves up by one, its title and pages stay.
  await w.service.store.update(state => { for (const source of state.sources) if (source.document?.chapter) source.document.chapter.index += 1; });
  const moved = await w.chapterIds();
  assert.notDeepEqual(moved, ids);
  const shown = await w.shown();
  assert.equal(shown.stale, false, 'the same chapters, numbered anew');
  assert.deepEqual(shown.parts.filter(part => part.pending).map(part => part.title), [1, 2, 5, 6, 7, 8, 9, 10].map(chapterTitle));
  const mark = w.fake.calls.length;
  await run(w, { chapters: [nodes[0].id] });
  assert.deepEqual(w.since(mark), [], 'a built chapter named by its node: nothing to do, not refused');
  await w.build({ chapters: [moved[4]], sample: 'skip' });
  assert.deepEqual(pointTitles(w.since(mark)), topicsOf([5]), 'the new id of chapter 5 builds chapter 5');
  assert.deepEqual((await w.outline()).courseOutline.nodes.map(node => node.title), [3, 4, 5].map(chapterTitle));
});

test('a built chapter the material no longer has: kept with its explanations, and said, never dropped', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  const four = (await w.outline()).courseOutline.nodes[1], count = written(await w.notes()).length;
  await w.service.store.update(state => { state.sources = state.sources.filter(source => source.document?.chapter?.index !== 3); });
  const shown = await w.shown();
  const lost = shown.parts.find(part => part.id === four.id);
  assert.equal(lost?.lost, true, 'the chapter is listed as not found in the material');
  assert.equal(ui.partState(lost), '资料里找不到这一章了 · 写好的讲解保留');
  ui.setUiLanguage('en');
  try { assert.equal(ui.partState(lost), 'Not in the material any more · its explanations are kept'); } finally { ui.setUiLanguage('zh'); }
  const mark = w.fake.calls.length;
  await run(w, { sample: 'skip' });
  assert.equal(w.since(mark).filter(call => call.stage === 'write').length, 0, 'nothing is written again');
  assert.deepEqual((await w.outline()).courseOutline.nodes.map(node => node.title), [chapterTitle(3), chapterTitle(4)], 'chapter 4 is still in the outline');
  assert.equal(written(await w.notes()).length, count, 'and its explanations in the book');
  assert.equal((await w.shown()).stale, false, 'said once, not out of date for ever');
});
