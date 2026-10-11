/* The gate review of the 复习全书 quality workflow, item by item, without a model: the learner's papers win and are never replaced by a guess; a material is
   used as a paper silently only with a paper-like marker; an unreadable paper that was only guessed does not stop the course; distinct items never merge;
   the coverage check forgives spacing, emphasis, LaTeX and glosses but not a missing name. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePapers, detectedPapers } from '../lib/contexts/generation/outline/papers.js';
import { planOutline } from '../lib/contexts/generation/outline/plan.js';
import { itemId, nameForms, nameKey } from '../lib/course-book-inventory.js';
import { judge, mentions } from '../lib/contexts/generation/book/coverage.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { planBook } from '../lib/contexts/generation/book/plan.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const doc = (key, title, format = 'pdf') => ({ key, title, format, filename: title, sourceIds: [`${key}-s`], chapters: [], chars: 3000 });

test('1. a 3.4 outline\'s papers are the learner\'s; 期末 / Midterm alone never makes a material a silent paper', () => {
  const documents = [doc('doc:final', 'CS2040S AY22-23 Final.pdf'), doc('doc:review', '期末复习讲义.pdf'), doc('doc:mid', 'Midterm Review Lecture.pdf'), doc('doc:l1', 'Lecture 1.pdf')];
  const old = { papers: [{ key: 'doc:final', sourceIds: ['doc:final-s'] }] };
  assert.deepEqual(choosePapers(documents, { outline: old }), { keys: ['doc:final'], by: 'learner' }, 'no papersBy, but papers: the learner chose them');
  assert.deepEqual(detectedPapers(documents), [], 'neither the review handout nor the review lecture is used silently');
  assert.deepEqual(choosePapers(documents, { outline: { papers: [] } }), { keys: [], by: 'auto' });
  assert.deepEqual(detectedPapers([...documents, doc('doc:sp', 'SWE5001 Sample Paper.pdf'), doc('doc:zt', '2023 期末真题.pdf')]), ['doc:sp', 'doc:zt']);
  assert.deepEqual(choosePapers(documents, { outline: { papers: [{ key: 'doc:final' }], papersBy: 'auto' } }).by, 'auto');
});

test('2. a paper only guessed by its name that has no text is left out and noted; one the learner chose is refused', () => {
  const sources = [{ id: 'l1', title: 'Lecture 1', text: 'CIA triad fact 1: confidentiality.', createdAt: '2026-09-01T00:00:00.000Z', courses: ['C'],
    document: { materialId: 'document-l1', format: 'md' } },
  { id: 'paper', title: 'SWE5001 Sample Paper', text: '   ', createdAt: '2026-09-02T00:00:00.000Z', courses: ['C'], document: { materialId: 'document-paper', format: 'pdf' } }];
  const state = { sources, decks: [], documents: [], drafts: [], attempts: [], courses: [] };
  const plan = planOutline(state, { course: 'C', language: 'zh' });
  assert.deepEqual([plan.papers.length, plan.papersSkipped.map(paper => paper.title), plan.papersBy], [0, ['SWE5001 Sample Paper'], 'auto']);
  const key = plan.papersSkipped[0].key;
  assert.throws(() => planOutline(state, { course: 'C', language: 'zh', papers: [key] }), error => error.code === 'course-outline-no-readable-text');
});

test('3. distinct items never merge: symbols and same-script glosses are part of the name; a translation gloss is not', () => {
  const distinct = [['P(A|B)', 'P(A∩B)', 'P(A∪B)'], ['E[X]', 'E(X)'], ['O(1)', 'O(n)', 'O(n log n)'], ['Mean (average)', 'Mean (expected value)']];
  for (const names of distinct) for (const kind of ['formula', 'concept']) {
    assert.equal(new Set(names.map(name => nameKey(name, kind))).size, names.length, `${names.join(' / ')} as ${kind}`);
  }
  assert.equal(nameKey('威胁建模（threat modelling）', 'term'), nameKey('威胁建模', 'concept'), 'a translation gloss is not the name; term, definition and concept are one kind');
  assert.equal(nameKey('Threat modelling (威胁建模)', 'concept'), nameKey('threat-modelling', 'definition'));
  assert.equal(nameKey('CIA Triad', 'concept'), nameKey('cia-triad', 'concept'));
  assert.notEqual(itemId('Scaling', 'concept'), itemId('Scaling', 'step'), 'a step is not the concept of the same name');
});

test('4. the coverage check forgives spacing, hyphens, emphasis, LaTeX, zero-width marks and glosses; one-character and formula names are left to the review', () => {
  const said = (text, name, kind = 'concept') => mentions(text, { name, kind });
  assert.ok(said('我们先讲威胁建模（threat-modelling）是什么。', 'Threat modelling'));
  assert.ok(said('先做威胁建模：……', '威胁建模（threat modelling）'), 'the Chinese name alone');
  assert.ok(said('Threat modelling first.', '威胁建模（threat modelling）'), 'or the English one');
  assert.ok(said('the **CIA** triad keeps', 'CIA triad'));
  assert.ok(said('Thre​at-modelling', 'Threat-modelling'));
  assert.ok(said('So $E=mc^2$ holds.', 'E = mc^2', 'formula'));
  assert.ok(said('TCP 三次握手的过程', 'TCP（传输控制协议）三次握手'), 'a gloss in the middle of the name');
  assert.ok(!said('Only risk is discussed.', 'CIA triad'));
  assert.deepEqual(nameForms('TCP（传输控制协议）三次握手'), ['TCP(传输控制协议)三次握手', 'TCP 三次握手']);
  const unit = { checklist: [{ alias: 'c1', id: 'x1', name: '熵', kind: 'concept', priority: 'must' }, { alias: 'c2', id: 'x2', name: 'S = k ln W', kind: 'formula', priority: 'must' }] };
  const verdict = judge(unit, { text: '无序程度的量度：$S=k\\ln W$', claimed: ['x1', 'x2'] }, { issues: [] }, 0);
  assert.deepEqual([verdict.covered, verdict.pass], [['x1', 'x2'], true], 'claimed and not flagged: the review decides');
  assert.deepEqual(judge(unit, { text: '…', claimed: ['x1', 'x2'] }, { issues: [{ kind: 'missing', item: 'x1', note: '' }] }, 0).missing.map(item => item.id), ['x1']);
});

test('6. a 3.4 book follows an outline rebuilt from the inventory: mine, Q&A, AI blocks and a forked generated file go with their pages, nothing to 未归位', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const keyOf = id => groupSourcesByDocument(sources).find(item => item.sourceIds.includes(id)).key;
  const lecture = keyOf('document-l1-p1'), handout = keyOf('handout-1');
  const outlineOf = (nodes, at) => ({ ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] },
    fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments), nodes, other: { anchors: [] }, counts: {} }), createdAt: at });
  // 3.4: one point per material.
  const old = outlineOf([{ id: 'c1', title: 'Materials', children: [{ id: 'lec', title: '01. Introduction to Solution Architecture v2.1', anchors: [lecture] },
    { id: 'hand', title: 'Handout 1', anchors: [handout] }] }], '2026-10-01T00:00:00.000Z');
  state.sources.push(old);
  openCourseBook(state, {});
  const book = state.sources.find(source => source.provenance === 'course-book-doc').bookDoc;
  book.files['lec.mine.md'].text = 'My own note on the lecture.\n\n<!-- sh:ai id="a1" -->An AI block I kept.<!-- /sh:ai -->';
  book.files['lec.qa.md'] = { text: '> **Q** Why layers?\n\nBecause.', version: 1 };
  Object.assign(book.files['hand.gen.md'], { text: 'My rewrite of the handout point.', forked: true, version: 2 });
  // Rebuilt from the inventory: the lecture cut into page spans, the handout whole.
  const fresh = outlineOf([{ id: 'c2', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}@s0-1`] },
    { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture}@s2-3`] }, { id: 'views', title: 'Views and viewpoints', anchors: [`${lecture}@s4-5`] },
    { id: 'roles', title: 'The architect\'s role', anchors: [handout] }] }], '2026-10-12T00:00:00.000Z');
  state.sources.push(fresh);
  state.revision = 2;
  const opened = openCourseBook(state, {});
  const text = opened.nodes.flatMap(node => node.children).map(leaf => [leaf.gen, leaf.mine, leaf.qa].join('\n')).join('\n');
  assert.equal(opened.unplaced.text.trim(), '', 'nothing ends in 未归位');
  for (const kept of ['My own note on the lecture.', 'An AI block I kept.', 'Why layers?', 'My rewrite of the handout point.']) assert.ok(text.includes(kept), kept);
  const files = state.sources.find(source => source.provenance === 'course-book-doc').bookDoc.files;
  assert.equal(files['roles.gen.md'].forked, true, 'the forked generated file went with the handout\'s pages');
});

test('6. the first 更新全书 after the upgrade keeps a 3.4 outline; it is rebuilt from the inventory only when the learner asks', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [] };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  state.sources.push({ ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Materials', children: [{ id: 'lec', title: 'Lecture 1', anchors: [lecture] }] }], other: { anchors: [] }, counts: {} }), createdAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(planBook(state, { course: COURSE, language: 'zh' }).mode, 'keep', 'no silent rebuild');
  assert.equal(planBook(state, { course: COURSE, language: 'zh', rebuildOutline: true }).mode, 'full');
});
