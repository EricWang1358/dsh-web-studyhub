/* 课程总纲 step 1 (the engine): the course's materials as a tree (document -> chapters), each question placed where it points by the ONE rule the
   coverage figure uses (lib/card-places.js cardPlaceList: selection, verified place, the quote as written or written a little differently), the
   questions nothing places in 未归位, drafts counted apart, and a practice scope of at most 200 questions. Pure: a synthetic library state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { courseOutline, courseOutlineIndex, UNPLACED_KEY, PRACTICE_LIMIT } from '../lib/course-outline.js';
import { checkScope } from '../lib/prereq.js';
import { scopeKey } from '../lib/mastery.js';

const NOW = Date.parse('2026-10-09T08:00:00.000Z');
const past = '2026-10-01T08:00:00.000Z', future = '2026-11-01T08:00:00.000Z';
const para = (tag, n = 4) => Array.from({ length: n }, (_, i) => `${tag} statement ${i}: the database keeps every committed write durable on disk.`).join(' ');
const page = (n, chapter) => ({ id: `p${n}`, title: `Book · p. ${n}`, text: `${para(`Page${n}`)}`, courses: ['DB'], createdAt: past,
  document: { materialId: 'document-book', page: n, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'book.pdf', chapter } });
const CH = [{ index: 0, title: 'Indexes', level: 1 }, { index: 1, title: 'Transactions', level: 1 }];
const notesText = `${para('Alpha', 3)} ${para('Beta', 3)}`;
const betaAt = notesText.indexOf('Beta statement 0');
const cite = (sourceId, quote) => ({ sourceId, quote });
const card = (id, citations = [], extra = {}) => ({ id, kind: 'flashcard', topic: 'T', prompt: `Prompt of ${id}?`, answer: 'A', citations, ...extra });

function library() {
  const sources = [page(1, CH[0]), page(2, CH[0]), page(3, CH[1]), page(4, CH[1]),
    { id: 'notes-old', title: 'Notes', text: notesText.replace('durable', 'safe'), courses: ['DB'], createdAt: past, document: { materialId: 'document-notes', format: 'md', filename: 'notes.md' } },
    { id: 'notes-new', title: 'Notes', text: notesText, courses: ['DB'], createdAt: past, document: { materialId: 'document-notes', format: 'md', filename: 'notes.md' },
      segmentation: { level: 1, revision: 'r2', sourceIds: ['notes-new'], chapters: [{ index: 0, title: 'Alpha part', level: 1, sourceId: 'notes-new', offset: 0 }, { index: 1, title: 'Beta part', level: 1, sourceId: 'notes-new', offset: betaAt }] } },
    { id: 'pe-src', title: 'PE handout', text: para('Sport'), courses: ['PE'], createdAt: past },
    { id: 'loose', title: 'Loose note', text: para('Loose'), courses: [], createdAt: past },
    { id: 'empty-doc', title: 'Unused slides', text: para('Unused'), courses: ['DB'], createdAt: past },
    { id: 'arch', title: 'Archived lecture', text: para('Old'), courses: ['DB'], archived: true, createdAt: past }];
  const quote = (id, i = 1) => sources.find(source => source.id === id).text.match(new RegExp(`\\S+ statement ${i}: [^.]+\\.`))[0];
  const decks = [
    { id: 'd1', title: 'Indexes deck (10 题)', course: 'DB', cards: [
      card('c1', [cite('p1', quote('p1'))], { review: { repetitions: 2, interval_days: 3, due_at: past } }),
      card('c2', [cite('p3', quote('p3'))]),
      card('c3', [cite('p1', quote('p1', 2)), cite('p3', quote('p3', 2))]),
      card('c4'),
      card('c5', [cite('pe-src', quote('pe-src'))]),
      card('c6', [cite('p1', quote('p1'))], { suspended: true }),
      card('c7', [cite('notes-old', quote('notes-old').replace('Alpha', 'Beta').replace('safe', 'durable'))]),
      card('c8', [cite('loose', quote('loose'))]),
      card('c9', [cite('arch', quote('arch'))]),
      card('c10', [cite('gone', 'a quote of a deleted material')]),
    ] },
    // The quote is written with different spaces and punctuation: only the fuzzy locator (the coverage rule) finds it in p2.
    { id: 'd2', title: 'Fuzzy deck', course: 'DB', cards: [card('f1', [cite('p2', quote('p2').replace(/ /g, '  ').replace(':', ' -'))])] },
    { id: 'd-arch', title: 'Archived deck', course: 'DB', archived: true, cards: [card('a1', [cite('p1', quote('p1'))])] },
    { id: 'pe', title: 'PE deck', course: 'PE', cards: [card('x1', [cite('p1', quote('p1'))])] },
  ];
  const drafts = [{ id: 'dr1', title: 'Draft', course: 'DB', cards: [card('n1', [cite('p1', quote('p1'))]), card('n2', [cite('p2', quote('p2'))]), card('n3', [cite('p4', quote('p4'))])] },
    { id: 'dr-edit', title: 'Editing copy', course: 'DB', editingDeckId: 'd1', cards: [card('c1', [cite('p1', quote('p1'))])] }];
  const documents = [{ id: 'document-notes', title: 'Notes', format: 'md', currentRevision: 'r2', versions: [{ revision: 'r1', sourceIds: ['notes-old'] }, { revision: 'r2', sourceIds: ['notes-new'] }] }];
  return { revision: 1, sources, documents, decks, drafts, attempts: [], runs: [], courses: [], focus: { course: 'DB' } };
}

const docByTitle = (outline, pattern) => outline.documents.find(document => pattern.test(document.title));

test('the tree: the course\'s documents with their chapters, a document without chapters is one row, other courses and archived materials are not in it', () => {
  const outline = courseOutline(library(), { course: 'DB' }, { now: NOW });
  assert.equal(outline.status, 'ok');
  assert.equal(outline.course, 'DB');
  assert.deepEqual(outline.documents.map(document => document.title), ['book.pdf', 'Notes', 'Loose note', 'Unused slides']);
  const book = docByTitle(outline, /book/);
  assert.equal(book.chapters, 2, 'the converted book has its two chapters');
  assert.equal(book.total, 4, 'c1, c2, c3 (cited in both chapters, once) and the fuzzy-quoted f1');
  assert.equal(docByTitle(outline, /Unused/).total, 0, 'a course material without questions is listed, 还没出题');
  assert.equal(docByTitle(outline, /Unused/).chapters, 0, 'a document without chapters has no chapter rows');
  assert.equal(docByTitle(outline, /Unused/).summary.state, 'none');
  assert.ok(!outline.documents.some(document => /PE|Archived/.test(document.title)));
});

test('a question citing two chapters is under both, flagged, and counted once in the document and the course', () => {
  const outline = courseOutline(library(), { course: 'DB', expand: ['pdf:document-book'] }, { now: NOW });
  const chapters = outline.open['pdf:document-book'].chapters;
  assert.deepEqual(chapters.map(chapter => [chapter.title, chapter.total]), [['Indexes', 3], ['Transactions', 2]]);
  const deeper = courseOutline(library(), { course: 'DB', expand: chapters.map(chapter => chapter.key) }, { now: NOW });
  const [indexes, transactions] = chapters.map(chapter => deeper.open[chapter.key].cards);
  assert.deepEqual(indexes.map(ref => ref.cardId).sort(), ['c1', 'c3', 'f1']);
  assert.deepEqual(transactions.map(ref => ref.cardId).sort(), ['c2', 'c3']);
  assert.equal(indexes.find(ref => ref.cardId === 'c3').shared, true);
  assert.equal(indexes.find(ref => ref.cardId === 'c1').shared, undefined);
  assert.equal(indexes.find(ref => ref.cardId === 'c1').deckTitle, 'Indexes deck', 'the deck name is the cleaned one');
  assert.equal(indexes.find(ref => ref.cardId === 'c1').level, 'learning');
  assert.equal(indexes.find(ref => ref.cardId === 'c1').due, true);
  assert.equal(outline.total, 10, 'every practisable question of the course once (suspended and archived decks left out)');
  assert.equal(outline.placed, 6);
  assert.equal(outline.summary.total, 10);
});

test('a re-imported document keeps the questions written from its old version, placed in the chapter their quote stands in now', () => {
  const outline = courseOutline(library(), { course: 'DB', expand: ['doc:document-notes'] }, { now: NOW });
  const notes = docByTitle(outline, /Notes/);
  assert.equal(notes.total, 1);
  const chapters = outline.open['doc:document-notes'].chapters;
  assert.deepEqual(chapters.map(chapter => [chapter.title, chapter.total]), [['Alpha part', 0], ['Beta part', 1]]);
});

test('a quote written a little differently is placed where it stands (the coverage rule), not at the start of its page', () => {
  const state = { ...library(), revision: 4 };
  const written = 'Beta statement 2 - the database keeps every committed write, durable on disk';
  state.decks.push({ id: 'd3', title: 'Loose quotes', course: 'DB', cards: [card('q1', [cite('notes-new', written)])] });
  const outline = courseOutline(state, { course: 'DB', expand: ['doc:document-notes'] }, { now: NOW });
  assert.deepEqual(outline.open['doc:document-notes'].chapters.map(chapter => [chapter.title, chapter.total]), [['Alpha part', 0], ['Beta part', 2]]);
});

test('an uncategorised material that the course\'s questions cite belongs to the outline; one of another course does not', () => {
  const outline = courseOutline(library(), { course: 'DB', expand: ['source:loose', UNPLACED_KEY] }, { now: NOW });
  assert.deepEqual(outline.open['source:loose'].cards.map(ref => ref.cardId), ['c8']);
  const unplaced = outline.open[UNPLACED_KEY].cards;
  assert.deepEqual(unplaced.map(ref => [ref.cardId, ref.reason]).sort(), [['c10', 'missing'], ['c4', 'none'], ['c5', 'elsewhere'], ['c9', 'elsewhere']]);
  assert.deepEqual(outline.unplaced.reasons, { none: 1, elsewhere: 2, missing: 1 });
  assert.equal(outline.unplaced.total, 4);
});

test('drafts are counted apart: never in the totals or the mastery, per chapter and for the course; editing copies are left out', () => {
  const outline = courseOutline(library(), { course: 'DB', expand: ['pdf:document-book'] }, { now: NOW });
  assert.equal(outline.draftCards, 3);
  const [indexes, transactions] = outline.open['pdf:document-book'].chapters;
  assert.equal(indexes.summary.draftCards, 2);
  assert.equal(transactions.summary.draftCards, 1);
  assert.equal(indexes.total, 3, 'drafts are not questions to practise');
  assert.equal(docByTitle(outline, /book/).summary.draftCards, 3);
});

test('the deck filter narrows the questions and lists every deck of the course with its count', () => {
  const outline = courseOutline(library(), { course: 'DB', deckId: 'd2' }, { now: NOW });
  assert.deepEqual(outline.decks.map(deck => [deck.id, deck.title, deck.total]), [['d1', 'Indexes deck', 9], ['d2', 'Fuzzy deck', 1]]);
  assert.equal(outline.total, 1);
  assert.deepEqual(outline.documents.map(document => [document.title, document.total]), [['book.pdf', 1]], 'with a deck chosen only the documents it has questions in');
});

test('pick: nodes and questions as one de-duplicated practice scope that review.start accepts', () => {
  const state = library();
  const keys = courseOutline(state, { course: 'DB', expand: ['pdf:document-book'] }, { now: NOW }).open['pdf:document-book'].chapters.map(chapter => chapter.key);
  const picked = courseOutline(state, { course: 'DB', pick: { keys, cards: [{ deckId: 'd1', cardId: 'c3' }, { deckId: 'd1', cardId: 'c8' }, { deckId: 'pe', cardId: 'x1' }] } }, { now: NOW });
  assert.deepEqual(Object.keys(picked).sort(), ['course', 'practice', 'status'], 'a pick answers the scope only');
  assert.deepEqual(picked.practice.scope.map(ref => ref.cardId).sort(), ['c1', 'c2', 'c3', 'c8', 'f1'], 'c3 once; a question of another course is ignored');
  assert.equal(picked.practice.total, 5);
  assert.equal(picked.practice.capped, false);
  assert.doesNotThrow(() => checkScope(state, picked.practice.scope));
});

test('more than 200 questions: the first 200 in the practice order (due, weak, new), the total said', () => {
  const state = { ...library(), revision: 3 };
  const text = Array.from({ length: 260 }, (_, i) => `Fact ${i}: the platform keeps statement ${i} durable.`).join(' ');
  state.sources.push({ id: 'big', title: 'Big material', text, courses: ['DB'], createdAt: past });
  const cards = Array.from({ length: 250 }, (_, i) => card(`b${i}`, [cite('big', `Fact ${i}: the platform keeps statement ${i} durable.`)],
    i >= 240 && i < 245 ? { review: { repetitions: 2, interval_days: 3, due_at: past } } : i >= 245 ? { review: { repetitions: 2, interval_days: 3, due_at: future } } : {}));
  state.decks.push({ id: 'big-deck', title: 'Big deck', course: 'DB', cards });
  state.attempts.push(...[230, 231].map(i => ({ deckId: 'big-deck', quiz_id: `b${i}`, grade: 1, at: past })));
  const outline = courseOutline(state, { course: 'DB' }, { now: NOW });
  const big = outline.documents.find(document => document.title === 'Big material');
  assert.equal(big.total, 250);
  assert.equal(outline.limit, PRACTICE_LIMIT);
  assert.equal(PRACTICE_LIMIT, 200);
  const { practice } = courseOutline(state, { course: 'DB', pick: { keys: [big.key] } }, { now: NOW });
  assert.equal(practice.total, 250);
  assert.equal(practice.capped, true);
  assert.equal(practice.scope.length, 200);
  assert.deepEqual(practice.scope.slice(0, 7).map(ref => ref.cardId), ['b240', 'b241', 'b242', 'b243', 'b244', 'b230', 'b231'], 'due first, then weak');
  assert.ok(practice.scope.slice(7).every(ref => Number(ref.cardId.slice(1)) < 240), 'then new questions; the not-due learned ones last, left out');
  assert.doesNotThrow(() => checkScope(state, practice.scope));
  assert.equal(new Set(practice.scope.map(ref => ref.cardId)).size, 200);
});

test('a node with an unfinished run of exactly its questions offers to go on (接着练)', () => {
  const state = library();
  const scope = [{ deckId: 'd1', cardId: 'c2' }, { deckId: 'd1', cardId: 'c3' }];
  state.runs.push({ id: 'run-1', mode: 'path', key: scopeKey('path', scope), scope, index: 1, entries: [{ deckId: 'd1', card: { id: 'c2' } }, { deckId: 'd1', card: { id: 'c3' } }] });
  const outline = courseOutline(state, { course: 'DB', expand: ['pdf:document-book'] }, { now: NOW });
  const [indexes, transactions] = outline.open['pdf:document-book'].chapters;
  assert.deepEqual(transactions.resume, { runId: 'run-1', index: 1, total: 2 });
  assert.equal(indexes.resume, undefined);
});

test('no course, or a course with nothing in it, is a plain empty outline', () => {
  const empty = courseOutline({ revision: 2, sources: [], decks: [], drafts: [], attempts: [], runs: [], courses: [], documents: [] }, {}, { now: NOW });
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.documents, []);
  const other = courseOutline(library(), { course: 'Nothing here' }, { now: NOW });
  assert.equal(other.total, 0);
  assert.deepEqual(other.documents, []);
});

test('the index is built once per library revision and minute, course and deck filter', () => {
  const state = library();
  const first = courseOutlineIndex(state, { course: 'DB' }, { now: NOW, root: 'r' });
  assert.equal(courseOutlineIndex(state, { course: 'DB' }, { now: NOW + 1000, root: 'r' }), first);
  assert.notEqual(courseOutlineIndex(state, { course: 'DB', deckId: 'd1' }, { now: NOW, root: 'r' }), first);
  assert.notEqual(courseOutlineIndex({ ...state, revision: 2 }, { course: 'DB' }, { now: NOW, root: 'r' }), first);
});
