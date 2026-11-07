/* 复习全书 built only for the chapters the learner picks (#708): with a current 总纲, `chapters` (top-level node ids) narrows a build to the knowledge points of
   those chapters: only they are written (their materials only are read), every other point is left as it is, so building another chapter later rewrites and
   re-pays nothing; the chapters not built yet are 未生成, not "out of date". A big pick writes its sample from the picked part, and building the rest of that
   sample stays inside the part. `estimate: true` answers the scale of a pick before anything starts (points, calls; no price). Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource, isCourseOutlineSource } from '../lib/exam-point-list.js';
import { SAMPLE_FROM } from '../lib/contexts/generation/book/constants.js';
import { OUTPUT_PER_CALL } from '../lib/contexts/generation/outline/constants.js';

const KIND = 'course-book-build', POINT_STAGES = ['write', 'review', 'repair'];

async function world(t, { organise = true } = {}) {
  const fake = bookModel(), root = await privateRoot(t, 'book-pick-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE };
  });
  const records = async () => (await service.store.read()).sources;
  const book = async () => (await records()).filter(isCourseNotesSource).find(record => !record.archived);
  const outline = async () => (await records()).filter(isCourseOutlineSource).find(record => !record.archived);
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND).at(-1)?.contract;
  const ask = args => service.call('generation.courseBook.build', { course: COURSE, language: 'zh', ...args });
  const build = async (args = {}) => {
    const job = await settleJob(service, (await ask(args)).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return { contract: contract(), record: await book() };
  };
  if (organise) {
    const organised = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
    assert.equal(organised.status, 'complete');
  }
  return { service, fake, ask, build, book, outline, since: mark => fake.calls.slice(mark) };
}
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
/** The chapters of the outline with their anchored points (the points a build writes). */
const chaptersOf = record => record.courseOutline.nodes.map(top => ({ id: top.id, title: top.title, points: leavesOf([top]).filter(leaf => leaf.anchors?.length) }));
const written = record => record.courseNotes.leaves.filter(leaf => leaf.body && !leaf.body.empty);
const pointTitles = calls => [...new Set(calls.filter(call => POINT_STAGES.includes(call.stage)).map(call => call.data.point.title))];

test('picked chapters: only their points are written; another chapter built later leaves every written point as it was', async t => {
  const w = await world(t);
  const chapters = chaptersOf(await w.outline()).filter(chapter => chapter.points.length && chapter.points.length < SAMPLE_FROM);
  assert.ok(chapters.length >= 2, `two small chapters to pick (${chapters.map(chapter => chapter.points.length)})`);
  const [first, second] = chapters, titles = chapter => chapter.points.map(point => point.title).sort();
  const mark = w.fake.calls.length;
  const one = await w.build({ chapters: [first.id] });
  assert.deepEqual(pointTitles(w.since(mark)).sort(), titles(first), 'only the picked chapter is asked');
  assert.equal(w.since(mark).filter(call => call.stage === 'inventory').length, 0, 'nothing else is read');
  assert.deepEqual(written(one.record).map(leaf => leaf.title).sort(), titles(first), 'and only it is written');
  // The 总纲 page: the other chapters are 未生成 (not "out of date"), each with its points, so they can be built later.
  const shown = (await w.service.call('course.outline', { course: COURSE })).book;
  assert.equal(shown.notes.stale, false, 'a book of some chapters is not out of date');
  const parts = new Map(shown.parts.map(part => [part.id, part]));
  assert.deepEqual([parts.get(first.id).written, parts.get(first.id).points], [first.points.length, leavesOf(shown.nodes.find(node => node.id === first.id).children).length]);
  assert.equal(parts.get(second.id).written, 0, 'a chapter not picked is not built');

  const before = new Map(written(one.record).map(leaf => [leaf.id, leaf]));
  const again = w.fake.calls.length;
  const two = await w.build({ chapters: [second.id] });
  assert.deepEqual(pointTitles(w.since(again)).sort(), titles(second), 'the second chapter only: no point of the first is asked again');
  const after = new Map(written(two.record).map(leaf => [leaf.id, leaf]));
  for (const [id, leaf] of before) assert.deepEqual(after.get(id), leaf, `${leaf.title} is unchanged`);
  assert.deepEqual([...after.values()].map(leaf => leaf.title).sort(), [...titles(first), ...titles(second)].sort());
});

test('a big pick writes its sample from the picked part, and building the rest stays inside the part', async t => {
  const w = await world(t);
  const all = chaptersOf(await w.outline()), part = [];
  for (const chapter of all) { if (part.reduce((sum, item) => sum + item.points.length, 0) >= SAMPLE_FROM) break; part.push(chapter); }
  const inPart = new Set(part.flatMap(chapter => chapter.points.map(point => point.id))), total = inPart.size;
  assert.ok(total >= SAMPLE_FROM && part.length < all.length, `a part big enough for a sample and not the whole book (${total} of ${all.length} chapters)`);
  const first = await w.build({ chapters: part.map(chapter => chapter.id) });
  const sample = first.record.courseNotes.sample;
  assert.equal(sample.status, 'waiting');
  assert.ok(sample.leaves.every(id => inPart.has(id)), 'the sample comes from the picked part');
  assert.deepEqual(sample.estimate.points, { total, sample: 2, rest: total - 2 }, 'the scale of the part, not the book');
  assert.deepEqual(sample.chapters, part.map(chapter => chapter.id), 'the sample remembers its part');
  assert.equal((await w.service.call('course.outline', { course: COURSE })).book.notes.sample.chapters, part.length);
  // 生成其余 sends no chapters: the rest of the sample's part is built, nothing outside it.
  const mark = w.fake.calls.length;
  const rest = await w.build({ sample: 'confirm' });
  assert.equal(w.since(mark).filter(call => call.stage === 'write').length, total - 2, 'the rest of the part');
  assert.ok(written(rest.record).every(leaf => inPart.has(leaf.id)), 'nothing outside the part is written');
  assert.equal(written(rest.record).length, total);
});

test('the scale of a pick before it starts: points and calls from the program, no call, no task; points already written are not counted', async t => {
  const w = await world(t);
  const [first, second] = chaptersOf(await w.outline()).filter(chapter => chapter.points.length);
  const mark = w.fake.calls.length, jobs = w.service.runtime.work.jobs.size;
  const pick = await w.ask({ chapters: [first.id, second.id], estimate: true });
  assert.equal(pick.status, 'estimate');
  const points = first.points.length + second.points.length;
  assert.equal(pick.scale.points, points);
  assert.equal(pick.scale.chapters, 2);
  assert.ok(pick.scale.calls.low >= points * 2 && pick.scale.calls.high > pick.scale.calls.low, JSON.stringify(pick.scale.calls));
  assert.ok(pick.scale.readTokens.low > 0 && pick.scale.readTokens.high > pick.scale.readTokens.low, 'the material the calls read, in tokens');
  assert.ok(pick.scale.writeTokens.low > 0 && pick.scale.writeTokens.high >= pick.scale.calls.high * OUTPUT_PER_CALL, 'what the calls write, thinking included at the high end');
  assert.deepEqual(pick.scale.totalTokens, { low: pick.scale.readTokens.low + pick.scale.writeTokens.low, high: pick.scale.readTokens.high + pick.scale.writeTokens.high });
  assert.equal(pick.scale.sample, points >= SAMPLE_FROM, 'whether it starts with a sample');
  assert.doesNotMatch(JSON.stringify(pick), /price|cost|¥|\$/i, 'no price');
  const whole = await w.ask({ estimate: true });
  assert.equal(whole.scale.points, chaptersOf(await w.outline()).reduce((sum, chapter) => sum + chapter.points.length, 0), 'no pick: the whole book');
  assert.equal(w.fake.calls.length, mark, 'no model call');
  assert.equal(w.service.runtime.work.jobs.size, jobs, 'no task');
  await w.build({ chapters: [first.id], sample: 'skip' });
  assert.equal((await w.ask({ chapters: [first.id, second.id], estimate: true })).scale.points, second.points.length, 'a written chapter costs nothing again');
});

test('a pick is refused before any call without a current outline, or with a chapter the outline does not have', async t => {
  const w = await world(t, { organise: false });
  await assert.rejects(w.ask({ chapters: ['c-1'] }), error => error.code === 'course-book-part-outline' && /生成总纲/.test(error.message));
  assert.equal(w.fake.calls.length, 0, 'refused before any call');
  const organised = await settleJob(w.service, (await w.service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
  assert.equal(organised.status, 'complete');
  const mark = w.fake.calls.length;
  await assert.rejects(w.ask({ chapters: ['no-such-chapter'] }), error => error.code === 'course-book-part-invalid');
  await assert.rejects(w.ask({ chapters: [] }), error => error.code === 'course-book-part-invalid', 'an empty pick is not the whole book');
  await assert.rejects(w.ask({ chapters: ['x'], language: 'en' }), error => error.code === 'course-book-part-invalid' && !/[㐀-鿿]/.test(error.message));
  assert.equal(w.fake.calls.length, mark);
});
