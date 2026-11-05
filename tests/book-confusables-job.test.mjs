/* 易混概念 (#710 S3) in the real build Job: after the term cards, one small call per CONFUSABLE_PAIRS pairs of cards the book calls opposite or parallel, visible in the
   console (its steps, its calls, their usage); the answers are checked by the program; the comparisons are kept in the book's notes and shown by course.book.open
   with C001 ids and K codes; a rerun asks nothing; a failed call leaves the book saved and partial and the next build asks only the pairs it lacks; a book written
   before them (補術語卡) gets them too. The 134-material synthetic course of tests/helpers/course-outline-library.mjs and the fake model; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { CONFUSABLE_PAIRS } from '../lib/contexts/generation/book/constants.js';
import { CONFUSABLE_ASPECTS } from '../lib/course-book-confusables.js';

const KIND = 'course-book-build';

async function world(t, options = {}) {
  const fake = bookModel({ pairs: true, ...options }), root = await privateRoot(t, 'book-confusables-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary({ paper: true });
  await service.store.update(state => { state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE }; });
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND).at(-1).contract;
  const notes = async () => (await service.store.read()).sources.filter(isCourseNotesSource).find(record => !record.archived);
  const run = async (args = {}) => {
    const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', sample: 'skip', ...args })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return contract();
  };
  const since = mark => fake.calls.slice(mark).reduce((count, call) => ({ ...count, [call.stage]: (count[call.stage] ?? 0) + 1 }), {});
  return { service, fake, run, notes, contract, since };
}

test('a build with confusable cards: the stage after the cards and before 考情, small calls of CONFUSABLE_PAIRS pairs, checked by the program, shown in the console; a rerun asks nothing', async t => {
  const w = await world(t);
  await w.run();
  const record = await w.notes(), saved = record.courseNotes.confusables, calls = w.fake.of('confusables');
  assert.ok(saved?.length > CONFUSABLE_PAIRS, `${saved?.length} comparisons, more than one call holds`);
  assert.equal(calls.length, Math.ceil(saved.length / CONFUSABLE_PAIRS), 'one call per CONFUSABLE_PAIRS pairs');
  assert.ok(calls.every(call => call.data.pairs.length <= CONFUSABLE_PAIRS && call.data.pairs.every(pair => pair.relation && pair.a.name && pair.b.name)));
  const stages = w.fake.stages();
  assert.ok(stages.lastIndexOf('write') < stages.indexOf('confusables') && stages.lastIndexOf('confusables') < stages.indexOf('exam'), 'after the writing, before 考情');
  // The program's checks: a bogus aspect and a pair nobody asked are dropped; every comparison has the four rows and two items that have a card.
  assert.ok(saved.every(entry => entry.rows.map(row => row.aspect).join() === CONFUSABLE_ASPECTS.join() && entry.items.length === 2 && /^[0-9a-f]{16}$/.test(entry.print)));
  assert.ok(!JSON.stringify(saved).includes('never asked'));
  // The console: the stage's steps, its calls and their usage, like the other stages.
  const contract = w.contract();
  assert.deepEqual(contract.detail.book.confusables, { done: calls.length, total: calls.length, made: saved.length });
  assert.equal(contract.calls.filter(call => call.kind === 'confusables').length, calls.length, JSON.stringify([...new Set(contract.calls.map(call => call.kind))]));
  assert.ok(contract.usage.tokens > 0);
  assert.match(contract.stage.text, new RegExp(`${saved.length} 组易混概念`));
  // The book page: C001… with K codes, the names of the cards, the cells in the order of the codes.
  const book = await w.service.call('course.book.open', { course: COURSE });
  assert.equal(book.confusables.length, saved.length);
  assert.deepEqual(book.confusables.slice(0, 2).map(each => each.id), ['C001', 'C002']);
  const cards = new Map(book.nodes.flatMap(function walk(node) { return node.leaf ? (node.cards || []) : node.children.flatMap(walk); }).map(card => [card.code, card]));
  for (const each of book.confusables) {
    assert.deepEqual(Object.keys(each).sort(), ['id', 'items', 'names', 'rows']);
    assert.ok(each.items.every(code => cards.has(code)) && each.items[0] < each.items[1]);
    assert.deepEqual(each.names, each.items.map(code => cards.get(code).name));
    assert.ok(each.rows[0].cells[0].includes(each.names[0]) && each.rows[0].cells[1].includes(each.names[1]), 'the cells follow the codes');
  }
  // A rerun: the same cards, nothing asked, the saved comparisons as they were.
  const mark = w.fake.calls.length;
  await w.run();
  assert.equal(w.fake.calls.length - mark, 0, 'no call');
  assert.deepEqual((await w.notes()).courseNotes.confusables, saved);
  assert.match(w.contract().stage.text, /复习全书已是最新/);
});

test('a book whose cards pair nobody has no stage and no field', async t => {
  const w = await world(t, { pairs: false });
  await w.run();
  assert.equal(w.fake.of('confusables').length, 0);
  assert.equal((await w.notes()).courseNotes.confusables, undefined);
  assert.deepEqual(w.contract().detail.book.confusables, { done: 0, total: 0, made: 0 });
  assert.equal((await w.service.call('course.book.open', { course: COURSE })).confusables, undefined);
});

test('a failed confusables call does not fail the book: it is saved, partial, and the next build asks only the pairs it lacks', async t => {
  let failing = true;
  const w = await world(t, { fail: call => failing && call.stage === 'confusables' && call.data.part === 1 });
  await w.run();
  const first = (await w.notes()).courseNotes;
  assert.equal(w.contract().result.completeness, 'partial');
  assert.ok(first.leaves.length > 0 && first.leaves.some(leaf => leaf.body?.units?.some(unit => unit.cards?.length)), 'the book itself is saved');
  const total = w.fake.of('confusables').filter(call => call.data.part === 1).length;
  assert.ok(total >= 1);
  assert.match(w.contract().stage.text, /没写成/);
  failing = false;
  const mark = w.fake.calls.length;
  await w.run();
  const asked = w.since(mark);
  assert.deepEqual(Object.keys(asked), ['confusables'], 'only the pairs it lacks');
  assert.equal(w.contract().result.completeness, 'complete');
  assert.ok((await w.notes()).courseNotes.confusables.length > (first.confusables?.length ?? 0));
});

test('a book written before them: 补术语卡 and the next build give it the comparisons, and ask only the pairs that are new', async t => {
  const w = await world(t);
  await w.run();
  const full = (await w.notes()).courseNotes.confusables;
  // The book as 4.3.6 saved it: cards, no comparisons.
  await w.service.store.update(state => { delete state.sources.find(source => isCourseNotesSource(source) && !source.archived).courseNotes.confusables; });
  assert.equal((await w.service.call('course.book.open', { course: COURSE })).confusables, undefined);
  const mark = w.fake.calls.length;
  const estimate = await w.service.call('generation.courseBook.build', { course: COURSE, language: 'zh', cards: true, estimate: true });
  assert.equal(w.fake.calls.length, mark, 'an estimate is no call');
  assert.equal(estimate.status, 'estimate');
  assert.equal(estimate.calls, Math.ceil(full.length / CONFUSABLE_PAIRS), 'every point has its cards: the calls are the comparisons\'');
  await w.run({ cards: true });
  assert.deepEqual(w.since(mark), { confusables: estimate.calls }, 'only the comparisons, as estimated');
  assert.deepEqual((await w.notes()).courseNotes.confusables, full);
  const nothing = await w.service.call('generation.courseBook.build', { course: COURSE, language: 'zh', cards: true });
  assert.deepEqual([nothing.status, nothing.calls, nothing.jobId], ['nothing', 0, undefined], 'no task, no call');
});

test('the sample\'s scale counts the comparisons of the rest, from the pairs its cards name; the sample itself asks none and the rest\'s build asks them', async t => {
  const w = await world(t);
  const sample = (await w.run({ sample: 'auto' }) && (await w.notes())).courseNotes;
  assert.equal(sample.sample.status, 'waiting');
  assert.equal(w.fake.of('confusables').length, 0, 'no comparison call in the sample');
  assert.equal(sample.confusables, undefined);
  const stage = sample.sample.estimate.stages.find(each => each.id === 'confusables');
  assert.ok(stage?.calls > 0, `in the scale (${JSON.stringify(sample.sample.estimate.stages)})`);
  assert.ok(stage.inputTokens.high >= stage.inputTokens.low && stage.outputTokens.high >= 0);
  await w.run({ sample: 'confirm' });
  const asked = w.fake.of('confusables').length;
  t.diagnostic(`scale said ${stage.calls} comparison calls; the rest asked ${asked}`);
  assert.ok(asked > 0 && stage.calls >= asked / 3 && stage.calls <= asked * 3, 'the same order of size');
  assert.ok((await w.notes()).courseNotes.confusables.length > 0);
});

test('the scale of a build before it starts counts the comparisons still to ask (#708 scale), none once they are written', async t => {
  const w = await world(t);
  await w.run();
  const saved = (await w.notes()).courseNotes.confusables;
  const ask = () => w.service.call('generation.courseBook.build', { course: COURSE, language: 'zh', estimate: true });
  const done = (await ask()).scale;
  await w.service.store.update(state => { delete state.sources.find(source => isCourseNotesSource(source) && !source.archived).courseNotes.confusables; });
  const lacking = (await ask()).scale;
  const calls = Math.ceil(saved.length / CONFUSABLE_PAIRS);
  assert.equal(lacking.calls.low - done.calls.low, calls, 'every comparison call is in the low end');
  assert.equal(lacking.calls.high - done.calls.high, calls, 'and in the high end');
});
