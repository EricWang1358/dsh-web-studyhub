/* 复习全书 M1 (docs/plans/review-book.md): the book of a course as Markdown files in one hidden record, made from the outline and its notes; generated
   files kept current, the learner's never touched; files mapped again after an outline rebuild (I3); stable heading ids and per-file footnotes (I4); only
   three question links (I5); never a material, in no list, search or retrieval (I6); the fixtures of I9. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { openCourseBook, remapManifest, genText } from '../lib/course-book-files.js';
import { assignHeadingIds, bookIndex, bookLinks, parseBookLink, plainBook, stitchBook } from '../lib/course-book-links.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { assertMaterials, isLibraryListSource, notExamPointList } from '../lib/exam-point-list.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const lectureKey = sources => groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
function outlineOf(state, nodes, extra = {}) {
  return { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 }, ...extra }), createdAt: extra.createdAt || '2026-10-09T00:00:00.000Z' };
}
/** The synthetic course: an outline of lecture 1's chapters 0 and 1 (two points), notes of the first point (with `papers`, a 考情). */
function library({ notes = true, papers = false } = {}) {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources);
  const outline = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
    { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }], papers ? { papers: [{ key: 'doc:x', title: 'Paper', sourceIds: ['document-l6-p1'] }] } : {});
  state.sources.push(outline);
  if (notes) {
    const page = sources.find(source => source.id === 'document-l1-p1'), leaf = outline.courseOutline.nodes[0].children[0];
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: [{ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: ['Architects decide [^1].'], explain: 'They keep a log [^1][^2].', cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 },
        { n: 2, sourceId: page.id, quote: page.text.slice(30, 60), start: 30, end: 60 }] }, ...(papers ? { exam: { fingerprint: 'e'.repeat(16), tested: true, note: 'Asked as a short answer.' } } : {}) }] }),
      createdAt: '2026-10-09T01:00:00.000Z' });
  }
  return { state, outline, lecture };
}
const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));
const bookOf = state => state.sources.find(source => source.provenance === 'course-book-doc');

test('open makes the files from the outline and its notes: headings by the manifest, a generated and an own file per point, questions as links; again, nothing changes', () => {
  const { state } = library();
  const book = openCourseBook(state, {});
  assert.equal(book.status, 'ok');
  assert.equal(book.notes, true);
  assert.deepEqual(book.nodes.map(node => [node.number, node.title, node.leaf]), [['1', 'Introduction', false]]);
  const [what, who] = leaves(book.nodes);
  assert.deepEqual([what.number, what.title, who.number, who.title], ['1.1', 'What architects do', '1.2', 'Stakeholders']);
  assert.ok(/^h\d+$/.test(what.hid) && what.hid !== who.hid);
  assert.match(what.gen, /\*\*知识梳理\*\*\n\n- Architects decide \[\^1\]\./);
  assert.match(what.gen, /\[\^2\]: \[「[^」]+」\]\(studyhub:\/\/source\/document-l1-p1\)/);
  assert.doesNotMatch(what.gen, /studyhub:\/\/card\//, 'no list of questions is stored in a file');
  assert.match(what.gen, new RegExp(`\\[练 5 道：What architects do\\]\\(studyhub://practice\\?heading=${what.hid}&n=5\\) · \\[本节问答：What architects do\\]\\(studyhub://qa\\?heading=${what.hid}\\)$`));
  assert.equal(what.questionTotal, 25, 'the point\'s questions are read live');
  assert.deepEqual(Object.keys(what.questions[0]), ['deckId', 'cardId', 'prompt']);
  assert.equal(what.questions[0].deckId, 'deck-l1');
  assert.equal(bookOf(state).text, '复习全书（由 StudyHub 3.4 以上管理，请勿删除）', 'an older release that lists it shows what it is');
  assert.equal(what.mine, '');
  assert.doesNotMatch(what.gen, /考情/, 'no sample paper: nothing about exams');
  const record = bookOf(state);
  assert.deepEqual(Object.keys(record.bookDoc.files).sort(), ['unplaced.md', 'what.gen.md', 'what.mine.md', 'who.gen.md', 'who.mine.md'].map(name => name.replace(/^(what|who)/, id => leaves(record.bookDoc.manifest.nodes).find(node => node.title.startsWith(id === 'what' ? 'What' : 'Stake')).id)).sort());
  assert.equal(openCourseBook(state, {}).revision, book.revision, 'opening again changes nothing');
});

test('generated files follow the notes and questions; the learner\'s file and a changed generated file are never touched (I2)', () => {
  const { state } = library();
  const first = openCourseBook(state, {}), record = bookOf(state), [what, who] = leaves(record.bookDoc.manifest.nodes);
  record.bookDoc.files[`${what.id}.mine.md`].text = 'My own note.';
  record.bookDoc.files[`${who.id}.gen.md`] = { ...record.bookDoc.files[`${who.id}.gen.md`], text: 'I changed this.', forked: true };
  state.decks.find(deck => deck.id === 'deck-l1').cards.push({ id: 'new1', kind: 'flashcard', topic: 'Stakeholders and concerns', prompt: 'A new question?', answer: 'A.',
    citations: [{ sourceId: 'document-l1-p3', quote: 'Stakeholders and concerns fact 0: the architect records this decision and its reasons in the decision log.' }] });
  state.decks.find(deck => deck.id === 'deck-l1').cards = state.decks.find(deck => deck.id === 'deck-l1').cards.filter(card => card.prompt !== state.decks.find(deck => deck.id === 'deck-l1').cards[0].prompt);
  state.revision = 2;
  const again = openCourseBook(state, {}), [whatView, whoView] = leaves(again.nodes);
  assert.equal(again.changed, false, 'questions added or deleted change no file');
  assert.equal(again.revision, first.revision);
  assert.equal(whatView.mine, 'My own note.');
  assert.equal(whatView.questionTotal, 24, 'a question removed: the live list follows');
  assert.equal(whoView.gen, 'I changed this.', 'a generated file the learner changed stays as it is');
  // The notes change: the generated file that nobody changed follows, the forked one does not.
  const notesRecord = state.sources.find(source => source.provenance === 'course-outline-notes');
  notesRecord.courseNotes.leaves[0].body = { ...notesRecord.courseNotes.leaves[0].body, explain: 'Rewritten.' };
  state.revision = 3;
  const third = openCourseBook(state, {});
  assert.equal(third.changed, true);
  assert.match(leaves(third.nodes)[0].gen, /Rewritten\./);
  assert.equal(leaves(third.nodes)[1].gen, 'I changed this.');
});

test('an outline rebuild maps the files by anchors, then by title; what cannot be mapped goes to 未归位 marked 已无对应知识点; nothing is deleted (I3)', () => {
  const { state, outline, lecture } = library();
  openCourseBook(state, {});
  const record = bookOf(state), [what, who] = leaves(record.bookDoc.manifest.nodes);
  record.bookDoc.files[`${what.id}.mine.md`].text = 'Note on what architects do.';
  record.bookDoc.files[`${who.id}.mine.md`].text = 'Note on stakeholders.';
  // The rebuild: new ids; "What architects do" keeps its anchor under another name, "Stakeholders" is gone, a new point and a renamed chapter.
  const rebuilt = outlineOf(state, [{ id: 'k1', title: 'Introduction', children: [{ id: 'k2', title: 'The architect\'s job', anchors: [`${lecture}#0`] }, { id: 'k3', title: 'Views', anchors: [`${lecture}#2`] }] }],
    { createdAt: '2026-10-10T00:00:00.000Z' });
  state.sources = state.sources.map(source => (source.id === outline.id ? { ...source, archived: true } : source)).concat(rebuilt);
  const book = openCourseBook(state, {}), [job, views] = leaves(book.nodes);
  assert.equal(job.hid, what.hid, 'mapped by anchors: the same heading id');
  assert.equal(job.mine, 'Note on what architects do.');
  assert.equal(book.nodes[0].hid, record.bookDoc.manifest.nodes[0].hid, 'the chapter of the same title keeps its id');
  assert.ok(views.hid !== what.hid && views.hid !== who.hid, 'a new point gets a new id, never an old one');
  assert.match(book.unplaced.text, /### Stakeholders（已无对应知识点）\n\nNote on stakeholders\./);
  // Mapped by title when the anchors changed.
  const titled = outlineOf(state, [{ id: 'm1', title: 'Introduction', children: [{ id: 'm2', title: 'The architect\'s job', anchors: [`${lecture}#1`] }] }], { createdAt: '2026-10-11T00:00:00.000Z' });
  state.sources = state.sources.map(source => (source.id === rebuilt.id ? { ...source, archived: true } : source)).concat(titled);
  assert.equal(leaves(openCourseBook(state, {}).nodes)[0].hid, what.hid);
  assert.match(openCourseBook(state, {}).unplaced.text, /Note on stakeholders\./, '未归位 keeps what it holds');
  const { nodes, lost } = remapManifest({ nodes: [{ id: 'a', hid: 'h1', title: 'A', leaf: true, anchors: ['x'], children: [] }] }, [{ id: 'b', title: 'B', anchors: ['y'] }], 2);
  assert.deepEqual([nodes[0].hid, lost.map(node => node.id)], ['h2', ['a']]);
});

test('heading ids are stable when sections are inserted before, moved or deleted, never reused; footnotes are named per file when stitched (I4)', () => {
  const start = assignHeadingIds('# Book\n\n## One\ntext [练习：Q](studyhub://card/d/q1)\n\n## Two\n\n### Two a\n[练 5 道：Two](studyhub://practice?heading=h9&n=5)\n```\n# not a heading\n```\n');
  const ids = text => Object.fromEntries(bookIndex(text).flat.map(item => [item.title, item.id]));
  const given = ids(start.text);
  assert.deepEqual(Object.keys(given), ['Book', 'One', 'Two', 'Two a'], 'a # inside a code fence is no heading');
  assert.ok(Object.values(given).every(id => /^h\d+$/.test(id)) && new Set(Object.values(given)).size === 4);
  const inserted = ids(assignHeadingIds(start.text.replace('## One', '## Zero\n\n## One'), { next: start.next }).text);
  assert.deepEqual({ ...inserted, Zero: undefined }, { ...given, Zero: undefined }, 'inserting before renumbers nothing');
  assert.ok(!Object.values(given).includes(inserted.Zero));
  const [head, one, two] = start.text.split(/\n(?=## )/);
  assert.deepEqual(ids(assignHeadingIds([head, two, one].join('\n'), { next: start.next }).text), given, 'moving a section keeps its id');
  const deleted = assignHeadingIds([head, two].join('\n'), { next: start.next });
  assert.deepEqual(ids(deleted.text), { Book: given.Book, Two: given.Two, 'Two a': given['Two a'] });
  const typed = assignHeadingIds(`${deleted.text}\n## Back\n`, { next: deleted.next });
  assert.ok(!Object.values(given).includes(ids(typed.text).Back), 'an id is never reused, not even a deleted one');
  const copied = ids(assignHeadingIds(`${start.text}\n## One again <!-- sh:id ${given.One} -->\n`, { next: start.next }).text);
  assert.ok(copied.One === given.One && copied['One again'] !== given.One, 'a copied id is given anew on the later heading');
  assert.equal(assignHeadingIds(start.text, { next: start.next }).text, start.text);
  const stitched = stitchBook({ title: '复习全书 · SA', nodes: [{ hid: 'h1', number: '1', title: 'A', leaf: true, gen: 'x [^1]\n\n[^1]: one', mine: 'y [^1]\n\n[^1]: mine', children: [] },
    { hid: 'h2', number: '2', title: 'B', leaf: true, gen: 'z [^1]\n\n[^1]: two', mine: '', children: [] }], unplaced: { title: '未归位', text: '' } });
  const marks = [...stitched.matchAll(/^\[\^([^\]]+)\]:/gm)].map(match => match[1]);
  assert.deepEqual(marks, ['h1g-1', 'h1m-1', 'h2g-1'], 'no two files share a footnote');
  assert.equal(stitchBook({ title: 'T', nodes: [], unplaced: { title: 'U', text: '' } }), stitchBook({ title: 'T', nodes: [], unplaced: { title: 'U', text: '' } }), 'deterministic');
  assert.doesNotMatch(plainBook(stitched), /sh:id/, 'plain Markdown hides the ids');
  const { tree } = bookIndex(start.text);
  assert.deepEqual(tree.map(node => [node.title, node.children.map(child => child.title)]), [['Book', ['One', 'Two']]]);
  assert.deepEqual(tree[0].children[0].links.map(link => [link.kind, link.cardId, link.text]), [['card', 'q1', '练习：Q']]);
  assert.deepEqual(tree[0].children[1].children[0].links.map(link => [link.kind, link.heading, link.n]), [['practice', 'h9', 5]]);
});

test('only the three question links (and a footnote\'s place) are interpreted (I5)', () => {
  assert.deepEqual(parseBookLink(bookLinks.card('d', 'q 1')), { kind: 'card', deckId: 'd', cardId: 'q 1' });
  assert.deepEqual(parseBookLink(bookLinks.practice('h3')), { kind: 'practice', heading: 'h3', n: 5 });
  assert.deepEqual(parseBookLink('studyhub://practice?heading=h3&n=999'), { kind: 'practice', heading: 'h3', n: 5 });
  assert.deepEqual(parseBookLink(bookLinks.qa('h3')), { kind: 'qa', heading: 'h3' });
  assert.deepEqual(parseBookLink(bookLinks.source('s1')), { kind: 'source', sourceId: 's1' });
  for (const other of ['https://example.com', 'studyhub://delete/d/q1', 'studyhub://card/d', 'studyhub://practice?node=bk%3Aa', 'javascript:alert(1)', '']) assert.equal(parseBookLink(other), null, other);
});

test('the fixtures: no notes, a point without questions, a single point, sample papers (I9)', () => {
  const bare = library({ notes: false }).state, open = openCourseBook(bare, {});
  assert.equal(open.notes, false, 'no notes: the page shows its empty state');
  assert.doesNotMatch(leaves(open.nodes)[0].gen, /知识梳理/);
  assert.equal(genText({ notes: null, hid: 'h1', title: 'X', language: 'zh' }), '[练 5 道：X](studyhub://practice?heading=h1&n=5) · [本节问答：X](studyhub://qa?heading=h1)');
  assert.equal(genText({ notes: null, hid: 'h1', title: 'X', language: 'en' }), '[Practise 5: X](studyhub://practice?heading=h1&n=5) · [Questions and answers: X](studyhub://qa?heading=h1)');
  assert.equal(leaves(open.nodes)[1].questionTotal, 25);
  const { state, lecture } = library({ notes: false });
  state.sources = state.sources.filter(source => !source.courseOutline).concat(outlineOf(state, [{ id: 'only', title: 'The only point', anchors: [`${lecture}#0`] }]));
  const single = openCourseBook(state, {});
  assert.deepEqual(single.nodes.map(node => [node.number, node.title, node.leaf]), [['1', 'The only point', true]]);
  const withPaper = openCourseBook(library({ papers: true }).state, {});
  assert.equal(withPaper.papers, 1);
  assert.match(leaves(withPaper.nodes)[0].gen, /^\*\*考情\*\* 样卷考过。 Asked as a short answer\./);
  assert.equal(openCourseBook({ ...bare, sources: bare.sources.filter(source => !source.courseOutline) }, {}).reason, 'no-outline');
});

test('the book is never material: no 资料 list, no search, no context count, no retrieval, refused as material (I6)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-book-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('snapshot');
  const { state } = library();
  await service.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  const before = await service.call('library.context', {});
  const opened = await service.call('course.book.open');
  assert.equal(opened.status, 'ok');
  const revision = (await service.store.read()).revision;
  const again = await service.call('course.book.open');
  assert.equal(again.changed, false);
  assert.equal((await service.store.read()).revision, revision, 'an unchanged open does not write the library');
  assert.deepEqual(again.nodes, opened.nodes);
  const record = bookOf(await service.store.read());
  assert.ok(record && isLibraryListSource(record) && !notExamPointList(record));
  assert.throws(() => assertMaterials([record]), error => error.code === 'course-book-doc-not-material');
  assert.ok(!(await service.call('source.list', {})).sources.some(source => source.id === record.id), 'not in the 资料 list');
  const found = await service.call('source.search', { query: 'Architects decide' });
  assert.ok(!JSON.stringify(found).includes(record.id), 'not found by the library search');
  assert.equal(JSON.stringify(await service.call('library.context', {})).includes(record.id), false, 'not in the main session\'s context');
  assert.deepEqual((await service.call('library.context', {})).counts?.sources, before.counts?.sources, 'not counted as a source');
  // The retrieval index takes its sources through notExamPointList (lib/contexts/generation/retrieval-operations.js), so the book is never indexed.
  const retrieval = await readFile(new URL('../lib/contexts/generation/retrieval-operations.js', import.meta.url), 'utf8');
  assert.match(retrieval, /sources\.filter\(source => notExamPointList\(source\)/);
  assert.equal(JSON.stringify(await service.call('snapshot')).includes('还有 5 道题'), false, 'the book is read on demand, not carried by the snapshot');
  assert.match(libraryContracts.learning, /course\.book\.open \{course\?\}/);
  assert.match(studyToolDescription, /course\.outline\.qa, course\.book\.open/);
});
