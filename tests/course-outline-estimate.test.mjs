/* #462: reading a build BEFORE running it (`estimate: true`) and the warning a build gives about knowledge points whose own text came out short
   (`minBodyChars`). The estimate is answered from the same plan the build runs — no model call, no Job, no write — and the warning is reported in the job's
   result without changing one character of what is saved. A synthetic library and a fake model: no real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseOutlineSource } from '../lib/exam-point-list.js';
import { DEFAULT_MIN_BODY_CHARS, OUTLINE_BUILD_OPTIONS, planOutline } from '../lib/contexts/generation/outline/plan.js';
import { courseOutlineJobSchemas } from '../lib/contexts/generation/outline/contracts.js';
import { BODY_WARNINGS_KEPT, bodyWarningsOf } from '../lib/contexts/generation/outline/body.js';
import { OUTLINE_LIMITS } from '../lib/course-outline-book.js';

const KIND = 'course-outline-build';
/** The keys of an estimate: the same for a course with no readable text, one material or several, and with or without sample papers. */
const ESTIMATE_KEYS = ['basis', 'bodyChars', 'calls', 'chars', 'cut', 'items', 'materials', 'nodes', 'papers', 'points', 'ranges'];
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));
/** The leaves of a review book's manifest (a leaf names itself and keeps an empty `children`). */
const manifestLeaves = nodes => nodes.flatMap(node => (node.children?.length ? manifestLeaves(node.children) : [node]));
const countNodes = nodes => nodes.reduce((sum, node) => sum + 1 + countNodes(node.children || []), 0);

/** A material of the course as the library holds it (one document, one source). */
const material = (id, title, text) => ({ id, title, text, courses: [COURSE], createdAt: '2026-09-01T00:00:00.000Z',
  document: { materialId: `document-${id}`, format: 'md', filename: `${title}.md` } });
const prose = (tag, lines = 12) => Array.from({ length: lines }, (_, i) => `${tag} point ${i}: the architect records this decision and its reasons in the decision log.`).join(' ');

async function world(t, { sources, fake = outlineModel({ inventory: 'none' }), noModel = false } = {}) {
  const root = await privateRoot(t, 'course-outline-estimate-');
  const complete = noModel ? undefined : fake.complete;
  const service = new StudyService(root, { complete, ...switchOptions('runtime', { complete, paths: [] }) });
  t.after(() => service.dispose());
  const library = sources ? { sources, decks: [] } : outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(library.sources)); state.decks.push(...structuredClone(library.decks)); });
  const build = extra => service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...extra });
  const jobs = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND);
  const outlines = async () => (await service.store.read()).sources.filter(isCourseOutlineSource);
  const contract = () => jobs().at(-1)?.contract;
  const finish = async extra => {
    const started = await build(extra);
    const job = await settleJob(service, started.jobId);
    assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null));
    return (await outlines()).find(record => !record.archived);
  };
  return { service, fake, build, jobs, outlines, contract, finish };
}

test('an estimate answers the same shape for a course with no readable text, one material and several, spending no model call, no task and no write', async t => {
  const cases = [
    { name: 'no readable text', sources: [material('empty-1', 'Empty handout', '')] },
    { name: 'one material', sources: [material('one-1', 'One lecture', prose('One lecture', 60))] },
    { name: 'several materials', sources: ['a', 'b', 'c', 'd', 'e', 'f'].map(key => material(`multi-${key}`, `Lecture ${key}`, prose(`Lecture ${key}`, 60))) },
  ];
  const answers = [];
  for (const item of cases) {
    const w = await world(t, { sources: item.sources });
    const answer = await w.build({ estimate: true });
    assert.deepEqual([w.fake.calls.length, w.jobs().length, (await w.outlines()).length], [0, 0, 0], `${item.name}: nothing spent, nothing started, nothing written`);
    assert.equal(answer.status, 'estimate');
    assert.equal(answer.jobId, undefined, 'an estimate is not a task');
    assert.equal(answer.course, COURSE);
    assert.equal(answer.estimate.materials, item.sources.length, `${item.name}: every material counted`);
    assert.deepEqual(Object.keys(answer.estimate).sort(), ESTIMATE_KEYS, `${item.name}: one shape for every course`);
    assert.ok(Number.isInteger(answer.steps) && answer.steps >= 1);
    assert.match(answer.scopeHash, /^[0-9a-f]{64}$/);
    const { points, nodes, bodyChars, chars, ranges, calls, items, basis } = answer.estimate;
    for (const [name, value] of Object.entries({ points, nodes, bodyChars, chars, ranges, calls })) assert.ok(Number.isInteger(value) && value >= 0, `${item.name}: ${name} is a whole number`);
    assert.ok(points >= 1 && nodes > points && bodyChars > 0, `${item.name}: a build makes at least one point, its chapter and its text`);
    assert.ok(items === null || Number.isInteger(items));
    assert.ok(['inventory', 'descriptors', 'current'].includes(basis));
    assert.deepEqual(answer.estimate.cut, {}, 'nothing asked: the default cut');
    answers.push(answer.estimate);
  }
  assert.equal(answers[0].chars, 0, 'a material with no readable text has nothing to read');
  assert.equal(answers[0].basis, 'descriptors', 'nothing to take stock of: the quick outline estimates from the materials themselves');
  assert.equal(answers[1].materials, 1);
  assert.ok(answers[2].points > answers[1].points, `more material, more points (${answers[1].points} -> ${answers[2].points})`);
  assert.ok(answers[2].bodyChars > answers[1].bodyChars);
});

test('the estimate follows the cut (coarse < medium < fine), holds maxPoints, and the sample papers never change it', async t => {
  const w = await world(t, {});
  const medium = await w.build({ estimate: true });
  const coarse = await w.build({ estimate: true, granularity: 'coarse' });
  const fine = await w.build({ estimate: true, granularity: 'fine' });
  assert.deepEqual(medium.estimate.cut, {});
  assert.deepEqual(coarse.estimate.cut, { granularity: 'coarse' }, 'the cut the estimate was asked about is echoed');
  assert.deepEqual(fine.estimate.cut, { granularity: 'fine' });
  assert.ok(coarse.estimate.points < medium.estimate.points && medium.estimate.points < fine.estimate.points,
    `coarser cut, fewer points (${coarse.estimate.points} < ${medium.estimate.points} < ${fine.estimate.points})`);
  assert.ok(coarse.estimate.nodes < fine.estimate.nodes && coarse.estimate.bodyChars < fine.estimate.bodyChars);
  const capped = await w.build({ estimate: true, maxPoints: 5 });
  assert.deepEqual(capped.estimate.cut, { maxPoints: 5 });
  assert.ok(capped.estimate.points <= 5, `maxPoints holds in the estimate too (${capped.estimate.points})`);
  assert.ok(capped.estimate.nodes > capped.estimate.points);
  // The sample papers are read on their own (they are what the exam asks, not what the course teaches): the cut of the points does not move with them.
  const papers = [[], ['doc:document-handout-1'], ['doc:document-handout-1', 'doc:document-handout-2', 'doc:document-handout-3']];
  for (const selected of papers) {
    const answer = await w.build({ estimate: true, papers: selected });
    assert.deepEqual(Object.keys(answer.estimate).sort(), ESTIMATE_KEYS);
    assert.equal(answer.estimate.papers, selected.length, `${selected.length} sample paper(s) counted`);
    assert.equal(answer.estimate.basis, medium.estimate.basis, 'the papers do not change what the points rest on');
  }
  assert.deepEqual([w.fake.calls.length, w.jobs().length, (await w.outlines()).length], [0, 0, 0], 'not one paper, point or task was made');
  // The sample papers are the only material of the course: there is nothing left to take stock of, and the estimate still answers the same shape.
  const onlyPapers = await world(t, { sources: [material('paper-only', 'Past paper 2024', 'Q1 Explain a view. (10 marks)')] });
  const bare = await onlyPapers.build({ estimate: true });
  assert.deepEqual(Object.keys(bare.estimate).sort(), ESTIMATE_KEYS);
  assert.deepEqual([bare.estimate.materials, bare.estimate.papers, bare.estimate.basis], [1, 1, 'descriptors'], 'a paper is read as a paper, so nothing is inventoried');
});

test('a knowledge point whose text came out shorter than minBodyChars is reported in the build result; minBodyChars: 0 turns the report off and changes nothing written', async t => {
  const w = await world(t, {});
  const first = await w.finish();
  const result = w.contract().result;
  const leaves = leavesOf(first.courseOutline.nodes);
  assert.equal(DEFAULT_MIN_BODY_CHARS, 200);
  assert.deepEqual(Object.keys(result).sort(), ['bodyWarnings', 'completeness', 'refs'], 'the warning rides with the result beside its refs');
  assert.equal(result.bodyWarnings.minBodyChars, 200, 'the default threshold');
  assert.equal(result.bodyWarnings.leaves, leaves.length);
  assert.equal(result.bodyWarnings.count, leaves.filter(leaf => (leaf.intro || '').length < 200).length, 'every short point counted');
  assert.ok(result.bodyWarnings.count > 0, 'the fake model writes one line an introduction: the warning has something to say');
  assert.ok(result.bodyWarnings.list.length <= BODY_WARNINGS_KEPT);
  for (const warning of result.bodyWarnings.list) {
    const leaf = leaves.find(node => node.id === warning.nodeId);
    assert.ok(leaf, `the warning names a point of the outline: ${warning.nodeId}`);
    assert.equal(warning.title, leaf.title);
    assert.equal(warning.bodyChars, (leaf.intro || '').length);
    assert.ok(warning.bodyChars < 200);
  }
  assert.deepEqual(result.bodyWarnings.list.map(item => item.title), leaves.filter(leaf => (leaf.intro || '').length < 200).map(leaf => leaf.title).slice(0, BODY_WARNINGS_KEPT), 'in reading order');
  const written = { text: first.text, nodes: structuredClone(first.courseOutline.nodes) };

  // 0 turns the report off; a smaller threshold reports fewer points. What is saved does not change either way.
  const off = await w.finish({ minBodyChars: 0 });
  assert.equal(w.contract().result.bodyWarnings.count, 0);
  assert.deepEqual(w.contract().result.bodyWarnings.list, []);
  assert.equal(w.contract().result.bodyWarnings.minBodyChars, 0);
  assert.equal(off.text, written.text, 'the same outline is written');
  assert.deepEqual(off.courseOutline.nodes, written.nodes);
  await w.finish({ minBodyChars: 5 });
  const report = w.contract().result.bodyWarnings;
  assert.equal(report.minBodyChars, 5);
  assert.ok(report.count <= result.bodyWarnings.count, 'a lower threshold reports no more point');
  assert.ok(report.list.every(item => item.bodyChars < 5));
  assert.ok(report.list.every(item => result.bodyWarnings.list.some(other => other.nodeId === item.nodeId)), 'what it reports is a subset of the default report');
  await w.finish({ minBodyChars: 200 });
  assert.equal(w.contract().result.bodyWarnings.count, result.bodyWarnings.count, 'saying 200 is the default');
});

test('the warning is a report only: the helper lists the first BODY_WARNINGS_KEPT short points and a count of them all', () => {
  const nodes = [{ id: 'c1', title: 'One', intro: 'x'.repeat(300), children: [
    { id: 'n1', title: 'Short', intro: 'abc' }, { id: 'n2', title: 'Long', intro: 'x'.repeat(250) }, { id: 'n3', title: 'Empty' }] },
    { id: 'c2', title: 'Two', children: [{ id: 'n4', title: 'Longer', intro: 'x'.repeat(200) }] }];
  assert.deepEqual(bodyWarningsOf(nodes, 200), { minBodyChars: 200, leaves: 4, count: 2,
    list: [{ nodeId: 'n1', title: 'Short', bodyChars: 3 }, { nodeId: 'n3', title: 'Empty', bodyChars: 0 }] }, 'a point with no intro is 0 characters');
  assert.deepEqual(bodyWarningsOf(nodes, 0), { minBodyChars: 0, leaves: 4, count: 0, list: [] }, '0: nothing reported');
  assert.equal(bodyWarningsOf(nodes, 1).count, 1, 'a whole number means something');
  const many = [{ id: 'c', title: 'Many', children: Array.from({ length: BODY_WARNINGS_KEPT + 7 }, (_, i) => ({ id: `s${i}`, title: `Short ${i}`, intro: '' })) }];
  const capped = bodyWarningsOf(many, 200);
  assert.deepEqual([capped.count, capped.list.length], [BODY_WARNINGS_KEPT + 7, BODY_WARNINGS_KEPT], 'the count is complete, the list is kept small');
});

test('minBodyChars is checked at stage 0 naming the field and costs nothing; the service refuses it the same way', async t => {
  const state = { ...outlineLibrary(), documents: [], drafts: [], attempts: [], courses: [] };
  for (const value of [-1, 2.5, '200', null, OUTLINE_LIMITS.introChars + 1])
    assert.throws(() => planOutline(state, { course: COURSE, minBodyChars: value }),
      error => error.code === 'course-outline-shape-invalid' && /minBodyChars/.test(error.message), `minBodyChars ${JSON.stringify(value)}`);
  assert.equal(planOutline(state, { course: COURSE }).minBodyChars, DEFAULT_MIN_BODY_CHARS);
  assert.equal(planOutline(state, { course: COURSE, minBodyChars: 0 }).minBodyChars, 0);
  assert.equal(planOutline(state, { course: COURSE, minBodyChars: OUTLINE_LIMITS.introChars }).minBodyChars, OUTLINE_LIMITS.introChars);
  const w = await world(t, {});
  const refused = (extra, pattern) => assert.rejects(w.build(extra), error => error.code === 'course-outline-shape-invalid' && pattern.test(error.message));
  await refused({ minBodyChars: -1 }, /minBodyChars 要是 0 到 360 之间的整数/);
  await refused({ minBodyChars: OUTLINE_LIMITS.introChars + 1 }, /minBodyChars/);
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0], 'a refused request spends nothing');
});

test('the contract declares exactly the options the build reads, so a parameter it accepts is one study_capabilities shows', async t => {
  assert.deepEqual(Object.keys(courseOutlineJobSchemas['courseOutline.build'].input.properties), [...OUTLINE_BUILD_OPTIONS],
    'the declared input and the options of the build are one list (outline/plan.js)');
  assert.ok(OUTLINE_BUILD_OPTIONS.includes('estimate') && OUTLINE_BUILD_OPTIONS.includes('minBodyChars'));
  // Each option has an effect the plan shows: a declared parameter that nothing reads would be a lie, and one read but undeclared would be invisible.
  const state = { ...outlineLibrary(), documents: [], drafts: [], attempts: [], courses: [] };
  const plan = extra => planOutline(state, { course: COURSE, ...extra });
  const base = plan({});
  assert.deepEqual(plan({ course: COURSE }).course, base.course);
  assert.equal(plan({ language: 'en' }).language, 'en');
  assert.equal(plan({ language: 'en' }).title, base.title.replace('总纲', 'Course outline'));
  assert.throws(() => plan({ supersedes: 'not-an-outline' }), error => error.code === 'course-outline-supersedes-invalid', 'supersedes is read (and checked)');
  assert.equal(plan({ papers: ['doc:document-handout-1'] }).papers.length, 1, 'papers is read');
  assert.equal(plan({ papers: ['doc:document-handout-1'], papersBy: 'learner' }).papersBy, 'learner', 'papersBy is read');
  assert.equal(plan({ inventory: false }).inventory, null, 'inventory is read');
  assert.equal(plan({ concurrency: 3 }).concurrency, 3, 'concurrency is read');
  assert.deepEqual(plan({ granularity: 'coarse' }).shape, { granularity: 'coarse' }, 'granularity is read');
  assert.deepEqual(plan({ maxPoints: 40 }).shape, { maxPoints: 40 }, 'maxPoints is read');
  assert.equal(plan({ minBodyChars: 50 }).minBodyChars, 50, 'minBodyChars is read');
  // The three the start reads before the plan: an estimate (also for a papers-only build) and the confirmation of a rebuild that moves the learner's text.
  const w = await world(t, {});
  const estimate = await w.build({ estimate: true });
  assert.equal(estimate.status, 'estimate', 'estimate is read');
  assert.deepEqual([w.jobs().length, w.fake.calls.length], [0, 0]);
  const outline = await w.finish();
  const papersOnly = await w.build({ papersOnly: true, estimate: true });
  assert.equal(papersOnly.status, 'estimate', 'papersOnly is read: its estimate is the outline it starts from');
  assert.equal(papersOnly.estimate.basis, 'current');
  assert.deepEqual([papersOnly.estimate.points, papersOnly.estimate.nodes], [leavesOf(outline.courseOutline.nodes).length, countNodes(outline.courseOutline.nodes)], 'a papers-only build keeps every point and node as it is');
  assert.deepEqual([w.fake.calls.at(-1)?.stage, w.jobs().length], ['reduce', 1], 'only the build asked the model');
  // The learner's own text in the review book: the rebuild is refused until confirm: true, which the page sends on the click.
  await w.service.call('course.book.open', { course: COURSE });
  await w.service.store.update(state => {
    const book = state.sources.find(source => source.provenance === 'course-book-doc');
    const point = manifestLeaves(book.bookDoc.manifest.nodes).find(node => node.leaf);
    book.bookDoc.files[`${point.id}.mine.md`] = { text: 'My own notes on this point.', version: 1 };
  });
  const priced = await w.build({ estimate: true });
  assert.equal(priced.status, 'estimate', 'an estimate changes nothing, so it needs no confirmation even then');
  await assert.rejects(w.build(), error => error.code === 'course-outline-book-confirm', 'confirm is read: without it, the rebuild costs nothing and is refused');
  const confirmed = await w.build({ confirm: true });
  assert.equal(confirmed.status, 'running', 'confirm is read: the rebuild starts');
  assert.equal((await settleJob(w.service, confirmed.jobId)).status, 'complete');
  assert.deepEqual([w.jobs().length, w.fake.calls.at(-1).stage], [2, 'reduce']);
});

test('an estimate needs no model: it is answered before any call, while a build says the model is unavailable', async t => {
  const fake = outlineModel({ inventory: 'none' });
  const w = await world(t, { fake, noModel: true });
  const answer = await w.build({ estimate: true });
  assert.equal(answer.status, 'estimate', 'no model configured: the estimate is still answered');
  assert.equal(answer.estimate.materials, 134);
  const started = await w.build();
  assert.deepEqual([started.available, started.reason], [false, 'model_unavailable'], 'a build without a model is refused, not priced');
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0]);
});
