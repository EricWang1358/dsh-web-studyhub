/* 复习全书, the pure part: the record (lib/course-book.js), what a leaf is explained from and when it is current (lib/course-book-inputs.js), how the model's
   answer is read (lib/contexts/generation/book/read.js) and what a build has to do (book/work.js). No model, no library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { courseNotesMaterial, currentCourseNotes, keepMarks, normalizeCourseNotes, sameNotes } from '../lib/course-book.js';
import { bodyFingerprint, documentIndex, examFingerprint, leafSegments, previousLeaf } from '../lib/course-book-inputs.js';
import { assertMaterials, isLibraryListSource } from '../lib/exam-point-list.js';
import { settleLeaf } from '../lib/contexts/generation/book/read.js';
import { excerpt, packLeaves } from '../lib/contexts/generation/book/work.js';

const F = '0123456789abcdef';
const body = extra => ({ fingerprint: F, points: ['A point [^1]'], explain: 'Why it matters [^1] and more [^3].', cites: [{ n: 1, sourceId: 's1', quote: 'the quote', start: 0, end: 9 }], ...extra });
const input = extra => ({ course: 'C', language: 'zh', outlineId: 'course-outline-x', leaves: [{ id: 'n1', title: 'Point one', anchors: ['doc:a'], body: body() }], ...extra });

test('the record: a reference with its own provenance, hidden from the materials and refused as one; marks of cites that do not exist are taken out', () => {
  const record = courseNotesMaterial({ title: '复习全书 · C', ...input() });
  assert.match(record.id, /^course-outline-notes-[0-9a-f]{40}$/);
  assert.deepEqual([record.provenance, record.courses, record.format], ['course-outline-notes', ['C'], 'md']);
  assert.equal(isLibraryListSource(record), true);
  assert.throws(() => assertMaterials([record]), error => error.code === 'course-notes-not-material');
  assert.equal(record.courseNotes.leaves[0].body.explain, 'Why it matters [^1] and more.', 'cite 3 does not exist');
  assert.match(record.text, /^# 复习全书 · C\n\n这份复习全书由模型按资料写成，只是参考/);
  assert.match(record.text, /- A point \[\^n1-1\]/);
  assert.match(record.text, /\[\^n1-1\]: 「the quote」/);
  assert.equal(keepMarks('x [^1] y [^2]', 1), 'x [^1] y');
  assert.equal(courseNotesMaterial({ title: '复习全书 · C', ...input() }).id, record.id, 'the same notes are one record');
});

test('the record refuses what is not notes: no outline, a repeated leaf, a cite out of order, an explanation without a fingerprint', () => {
  assert.throws(() => normalizeCourseNotes(input({ outlineId: '' })), /name the outline/);
  assert.throws(() => normalizeCourseNotes(input({ leaves: [input().leaves[0], input().leaves[0]] })), /Leaf repeated/);
  assert.throws(() => normalizeCourseNotes(input({ leaves: [{ id: 'n1', title: 'P', body: body({ cites: [{ n: 2, sourceId: 's', quote: 'q' }] }) }] })), /cite 1/);
  assert.throws(() => normalizeCourseNotes(input({ leaves: [{ id: 'n1', title: 'P', body: body({ fingerprint: 'x' }) }] })), /fingerprint/);
  const empty = normalizeCourseNotes(input({ leaves: [{ id: 'n1', title: 'P', body: { fingerprint: F, empty: true } }] }));
  assert.deepEqual(empty.leaves[0].body, { fingerprint: F, empty: true });
  const exam = normalizeCourseNotes(input({ leaves: [{ id: 'n1', title: 'P', exam: { fingerprint: F, tested: false, note: 'ignored' } }] }));
  assert.deepEqual(exam.leaves[0].exam, { fingerprint: F, tested: false }, 'an untested leaf says so, without a note');
  assert.equal(sameNotes(normalizeCourseNotes(input()), normalizeCourseNotes(input({ supersedes: 'old', counts: { written: 3 } }))), true, 'what replaced and the counts are not content');
});

test('the current notes of a course: the newest not archived, filed under exactly that course', () => {
  const make = (id, createdAt, extra = {}) => ({ id, provenance: 'course-outline-notes', courseNotes: { version: 1 }, courses: ['C'], createdAt, ...extra });
  const sources = [make('a', '2026-10-01'), make('b', '2026-10-03'), make('c', '2026-10-05', { archived: true }), make('d', '2026-10-06', { courses: ['D'] })];
  assert.equal(currentCourseNotes(sources, 'C').id, 'b');
  assert.equal(currentCourseNotes(sources, '*'), null);
});

test('a leaf\'s passages: a document whole, a chapter from where it starts to where the next starts inside a page; copies once; fingerprints follow the text only', () => {
  const sources = [{ id: 'p1', text: 'Front matter. Chapter one starts here and goes on.' }, { id: 'p2', text: 'Still chapter one. Chapter two begins here.' },
    { id: 'copy', text: 'Front matter. Chapter one starts here and goes on.' }, { id: 'list', text: 'x', provenance: 'course-outline', courseOutline: {} }];
  const chapters = [{ index: 0, title: 'One', sourceIds: ['p2'], startSourceId: 'p1', startOffset: 14 }, { index: 1, title: 'Two', sourceIds: [], startSourceId: 'p2', startOffset: 19 }];
  const docs = documentIndex([{ key: 'doc:book', title: 'Book', sourceIds: ['p1', 'p2'], chapters }, { key: 'doc:copy', title: 'Copy', sourceIds: ['copy'], chapters: [] },
    { key: 'doc:list', title: 'List', sourceIds: ['list'], chapters: [] }]);
  const byId = new Map(sources.map(source => [source.id, source]));
  const one = leafSegments(byId, docs, ['doc:book#0']);
  assert.deepEqual(one.map(item => [item.sourceId, item.text]), [['p1', 'Chapter one starts here and goes on.'], ['p2', 'Still chapter one. ']]);
  assert.deepEqual(leafSegments(byId, docs, ['doc:book#1']).map(item => [item.start, item.text]), [[19, 'Chapter two begins here.']]);
  assert.equal(leafSegments(byId, docs, ['doc:book', 'doc:copy']).length, 2, 'the copy\'s text is the first page\'s: once');
  assert.deepEqual(leafSegments(byId, docs, ['doc:list', 'doc:gone']), [], 'a list and a gone row give nothing');
  const print = bodyFingerprint('zh', one);
  assert.equal(print, bodyFingerprint('zh', leafSegments(byId, docs, ['doc:book#0'])));
  assert.notEqual(print, bodyFingerprint('en', one), 'the language is an input');
  byId.set('p2', { id: 'p2', text: 'Still chapter one, edited. Chapter two begins here.' });
  assert.notEqual(print, bodyFingerprint('zh', leafSegments(byId, docs, ['doc:book#0'])), 'a changed text is a changed explanation');
  const node = place => ({ exam: { evidence: [{ paper: 'doc:p', sourceId: 'p', quote: place }] } });
  assert.equal(examFingerprint('zh', node('Q1'), [{ key: 'doc:p', fingerprint: 'aa' }]), examFingerprint('zh', node('Q1'), [{ key: 'doc:p', fingerprint: 'aa' }]));
  assert.notEqual(examFingerprint('zh', node('Q1'), [{ key: 'doc:p', fingerprint: 'aa' }]), examFingerprint('zh', node('Q2'), [{ key: 'doc:p', fingerprint: 'aa' }]));
});

test('the earlier explanation of a leaf: the same id, else the most overlapping anchors, else the only one of that title', () => {
  const earlier = [{ id: 'a', title: 'Layers', anchors: ['x#0', 'x#1'] }, { id: 'b', title: 'Messaging', anchors: ['y'] }, { id: 'c', title: 'Zero trust', anchors: ['z'] }];
  assert.equal(previousLeaf(earlier, { id: 'b', title: 'Other', anchors: [] }).id, 'b');
  assert.equal(previousLeaf(earlier, { id: 'n', title: 'Layered style', anchors: ['x#0', 'x#1', 'w'] }).id, 'a', 'two of three anchors');
  assert.equal(previousLeaf(earlier, { id: 'n', title: 'zero  TRUST', anchors: ['q'] }).id, 'c');
  assert.equal(previousLeaf(earlier, { id: 'n', title: 'New', anchors: ['x#0', 'q', 'r'] }), null, 'one of three is not enough');
});

test('reading an answer: a quote is kept only when found in the leaf\'s passage, as the original\'s words; marks are numbered again in reading order', () => {
  const item = { segments: [{ sourceId: 's1', start: 100, end: 200, text: 'Intro. The   architect records each decision\nin the log. Done.' }] };
  const settled = settleLeaf(item, { points: ['First [2]', 'Second [3]'], explain: 'Text [1] [2] [9].', example: '', extra: ['Beyond [1]'],
    quotes: [{ n: 1, ref: 'S1', quote: 'not in the passage at all, really' }, { n: 2, ref: 'S7', quote: 'the architect records each decision in the log' }, { n: 3, quote: 'short' }] });
  assert.deepEqual(settled.cites, [{ n: 1, sourceId: 's1', quote: 'The architect records each decision in the log', start: 107, end: 155 }]);
  assert.deepEqual([settled.points, settled.explain, settled.extra, settled.dropped], [['First [^1]', 'Second'], 'Text [^1].', ['Beyond'], 2]);
  const unmarked = settleLeaf(item, { explain: 'No marks.', quotes: [{ n: 1, quote: 'records each decision' }] });
  assert.equal(unmarked.explain, 'No marks. [^1]', 'a found quote no text marks still points to the original');
});

test('a call is modest: an excerpt shares the characters out, a call holds at most three leaves and its characters', () => {
  const long = (n, size) => ({ sourceId: `s${n}`, start: 0, end: size, text: 'x'.repeat(size), material: 'M' });
  const shown = excerpt([long(1, 500), long(2, 20000), long(3, 20000)], 12000);
  assert.deepEqual(shown.map(item => [item.text.length, item.cut]), [[500, false], [5750, true], [5750, true]]);
  const items = n => Array.from({ length: n }, (_, at) => ({ id: `n${at}`, fingerprint: F, shown: [long(at, 9000)] }));
  assert.deepEqual(packLeaves(items(7)).map(batch => batch.items.length), [2, 2, 2, 1], 'two leaves of 9,000 characters fill 24,000');
  assert.deepEqual(packLeaves(items(7).map(item => ({ ...item, shown: [long(0, 100)] }))).map(batch => batch.items.length), [3, 3, 1]);
});
