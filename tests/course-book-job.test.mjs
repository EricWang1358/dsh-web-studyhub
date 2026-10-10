/* 复习全书, its explanation layer: the build as ONE kind of Job of the unified runtime (`course-book-build`). For each knowledge point of the 课程总纲 an
   explanation from its own materials with cites found word for word in the original, 考情 only with sample papers; the outline is organised first when there
   is none; a rebuild asks only what changed. A synthetic library shaped like the owner's (134 materials, about 900 questions) and a fake model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { INVENTED, bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource, isCourseOutlineSource } from '../lib/exam-point-list.js';

const KIND = 'course-book-build';
const PAPER = 'doc:document-paper-2025', PAPER_B = 'doc:document-paper-2024';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf } from './ui/tasks/task-model.js';
  export { resultOpener } from './ui/tasks/task-actions.js';`);
const paperB = { id: 'paper-2024', title: 'SA 2024 样卷', text: 'Q2 Write a quality attribute scenario for availability. (10 marks)', createdAt: '2026-09-30T00:00:00.000Z',
  courses: [COURSE], document: { materialId: 'document-paper-2024', format: 'md', filename: 'SA 2024 样卷.md' } };

async function world(t, { fake = bookModel(), library = {}, sources: own, decks: ownDecks, course = COURSE, runtime = true, extra = [] } = {}) {
  const root = await privateRoot(t, 'course-book-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions(runtime ? 'runtime' : 'legacy', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = own ? { sources: own, decks: ownDecks || [] } : outlineLibrary(library);
  const decks = library.noQuestions ? [] : built.decks;
  await service.store.update(state => { state.sources.push(...structuredClone([...built.sources, ...extra])); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course }; });
  const build = (args = {}) => service.call('generation.courseBook.build', { course, language: 'zh', ...args });
  const jobs = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND);
  const records = async () => (await service.store.read()).sources;
  const notes = async () => (await records()).filter(isCourseNotesSource);
  const outlines = async () => (await records()).filter(isCourseOutlineSource);
  const view = async (args = {}) => service.call('course.outline', { course, ...args });
  return { service, fake, build, jobs, notes, outlines, view, contract: () => jobs().at(-1).contract };
}
const finish = async (w, args) => {
  const job = await settleJob(w.service, (await w.build(args)).jobId);
  assert.equal(job.status, 'complete', JSON.stringify(w.contract()?.error ?? null));
  return (await w.notes()).find(record => !record.archived);
};
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
const bodies = record => Object.fromEntries(record.courseNotes.leaves.map(leaf => [leaf.id, JSON.stringify(leaf.body)]));
const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });

test('(a)(d) no outline, no questions, no papers: the build organises the outline first, then explains every knowledge point a few at a time', async t => {
  const w = await world(t, { library: { noQuestions: true } });
  assert.equal((await w.view()).book, null);
  const record = await finish(w);
  const [outline] = await w.outlines(), leaves = leavesOf(outline.courseOutline.nodes);
  const notesCalls = w.fake.of('notes').length;
  assert.deepEqual(w.fake.stages(), ['map', 'reduce', ...Array(notesCalls).fill('notes')], 'the outline first (one map, one reduce), then the notes; no 考情 without papers');
  assert.equal(notesCalls, Math.ceil(leaves.length / 3), `${leaves.length} knowledge points, three a call`);
  assert.ok(w.fake.of('notes').every(call => call.data.leaves.length <= 3 && call.prompt.length < 40000), 'every call modest');
  const notes = record.courseNotes;
  assert.deepEqual([notes.outlineId, notes.leaves.map(leaf => leaf.id)], [outline.id, leaves.map(leaf => leaf.id)], 'one explanation per leaf, in reading order');
  assert.ok(notes.leaves.every(leaf => leaf.body && !leaf.exam), 'no 考情 without sample papers');
  const state = await w.service.store.read(), byId = new Map(state.sources.map(source => [source.id, source]));
  for (const leaf of notes.leaves) for (const cite of leaf.body.cites) {
    assert.equal(byId.get(cite.sourceId).text.slice(cite.start, cite.end).replace(/\s+/g, ' '), cite.quote, 'a cite is the original\'s own words at its place');
  }
  const first = notes.leaves[0].body;
  assert.match(first.points[0], /\[\^1\]$/);
  assert.deepEqual(first.extra, ['A general intuition the materials do not give'], '补充 carries no cite');
  assert.ok(!/考情/.test(record.text) && /## .+\n\n### 知识梳理/.test(record.text) && /\[\^n[0-9a-f-]+-1\]: 「/.test(record.text));
  assert.equal(w.contract().detail.book.leaves, leaves.length);
  assert.match(w.contract().stage.text, /^复习全书已保存：\d+ 个知识点$/);
  // The page: the book's line and, once a leaf is opened, its notes with the cites' materials.
  const answer = await w.view(), leaf = leavesOf(answer.book.nodes)[1];
  assert.deepEqual([answer.book.notes.id, answer.book.notes.stale, answer.book.notes.papers], [record.id, false, false]);
  const opened = (await w.view({ expand: [leaf.key] })).open[leaf.key].notes;
  assert.ok(opened.body.explain && opened.body.cites[0].title && !opened.exam);
});

test('(b) with questions and one sample paper: 考情 for every leaf, written by the model only where the paper tests it', async t => {
  const w = await world(t, { library: { paper: true } });
  const record = await finish(w, { papers: [PAPER] });
  const [outline] = await w.outlines(), leaves = leavesOf(outline.courseOutline.nodes);
  const tested = leaves.filter(leaf => leaf.exam?.evidence?.length);
  assert.deepEqual(w.fake.stages().filter(stage => stage !== 'notes'), ['map', 'reduce', 'paper', 'exam'], 'one 考情 call for the tested leaves');
  assert.deepEqual(w.fake.of('exam')[0].data.leaves.map(leaf => leaf.title).sort(), tested.map(leaf => leaf.title).sort());
  const byId = new Map(record.courseNotes.leaves.map(leaf => [leaf.id, leaf]));
  assert.ok(tested.every(leaf => byId.get(leaf.id).exam.tested && /^Asked as: /.test(byId.get(leaf.id).exam.note)));
  assert.ok(leaves.filter(leaf => !tested.includes(leaf)).every(leaf => byId.get(leaf.id).exam.tested === false && !byId.get(leaf.id).exam.note));
  assert.match(record.text, /### 考情\n\n样卷考过。 Asked as: /);
  assert.match(record.text, /### 考情\n\n样卷没有考到。/);
  assert.deepEqual(record.courseNotes.papers.map(paper => paper.key), [PAPER]);
});

test('(c) a course of one short material and no question: an outline of one point and one explanation', async t => {
  const tiny = { id: 'tiny', title: 'Week 1 note', text: 'Entropy measures disorder. Example: a melting ice cube gains entropy as its molecules spread out.',
    createdAt: '2026-09-01T00:00:00.000Z', courses: ['Tiny'], document: { materialId: 'document-tiny', format: 'md', filename: 'week1.md' } };
  const w = await world(t, { sources: [tiny], course: 'Tiny' });
  const record = await finish(w);
  assert.deepEqual(w.fake.stages(), ['map', 'reduce', 'notes']);
  const [leaf] = record.courseNotes.leaves;
  assert.deepEqual([record.courseNotes.leaves.length, leaf.body.cites[0].sourceId], [1, 'tiny']);
  assert.match(leaf.body.example, /^Example: /, 'the material has a worked example: the notes restate one');
});

test('(e) a material added: the outline is organised again and only the knowledge point it joins is explained again; the rest is kept, the old book archived', async t => {
  const w = await world(t);
  const old = await finish(w), before = w.fake.calls.length;
  await w.service.store.update(state => { state.sources.push({ id: 'handout-99', title: 'Handout 99: Zero trust', text: 'Zero trust fact 9: never trust, always verify every request.',
    createdAt: '2026-10-05T00:00:00.000Z', courses: [COURSE], document: { materialId: 'document-handout-99', format: 'md', filename: 'Handout 99.md' } }); });
  assert.equal((await w.view()).book.notes.stale, true, '资料有更新，建议更新全书');
  const fresh = await finish(w);
  const calls = w.fake.calls.slice(before);
  assert.deepEqual(calls.map(call => call.stage), ['map', 'reduce', 'notes'], 'the outline (it is out of date), then ONE notes call');
  assert.deepEqual(calls[2].data.leaves.map(leaf => leaf.title), ['Zero trust'], 'only the point the new handout joined');
  const was = bodies(old), now = bodies(fresh), zero = fresh.courseNotes.leaves.find(leaf => leaf.title === 'Zero trust');
  for (const leaf of fresh.courseNotes.leaves) if (leaf !== zero) assert.equal(now[leaf.id], was[leaf.id], `${leaf.title} kept byte for byte`);
  assert.equal(zero.body.replaces, old.id);
  assert.deepEqual([fresh.courseNotes.supersedes, fresh.courseNotes.counts.written, fresh.courseNotes.counts.reused], [old.id, 1, old.courseNotes.leaves.length - 1]);
  const all = await w.notes();
  assert.equal(all.find(record => record.id === old.id).archived, true, 'the old version is kept, archived');
  assert.equal((await w.outlines()).filter(record => !record.archived).length, 1, 'the outline it organised replaced the old one in the same write');
  assert.equal((await w.view()).book.notes.stale, false);
});

test('(f) the outline organised again under other names (new node ids): the notes follow their leaves by anchors, no call', async t => {
  const fake = bookModel();
  const w = await world(t, { fake });
  const old = await finish(w);
  // The outline alone, rebuilt by its own task with other titles.
  fake.opts.renameMap = true;
  const rebuild = await w.service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' });
  await settleJob(w.service, rebuild.jobId);
  const outline = (await w.outlines()).find(record => !record.archived), leaves = leavesOf(outline.courseOutline.nodes);
  const oldIds = new Set(old.courseNotes.leaves.map(leaf => leaf.id));
  assert.ok(leaves.every(leaf => !oldIds.has(leaf.id)), 'every node id changed');
  assert.equal((await w.view()).book.notes.stale, true, 'notes of another outline');
  const before = fake.calls.length;
  const fresh = await finish(w);
  assert.equal(fake.calls.length, before, 'no model call: every explanation is of the same texts');
  assert.deepEqual(fresh.courseNotes.leaves.map(leaf => leaf.id), leaves.map(leaf => leaf.id));
  const was = new Map(old.courseNotes.leaves.map(leaf => [leaf.anchors.join('|'), leaf.body]));
  assert.ok(fresh.courseNotes.leaves.every(leaf => JSON.stringify(leaf.body) === JSON.stringify(was.get(leaf.anchors.join('|')))));
  assert.equal(fresh.courseNotes.outlineId, outline.id);
});

test('(g) a quote that is not in the original is dropped with its mark; the rest stays', async t => {
  const w = await world(t, { fake: bookModel({ invent: true }) });
  const record = await finish(w);
  const leaves = record.courseNotes.leaves;
  assert.ok(leaves.every(leaf => leaf.body.cites.length === 1 && leaf.body.cites.every(cite => cite.quote !== INVENTED)));
  assert.ok(leaves.every(leaf => !/\[\^2\]|\[2\]/.test(leaf.body.explain) && /rests on nothing\.$/.test(leaf.body.explain)), 'the mark of the dropped quote is gone');
  assert.equal(record.courseNotes.counts.dropped, leaves.length);
  assert.match(w.contract().stage.text, new RegExp(`；${leaves.length} 处引文在原文里找不到，已去掉`));
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
  await assert.rejects(w.service.call('generate', { sourceIds: ['handout-1'], referenceSourceIds: [record.id], kind: 'quiz', count: 3 }), words);
  assert.match((await w.service.call('source.get', { id: record.id })).text, /^# 复习全书 · SA/);
});

test('a sample paper added after the book: only the paper is read and 考情 written; 讲解 stays byte for byte; changed 考情 replaces the old version', async t => {
  const w = await world(t, { library: { paper: true }, extra: [paperB] });
  const plain = await finish(w);
  const outlineBefore = (await w.outlines())[0];
  let mark = w.fake.calls.length;
  const withA = await finish(w, { papers: [PAPER] });
  assert.deepEqual(w.fake.calls.slice(mark).map(call => call.stage), ['paper', 'exam'], 'no map, no reduce, no notes: the outline is only marked again');
  assert.deepEqual(bodies(withA), bodies(plain), '讲解 byte for byte');
  const outline = (await w.outlines()).find(record => !record.archived);
  assert.deepEqual(leavesOf(outline.courseOutline.nodes).map(leaf => leaf.id), leavesOf(outlineBefore.courseOutline.nodes).map(leaf => leaf.id), 'the same knowledge points');
  assert.deepEqual([outline.courseOutline.supersedes, withA.courseNotes.supersedes], [outlineBefore.id, plain.id]);
  mark = w.fake.calls.length;
  const withB = await finish(w, { papers: [PAPER, PAPER_B] });
  const calls = w.fake.calls.slice(mark);
  assert.deepEqual(calls.map(call => call.stage), ['paper', 'paper', 'exam'], 'a call per paper, one 考情 call');
  assert.deepEqual(calls[2].data.leaves.map(leaf => leaf.title), ['Quality attribute scenarios'], 'only the leaf the new paper touches');
  assert.deepEqual(bodies(withB), bodies(plain));
  const exam = title => withB.courseNotes.leaves.find(leaf => leaf.title === title).exam, examA = title => withA.courseNotes.leaves.find(leaf => leaf.title === title).exam;
  assert.deepEqual(exam('Views and viewpoints'), examA('Views and viewpoints'), 'kept as it was');
  assert.equal(exam('Quality attribute scenarios').replaces, withA.id, 'the old 考情 version is superseded');
  assert.equal((await w.notes()).find(record => record.id === withA.id).archived, true);
});

test('questions added after the book change nothing: the record is the same and a rebuild asks no model and writes nothing', async t => {
  const w = await world(t);
  const record = await finish(w), calls = w.fake.calls.length;
  await w.service.store.update(state => { state.decks.push({ id: 'deck-late', title: 'Late deck', course: COURSE, cards: [{ id: 'late-1', kind: 'flashcard', topic: 'Layers', prompt: 'Why layers?',
    answer: 'Separation.', citations: [{ sourceId: 'handout-1', quote: 'Views and viewpoints fact 0' }] }] }); });
  assert.equal((await w.view()).book.notes.stale, false, 'questions are no input of the notes');
  assert.deepEqual((await w.notes()).map(item => item.id), [record.id]);
  const again = await w.build();
  await settleJob(w.service, again.jobId);
  assert.equal(w.fake.calls.length, calls, 'no model call');
  assert.deepEqual((await w.notes()).map(item => [item.id, !!item.archived]), [[record.id, false]], 'nothing written');
  assert.match(w.contract().stage.text, /复习全书已是最新/);
});

test('papers only on the outline itself: the knowledge points stay, only the paper is read', async t => {
  const w = await world(t, { library: { paper: true } });
  const first = await w.service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' });
  await settleJob(w.service, first.jobId);
  const [old] = await w.outlines(), mark = w.fake.calls.length;
  const marked = await w.service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', papers: [PAPER], papersOnly: true });
  await settleJob(w.service, marked.jobId);
  assert.deepEqual(w.fake.calls.slice(mark).map(call => call.stage), ['paper']);
  const fresh = (await w.outlines()).find(record => !record.archived);
  assert.deepEqual(leavesOf(fresh.courseOutline.nodes).map(leaf => leaf.id), leavesOf(old.courseOutline.nodes).map(leaf => leaf.id));
  assert.ok(leavesOf(fresh.courseOutline.nodes).find(leaf => leaf.title === 'Views and viewpoints').exam.evidence.length);
  assert.equal(fresh.courseOutline.supersedes, old.id);
  await refused(w.service.call('generation.courseOutline.build', { course: 'Nowhere', language: 'zh', papersOnly: true }), 'course-outline-no-outline');
});

test('an unreadable answer is asked once more; twice fails, nothing is saved, and a retry asks only what is missing; a stop keeps nothing', async t => {
  let broken = 2;
  const w = await world(t, { fake: bookModel({ junk: call => call.stage === 'notes' && call.data.part === 2 && broken-- > 0 }) });
  const started = await w.build();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'failed');
  assert.match(w.contract().error.message, /写讲解（第 2 批）时模型两次都没有给出可用的答案，没有保存复习全书/);
  assert.deepEqual([await w.notes(), await w.outlines()], [[], []], 'not even the outline it organised');
  const before = w.fake.stages();
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  const after = w.fake.stages().slice(before.length);
  assert.deepEqual([after[0], after.includes('map')], ['notes', false], 'the outline and batch 1 were kept');
  assert.equal(w.fake.of('notes').filter(call => call.data.part === 1).length, 1);
  const held = { at: 3, gate: gate() };
  t.after(() => held.gate.release());
  const s = await world(t, { fake: bookModel({ held }) });
  const run = await s.build();
  await until(() => s.fake.calls.length === 3, 'the first notes call');
  await s.service.call('job.control', { jobId: run.jobId, action: 'cancel' });
  held.gate.release();
  assert.equal((await settleJob(s.service, run.jobId)).status, 'cancelled');
  assert.deepEqual([await s.notes(), await s.outlines()], [[], []]);
  assert.match(s.contract().stage.text, /已取消，没有保存复习全书/);
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
  const done = await settleJob(h.service, first.jobId);
  assert.equal(done.status, 'complete');
  const [record] = await h.notes();
  const tasks = consoleCode.tasksOf(await h.service.call('snapshot')).filter(task => task.type === KIND || task.kind === KIND || task.contract?.kind === KIND);
  const summary = consoleCode.taskSummary(tasks.at(-1) ?? consoleCode.tasksOf(await h.service.call('snapshot'))[0]);
  assert.deepEqual([summary.state, summary.title], ['done', '生成复习全书 · SA']);
  assert.deepEqual(h.contract().result.refs[0].kind, 'course-book');
  assert.equal(h.contract().result.refs[0].id, record.id);
  const went = [];
  const app = { data: { focus: { course: COURSE }, sources: [] }, nav: { navigate: page => went.push(page) }, core: { act: async () => went.push('focus') } };
  const opener = consoleCode.resultOpener(tasks.at(-1) ?? consoleCode.tasksOf(await h.service.call('snapshot'))[0], app);
  assert.equal(opener.label, '打开复习全书');
  await opener.run();
  assert.deepEqual(went, ['outline']);
});
