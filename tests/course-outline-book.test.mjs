/* 课程总纲 step 2, the record and how the page reads it (pure: a synthetic library state, no model). The AI outline is a special material
   (provenance course-outline): never a material, never evidence; its leaves name rows of the v3.3.0 engine, so the questions, counts, mastery and practice
   stay computed by that engine; what no leaf holds is in 其他; a changed library shows the outline as out of date. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { courseOutline, OTHER_KEY } from '../lib/course-outline.js';
import { courseOutlineMaterial, courseOutlineText, currentCourseOutline, materialsFingerprint, normalizeCourseOutline, nodeId, OUTLINE_LIMITS } from '../lib/course-outline-book.js';
import { bookLayout } from '../lib/course-outline-book-view.js';
import { assertMaterials, isCourseOutlineSource, isLibraryListSource, notExamPointList } from '../lib/exam-point-list.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';

const NOW = Date.parse('2026-10-09T08:00:00.000Z'), at = '2026-10-01T08:00:00.000Z';
const fact = (topic, i) => `${topic} fact ${i}: the database keeps every committed write durable on disk.`;
const text = topic => Array.from({ length: 4 }, (_, i) => fact(topic, i)).join(' ');
const page = (n, chapter) => ({ id: `p${n}`, title: `Book · p. ${n}`, text: text(`Page${n}`), courses: ['DB'], createdAt: at,
  document: { materialId: 'document-book', page: n, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'book.pdf', chapter } });
const CH = [{ index: 0, title: 'Indexes', level: 1 }, { index: 1, title: 'Transactions', level: 1 }];
const card = (id, sourceId, i = 1, topic = sourceId) => ({ id, kind: 'flashcard', topic, prompt: `Prompt ${id}?`, answer: 'A', citations: [{ sourceId, quote: fact(topic, i) }] });

function library(extra = []) {
  const sources = [page(1, CH[0]), page(2, CH[0]), page(3, CH[1]), page(4, CH[1]),
    { id: 'notes', title: 'Notes', text: text('Notes'), courses: ['DB'], createdAt: at },
    { id: 'tiny', title: '补充笔记 · Indexes', text: text('Tiny'), courses: ['DB'], createdAt: at },
    { id: 'quiz', title: 'JSON 导入：quiz', text: text('Quiz'), courses: ['DB'], createdAt: at }, ...extra];
  const decks = [{ id: 'd1', title: 'Deck', course: 'DB', cards: [card('c1', 'p1', 1, 'Page1'), card('c2', 'p3', 1, 'Page3'), card('c3', 'notes', 1, 'Notes'),
    card('c4', 'tiny', 1, 'Tiny'), card('c5', 'quiz', 2, 'Quiz'), card('c6', 'p2', 2, 'Page2')] }];
  return { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { course: 'DB' } };
}
const keys = state => Object.fromEntries(groupSourcesByDocument(state.sources).map(item => [item.title, item.key]));

/** An outline of the library: chapter "Storage" › section "Basics" › leaf Indexes (the book's first chapter + the tiny note); leaf Notes; the quiz left out. */
function outlineOf(state, extra = {}) {
  const k = keys(state), book = k['book.pdf'];
  return courseOutlineMaterial({ title: '总纲 · DB', course: 'DB', orderBasis: { codes: ['numbering', 'logic'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: 'DB' }).allDocuments),
    nodes: [{ id: 'n1', title: 'Storage', intro: 'How data is kept.', children: [
      { id: 'n2', title: 'Basics', intro: 'First things.', children: [{ id: 'n3', title: 'Indexes', anchors: [`${book}#0`, k['补充笔记 · Indexes']] }] },
      { id: 'n4', title: 'Lecture notes', anchors: [k.Notes] }] }],
    other: { anchors: [] }, counts: { units: 5, leftover: 2, invalid: 0, repeated: 0 }, ...extra });
}
const withOutline = (state, record) => ({ ...state, revision: 2, sources: [...state.sources, { ...record, createdAt: '2026-10-08T00:00:00.000Z' }] });

test('the record: an ordinary source with a readable outline, a content id, hidden from every list of materials and refused as material', () => {
  const state = library(), record = outlineOf(state);
  assert.match(record.id, /^course-outline-[0-9a-f]{40}$/);
  assert.equal(outlineOf(state).id, record.id, 'the same outline is the same record');
  assert.deepEqual([record.provenance, record.format, record.courses], ['course-outline', 'md', ['DB']]);
  assert.ok(isCourseOutlineSource(record) && isLibraryListSource(record) && !notExamPointList(record));
  assert.ok(!isCourseOutlineSource({ ...record, courseOutline: undefined }) && !isCourseOutlineSource({ ...record, provenance: 'exam-blueprint' }));
  assert.match(record.text, /## 1 Storage\n\nHow data is kept\.\n\n### 1\.1 Basics/);
  assert.match(record.text, /- 1\.1\.1 Indexes/);
  assert.match(record.text, /只是参考：它不是资料，不能用来出题/);
  assert.match(record.text, /学习顺序依据：资料标题里的编号.*；先学什么、后学什么的道理。/);
  assert.ok(!record.text.includes('#0') && !record.text.includes('pdf:'), 'no anchor key in the readable text');
  assert.throws(() => assertMaterials([record]), error => error.code === 'course-outline-not-material' && /课程总纲只是参考/.test(error.message));
  assert.deepEqual(groupSourcesByDocument(withOutline(state, record).sources).map(item => item.title), groupSourcesByDocument(state.sources).map(item => item.title), 'not a material in the 资料 list');
});

test('validation is deterministic: three levels at most, an anchor in one place, titles cut to size, ids content-derived', () => {
  const base = { course: 'DB', orderBasis: { codes: ['logic'] }, fingerprint: '0badc0de', other: { anchors: [] } };
  const leaf = (id, anchors) => ({ id, title: 'x', anchors });
  assert.throws(() => normalizeCourseOutline({ ...base, nodes: [{ id: 'a', title: 'a', children: [{ id: 'b', title: 'b', children: [{ id: 'c', title: 'c', children: [leaf('d', ['k'])] }] }] }] }), /three levels/);
  assert.throws(() => normalizeCourseOutline({ ...base, nodes: [leaf('a', ['k']), leaf('b', ['k'])] }), /Anchor in two places/);
  assert.throws(() => normalizeCourseOutline({ ...base, nodes: [leaf('a', ['k'])], other: { anchors: ['k'] } }), /Anchor in two places/);
  assert.throws(() => normalizeCourseOutline({ ...base, nodes: [] }), /at least one chapter/);
  assert.throws(() => normalizeCourseOutline({ ...base, fingerprint: 'nope', nodes: [leaf('a', ['k'])] }), /fingerprint/);
  const long = normalizeCourseOutline({ ...base, nodes: [{ id: 'a', title: 'T'.repeat(300), intro: 'I'.repeat(400), anchors: ['k'] }], orderBasis: { codes: ['magic', 'syllabus'], syllabus: '大纲' } });
  assert.equal(long.nodes[0].title.length, OUTLINE_LIMITS.titleChars);
  assert.ok(long.nodes[0].title.endsWith('…') && long.nodes[0].intro.length === OUTLINE_LIMITS.introChars);
  assert.deepEqual(long.orderBasis, { codes: ['syllabus'], syllabus: '大纲' }, 'an unknown ground is dropped');
  const taken = new Set();
  assert.equal(nodeId(taken, ['leaf', 'x', ['k']]), nodeId(new Set(), ['leaf', 'x', ['k']]), 'the id comes from the content');
  assert.match(nodeId(taken, ['leaf', 'x', ['k']]), /^n[0-9a-f]{10}-2$/, 'an equal node is told apart');
  assert.match(courseOutlineText('T', long), /学习顺序依据：讲义大纲《大纲》的顺序。/);
});

test('the page reads the outline over the engine: counts computed now, 其他 holds what no leaf holds, a leaf opens to its rows', () => {
  const state = library(), record = outlineOf(state), seen = withOutline(state, record);
  const answer = courseOutline(seen, { course: 'DB' }, { now: NOW });
  assert.equal(answer.book.id, record.id);
  assert.equal(answer.book.stale, false);
  const [storage] = answer.book.nodes, [basics, notes] = storage.children, [indexes] = basics.children;
  assert.deepEqual([storage.title, storage.depth, basics.title, indexes.title, notes.title], ['Storage', 1, 'Basics', 'Indexes', 'Lecture notes']);
  assert.deepEqual([indexes.total, indexes.anchors, indexes.opensRows, notes.total, notes.anchors, notes.opensRows], [3, 2, true, 1, 1, false], 'c1, c6 (book chapter 1) and c4 (the note)');
  assert.equal(storage.total, 4);
  assert.equal(answer.book.other.total, 2, 'the book\'s second chapter (c2) and the quiz (c5) are in 其他');
  assert.equal(answer.book.other.anchors, 2);
  assert.equal(answer.book.nodes.flatMap(function all(node) { return [node, ...(node.children || []).flatMap(all)]; }).some(node => node.tier), false, 'no paper, no tier');
  // A leaf opens to its rows (the chapter, named with its material, and the note); a one-row leaf to its questions.
  const opened = courseOutline(seen, { course: 'DB', expand: [indexes.key, notes.key, OTHER_KEY] }, { now: NOW }).open;
  assert.deepEqual(opened[indexes.key].anchors.map(row => [row.kind, row.title, row.material ?? null, row.total]), [['chapter', 'Indexes', 'book.pdf', 2], ['document', '补充笔记 · Indexes', null, 1]]);
  assert.deepEqual(opened[notes.key].cards.map(ref => ref.cardId), ['c3']);
  assert.deepEqual(opened[OTHER_KEY].anchors.map(row => row.title).sort(), ['JSON 导入：quiz', 'Transactions']);
  // Practising a chapter of the outline is practising its questions, once each.
  const { practice } = courseOutline(seen, { course: 'DB', pick: { keys: [storage.key, indexes.key] } }, { now: NOW });
  assert.deepEqual(practice.scope.map(ref => ref.cardId).sort(), ['c1', 'c3', 'c4', 'c6']);
});

test('an outline goes out of date when the course\'s materials change; a deck filter leaves out the nodes without its questions; the newest outline of the course is read', () => {
  const state = library(), record = outlineOf(state), seen = withOutline(state, record);
  const added = { ...seen, revision: 3, sources: [...seen.sources, { id: 'new', title: 'New handout', text: text('New'), courses: ['DB'], createdAt: at }] };
  const answer = courseOutline(added, { course: 'DB' }, { now: NOW });
  assert.equal(answer.book.stale, true);
  assert.equal(answer.book.other.anchors, 3, 'the new material is in 其他 at once, never hidden');
  const renamed = { ...seen, revision: 4, sources: seen.sources.map(source => source.id === 'notes' ? { ...source, title: 'Notes (v2)' } : source) };
  assert.equal(courseOutline(renamed, { course: 'DB' }, { now: NOW }).book.stale, true);
  const filtered = { ...seen, revision: 5, decks: [...seen.decks, { id: 'd2', title: 'Other deck', course: 'DB', cards: [card('x1', 'notes', 2, 'Notes')] }] };
  const only = courseOutline(filtered, { course: 'DB', deckId: 'd2' }, { now: NOW });
  assert.deepEqual(only.book.nodes.map(node => [node.title, node.children.map(child => child.title)]), [['Storage', ['Lecture notes']]]);
  assert.equal(only.book.other, null);
  // A newer outline of the course is the one read; an archived one or another course's is not.
  const newer = outlineOf(state, { orderBasis: { codes: ['logic'] } });
  const both = { ...seen, revision: 6, sources: [...seen.sources, { ...newer, createdAt: '2026-10-09T00:00:00.000Z' }, { ...outlineOf(state, { course: 'PE' }), courses: ['PE'], createdAt: '2026-10-10T00:00:00.000Z' }] };
  assert.equal(currentCourseOutline(both.sources, 'DB').id, newer.id);
  assert.equal(currentCourseOutline(both.sources.map(source => source.id === newer.id ? { ...source, archived: true } : source), 'DB').id, record.id);
  assert.equal(currentCourseOutline(both.sources, '*'), null);
  assert.equal(courseOutline(state, { course: 'DB' }, { now: NOW }).book, null, 'no outline: the v3.3.0 view alone');
});

test('a leaf\'s anchor that is no longer a row is passed over; a document claimed whole by one leaf is not listed again', () => {
  const state = library(), k = keys(state);
  const layout = new Map([[k.Notes, { key: k.Notes, kind: 'document', item: {}, chapters: [], nodes: [k.Notes] }]]);
  const book = bookLayout(layout, { nodes: [{ id: 'a', title: 'A', anchors: ['gone', k.Notes] }, { id: 'b', title: 'B', anchors: [k.Notes] }], other: { anchors: [] } });
  assert.deepEqual([book.rows.get('bk:a').anchors, book.rows.get('bk:b').anchors, book.other.anchors], [[k.Notes], [], []]);
});

test('a document\'s questions outside its chapters go with the leaf that holds its first claimed chapter; its unclaimed chapters go to 其他', () => {
  const chapter = (key, nodes) => ({ key, kind: 'chapter', nodes: [key] });
  const doc = { key: 'D', kind: 'document', item: {}, chapters: [chapter('D#0'), chapter('D#1'), { key: 'D#rest', kind: 'rest', nodes: ['D#rest'] }], nodes: ['D#0', 'D#1', 'D#rest'] };
  const layout = new Map([['D', doc], ...doc.chapters.map(row => [row.key, row])]);
  const book = bookLayout(layout, { nodes: [{ id: 'a', title: 'A', anchors: ['D#1'] }], other: { anchors: [] } });
  assert.deepEqual([book.rows.get('bk:a').anchors, book.rows.get('bk:a').nodes, book.other.anchors], [['D#1', 'D#rest'], ['D#1', 'D#rest'], ['D#0']]);
  const whole = bookLayout(layout, { nodes: [{ id: 'a', title: 'A', anchors: ['D'] }], other: { anchors: [] } });
  assert.deepEqual([whole.rows.get('bk:a').anchors, whole.rows.get('bk:a').opensRows, whole.other.anchors], [['D'], true, []], 'a whole document opens to its chapters first');
});
