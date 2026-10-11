/* 复习全书 as a QUALITY WORKFLOW, ONE kind of Job of the unified runtime (`course-book-build`): the inventory of every page range first, the outline built from
   it, a MUST-COVER checklist per knowledge point, every point written in parallel from its own pages, reviewed by an independent call and repaired at most
   twice; a point still short is kept and marked, the Job ends partial and the next build does only those; a glossary from the covered items; a rerun asks
   nothing. A synthetic library shaped like the owner's (134 materials, about 900 questions) and a fake model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { INVENTED, bookModel } from './helpers/course-book-model.mjs';
import { isCourseInventorySource, isCourseNotesSource, isCourseOutlineSource } from '../lib/exam-point-list.js';
import { bodyText } from '../lib/course-book.js';

const KIND = 'course-book-build';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf } from './ui/tasks/task-model.js';
  export { resultOpener } from './ui/tasks/task-actions.js';`);

async function world(t, { fake = bookModel(), library = {}, sources: own, decks: ownDecks, course = COURSE, extra = [] } = {}) {
  const root = await privateRoot(t, 'course-book-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = own ? { sources: own, decks: ownDecks || [] } : outlineLibrary(library);
  await service.store.update(state => { state.sources.push(...structuredClone([...built.sources, ...extra])); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course }; });
  const build = (args = {}) => service.call('generation.courseBook.build', { course, language: 'zh', ...args });
  const jobs = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND);
  const records = async () => (await service.store.read()).sources;
  const notes = async () => (await records()).filter(isCourseNotesSource);
  const outlines = async () => (await records()).filter(isCourseOutlineSource);
  const view = async (args = {}) => service.call('course.outline', { course, ...args });
  const count = () => Object.fromEntries([...new Set(fake.calls.map(call => call.stage))].map(stage => [stage, fake.calls.filter(call => call.stage === stage).length]));
  return { service, fake, build, jobs, notes, outlines, view, count, records, contract: () => jobs().at(-1).contract };
}
const finish = async (w, args) => {
  const job = await settleJob(w.service, (await w.build(args)).jobId);
  assert.equal(job.status, 'complete', JSON.stringify(w.contract()?.error ?? null));
  return (await w.notes()).find(record => !record.archived);
};
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });

test('the 134-material course: inventory, outline, checklist, parallel writing, review; every must concept covered; calls per phase; a rerun asks nothing', async t => {
  const w = await world(t, { library: { paper: true } });
  const record = await finish(w);
  const phases = w.count();
  t.diagnostic(`134 materials, first build, calls per phase: ${JSON.stringify(phases)}`);
  const [outline] = await w.outlines(), leaves = leavesOf(outline.courseOutline.nodes);
  assert.deepEqual(phases, { inventory: 7, cluster: 2, order: 1, paper: 1, write: leaves.length, review: leaves.length, exam: 1 }, 'one write and one review a point, no repair');
  assert.ok(w.fake.of('write').every(call => call.prompt.length < 60000), 'every call modest');
  const notes = record.courseNotes;
  assert.deepEqual(notes.leaves.map(leaf => leaf.id), leaves.map(leaf => leaf.id), 'one explanation per point, in reading order');
  assert.ok(notes.leaves.every(leaf => leaf.body.status === 'ok' && leaf.body.coverage.missing.length === 0));
  const inventory = (await w.records()).find(isCourseInventorySource).courseInventory;
  assert.deepEqual(notes.coverage, { documents: { used: 133, total: 133 }, pages: { read: 168, total: 168 }, leaves: { ok: leaves.length, total: leaves.length },
    items: { covered: inventory.items.length, total: inventory.items.length } }, 'materials, points and concepts: all of them');
  // The writer's prompt: the checklist and the pages, the neighbours, no template.
  const write = w.fake.of('write')[2].data;
  assert.ok(write.checklist.length && write.pages.length && write.point.before && write.point.after);
  // Cites are the original's own words at their place.
  const state = await w.service.store.read(), byId = new Map(state.sources.map(source => [source.id, source]));
  for (const leaf of notes.leaves) for (const cite of bodyText(leaf.body).cites) assert.equal(byId.get(cite.sourceId).text.slice(cite.start, cite.end).replace(/\s+/g, ' '), cite.quote);
  // The glossary: every covered item, alphabetical, with its point.
  assert.equal(notes.glossary.length, inventory.items.length);
  const names = notes.glossary.map(entry => entry.name);
  assert.deepEqual(names, [...names].sort(new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true }).compare));
  assert.ok(notes.glossary.every(entry => notes.leaves.some(leaf => leaf.id === entry.leaf && leaf.body.coverage.covered.includes(entry.id))));
  assert.match(record.text, /## 生词与概念\n\n- \*\*/);
  assert.equal(w.contract().result.completeness, 'complete');
  // A rerun: the inventory, the outline and every point are current. No call, nothing written.
  const before = w.fake.calls.length;
  const again = await w.build();
  await settleJob(w.service, again.jobId);
  assert.equal(w.fake.calls.length - before, 0, 'the second run makes no call');
  assert.match(w.contract().stage.text, /复习全书已是最新/);
  assert.deepEqual((await w.notes()).map(item => item.id), [record.id]);
});

test('a point that misses concepts goes through repair; one still short after two rounds is kept as 未达标, the Job is partial, and the next build mends only it', async t => {
  const w = await world(t, { fake: bookModel({ omit: 1, stubborn: ['Layers'] }) });
  const record = await finish(w);
  const leaves = record.courseNotes.leaves, layers = leaves.find(leaf => leaf.title === 'Layers');
  assert.equal(w.fake.of('repair').length, leaves.length + 1, 'one repair a point, two for the stubborn one');
  assert.deepEqual([layers.body.status, layers.body.coverage.missing.length], ['short', 1], 'never claimed complete');
  assert.ok(leaves.filter(leaf => leaf !== layers).every(leaf => leaf.body.status === 'ok'));
  assert.equal(w.contract().result.completeness, 'partial');
  assert.match(w.contract().stage.text, /1 个未达标/);
  assert.match(record.text, /> 未达标：缺 1 个概念（Layers fact \d）/);
  assert.equal(record.courseNotes.coverage.items.covered, record.courseNotes.coverage.items.total - 1);
  const repairs = w.fake.of('repair').filter(call => call.data.point.title === 'Layers');
  assert.ok(repairs.every(call => call.data.missing.length === 1 && call.data.issues.some(issue => issue.kind === 'missing')), 'the repair is told what is missing');
  // The page: concept coverage per point and the missing list.
  const view = await w.view(), point = leavesOf(view.book.nodes).find(leaf => leaf.title === 'Layers');
  const opened = (await w.view({ expand: [point.key] })).open[point.key].notes;
  assert.deepEqual([opened.concepts.covered, opened.concepts.total, opened.body.status], [3, 4, 'short']);
  assert.deepEqual([view.book.notes.short, view.book.notes.levels.leaves.ok], [1, leaves.length - 1]);
  // The main chat's book tools say the same: book.toc per point, book.coverage with the missing names.
  const toc = await w.service.call('book.toc', { course: COURSE, limit: 40 }), row = toc.toc.find(item => item.title === 'Layers');
  assert.deepEqual([row.concepts, row.short, toc.coverage.leaves.ok], ['3/4', true, leaves.length - 1]);
  const own = await w.service.call('book.coverage', { course: COURSE, hid: row.hid });
  assert.deepEqual([own.concepts.covered, own.concepts.total, own.concepts.status, own.concepts.missing.length], [3, 4, 'short', 1]);
  // The next build: only the short point is mended (reviewed and repaired from its text, not written again).
  w.fake.opts.stubborn = [];
  const mark = w.fake.calls.length;
  const fresh = await finish(w);
  assert.deepEqual([...new Set(w.fake.calls.slice(mark).map(call => call.data.point?.title))], ['Layers']);
  assert.deepEqual(w.fake.calls.slice(mark).map(call => call.stage), ['review', 'repair', 'review']);
  assert.equal(fresh.courseNotes.leaves.find(leaf => leaf.title === 'Layers').body.status, 'ok');
  assert.equal(w.contract().result.completeness, 'complete');
});

test('the writer\'s claim is checked: an item it claims but never names is missing; an unsupported claim fails the review until repaired', async t => {
  const w = await world(t, { fake: bookModel({ unsupported: ['Scaling'] }) });
  const record = await finish(w);
  const scaling = record.courseNotes.leaves.find(leaf => leaf.title === 'Scaling');
  assert.equal(scaling.body.status, 'short', 'the reviewer still finds an unsupported claim after two repairs');
  assert.ok(scaling.body.issues.some(issue => issue.kind === 'unsupported'));
  assert.equal(w.fake.of('repair').filter(call => call.data.point.title === 'Scaling').length, 2, 'at most two rounds');
});

test('a quote not in the original is dropped with its mark; a point whose writing fails keeps nothing and the Job is partial', async t => {
  const w = await world(t, { fake: bookModel({ invent: true, skip: ['Zero trust'] }) });
  const record = await finish(w);
  const leaves = record.courseNotes.leaves.filter(leaf => leaf.body);
  assert.ok(leaves.every(leaf => bodyText(leaf.body).cites.every(cite => cite.quote !== INVENTED)));
  assert.ok(leaves.every(leaf => !/\[\^2\]/.test(leaf.body.units[0].text) && /rests on nothing\./.test(leaf.body.units[0].text)), 'the mark of the dropped quote is gone');
  assert.equal(record.courseNotes.leaves.find(leaf => leaf.title === 'Zero trust').body, undefined);
  assert.equal(w.fake.of('write').filter(call => call.data.point.title === 'Zero trust').length, 2, 'asked once more, then left alone');
  assert.equal(w.contract().result.completeness, 'partial');
  w.fake.opts.skip = [];
  const mark = w.fake.calls.length;
  await finish(w);
  assert.deepEqual([...new Set(w.fake.calls.slice(mark).map(call => call.data.point?.title))], ['Zero trust'], 'the next build writes only it');
});

test('(h) the book is not a material: hidden from the lists, refused as the source of questions, readable as a record', async t => {
  const w = await world(t);
  const record = await finish(w);
  const snapshot = await w.service.call('snapshot');
  assert.ok(!snapshot.sources.some(source => source.id === record.id));
  assert.ok(!(await w.service.call('source.list', {})).sources.some(source => source.id === record.id));
  assert.equal((await w.view()).documents.length, 134, 'not a row of its own outline');
  const words = error => { assert.equal(error.code, 'course-notes-not-material', error.message); assert.match(error.message, /复习全书只是参考/); return true; };
  await assert.rejects(w.service.call('generate', { sourceIds: [record.id], kind: 'quiz', count: 3 }), words);
  assert.match((await w.service.call('source.get', { id: record.id })).text, /^# 复习全书 · SA/);
});

test('an order call that fails keeps the points in the order of their materials; a stop keeps the inventory and no book; a pause resumes with what is left', async t => {
  const w = await world(t, { fake: bookModel({ fail: call => call.stage === 'order' }) });
  const record = await finish(w);
  const [outline] = await w.outlines();
  assert.ok(outline.courseOutline.nodes.length > 1 && record.courseNotes.leaves.every(leaf => leaf.body?.status === 'ok'), 'the book is written all the same');
  const held = { stage: 'write', gate: gate() };
  t.after(() => held.gate.release());
  const s = await world(t, { fake: bookModel({ held }) });
  const run = await s.build();
  await until(() => s.fake.of('write').length >= 1, 'the first writing call');
  await s.service.call('job.control', { jobId: run.jobId, action: 'cancel' });
  held.gate.release();
  assert.equal((await settleJob(s.service, run.jobId)).status, 'cancelled');
  assert.deepEqual(await s.notes(), [], 'no book');
  assert.equal((await s.records()).filter(isCourseInventorySource).length, 1, 'the inventory read so far is kept');
  const pausing = { stage: 'write', gate: gate() };
  t.after(() => pausing.gate.release());
  const p = await world(t, { fake: bookModel({ held: pausing }) });
  const job = await p.build();
  await until(() => p.fake.of('write').length >= 1, 'the first writing call');
  await p.service.call('job.control', { jobId: job.jobId, action: 'pause' });
  pausing.gate.release();
  await until(() => p.contract().status === 'paused', 'a checkpoint');
  const writes = p.fake.of('write').length;
  await p.service.call('job.control', { jobId: job.jobId, action: 'resume' });
  assert.equal((await settleJob(p.service, job.jobId)).status, 'complete');
  const leaves = leavesOf((await p.outlines())[0].courseOutline.nodes).length;
  assert.equal(p.fake.of('write').length, leaves, `every point written once in all (${writes} before the pause)`);
});

test('stage 0 refuses with a code and no call; one build per course; the console shows it and opens the outline page', async t => {
  const w = await world(t);
  await refused(w.build({ course: '*' }), 'course-book-no-course');
  await refused(w.build({ course: 'Empty course' }), 'course-book-no-materials');
  await refused(w.build({ papers: ['doc:nowhere'] }), 'course-outline-paper-invalid');
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0]);
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const h = await world(t, { fake: bookModel({ held }) });
  const first = await h.build();
  assert.deepEqual([(await h.build()).jobId, (await h.build()).alreadyRunning], [first.jobId, true]);
  await refused(h.service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' }), 'course-outline-book-running');
  held.gate.release();
  assert.equal((await settleJob(h.service, first.jobId)).status, 'complete');
  const [record] = await h.notes();
  const tasks = consoleCode.tasksOf(await h.service.call('snapshot')).filter(task => task.type === KIND || task.kind === KIND || task.contract?.kind === KIND);
  const summary = consoleCode.taskSummary(tasks.at(-1));
  assert.deepEqual([summary.state, summary.title], ['done', '生成复习全书 · SA']);
  assert.equal(h.contract().result.refs[0].id, record.id);
  assert.ok(h.contract().detail.book.board.every(row => row.status === 'ok'), 'the board says each point\'s state');
  const went = [];
  const app = { data: { focus: { course: COURSE }, sources: [] }, nav: { navigate: page => went.push(page) }, core: { act: async () => went.push('focus') } };
  const opener = consoleCode.resultOpener(tasks.at(-1), app);
  assert.equal(opener.label, '打开复习全书');
  await opener.run();
  assert.deepEqual(went, ['outline']);
});
