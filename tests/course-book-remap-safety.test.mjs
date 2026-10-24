/* #461: after the 总纲 is organised again, the review book's points follow their pages to the new points (lib/course-book-remap.js). A point's own text (the
   learner's file, a generated file the learner changed, its Q&A) moves to a new point of ANOTHER title only when that point holds most of the old point's
   pages (MOVE_MIN_SHARE); otherwise it waits in 未归位 under its old title, saying which point was closest, instead of sitting under a wrong title. Every
   move is recorded with how much of the old point the new one holds. A rebuild of an outline whose book holds the learner's own text asks for `confirm`
   first. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_MIN_SHARE, remapManifest } from '../lib/course-book-remap.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';

const leaf = (id, hid, title, anchors) => ({ id, hid, title, leaf: true, anchors, children: [] });
const span = (sourceId, start, end) => ({ sourceId, start, end });

test('a point of another title takes the old point\'s text only when it holds most of its pages; else the old point is held back, with the closest point named', () => {
  const pages = { a: [span('s1', 0, 100)], b: [span('s1', 0, 10), span('s2', 0, 1000)], c: [span('s3', 0, 100)], d: [span('s3', 0, 70), span('s4', 0, 30)] };
  const sourcesOf = anchor => pages[anchor];
  const old = { nodes: [leaf('A', 'h1', 'Cloud native', ['a']), leaf('C', 'h2', 'Layers', ['c'])] };
  const { nodes, moved, held, lost } = remapManifest(old, [{ id: 'B', title: 'Databases state failure conditions', anchors: ['b'] },
    { id: 'D', title: 'Layered style', anchors: ['d'] }], 3, { sourcesOf });
  assert.ok(MOVE_MIN_SHARE > 0.1 && MOVE_MIN_SHARE <= 0.7);
  assert.equal(moved.has('A'), false, 'one tenth of "Cloud native" is in the new point: its text does not go under that title');
  assert.deepEqual(held.map(item => [item.node.id, item.likely, item.share]), [['A', 'B', 0.1]]);
  assert.equal(nodes[0].hid, 'h3', 'the new point gets a new heading id, not the old one');
  assert.deepEqual([moved.get('C'), nodes[1].hid, nodes[1].movedFrom, nodes[1].moveShare], ['D', 'h2', 'Layers', 0.7], 'a renamed point holding most of the pages keeps them');
  assert.deepEqual(lost, []);
  // A new point that is mostly a part of the old one (a point cut into its sections) takes it too.
  const part = remapManifest({ nodes: [leaf('W', 'h1', 'Whole lecture', ['w'])] }, [{ id: 'P', title: 'Its first section', anchors: ['p1'] }, { id: 'Q', title: 'Its second', anchors: ['p2'] },
    { id: 'R', title: 'Its third', anchors: ['p3'] }], 3, { sourcesOf: anchor => ({ w: [span('s9', 0, 300)], p1: [span('s9', 0, 100)], p2: [span('s9', 100, 200)], p3: [span('s9', 200, 300)] })[anchor] });
  assert.deepEqual([part.moved.get('W'), part.held.length, part.nodes[0].moveShare], ['P', 0, 0.33]);
  // However many parts: a lecture cut into 6 or 12 points follows into its first part, nothing held, nothing lost.
  for (const count of [6, 12]) {
    const parts = Array.from({ length: count }, (_, at) => ({ id: `P${at}`, title: `Section ${at + 1}`, anchors: [`p${at}`] }));
    const sourcesOf = anchor => (anchor === 'w' ? [span('s9', 0, count * 100)] : [span('s9', Number(anchor.slice(1)) * 100, Number(anchor.slice(1)) * 100 + 100)]);
    const cut = remapManifest({ nodes: [leaf('W', 'h1', 'Whole lecture', ['w'])] }, parts, 3, { sourcesOf });
    assert.deepEqual([cut.moved.get('W'), cut.held.length, cut.lost.length, cut.nodes[0].hid], ['P0', 0, 0, 'h1'], `${count} parts`);
  }
  // The same title moves whatever the share; an old point held back may still be matched by its title.
  const titled = remapManifest(old, [{ id: 'B', title: 'Cloud native', anchors: ['b'] }], 3, { sourcesOf });
  assert.deepEqual([titled.moved.get('A'), titled.held.length, titled.nodes[0].hid], ['B', 0, 'h1']);
  // A fold (two old points into one new one) is held back the same way when the new point holds little of the folded one.
  const fold = remapManifest({ nodes: [leaf('A', 'h1', 'Cloud native', ['a']), leaf('E', 'h2', 'Edge', ['e'])] }, [{ id: 'B', title: 'Databases', anchors: ['b', 'f'] }], 3,
    { sourcesOf: anchor => ({ ...pages, e: [span('s5', 0, 100)], f: [span('s5', 0, 2000)] })[anchor] });
  assert.deepEqual([[...fold.moved], [...fold.folded], fold.held.map(item => item.node.id)], [[['E', 'B']], [], ['A']]);
});

const lectureKey = sources => groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
function outlineOf(state, nodes, createdAt) {
  return { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt };
}
const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));
const bookOf = state => state.sources.find(source => source.provenance === 'course-book-doc');

test('the book: a learner\'s note whose pages went mostly elsewhere waits in 未归位 under its old title; the moves say what moved where and how much', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources), other = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l3-p1')).key;
  const first = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
    { id: 'who', title: 'Stakeholders and views', anchors: [`${lecture}#1`, `${lecture}#2`] }] }], '2026-10-09T00:00:00.000Z');
  state.sources.push(first);
  openCourseBook(state, {});
  const record = bookOf(state), [what, who] = leaves(record.bookDoc.manifest.nodes);
  record.bookDoc.files[`${what.id}.mine.md`].text = 'Note on what architects do.';
  record.bookDoc.files[`${who.id}.mine.md`].text = 'A long note on stakeholders and views.';
  // The rebuild: "What architects do" keeps its chapter under a new name; one page of the four of "Stakeholders and views" is now in a point that is mostly
  // another lecture (a point on another topic).
  const rebuilt = outlineOf(state, [{ id: 'k1', title: 'Introduction', children: [{ id: 'k2', title: 'The architect\'s job', anchors: [`${lecture}#0`] },
    { id: 'k3', title: 'Databases state failure conditions', anchors: [`${lecture}@s2-2`, other] }] }], '2026-10-10T00:00:00.000Z');
  state.sources = state.sources.map(source => (source.id === first.id ? { ...source, archived: true } : source)).concat(rebuilt);
  const book = openCourseBook(state, {}), [job, databases] = leaves(book.nodes);
  assert.deepEqual([job.hid, job.mine, job.movedFrom], [what.hid, 'Note on what architects do.', 'What architects do']);
  assert.equal(databases.mine, '', 'the note on stakeholders is not put under a point on databases');
  assert.notEqual(databases.hid, who.hid);
  assert.match(book.unplaced.text, /### Stakeholders and views（总纲重新整理后对不上新的知识点，先放在这里；最接近的是「Databases state failure conditions」，只有 \d+% 的页在那里）\n\nA long note on stakeholders and views\./);
  // The moves list only what moved; what was held back is listed apart (it is in 未归位, not under the closest point).
  assert.deepEqual(book.moves.list, [{ from: 'What architects do', to: 'The architect\'s job', folded: false, share: 1 }]);
  assert.equal(book.moves.total, book.moves.list.length, 'how many moves there were, so a cut list says so');
  assert.equal(book.moves.held, 1);
  const [kept] = book.moves.heldList;
  assert.deepEqual([kept.from, kept.closest], ['Stakeholders and views', 'Databases state failure conditions']);
  assert.ok(kept.share > 0 && kept.share < MOVE_MIN_SHARE);
});

test('the book: a 3.4 point of a whole lecture cut into six points follows to the first of them; nothing waits in 未归位', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources);
  const first = outlineOf(state, [{ id: 'c1', title: 'Materials', children: [{ id: 'lec', title: '01. Introduction to Solution Architecture v2.1', anchors: [lecture] }] }],
    '2026-10-09T00:00:00.000Z');
  state.sources.push(first);
  openCourseBook(state, {});
  bookOf(state).bookDoc.files['lec.mine.md'].text = 'My own note on the lecture.';
  const six = Array.from({ length: 6 }, (_, at) => ({ id: `s${at}`, title: `Page ${at + 1} topic`, anchors: [`${lecture}@s${at}-${at}`] }));
  state.sources = state.sources.map(source => (source.id === first.id ? { ...source, archived: true } : source))
    .concat(outlineOf(state, [{ id: 'c2', title: 'Introduction', children: six }], '2026-10-10T00:00:00.000Z'));
  const book = openCourseBook(state, {});
  assert.equal(book.unplaced.text.trim(), '');
  assert.equal(leaves(book.nodes).filter(point => point.mine === 'My own note on the lecture.').length, 1, 'the note is in the part it shares most with');
  assert.equal(book.moves.held, 0);
});

test('organising the outline again when the book holds the learner\'s own text asks for confirm first, saying what will happen; an empty book does not', async t => {
  const fake = outlineModel({ inventory: 'none' }), root = await privateRoot(t, 'course-book-remap-safety-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const build = async (extra = {}) => service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...extra });
  const settle = async extra => assert.equal((await settleJob(service, (await build(extra)).jobId)).status, 'complete');
  await settle();
  const opened = await service.call('course.book.open', { course: COURSE });
  await settle();
  const calls = fake.calls.length, point = leaves(opened.nodes)[0];
  await service.call('course.book.save', { course: COURSE, file: point.files.mine, text: 'My own note.', version: opened.files[point.files.mine].version });
  await assert.rejects(build(), error => {
    assert.equal(error.code, 'course-outline-book-confirm', error.message);
    assert.match(error.message, new RegExp(`复习全书里有你自己写的内容（1 个知识点：「${point.title}」）.*未归位.*confirm: true`));
    return true;
  });
  await assert.rejects(build({ language: 'en' }), error => error.code === 'course-outline-book-confirm' && /confirm: true/.test(error.message) && /1 knowledge point/.test(error.message));
  assert.equal(fake.calls.length, calls, 'refused before any model call');
  // The review book asked to organise it again (rebuildOutline, here over an outline of an older version) asks the same.
  await service.store.update(state => { for (const source of state.sources) if (source.provenance === 'course-outline' && !source.archived) delete source.courseOutline.from; });
  await assert.rejects(service.call('generation.courseBook.build', { course: COURSE, language: 'zh', rebuildOutline: true }),
    error => error.code === 'course-outline-book-confirm' && /confirm: true/.test(error.message));
  assert.equal(fake.calls.length, calls);
  await settle({ confirm: true });
});
