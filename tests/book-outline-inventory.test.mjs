/* 总纲 from the 清点 (Phase 1.5): the inventory's items are grouped into KNOWLEDGE POINTS (map in parallel, one order call), not one leaf per material; every
   item is in exactly one leaf; each leaf anchors the pages it teaches (whole materials, whole chapters, or spans of pages), so questions and practice follow;
   sample papers are recognised by name and used by default; a rerun reuses everything. A fake model: no real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { ALL_CHAPTERS, COURSE as SA, LECTURES, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseInventorySource, isCourseOutlineSource } from '../lib/exam-point-list.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { documentIndex, leafSegments } from '../lib/course-book-inputs.js';
import { requestData } from './helpers/request-data.mjs';

const COURSE = 'ArchSS';
const TOPICS = [['CIA triad', 'Risk scenarios'], ['Availability in series', 'Availability in parallel'], ['Security patterns', 'Threat trees']];
const facts = (topic, from = 0, count = 3) => Array.from({ length: count }, (_, i) => `${topic} fact ${from + i}: what the course says about ${topic.toLowerCase()} number ${from + i}.`).join(' ');
const stamp = at => new Date(Date.UTC(2026, 8, 1) + at * 3600e3).toISOString();

/** A course of three documents: a paged lecture of `topics` (two pages a topic, no chapters), a handout on its first two topics, and a sample paper. */
function library(topics = TOPICS.flat()) {
  const pages = topics.flatMap((topic, at) => [0, 1].map(half => {
    const page = at * 2 + half + 1;
    return { id: `lec-p${page}`, title: `Solution Architecture · p. ${page}`, text: facts(topic, half * 3), createdAt: stamp(0), courses: [COURSE],
      document: { materialId: 'document-lec', page, totalPages: topics.length * 2, format: 'pdf', origin: 'converted', filename: '5001-A Solution Architecture.pdf' } };
  }));
  const handout = { id: 'handout', title: 'S-ARCHSS Case Study Exercises', text: `${facts(topics[0], 10, 2)}\n${facts(topics[1], 10, 2)}`, createdAt: stamp(1), courses: [COURSE],
    document: { materialId: 'document-handout', format: 'md', filename: 'S-ARCHSS Case Study Exercises.md' } };
  const paper = { id: 'paper', title: 'SWE5001 Sample Paper', text: `Q1 Explain the ${topics[0]} with an example. (10 marks)\nQ2 Compute ${topics[2].toLowerCase()} for two servers. (10 marks)`,
    createdAt: stamp(2), courses: [COURSE], document: { materialId: 'document-paper', format: 'md', filename: 'SWE5001 Sample Paper.md' } };
  // A question on each page of the lecture: practice follows the pages a leaf teaches.
  const cards = pages.map((source, at) => ({ id: `q${at + 1}`, kind: 'flashcard', topic: 'x', prompt: `Question on page ${at + 1}?`, answer: 'A.',
    citations: [{ sourceId: source.id, quote: source.text.slice(0, 50) }] }));
  return { sources: [...pages, handout, paper], decks: [{ id: 'deck-1', title: 'Lecture deck', course: COURSE, cards }] };
}

/** The outline fake, with a paper reader that marks the leaf whose title the question names. */
function model(options) {
  const base = outlineModel(options);
  const complete = async (system, prompt, request) => {
    const data = requestData(prompt);
    // Order (and the fallback's reduce): one chapter, points of the same title (found in two materials) merged into one leaf.
    if (data.stage === 'order' || data.stage === 'reduce') {
      base.calls.push({ stage: data.stage, data });
      const byTitle = new Map();
      for (const point of data.points) byTitle.set(point.title, [...(byTitle.get(point.title) || []), point.id]);
      return JSON.stringify({ basis: ['logic'], chapters: [{ title: 'Security and availability', intro: 'The course.', points: [...byTitle.values()] }] });
    }
    if (data.stage !== 'paper') return base.complete(system, prompt, request);
    base.calls.push({ stage: 'paper', data });
    const questions = data.paper[0].text.split('\n').map(line => ({ label: line.slice(0, 2), quote: line.slice(3, 40),
      points: data.points.filter(point => line.toLowerCase().includes(point.title.toLowerCase())).map(point => point.id) }));
    return JSON.stringify({ questions });
  };
  return { ...base, complete };
}

async function world(t, { fake = model(), topics } = {}) {
  const root = await privateRoot(t, 'outline-inventory-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = library(topics);
  await service.store.update(state => { state.sources.push(...sources); state.decks.push(...decks); state.focus = { mode: 'class', course: COURSE }; });
  const build = async (args = {}) => {
    const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...args })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(job.error ?? null));
    return (await service.store.read()).sources.find(source => isCourseOutlineSource(source) && !source.archived);
  };
  return { service, fake, build, stages: () => fake.calls.map(call => call.stage) };
}
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));

test('three documents become knowledge points, not documents: every item in exactly one leaf, the pages it teaches as anchors, the paper found and used', async t => {
  const w = await world(t);
  const record = await w.build(), outline = record.courseOutline, leaves = leavesOf(outline.nodes);
  assert.equal(outline.from, 'inventory');
  assert.deepEqual(leaves.map(leaf => leaf.title), TOPICS.flat(), 'one leaf per topic, in the order taught; no file name');
  const inventory = (await w.service.store.read()).sources.find(isCourseInventorySource).courseInventory;
  const held = leaves.flatMap(leaf => leaf.items);
  assert.equal(held.length, new Set(held).size, 'no item in two leaves');
  assert.deepEqual(new Set(held), new Set(inventory.items.map(item => item.id)), 'every item in a leaf');
  // The lecture has no chapters: each leaf holds the two pages it teaches; the handout teaches two topics in one source, so it is cut by range or held whole.
  assert.deepEqual(leaves.map(leaf => leaf.anchors.filter(anchor => anchor.startsWith('pdf:document-lec') || anchor.includes('document-lec'))),
    TOPICS.flat().map((_, at) => [`${leaves[0].anchors.find(anchor => anchor.includes('document-lec')).split('@')[0]}@s${at * 2}-${at * 2 + 1}`]));
  // The sample paper is recognised by its name and used without asking: the leaves its questions name are tested 1/1.
  assert.deepEqual([outline.papers.map(paper => paper.title), outline.papersBy], [['SWE5001 Sample Paper'], 'auto']);
  assert.deepEqual(leaves.filter(leaf => leaf.exam?.evidence?.length).map(leaf => leaf.title), ['CIA triad', 'Availability in series']);
  const view = await w.service.call('course.outline', { course: COURSE }), shown = leavesOf(view.book.nodes);
  assert.deepEqual(shown.filter(leaf => leaf.tier === 'must').map(leaf => [leaf.title, leaf.papers]), [['CIA triad', 1], ['Availability in series', 1]]);
  // Questions follow the pages: the two questions of pages 3-4 are under 风险场景 (Risk scenarios) only, and practice takes them.
  assert.deepEqual(shown.map(leaf => leaf.total), [2, 2, 2, 2, 2, 2]);
  const risk = shown[1], picked = await w.service.call('course.outline', { course: COURSE, pick: { keys: [risk.key] } });
  assert.deepEqual(picked.practice.scope.map(ref => ref.cardId).sort(), ['q3', 'q4']);
  const opened = await w.service.call('course.outline', { course: COURSE, expand: [risk.key] });
  assert.ok(opened.open[risk.key], 'the leaf opens');
  // What the book explains a leaf from: the pages it teaches.
  const state = await w.service.store.read(), byId = new Map(state.sources.map(source => [source.id, source]));
  const segments = leafSegments(byId, documentIndex(buildOutlineIndex(state, { course: COURSE }).allDocuments), leaves[1].anchors);
  assert.deepEqual(segments.filter(segment => segment.sourceId.startsWith('lec-')).map(segment => segment.sourceId), ['lec-p3', 'lec-p4']);
  assert.ok(view.book.other === null || view.book.other.total === 0, 'nothing of the lecture is left in Other');
});

test('the leaf count follows the content: twice the topics, twice the knowledge points', async t => {
  const small = await world(t, { topics: TOPICS.flat().slice(0, 3) });
  const big = await world(t, { topics: [...TOPICS.flat(), 'Caching', 'Load balancing', 'Message queues', 'Disaster recovery', 'Cost models', 'Observability'] });
  const few = leavesOf((await small.build()).courseOutline.nodes).length, many = leavesOf((await big.build()).courseOutline.nodes).length;
  assert.deepEqual([few, many], [3, 12]);
});

test('a rerun reuses everything: no inventory, cluster or order call; only the paper is read again; the learner removing the paper is remembered', async t => {
  const w = await world(t);
  const first = await w.build(), mark = w.fake.calls.length;
  const again = await w.build();
  assert.deepEqual(w.stages().slice(mark), ['paper'], 'the inventory and its grouping are kept');
  assert.deepEqual(leavesOf(again.courseOutline.nodes).map(leaf => leaf.id), leavesOf(first.courseOutline.nodes).map(leaf => leaf.id), 'the same knowledge points');
  const none = await w.build({ papers: [] });
  assert.deepEqual([none.courseOutline.papers, none.courseOutline.papersBy], [undefined, 'learner']);
  const later = await w.build();
  assert.deepEqual([later.courseOutline.papers, later.courseOutline.papersBy], [undefined, 'learner'], 'no paper until the learner picks one again');
});

test('an inventory that finds nothing falls back to the quick outline from the descriptors', async t => {
  const w = await world(t, { fake: model({ inventory: 'none' }) });
  const record = await w.build();
  assert.equal(record.courseOutline.from, 'descriptors');
  assert.deepEqual(w.stages().filter(stage => stage !== 'inventory' && stage !== 'paper'), ['map', 'reduce']);
});

test('a cluster call that fails leaves its items to Other / unplaced, never away', async t => {
  const w = await world(t, { fake: model({ fail: call => call.stage === 'cluster' }) });
  const leaves = leavesOf((await w.build()).courseOutline.nodes);
  const inventory = (await w.service.store.read()).sources.find(isCourseInventorySource).courseInventory;
  assert.deepEqual(leaves.map(leaf => leaf.title), ['未归位的概念']);
  assert.equal(leaves[0].items.length, inventory.items.length);
});

test('the 134-material course: knowledge points from the inventory in a handful of calls per phase, every row held once, only the paper left in Other', async t => {
  const fake = outlineModel();
  const root = await privateRoot(t, 'outline-inventory-134-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); });
  const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: SA, language: 'zh' })).jobId);
  assert.equal(job.status, 'complete');
  const count = stage => fake.calls.filter(call => call.stage === stage).length;
  const phases = Object.fromEntries(['inventory', 'cluster', 'order', 'paper', 'map', 'reduce'].map(stage => [stage, count(stage)]));
  t.diagnostic(`134 materials, calls per phase: ${JSON.stringify(phases)}`);
  assert.deepEqual(phases, { inventory: 7, cluster: 2, order: 1, paper: 1, map: 0, reduce: 0 });
  const state = await service.store.read(), outline = state.sources.find(isCourseOutlineSource).courseOutline, leaves = leavesOf(outline.nodes);
  assert.deepEqual(leaves.map(leaf => leaf.title), ['Course overview', ...ALL_CHAPTERS], 'the knowledge points, in the syllabus order');
  assert.deepEqual(outline.nodes.slice(1).map(node => node.title), LECTURES.map(lecture => lecture.title));
  const anchors = [...leaves.flatMap(leaf => leaf.anchors), ...outline.other.anchors];
  assert.equal(new Set(anchors).size, anchors.length, 'every row once');
  assert.deepEqual(outline.other.anchors, ['doc:document-paper-2025'], 'only the paper, which teaches nothing, is in Other');
  const items = state.sources.find(isCourseInventorySource).courseInventory.items.length;
  assert.equal(leaves.flatMap(leaf => leaf.items).length, items);
  assert.equal(leaves.find(leaf => leaf.title === 'Views and viewpoints').exam.evidence.length, 1, 'the paper, recognised by its name, marks what it tests');
});
