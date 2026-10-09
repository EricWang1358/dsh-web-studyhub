/* 为啥有题目没有覆盖率 (2026-10-08): a 资料 row said 掌握 1% · 43 题 and another 未学 · 69 题 and neither had a coverage figure. The row's questions are the document's whole set
   (lib/material-mastery.js documentCardSet: every version of it, the materials made from the same recording, the recordings a merged material consists of), but the coverage of a
   document only looked at questions that cite ITS OWN source records, so a material whose questions sit on an older version or on another import of the recording had no number.
   The coverage now reads the same set and puts the questions that cite other records where their quotes stand in this material's text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { materialMasteryIndex } from '../lib/material-mastery.js';
import { materialCoverageIndex, coverageForDocument } from '../lib/coverage-state.js';
import { coverageFromDigest } from '../lib/coverage.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const statement = (n, i) => `Statement ${n}.${i}: the platform team owns the interface contract and every consumer must negotiate changes through it.`;
const body = n => Array.from({ length: 6 }, (_, i) => statement(n, i)).join(' ');
const outline = (topics = [1, 2, 3]) => topics.map(n => `# Topic ${n}\n\n${body(n)}\n`).join('\n');
const quoteCard = (id, sourceId, n) => ({ id, kind: 'flashcard', topic: 't', prompt: `Q ${id}`, answer: 'A', citations: [{ sourceId, quote: statement(n, 2) }] });
const mdSource = (id, text) => ({ id, title: `Lecture ${id}`, text, document: { materialId: 'document-A', format: 'md', filename: 'lecture.md' } });
const base = extra => ({ sources: [], documents: [], decks: [], drafts: [], attempts: [], courses: [], revision: 1, ...extra });
const rowMastery = (state, key) => materialMasteryIndex(state, { now: NOW })[key]?.document;
const rowCoverage = (state, key) => coverageFromDigest(materialCoverageIndex(state)[key]);

test('a material whose questions cite its own source records has a coverage figure (the case that always worked)', () => {
  const state = base({ sources: [mdSource('a1', outline())], decks: [{ id: 'k', title: 'K', cards: [quoteCard('c1', 'a1', 1), quoteCard('c2', 'a1', 2)] }] });
  assert.equal(rowMastery(state, 'doc:document-A').total, 2);
  const coverage = rowCoverage(state, 'doc:document-A');
  assert.deepEqual([coverage.covered, coverage.leaves], [2, 3]);
});

test('a re-imported document: the questions written from its older version are the document\'s questions, so the row has their coverage over the current text', () => {
  const state = base({
    sources: [mdSource('old1', outline()), mdSource('new1', outline())],
    documents: [{ id: 'document-A', title: 'Lecture', format: 'md', currentRevision: 'r2', versions: [{ revision: 'r1', sourceIds: ['old1'] }, { revision: 'r2', sourceIds: ['new1'] }] }],
    decks: [{ id: 'k', title: 'K', cards: [quoteCard('c1', 'old1', 1), quoteCard('c2', 'old1', 3)] }] });
  assert.equal(rowMastery(state, 'doc:document-A').total, 2, 'the row counts the older version\'s questions');
  const coverage = rowCoverage(state, 'doc:document-A');
  assert.ok(coverage, 'and so the row has a coverage figure');
  assert.deepEqual([coverage.covered, coverage.leaves], [2, 3], 'the quotes are found in the current text: sections 1 and 3');
});

test('a question whose quote is no longer in the current text counts for the document but covers nothing: 0 of the sections, not no figure', () => {
  const state = base({
    sources: [mdSource('old1', outline()), mdSource('new1', outline([4, 5]))],
    documents: [{ id: 'document-A', title: 'Lecture', format: 'md', currentRevision: 'r2', versions: [{ revision: 'r1', sourceIds: ['old1'] }, { revision: 'r2', sourceIds: ['new1'] }] }],
    decks: [{ id: 'k', title: 'K', cards: [quoteCard('c1', 'old1', 1)] }] });
  assert.equal(rowMastery(state, 'doc:document-A').total, 1);
  const coverage = rowCoverage(state, 'doc:document-A');
  assert.deepEqual([coverage.covered, coverage.leaves], [0, 2]);
});

const audio = (id, text, extra = {}) => ({ id, title: id, text, audio: extra });
const HASH = '1'.repeat(64);

test('the same recording imported twice: each import shows the coverage of the questions written from the other one', () => {
  const state = base({
    sources: [audio('audio-1111111111111111-k1', `speech ${body(1)}`, { hash: HASH }), audio('audio-1111111111111111-k2', `speech ${body(1)}`, { hash: HASH })],
    decks: [{ id: 'k', title: 'K', cards: [quoteCard('c1', 'audio-1111111111111111-k1', 1)] }] });
  assert.equal(rowMastery(state, 'source:audio-1111111111111111-k2').total, 1);
  assert.equal(rowCoverage(state, 'source:audio-1111111111111111-k2').covered, 1);
  assert.equal(rowCoverage(state, 'source:audio-1111111111111111-k1').covered, 1, 'the import the questions cite keeps its own figure');
});

test('a merged recording of 2 volumes whose questions cite the single recordings it consists of: every volume is covered where its quotes stand', () => {
  const H2 = '2'.repeat(64);
  const volumes = [1, 2].map(volume => audio(`audio-batch-b1${volume > 1 ? '-p2' : ''}`, `merged volume ${volume} ${body(volume)}`,
    { batch: { id: 'b1', title: 'rec + 1', volume, volumes: 2, sourceIds: ['audio-batch-b1', 'audio-batch-b1-p2'], members: [{ order: 1, filename: 'a.mp3', hash: HASH }, { order: 2, filename: 'b.mp3', hash: H2 }] } }));
  const state = base({
    sources: [audio('audio-1111111111111111-k1', `merged volume 1 ${body(1)}`, { hash: HASH }), audio('audio-2222222222222222-k1', `merged volume 2 ${body(2)}`, { hash: H2 }), ...volumes],
    decks: [{ id: 'k', title: 'K', cards: [quoteCard('c1', 'audio-1111111111111111-k1', 1), quoteCard('c2', 'audio-2222222222222222-k1', 2)] }] });
  assert.equal(rowMastery(state, 'audio:b1').total, 2);
  const coverage = rowCoverage(state, 'audio:b1');
  assert.deepEqual([coverage.covered, coverage.leaves], [2, 2], 'a multi-part material is counted over all its parts');
  const found = coverageForDocument(state, { key: 'audio:b1' });
  assert.equal(found.coverage.covered, 2, 'coverage.get (the reader, the top-up) says the same');
});

test('every material the 资料 page gives a question count has a coverage figure (one set of questions for both)', () => {
  const state = base({
    sources: [mdSource('old1', outline()), mdSource('new1', outline()), audio('lonely', `speech ${body(7)}`, {})],
    documents: [{ id: 'document-A', title: 'Lecture', format: 'md', currentRevision: 'r2', versions: [{ revision: 'r1', sourceIds: ['old1'] }, { revision: 'r2', sourceIds: ['new1'] }] }],
    decks: [{ id: 'k', title: 'K', cards: [quoteCard('c1', 'old1', 1), quoteCard('c2', 'lonely', 7)] }] });
  const mastery = materialMasteryIndex(state, { now: NOW }), coverage = materialCoverageIndex(state);
  assert.ok(Object.keys(mastery).length >= 2);
  for (const [key, entry] of Object.entries(mastery)) if (entry.document.total > 0) assert.ok(coverage[key], `${key} has ${entry.document.total} questions and a coverage figure`);
});
