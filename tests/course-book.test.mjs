/* 复习全书, the pure part: the record (lib/course-book.js), what a leaf is explained from and when it is current (lib/course-book-inputs.js), how the model's
   answer is read (lib/contexts/generation/book/read.js) and what a build has to do (book/work.js). No model, no library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, courseNotesMaterial, currentCourseNotes, keepMarks, normalizeCourseNotes, sameNotes } from '../lib/course-book.js';
import { bodyFingerprint, documentIndex, examFingerprint, leafSegments, previousLeaf } from '../lib/course-book-inputs.js';
import { assertMaterials, isLibraryListSource } from '../lib/exam-point-list.js';
import { readDraft, settleText } from '../lib/contexts/generation/book/read.js';
import { unitsOf } from '../lib/contexts/generation/book/sources.js';

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

test('reading an answer: a quote is kept only when found in the unit\'s pages, as the original\'s words; marks are numbered again in reading order', () => {
  const unit = { segments: [{ sourceId: 's1', start: 100, end: 200, text: 'Intro. The   architect records each decision\nin the log. Done.' }], checklist: [{ alias: 'c1', id: 'i00000000001' }] };
  const settled = settleText(unit, 'Text [1] [2] [9]. And [3].\n## A heading of its own', [{ n: 1, ref: 'S1', quote: 'not in the passage at all, really' },
    { n: 2, ref: 'S7', quote: 'the architect records each decision in the log' }, { n: 3, quote: 'short' }]);
  assert.deepEqual(settled.cites, [{ n: 1, sourceId: 's1', quote: 'The architect records each decision in the log', start: 107, end: 155 }]);
  assert.deepEqual([settled.text, settled.dropped], ['Text [^1]. And.\n#### A heading of its own', 2], 'a heading of the model\'s stays under the book\'s');
  assert.equal(settleText(unit, 'No marks.', [{ n: 1, quote: 'records each decision' }]).text, 'No marks. [^1]', 'a found quote no text marks still points to the original');
  const draft = readDraft(JSON.stringify({ text: 'x', covered: [{ id: 'c1' }, { id: 'c9' }], quotes: [] }), unit);
  assert.deepEqual(draft.claimed, ['i00000000001'], 'a claimed id that was not asked is ignored');
  assert.equal(readDraft(JSON.stringify({ text: '  ', covered: [] }), unit), null, 'no text, no answer');
});

test('a unit body: one text with its cites numbered through the units; a short body says what it misses; a big point is written in passes of whole pages', () => {
  const unitBody = { fingerprint: F, units: [{ text: 'One [^1].', cites: [{ n: 1, sourceId: 's1', quote: 'q1' }], covered: ['i00000000001'], read: [] },
    { text: 'Two [^1].', cites: [{ n: 1, sourceId: 's2', quote: 'q2' }], covered: [], read: [] }],
    coverage: { must: 2, covered: ['i00000000001'], missing: [{ id: 'i00000000002', name: 'Risk' }], optional: 0 }, issues: [], status: 'ok', readPrint: F };
  const notes = normalizeCourseNotes(input({ leaves: [{ id: 'n1', title: 'Point one', anchors: [], body: unitBody }] }));
  assert.equal(notes.leaves[0].body.status, 'short', 'a missing item is never complete');
  assert.deepEqual(bodyText(notes.leaves[0].body), { text: 'One [^1].\n\nTwo [^2].', cites: [{ n: 1, sourceId: 's1', quote: 'q1' }, { n: 2, sourceId: 's2', quote: 'q2' }] });
  const record = courseNotesMaterial({ title: '复习全书 · C', ...input({ leaves: [{ id: 'n1', title: 'Point one', anchors: [], body: unitBody }] }) });
  assert.match(record.text, /One \[\^n1-1\]\.\n\nTwo \[\^n1-2\]\.\n\n> 未达标：缺 1 个概念（Risk）/);
  const page = n => ({ sourceId: `p${n}`, start: 0, end: 9000, text: 'x'.repeat(9000), page: n });
  const units = unitsOf([page(1), page(2), page(3), page(4), page(5)], [{ id: 'a', places: [{ sourceId: 'p4', start: 0 }] }, { id: 'b', places: [{ sourceId: 'gone', start: 0 }] }]);
  assert.deepEqual(units.map(unit => unit.segments.map(segment => segment.sourceId)), [['p1', 'p2'], ['p3', 'p4'], ['p5']], 'whole pages, at most 20,000 characters a pass');
  assert.deepEqual(units.map(unit => unit.checklist.map(item => item.id)), [['b'], ['a'], []], 'an item in the pass of its page; one without a place in the first');
});
