import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { LARGE_DOCUMENT_LIMITS } from '../lib/large-documents.js';
import { PAPER_MAX_CHARS, PAPER_MAX_PAGES, PAPER_WORDS, REASON_CODES, SYLLABUS_MAX_PAGES, SYLLABUS_WORDS, WEAK_PAPER_WORDS, suggestRoles } from '../lib/exam-prep-roles.js';

/* 备考补习, role suggestion (lib/exam-prep-roles.js): conservative on purpose. A lecture taken for a sample paper makes false 样卷考过 badges,
   a missed paper leaves every point as 补充. Items are the documents of lib/source-groups.js; here they are written by hand. */

let counter = 0;
const item = (title, extra = {}) => ({ key: `doc:${++counter}`, title, format: 'pdf', pages: [], chars: 5000, courses: [], ...extra });
const pages = count => Array.from({ length: count }, (_, index) => ({ sourceId: `s${index}`, page: index + 1, chars: 100, title: 'p' }));
const one = (it, options) => suggestRoles([it], options)[0];

test('constants: the limits and word lists the Settings pane shows', () => {
  assert.equal(PAPER_MAX_PAGES, 20);
  assert.equal(PAPER_MAX_CHARS, 60000);
  assert.ok(SYLLABUS_MAX_PAGES >= PAPER_MAX_PAGES);
  for (const word of ['样卷', '真题', '试卷', '历年', '往年', '模拟卷', '期中', '期末', 'past paper', 'sample paper', 'exam paper', 'midterm', 'mid-term', 'final exam', 'mock exam'])
    assert.ok(PAPER_WORDS.includes(word), word);
  for (const word of ['大纲', '教学大纲', '考试大纲', '考试范围', 'syllabus', 'course outline']) assert.ok(SYLLABUS_WORDS.includes(word), word);
  for (const word of ['paper', 'sample', 'exam', 'final', 'quiz', 'test', '试题', '习题', '卷子']) assert.ok(WEAK_PAPER_WORDS.includes(word), word);
  assert.ok(REASON_CODES.includes('name-paper') && REASON_CODES.includes('auto-off'));
  assert.ok(Object.isFrozen(PAPER_WORDS));
});

test('an ordinary document is a lecture; a slide deck says so', () => {
  assert.deepEqual(one(item('Week 3 notes', { id: 'a', format: 'docx' })), { id: 'a', role: 'lecture', reason: { code: 'default-lecture' } });
  assert.deepEqual(one(item('Lecture 3', { id: 'b', format: 'pptx' })), { id: 'b', role: 'lecture', reason: { code: 'slides' } });
  for (const format of ['pdf', 'docx', 'md', 'txt', 'audio', 'html', 'text']) assert.equal(one(item('Notes', { format })).role, 'lecture', format);
  assert.equal(one(item('Notes', { format: 'audio' })).reason.code, 'default-lecture');
});

test('the id is the item id, else its key (the id space the pickers use)', () => {
  assert.equal(one(item('x', { id: 'mine', key: 'doc:other' })).id, 'mine');
  assert.equal(one({ key: 'doc:k', title: 'x', format: 'pdf' }).id, 'doc:k');
});

test('none: a json card deck is not readable text', () => {
  assert.deepEqual(one(item('Cards', { id: 'cards', format: 'json' })), { id: 'cards', role: 'none', reason: { code: 'not-text' } });
  assert.equal(one(item('样卷 cards', { format: 'json' })).role, 'none');
});

test('none: a very large document, by the existing big-document threshold', () => {
  const limit = LARGE_DOCUMENT_LIMITS.advisePages;
  assert.deepEqual(one(item('Textbook', { pages: pages(limit + 1) })).reason, { code: 'too-big' });
  assert.equal(one(item('Textbook', { pages: pages(limit + 1) })).role, 'none');
  assert.equal(one(item('Textbook', { totalPages: limit + 50 })).role, 'none');
  assert.equal(one(item('Textbook', { pages: pages(limit) })).role, 'lecture');
  assert.equal(one(item('Textbook', { totalPages: limit })).role, 'lecture');
  const book = one(item('Converted book', { format: 'md', converted: 'MinerU', pages: pages(limit + 1) }));
  assert.deepEqual([book.role, book.reason.code], ['none', 'too-big']);
  assert.equal(one(item('真题 collection', { totalPages: limit + 1 })).role, 'none');
});

test('past-paper: a strong word in the title and a short document', () => {
  const found = one(item('CS2105 期中样卷', { id: 'p', totalPages: 8 }));
  assert.deepEqual(found, { id: 'p', role: 'past-paper', reason: { code: 'name-paper', word: '样卷' } });
  for (const word of ['样卷', '真题', '试卷', '历年', '往年', '模拟卷', '期中', '期末'])
    assert.deepEqual([one(item(`网络${word}2023`, { totalPages: 6 })).role, one(item(`网络${word}2023`, { totalPages: 6 })).reason.word], ['past-paper', word], word);
  for (const name of ['Past Paper 2023', 'sample paper', 'EXAM PAPER', 'Midterm 2022', 'mid-term', 'Final Exam', 'mock exam'])
    assert.equal(one(item(name, { totalPages: 6 })).role, 'past-paper', name);
  assert.equal(one(item('x', { filename: 'past_paper_2023.pdf', totalPages: 6 })).role, 'past-paper');
  assert.equal(one(item('x', { filename: 'Mid-Term-Test.PDF', totalPages: 6 })).role, 'past-paper');
  assert.equal(one(item('CS2105_final-exam_AY2223', { totalPages: 6 })).role, 'past-paper');
});

test('past-paper: the size gate, by pages and, when the page count is unknown, by characters', () => {
  assert.equal(one(item('真题', { totalPages: PAPER_MAX_PAGES })).role, 'past-paper');
  assert.equal(one(item('真题', { totalPages: PAPER_MAX_PAGES + 1 })).role, 'lecture');
  assert.equal(one(item('真题', { pages: pages(PAPER_MAX_PAGES) })).role, 'past-paper');
  assert.equal(one(item('真题', { pages: pages(PAPER_MAX_PAGES + 1) })).role, 'lecture');
  assert.equal(one(item('真题', { format: 'docx', chars: PAPER_MAX_CHARS })).role, 'past-paper');
  assert.equal(one(item('真题', { format: 'docx', chars: PAPER_MAX_CHARS + 1 })).role, 'lecture');
  assert.deepEqual(one(item('真题', { totalPages: 90 })).reason, { code: 'default-lecture' });
});

test('past-paper: never a slide deck', () => {
  assert.deepEqual([one(item('期末复习', { format: 'pptx', pages: pages(10) })).role, one(item('期末复习', { format: 'pptx', pages: pages(10) })).reason.code], ['lecture', 'slides']);
  assert.equal(one(item('Sample Paper walk-through', { format: 'pptx', totalPages: 5 })).role, 'lecture');
  assert.equal(one(item('课程大纲', { format: 'pptx', totalPages: 5 })).role, 'lecture');
});

test('a weak word never assigns a role; it only leaves a hint on the lecture row', () => {
  for (const name of ['Quiz 3', 'Sample questions', 'exam tips', 'Final notes', 'test bank', 'Paper reading', '试题讲解', '习题课', '去年的卷子', 'Practice Test'])
    assert.deepEqual([one(item(name, { totalPages: 5 })).role, one(item(name, { totalPages: 5 })).hint], ['lecture', 'maybe-paper'], name);
  assert.equal(one(item('Lecture 4 slides', { totalPages: 5 })).hint, undefined);
  assert.equal('hint' in one(item('Lecture 4', { totalPages: 5 })), false);
  // Whole words only: "latest" is not "test", "papers" is not the weak word either way of a role.
  assert.equal(one(item('Latest news', { totalPages: 5 })).hint, undefined);
  assert.equal(one(item('Quiz deck', { format: 'pptx' })).hint, 'maybe-paper');
});

test("the learner's own paper words are strong words", () => {
  const options = { paperWords: ['Quiz Bank', '练习卷', '  '] };
  assert.deepEqual(one(item('CS quiz bank 2023', { id: 'q', totalPages: 6 }), options), { id: 'q', role: 'past-paper', reason: { code: 'name-paper', word: 'Quiz Bank' } });
  assert.equal(one(item('数据结构练习卷', { totalPages: 6 }), options).reason.word, '练习卷');
  assert.equal(one(item('数据结构练习卷', { totalPages: 6 })).role, 'lecture');
  assert.equal(one(item('数据结构练习卷', { totalPages: 60 }), options).role, 'lecture');
  assert.equal(one(item('数据结构练习卷', { format: 'pptx', totalPages: 6 }), options).role, 'lecture');
  assert.equal(one(item('Notes', { totalPages: 6 }), { paperWords: 'oops' }).role, 'lecture');
});

test('syllabus: from course guidance, whatever the name', () => {
  const doc = item('Anything', { id: 'g', format: 'pptx', totalPages: 90 });
  assert.deepEqual(one(doc, { guidanceSourceIds: ['g'] }), { id: 'g', role: 'syllabus', reason: { code: 'course-guidance' } });
  assert.equal(one(doc, { guidanceSourceIds: ['other'] }).role, 'lecture');
  assert.equal(one(item('x', { id: 'h', sourceIds: ['s1', 's2'] }), { guidanceSourceIds: ['s2'] }).role, 'syllabus');
  assert.equal(one(item('真题', { id: 'g2', totalPages: 5 }), { guidanceSourceIds: ['g2'] }).role, 'syllabus');
});

test('syllabus: a strong word and a short document', () => {
  for (const word of ['大纲', '教学大纲', '考试大纲', '考试范围', 'syllabus', 'course outline'])
    assert.deepEqual([one(item(`CS2105 ${word}`, { totalPages: 4 })).role, one(item(`CS2105 ${word}`, { totalPages: 4 })).reason.code], ['syllabus', 'name-syllabus'], word);
  assert.equal(one(item('Course Syllabus', { totalPages: 4 })).reason.word, 'syllabus');
  assert.equal(one(item('Syllabus 2023', { totalPages: SYLLABUS_MAX_PAGES })).role, 'syllabus');
  assert.equal(one(item('Syllabus 2023', { totalPages: SYLLABUS_MAX_PAGES + 1 })).role, 'lecture');
  assert.equal(one(item('syllabus', { pages: pages(4) })).role, 'syllabus');
  assert.equal(one(item('考试大纲', { format: 'docx', chars: 4000 })).role, 'syllabus');
});

test('syllabus wins when a name says both, and a deck is only a syllabus by guidance', () => {
  assert.equal(one(item('期末考试大纲', { totalPages: 3 })).role, 'syllabus');
  assert.equal(one(item('Final exam syllabus', { totalPages: 3 })).role, 'syllabus');
  assert.equal(one(item('Syllabus', { format: 'pptx', totalPages: 3 })).role, 'lecture');
  assert.equal(one(item('Syllabus', { format: 'pptx', totalPages: 3, id: 'z' }), { guidanceSourceIds: ['z'] }).role, 'syllabus');
});

test('none comes before guidance and names', () => {
  assert.equal(one(item('Syllabus', { id: 'j', format: 'json' }), { guidanceSourceIds: ['j'] }).role, 'none');
  assert.equal(one(item('Syllabus', { id: 'k', totalPages: 999 }), { guidanceSourceIds: ['k'] }).role, 'none');
});

test('autoRoles false guesses nothing', () => {
  const off = { autoRoles: false, paperWords: ['quiz bank'], guidanceSourceIds: ['g'] };
  const result = suggestRoles([item('真题', { totalPages: 5 }), item('Syllabus', { id: 'g', totalPages: 5 }), item('Lecture', { format: 'pptx' }),
    item('Cards', { format: 'json' }),
    item('Book', { totalPages: 999 }), item('quiz bank', { totalPages: 3 })], off);
  assert.deepEqual(result.map(entry => entry.role), ['lecture', 'lecture', 'lecture', 'none', 'none', 'lecture']);
  assert.deepEqual(result.filter(entry => entry.role === 'lecture').map(entry => entry.reason), Array(4).fill({ code: 'auto-off' }));
  assert.equal(result.some(entry => 'hint' in entry), false);
  assert.equal(result[3].reason.code, 'not-text');
  assert.equal(result[4].reason.code, 'too-big');
  assert.equal(one(item('真题', { totalPages: 5 }), { autoRoles: true }).role, 'past-paper');
  assert.equal(one(item('真题', { totalPages: 5 }), {}).role, 'past-paper');
  assert.equal(one(item('真题', { totalPages: 5 })).role, 'past-paper');
});

test('order independence and determinism', () => {
  const items = [item('A 真题', { id: 'a', totalPages: 5 }), item('B notes', { id: 'b' }), item('C Syllabus', { id: 'c', totalPages: 3 }),
    item('D deck', { id: 'd', format: 'pptx' }),
    item('E cards', { id: 'e', format: 'json' }),
    item('F Quiz', { id: 'f', totalPages: 2 }), item('G book', { id: 'g', totalPages: 500 }), item('H mid-term', { id: 'h', totalPages: 30 })];
  const options = { paperWords: ['deck'], guidanceSourceIds: ['b'] };
  const forward = suggestRoles(items, options);
  assert.deepEqual(forward.map(entry => entry.id), items.map(entry => entry.id));
  const byId = result => Object.fromEntries(result.map(entry => [entry.id, entry]));
  for (const order of [[...items].reverse(), [items[3], items[0], items[6], items[1], items[7], items[2], items[5], items[4]]]) {
    const result = suggestRoles(order, options);
    assert.deepEqual(result.map(entry => entry.id), order.map(entry => entry.id));
    assert.deepEqual(byId(result), byId(forward));
  }
  assert.deepEqual(suggestRoles(items, options), forward);
  assert.deepEqual(suggestRoles(items.map(entry => structuredClone(entry)), structuredClone(options)), forward);
  assert.deepEqual(suggestRoles([], options), []);
  assert.deepEqual(suggestRoles(undefined), []);
  assert.deepEqual(suggestRoles(items.slice(0, 1), { paperWords: undefined, guidanceSourceIds: null }).map(entry => entry.role), ['past-paper']);
});

test('it works on real document items of groupSourcesByDocument', () => {
  const page = (id, document, extra = {}) => ({ id, title: document.filename, text: 'x'.repeat(400), document, ...extra });
  const hash = 'a'.repeat(64), other = 'b'.repeat(64);
  const sources = [
    ...[1, 2, 3].map(number => page(`p${number}`, { format: 'pdf', filename: 'CS2105 期中样卷.pdf', materialId: `document-${hash}-pdf`, id: hash, page: number, totalPages: 3 })),
    ...Array.from({ length: 40 }, (_, index) => page(`l${index}`, { format: 'pdf', filename: 'Lecture 5.pdf', materialId: `document-${other}-pdf`, id: other, page: index + 1, totalPages: 40 })),
    page('d1', { format: 'pptx', filename: '期末复习.pptx', materialId: 'document-deck', page: 1, totalPages: 12 }),
    { id: 'c1', title: 'Cards', text: '{"cards":[]}', format: 'json', provenance: 'json-cards' },
  ];
  const items = groupSourcesByDocument(sources);
  const roles = Object.fromEntries(suggestRoles(items).map((entry, index) => [items[index].title, entry.role]));
  assert.equal(roles['CS2105 期中样卷.pdf'], 'past-paper');
  assert.equal(roles['Lecture 5.pdf'], 'lecture');
  assert.equal(roles['期末复习.pptx'], 'lecture');
  assert.ok(suggestRoles(items).every(entry => typeof entry.id === 'string' && entry.id));
});
