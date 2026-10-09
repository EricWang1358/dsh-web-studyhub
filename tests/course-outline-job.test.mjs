/* 课程总纲 step 2: the build as ONE kind of Job of the unified runtime (`course-outline-build`). The course's materials are described compactly (never their
   texts, the syllabus excepted), grouped into knowledge points in batches (map), arranged into chapters and sections in learning order (reduce), marked by
   sample papers when some are chosen (papers), and saved as ONE special material. A synthetic library shaped like the owner's (134 materials, about 900
   questions) and a fake model: no real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { COURSE, IMPORT_ORDER, LECTURES, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseOutlineSource } from '../lib/exam-point-list.js';
import { batchesOf, planOutline } from '../lib/contexts/generation/outline/plan.js';
import { assemble, pointsOf } from '../lib/contexts/generation/outline/tree.js';
import { readMap } from '../lib/contexts/generation/outline/read.js';

const KIND = 'course-outline-build';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, taskKindOf } from './ui/tasks/task-model.js';
  export { resultOpener } from './ui/tasks/task-actions.js';`);
const PAPER = 'doc:document-paper-2025';

async function world(t, { fake = outlineModel(), library = {}, runtime = true } = {}) {
  const root = await privateRoot(t, 'course-outline-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions(runtime ? 'runtime' : 'legacy', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary(library);
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const build = (extra = {}) => service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...extra });
  const jobs = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND);
  const outlines = async () => (await service.store.read()).sources.filter(isCourseOutlineSource);
  const view = async (args = {}) => service.call('course.outline', { course: COURSE, ...args });
  return { service, fake, build, jobs, outlines, view, contract: () => jobs().at(-1).contract, sources };
}
const finish = async (w, extra) => {
  const job = await settleJob(w.service, (await w.build(extra)).jobId);
  assert.equal(job.status, 'complete', JSON.stringify(w.contract()?.error ?? null));
  return (await w.outlines()).find(record => !record.archived);
};
const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
const depthOf = nodes => Math.max(0, ...nodes.map(node => 1 + (node.children ? depthOf(node.children) : 0)));

test('134 materials and about 900 questions become a book in a handful of calls: chapters › sections › points, every row of the course held once, the rest in 其他', async t => {
  const w = await world(t, { fake: outlineModel({ drop: ['Zero trust'] }) });
  const before = await w.view();
  assert.deepEqual([before.documents.length, before.total > 850, before.book], [134, true, null]);
  const record = await finish(w);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['map', 'reduce'], 'one batch of descriptors and one reduce for 134 materials');
  const outline = record.courseOutline;
  assert.equal(depthOf(outline.nodes), 3);
  const anchors = [...leavesOf(outline.nodes).flatMap(leaf => leaf.anchors), ...outline.other.anchors];
  assert.equal(new Set(anchors).size, anchors.length, 'every anchor once');
  const answer = await w.view();
  assert.equal(answer.book.id, record.id);
  const counted = answer.book.nodes.reduce((sum, node) => sum + node.total, 0) + (answer.book.other?.total ?? 0);
  assert.ok(counted >= answer.total - answer.unplaced.total, 'every placed question is under a chapter or 其他');
  // The point the reduce left out is not lost: its rows are in 其他, counted in the task's result.
  assert.ok(answer.book.other.total > 0 && outline.counts.leftover > 0);
  assert.equal(outline.counts.invalid, 1, 'the invented point id p999 is counted');
  assert.equal(w.contract().detail.outline.leftover, outline.counts.leftover);
  // Overview and six lectures; the exam review chapter held only an invented id and is left out.
  assert.match(w.contract().stage.text, /^总纲已保存：7 章、\d+ 个知识点；\d+ 处资料放在「其他」$/);
});

test('the model sees descriptors, not texts; copies and tiny notes land together; the order follows the syllabus, not the import order', async t => {
  const w = await world(t);
  const record = await finish(w);
  const [map] = w.fake.of('map'), [reduce] = w.fake.of('reduce');
  assert.ok(!map.prompt.includes('the architect records this decision'), 'no material text reaches a map call');
  assert.ok(map.data.syllabus.includes('第 1 讲') && reduce.data.syllabus.includes('第 6 讲'), 'the syllabus is the ordering authority');
  const copy = map.data.materials.find(item => item.copies === 2 && item.chapters);
  assert.equal(copy.title, '01. Introduction to Solution Architecture v2.1', 'two imports of one lecture are one descriptor');
  assert.deepEqual([copy.number, copy.version], [1, '2.1']);
  assert.equal(map.data.materials.find(item => item.title === '补充笔记 · Reintroduction').copies, 4, 'four identical notes are one descriptor');
  assert.ok(map.data.materials.find(item => /2026-09-02/.test(item.title)).date === '2026-09-02');
  const leaves = leavesOf(record.courseOutline.nodes), holding = key => leaves.find(leaf => leaf.anchors.includes(key));
  const first = holding('pdf:document-l1#0');
  assert.ok(first === holding('pdf:document-l1-again#0'), 'a lecture and its second import are in one leaf');
  assert.ok(first === holding('doc:document-l1-diagrams'), 'its diagram copy too');
  for (const n of [1, 2, 3, 4]) assert.ok(first === holding(`doc:document-note-${n}`), 'the four 补充笔记 · Reintroduction too');
  assert.deepEqual(record.courseOutline.nodes.slice(1, 7).map(node => node.title), LECTURES.map(lecture => lecture.title), 'syllabus order 1..6');
  assert.notDeepEqual(IMPORT_ORDER, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(record.courseOutline.orderBasis, { codes: ['syllabus', 'numbering', 'dates'], syllabus: 'SA 讲义大纲' }, 'a ground the library has no sign of is dropped');
  assert.match(record.text, /学习顺序依据：讲义大纲《SA 讲义大纲》的顺序；资料标题里的编号/);
});

test('more materials are read in several batches: a point split across batches is merged by the reduce, and the calls stay few', async t => {
  const w = await world(t, { library: { extraHandouts: 150, longNames: true } });
  const record = await finish(w);
  const maps = w.fake.of('map').length;
  assert.ok(maps >= 2 && maps <= 6, `${maps} map calls`);
  assert.ok(w.fake.calls.every(call => call.prompt.length < 60000), 'every call under the per-call limit');
  const titles = leavesOf(record.courseOutline.nodes).map(leaf => leaf.title);
  assert.equal(new Set(titles).size, titles.length, 'one leaf per point title: the reduce merged the points of different batches');
});

test('an answer that is not JSON is asked again once and the build goes on; a reduce unreadable twice fails, and a retry in the same run asks only what is missing', async t => {
  const junk = await world(t, { fake: outlineModel({ junk: (call, calls) => calls.length === 1 }) });
  await finish(junk);
  assert.deepEqual(junk.fake.calls.map(call => call.stage), ['map', 'map', 'reduce']);
  assert.match(junk.fake.calls[1].prompt, /Your previous reply could not be read/);
  let broken = 2;
  const w = await world(t, { fake: outlineModel({ junk: call => call.stage === 'reduce' && broken-- > 0 }) });
  const started = await w.build();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'failed');
  assert.match(w.contract().error.message, /排章节时模型两次都没有给出可用的答案，没有保存总纲；可以重试/);
  assert.deepEqual(await w.outlines(), [], 'nothing saved');
  assert.equal(w.contract().actions.retry.available, true);
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['map', 'reduce', 'reduce', 'reduce'], 'the map answer was kept: only the reduce was asked again');
  assert.equal(w.contract().runtime.attempts.length, 2);
  assert.equal((await w.outlines()).length, 1);
});

test('a stop aborts the call in flight and keeps nothing; a pause waits at the next checkpoint and the resume asks only what is left', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { fake: outlineModel({ held }) });
  const started = await w.build();
  await until(() => w.fake.calls.length === 1, 'the map call');
  await w.service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  assert.equal(w.fake.calls[0].request.signal.aborted, true);
  held.gate.release();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'cancelled');
  assert.deepEqual(await w.outlines(), []);
  assert.match(w.contract().stage.text, /已取消，没有保存总纲/);
  const pausing = { at: 1, gate: gate() };
  t.after(() => pausing.gate.release());
  const p = await world(t, { fake: outlineModel({ held: pausing }) });
  const run = await p.build();
  await until(() => p.fake.calls.length === 1, 'the map call');
  await p.service.call('job.control', { jobId: run.jobId, action: 'pause' });
  pausing.gate.release();
  await until(() => p.contract().status === 'paused', 'the checkpoint before the reduce');
  assert.deepEqual(p.fake.calls.map(call => call.stage), ['map']);
  await p.service.call('job.control', { jobId: run.jobId, action: 'resume' });
  assert.equal((await settleJob(p.service, run.jobId)).status, 'complete');
  assert.deepEqual(p.fake.calls.map(call => call.stage), ['map', 'reduce'], 'the map was asked once in all');
});

test('staleness follows the materials; a rebuild replaces the current outline (archived, never deleted)', async t => {
  const w = await world(t);
  const old = await finish(w);
  assert.equal((await w.view()).book.stale, false);
  await w.service.store.update(state => { state.sources.push({ id: 'late', title: 'Late handout', text: 'A late handout on zero trust networks.', createdAt: '2026-10-05T00:00:00.000Z', courses: [COURSE] }); });
  const stale = await w.view();
  assert.equal(stale.book.stale, true, '资料有更新');
  assert.ok(stale.book.other.anchors >= 1, 'the new material shows in 其他 at once');
  const fresh = await finish(w);
  const all = await w.outlines();
  assert.equal(all.length, 2);
  assert.equal(all.find(record => record.id === old.id).archived, true, 'the old outline is kept, archived');
  assert.ok(all.find(record => record.id === old.id).text.length > 0, 'and still readable');
  assert.deepEqual([fresh.courseOutline.supersedes, w.contract().detail.supersedes, w.contract().detail.targetId], [old.id, old.id, fresh.id]);
  const answer = await w.view();
  assert.deepEqual([answer.book.id, answer.book.stale, answer.book.supersedes], [fresh.id, false, old.id]);
});

test('a second start while a build of the course runs answers with the running task', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { fake: outlineModel({ held }) });
  const first = await w.build();
  const second = await w.build();
  assert.deepEqual([second.jobId, second.alreadyRunning], [first.jobId, true]);
  held.gate.release();
  await settleJob(w.service, first.jobId);
  assert.equal(w.jobs().length, 1);
});

test('sample papers mark the leaves they test from quotes found in the paper; without a paper nothing is said about exams', async t => {
  const w = await world(t, { library: { paper: true } });
  const record = await finish(w, { papers: [PAPER] });
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['map', 'reduce', 'paper']);
  const outline = record.courseOutline, leaves = leavesOf(outline.nodes), by = title => leaves.find(leaf => leaf.title === title);
  assert.deepEqual(outline.papers.map(paper => [paper.key, paper.title]), [[PAPER, 'SA 2025 样卷']]);
  const [place] = by('Views and viewpoints').exam.evidence;
  assert.deepEqual([place.sourceId, place.quote, place.paper], ['paper-2025', 'Explain the difference between a view and a viewpoint, with', PAPER], 'the paper\'s own words');
  assert.equal(by('Layers').exam, undefined, 'a quote that is not in the paper marks nothing');
  assert.equal(w.contract().detail.outline.unverified, 1);
  const answer = await w.view(), flat = leavesOf(answer.book.nodes);
  assert.deepEqual(flat.find(leaf => leaf.title === 'Views and viewpoints').tier, 'must');
  assert.deepEqual([flat.find(leaf => leaf.title === 'Layers').tier, answer.book.papers], ['extra', 1]);
  assert.match(record.text, /Views and viewpoints（样卷考过 1\/1 份）/);
  // 重新整理 without naming papers keeps the ones the outline rested on; naming none drops them.
  const again = await finish(w);
  assert.deepEqual(again.courseOutline.papers.map(paper => paper.key), [PAPER]);
  assert.equal((await finish(w, { papers: [] })).courseOutline.papers, undefined);
  const plain = await world(t);
  const none = await finish(plain);
  assert.ok(!('papers' in none.courseOutline) && !/样卷考过|补充/.test(none.text));
  assert.ok(leavesOf((await plain.view()).book.nodes).every(leaf => !('tier' in leaf)));
});

test('stage 0 refuses with a code, no model call and no task: no course, all courses, a paper outside the course, no materials, no task service', async t => {
  const w = await world(t);
  await refused(w.build({ course: '*' }), 'course-outline-no-course');
  await refused(w.service.call('generation.courseOutline.build', { language: 'zh' }), 'course-outline-no-course');
  await refused(w.build({ papers: ['doc:nowhere'] }), 'course-outline-paper-invalid');
  await refused(w.build({ course: 'Empty course' }), 'course-outline-no-materials');
  await refused(w.build({ supersedes: 'handout-1' }), 'course-outline-supersedes-invalid');
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0]);
  await refused((await world(t, { runtime: false })).build(), 'executor-unavailable');
});

test('the outline is not a material: hidden from the snapshot and the lists, refused as the source of questions, readable as a record', async t => {
  const w = await world(t);
  const record = await finish(w);
  const snapshot = await w.service.call('snapshot');
  assert.ok(!snapshot.sources.some(source => source.id === record.id));
  assert.ok(!(await w.service.call('source.list', {})).sources.some(source => source.id === record.id));
  assert.equal((await w.view()).documents.length, 134, 'not a row of its own outline');
  const words = error => { assert.equal(error.code, 'course-outline-not-material', error.message); assert.match(error.message, /课程总纲只是参考/); return true; };
  await assert.rejects(w.service.call('generate', { sourceIds: [record.id], kind: 'quiz', count: 3 }), words);
  await assert.rejects(w.service.call('generate', { sourceIds: ['handout-1'], referenceSourceIds: [record.id], kind: 'quiz', count: 3 }), words);
  assert.match((await w.service.call('source.get', { id: record.id })).text, /## 2 Introduction to Solution Architecture/);
});

test('the console draws it as a task with what it made: done, its title, the result opens the outline page of its course', async t => {
  const w = await world(t);
  const record = await finish(w);
  const tasks = consoleCode.tasksOf(await w.service.call('snapshot'));
  assert.equal(tasks.length, 1);
  const summary = consoleCode.taskSummary(tasks[0]);
  assert.deepEqual([summary.state, summary.title], ['done', '整理总纲 · SA']);
  assert.ok(summary.line && !/undefined|NaN/.test(JSON.stringify(summary)));
  const { result, capabilities, detail } = w.contract();
  assert.deepEqual(result.refs, [{ kind: 'course-outline', id: record.id, course: COURSE }]);
  assert.deepEqual([capabilities.retryKeeps, capabilities.stopKeeps, capabilities.pauseMode], ['completed', 'nothing', 'checkpoint']);
  assert.equal(detail.course, COURSE);
  const went = [];
  const app = { data: { focus: { course: COURSE }, sources: [] }, nav: { navigate: page => went.push(page) }, core: { act: async () => went.push('focus') } };
  const opener = consoleCode.resultOpener(tasks[0], app);
  assert.equal(opener.label, '打开总纲');
  await opener.run();
  assert.deepEqual(went, ['outline']);
});

test('the program checks the model: ids of another batch or invented ones are dropped and counted, a unit claimed twice keeps its first place', () => {
  const state = outlineLibrary();
  const plan = planOutline({ ...state, documents: [], drafts: [], attempts: [], courses: [] }, { course: COURSE });
  const [batch] = plan.batches, [first] = batch.descriptors;
  const answers = [readMap(JSON.stringify({ points: [{ title: 'A', ids: [first.id, 'm9999', first.chapters?.[0]?.id ?? first.id] }, { title: 'B', ids: [first.id] }, { title: '', ids: ['m2'] }] }))];
  const mapped = pointsOf(plan, answers);
  assert.deepEqual([mapped.points.length, mapped.counts.invalid, mapped.counts.repeated], [1, 1, 2]);
  const outline = assemble(plan, mapped, { basis: [], chapters: [{ title: '', intro: '', leaves: [{ ids: ['p1', 'p1', 'p7'] }], sections: [] }] });
  assert.equal(outline.nodes[0].title, 'A', 'an untitled chapter takes its first leaf\'s title');
  assert.deepEqual([outline.counts.repeated, outline.counts.invalid], [3, 2]);
  assert.equal(outline.counts.leftover, plan.described.units.length - (first.chapters?.length ?? 1));
  assert.deepEqual(outline.orderBasis.codes, ['numbering'], 'no ground claimed: the names\' numbers if there are any');
  assert.equal(batchesOf(plan.described.descriptors, 2000).length > 5, true, 'a small limit makes many batches, each under it or alone');
});
