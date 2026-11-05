/* 深度定制 S2: the parts of a course's 定制方案 (lib/custom-plan.js custom.book.parts) decide which steps a review book build makes. A plan without 术语卡,
   易混概念 or 答题模板 makes no card pass, no comparison and no kit call; turned back on, the next build makes them (the written points kept, no call again); the
   learner's own 补术语卡 still runs the card pass; a plan of the answer kit alone writes no explanation. The 134-material course of
   tests/helpers/course-outline-library.mjs with a sample paper and the fake model; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { planBook } from '../lib/contexts/generation/book/plan.js';

const KIND = 'course-book-build';
const plan = parts => ({ version: 1, purpose: 'review', scope: { kind: 'all' }, book: { make: true, coverage: 'brief', parts },
  questions: { make: false, kinds: [], strength: 'standard', variants: false }, plan: { make: false, by: 'exam' }, sampleFirst: false });

async function world(t) {
  // The writer makes no cards, so the cards come from the card pass; they pair up, so the book has confusable pairs to compare.
  const fake = bookModel({ cards: false, pairs: true }), root = await privateRoot(t, 'custom-book-parts-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary({ paper: true });
  await service.store.update(state => { state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE }; });
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND).at(-1).contract;
  const run = async (args = {}) => {
    const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', sample: 'skip', ...args })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return contract();
  };
  const since = mark => fake.calls.slice(mark).reduce((count, call) => ({ ...count, [call.stage]: (count[call.stage] ?? 0) + 1 }), {});
  const notes = async () => (await service.store.read()).sources.filter(isCourseNotesSource).find(record => !record.archived);
  return { service, fake, run, since, notes, save: parts => service.call('course.save', { name: COURSE, custom: plan(parts) }) };
}

test('a plan without 术语卡, 易混概念 and 答题模板 makes none of their calls; ticked again, the next build makes them and writes no point again', async t => {
  const w = await world(t);
  await w.save(['explain', 'formulas']);
  await w.run();
  const first = w.since(0);
  assert.ok(first.write > 0, 'the explanations are written');
  assert.deepEqual([first.cards, first.confusables, first.kit], [undefined, undefined, undefined], JSON.stringify(first));
  const saved = (await w.notes()).courseNotes;
  assert.equal(saved.examKit, undefined);
  assert.equal(saved.confusables, undefined);

  await w.save(['explain', 'terms', 'confusables', 'answerKit']);
  const mark = w.fake.calls.length;
  await w.run();
  const second = w.since(mark);
  assert.ok(second.cards > 0 && second.confusables > 0 && second.kit > 0, JSON.stringify(second));
  assert.equal(second.write, undefined, 'the written points are kept');
});

test('the learner\'s own 补术语卡 runs the card pass although the plan leaves 术语卡 out', async t => {
  const w = await world(t);
  await w.save(['explain']);
  await w.run();
  assert.equal(w.since(0).cards, undefined);
  const mark = w.fake.calls.length;
  await w.run({ cards: true });
  assert.ok(w.since(mark).cards > 0, 'an explicit click wins over the plan');
});

test('a plan of the answer kit alone writes no explanation: the inventory, the outline and the kit only', async t => {
  const w = await world(t);
  await w.save(['answerKit']);
  const contract = await w.run();
  const calls = w.since(0);
  assert.ok(calls.kit > 0 && calls.inventory > 0, JSON.stringify(calls));
  assert.deepEqual([calls.write, calls.review, calls.exam, calls.cards, calls.confusables], [undefined, undefined, undefined, undefined, undefined], JSON.stringify(calls));
  assert.ok((await w.notes()).courseNotes.examKit?.types?.length, 'the kit is saved');
  assert.equal(contract.detail.book.leaves.total, 0);
});

test('the plan\'s detail level is the build\'s when the request names none', async t => {
  const w = await world(t);
  await w.save(['explain']);
  const state = await w.service.store.read();
  assert.equal(planBook(state, { course: COURSE }).coverage, 'brief');
  assert.equal(planBook(state, { course: COURSE, coverage: 'full' }).coverage, 'full', 'the request wins');
  assert.equal(planBook(state, { course: COURSE }).parts.has('terms'), false);
  assert.equal(planBook(state, { course: COURSE, cards: true }).parts, null, '补术语卡 is the learner\'s own click');
});
