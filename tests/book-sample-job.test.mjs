/* The sample slice of a 复习全书 build as ONE kind of Job of the unified runtime (#710): a build with many points to write writes two of them the whole way,
   saves them in the book with the scale of the rest and ends partial, the book waiting for the learner; building the rest ('confirm') keeps those two (no
   call is asked again) and sends the approved sample with every write; another build at changed settings makes the sample again. Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseInventorySource, isCourseNotesSource, isCourseOutlineSource } from '../lib/exam-point-list.js';

const KIND = 'course-book-build';

async function world(t, { fake = bookModel(), library = {} } = {}) {
  const root = await privateRoot(t, 'book-sample-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary(library);
  await service.store.update(state => { state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE }; });
  const records = async () => (await service.store.read()).sources;
  const book = async () => (await records()).filter(isCourseNotesSource).find(record => !record.archived);
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND).at(-1).contract;
  const build = async (args = {}) => {
    const started = await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', ...args });
    const job = await settleJob(service, started.jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return { contract: contract(), record: await book() };
  };
  const since = mark => fake.calls.slice(mark);
  return { service, fake, build, book, records, contract, since };
}
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
const titled = (calls, titles) => calls.filter(call => titles.includes(call.data.point?.title));

test('a first build writes the sample and waits; building the rest keeps it, sends it with every write and approves it; a later build asks nothing', async t => {
  const w = await world(t, { library: { paper: true } });
  const first = await w.build();
  const notes = first.record.courseNotes, sample = notes.sample;
  // The sample: two points, written, reviewed (and repaired when needed) the whole way; the book holds only them.
  assert.equal(sample.status, 'waiting');
  assert.equal(sample.leaves.length, 2);
  const written = notes.leaves.filter(leaf => leaf.body && !leaf.body.empty).map(leaf => leaf.id);
  assert.deepEqual([...written].sort(), [...sample.leaves].sort(), 'only the sample is written');
  const titles = notes.leaves.filter(leaf => sample.leaves.includes(leaf.id)).map(leaf => leaf.title);
  assert.equal(w.fake.of('write').length, 2, 'one write per sample point');
  assert.deepEqual([...new Set(w.fake.of('review').map(call => call.data.point.title))].sort(), [...titles].sort(), 'each reviewed');
  assert.ok(sample.exemplar.length > 20 && sample.band.high >= sample.band.low && sample.band.low > 0, 'its words and band');
  // The scale of the rest, from what the sample used: points, calls, tokens, time; no price.
  const leaves = leavesOf((await w.records()).filter(isCourseOutlineSource)[0].courseOutline.nodes);
  const anchored = leaves.filter(leaf => leaf.anchors?.length).length;
  assert.deepEqual(sample.estimate.points, { total: anchored, sample: 2, rest: anchored - 2 });
  assert.ok(sample.estimate.calls.low >= (anchored - 2) * 2, `two calls a point at least (${JSON.stringify(sample.estimate.calls)})`);
  assert.ok(sample.estimate.totalTokens.low > 0 && sample.estimate.concurrency >= 1);
  // The Job: partial (the rest is not written), and the console says the book waits for the learner.
  assert.equal(first.contract.result.completeness, 'partial');
  // The waiting first, so the console's one-line row says it even when narrow.
  assert.equal(first.contract.stage.text, `样例已写好，等你看过再生成其余 ${anchored - 2} 个（样例 2 个知识点）`);
  assert.deepEqual(first.contract.detail.book.sample, { points: 2, rest: anchored - 2, total: anchored, ready: true, written: true });
  // The pages show it while it waits: the 总纲's book line and the book page, its points by title (on the book page with their headings) and the scale.
  const shown = (await w.service.call('course.outline', { course: COURSE })).book.notes.sample;
  const inOrder = sample.leaves.map(id => notes.leaves.find(leaf => leaf.id === id).title);
  assert.deepEqual(shown.points.map(point => point.title), inOrder, 'the typical point first');
  assert.deepEqual([shown.level, shown.written, shown.estimate], [sample.level, true, sample.estimate]);
  const opened = (await w.service.call('course.book.open', { course: COURSE })).sample;
  assert.deepEqual(opened.points.map(point => point.title), inOrder);
  assert.ok(opened.points.every(point => /^[a-z0-9-]+$/i.test(point.hid)), 'each point by its heading on the book page');

  // Build the rest: the sample's points are kept (no call asks for them again); every write carries the approved sample.
  const mark = w.fake.calls.length;
  const rest = await w.build({ sample: 'confirm' });
  const asked = w.since(mark);
  assert.deepEqual(titled(asked, titles), [], 'the sample is never paid twice');
  assert.equal(asked.filter(call => call.stage === 'write').length, anchored - 2, 'every other point written once');
  assert.ok(asked.filter(call => ['write', 'review', 'repair'].includes(call.stage)).every(call => call.prompt.includes(sample.exemplar)), 'the sample leads every request');
  assert.ok(asked.filter(call => call.stage === 'review').every(call => call.prompt.includes('"drift"')));
  assert.equal(rest.record.courseNotes.sample.status, 'confirmed');
  assert.ok(rest.record.courseNotes.leaves.filter(leaf => leaf.anchors.length).every(leaf => leaf.body?.status === 'ok'));
  assert.equal(rest.contract.result.completeness, 'complete');
  assert.equal(rest.contract.detail.book.sample, undefined, 'no sample in this build');
  assert.equal((await w.service.call('course.outline', { course: COURSE })).book.notes.sample, undefined, 'an approved sample is not shown');

  // A later build at the same settings: the approved sample stands, nothing to write, no call.
  const after = w.fake.calls.length;
  await w.build();
  assert.equal(w.fake.calls.length, after, 'a rerun asks nothing');
});

test('an outline without its inventory: the sample reads only its own materials; the rest reads the others and still keeps the sample', async t => {
  const w = await world(t);
  const organised = await settleJob(w.service, (await w.service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
  assert.equal(organised.status, 'complete');
  const full = w.fake.of('inventory').length;
  // The inventory is a cache: without it the outline stands, and a book build reads it again.
  await w.service.store.update(state => { state.sources = state.sources.filter(source => !isCourseInventorySource(source)); });
  const mark = w.fake.calls.length;
  const first = await w.build();
  const sampleInventory = w.since(mark).filter(call => call.stage === 'inventory').length;
  assert.ok(sampleInventory > 0 && sampleInventory < full, `the sample's materials only (${sampleInventory} of ${full} calls)`);
  const sample = first.record.courseNotes.sample, titles = first.record.courseNotes.leaves.filter(leaf => sample.leaves.includes(leaf.id)).map(leaf => leaf.title);
  assert.equal(sample.estimate.stages.find(stage => stage.id === 'inventory')?.calls, full - sampleInventory, 'what is left to read is in the scale');
  const before = w.fake.calls.length;
  await w.build({ sample: 'confirm' });
  const rest = w.since(before);
  assert.equal(rest.filter(call => call.stage === 'inventory').length, full - sampleInventory, 'the rest reads the other materials');
  assert.deepEqual(titled(rest, titles), [], 'and keeps the sample');
});

test('changed settings: the sample made again at the new level (the same points); building the rest of the old one is refused; the same settings again cost nothing', async t => {
  const w = await world(t);
  const first = await w.build({ coverage: 'standard' });
  const points = first.record.courseNotes.sample.leaves;
  const mark = w.fake.calls.length;
  const again = await w.build({ coverage: 'full' });
  const sample = again.record.courseNotes.sample;
  assert.deepEqual([sample.level, sample.status, sample.leaves], ['full', 'waiting', points], 'the same two points, at the new level');
  assert.equal(w.since(mark).filter(call => call.stage === 'write').length, 2, 'written again');
  const refusedAt = w.fake.calls.length;
  await assert.rejects(w.service.call('generation.courseBook.build', { course: COURSE, language: 'zh', coverage: 'standard', sample: 'confirm' }),
    error => error.code === 'course-book-sample-stale' && /重做样例/.test(error.message));
  assert.equal(w.fake.calls.length, refusedAt, 'refused before any call');
  const same = await w.build({ coverage: 'full' });
  assert.equal(w.fake.calls.length, refusedAt, 'the same settings again: the kept sample, no call');
  assert.deepEqual(same.record.courseNotes.sample, sample, 'and the same sample, its scale kept');
});
