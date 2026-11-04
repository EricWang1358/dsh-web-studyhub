/* 复习全书 S4 (#710) in the real build Job: with sample papers the exam answer kit is one more stage after 考情, visible in the console (its steps, its calls,
   their usage); its answers are checked by the program (an invented question and an invented trigger word are dropped) and each type is linked to the points
   whose paper places hold its questions; a rerun asks nothing; a book written before the kit gets only the kit's calls; without papers there is no stage.
   The 134-material synthetic course of tests/helpers/course-outline-library.mjs and the fake model; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource, isCourseOutlineSource } from '../lib/exam-point-list.js';

const KIND = 'course-book-build';

async function world(t, { paper = true } = {}) {
  const fake = bookModel(), root = await privateRoot(t, 'book-exam-kit-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary({ paper });
  await service.store.update(state => { state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE }; });
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND).at(-1).contract;
  const notes = async () => (await service.store.read()).sources.filter(isCourseNotesSource).find(record => !record.archived);
  // The whole build (no sample first, #710): the kit is made by a build that writes every point.
  const build = async () => {
    const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', sample: 'skip' })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return notes();
  };
  return { service, fake, build, notes, contract };
}
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));

test('with sample papers: the kit stage after 考情, one call for the tiny types, checked and linked by the program, shown in the console; a rerun asks nothing', async t => {
  const w = await world(t);
  const record = await w.build(), kit = record.courseNotes.examKit;
  const kitCalls = w.fake.of('kit');
  assert.equal(kitCalls.length, 1, 'three one-question types share one call');
  const stages = w.fake.stages();
  assert.ok(stages.lastIndexOf('exam') < stages.indexOf('kit'), 'the kit comes after 考情');
  assert.deepEqual(kitCalls[0].data.types.map(type => type.kind).sort(), ['compare', 'explain', 'list']);
  assert.equal(kitCalls[0].data.papers, 'en', 'the papers are English: the template follows them');
  assert.equal(kit.language, 'en');
  assert.equal(kit.types.length, 3);
  const questions = new Map(kit.questions.map(question => [question.id, question]));
  assert.deepEqual(kit.questions.map(question => question.label), ['Q1', 'Q2', 'Q3'], 'the labels printed in the paper');
  for (const type of kit.types) {
    assert.ok(type.fills.length === type.questions.length && type.fills.every(fill => questions.has(fill.question)), 'the invented question q99 is dropped');
    assert.ok(!type.signals.includes('words in no question'), 'an invented trigger word is dropped');
    assert.match(type.template, /\[Claim\]/);
  }
  // The links are the program's: each type's points are exactly the points whose paper places hold its questions.
  const [outline] = (await w.service.store.read()).sources.filter(isCourseOutlineSource), leaves = leavesOf(outline.courseOutline.nodes);
  for (const type of kit.types) {
    const quotes = new Set(type.questions.map(id => questions.get(id).quote));
    assert.deepEqual(type.leaves, leaves.filter(leaf => (leaf.exam?.evidence || []).some(place => quotes.has(place.quote))).map(leaf => leaf.id));
  }
  // The console: the stage's steps, its calls and their usage, like the other stages.
  const contract = w.contract();
  assert.deepEqual(contract.detail.book.kit, { done: 1, total: 1 });
  const calls = contract.calls.filter(call => call.kind === 'kit');
  assert.equal(calls.length, 1, JSON.stringify(contract.calls.map(call => call.kind)));
  assert.ok(contract.usage.tokens > 0);
  // The book page: the kit with its codes and its points as headings of the book.
  const book = await w.service.call('course.book.open', { course: COURSE });
  assert.deepEqual(book.examKit.types.map(type => type.code), ['T01', 'T02', 'T03']);
  assert.ok(book.examKit.types.every(type => type.hids.length >= 1));
  // A rerun: the same paper places, the kit kept, no call.
  const before = w.fake.calls.length;
  const again = await w.build();
  assert.equal(w.fake.calls.length, before, 'no call');
  assert.deepEqual(again.courseNotes.examKit, kit);
  assert.match(w.contract().stage.text, /复习全书已是最新/);
});

test('a book written before the kit: the next build asks only the kit; without sample papers there is no kit stage', async t => {
  const w = await world(t);
  const first = await w.build();
  // The book as an earlier release saved it: no kit.
  await w.service.store.update(state => { delete state.sources.find(source => source.id === first.id).courseNotes.examKit; });
  assert.equal((await w.service.call('course.book.open', { course: COURSE })).examKit, undefined, 'an old book opens without a kit');
  const mark = w.fake.calls.length;
  const record = await w.build();
  assert.deepEqual(w.fake.calls.slice(mark).map(call => call.stage), ['kit'], 'only the kit is asked');
  assert.equal(record.courseNotes.examKit.types.length, 3);

  const bare = await world(t, { paper: false });
  const plain = await bare.build();
  assert.equal(bare.fake.of('kit').length, 0, 'no papers: no kit call');
  assert.equal(plain.courseNotes.examKit, undefined);
  assert.deepEqual(bare.contract().detail.book.kit, { done: 0, total: 0 });
});
