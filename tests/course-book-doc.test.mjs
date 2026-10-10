/* The 复习全书 as one Markdown text with links to questions (lib/course-book-doc.js, lib/course-book-doc-ops.js): assembled from the outline, its notes
   and the questions; generated sections in markers, replaced only when nobody edited them (an edited one gets a suggestion); a 追问 made in practice lands
   under the card's link once, only when the book links the card; the record is the learner's and never a material. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { acceptSuggestion, assembleBook, assignHeadingIds, bookIndex, bookLinks, bookSections, genSections, insertFollowup, insertRegion, mergeBook, parseBookLink, plainBook, rebaseBook } from '../lib/course-book-doc.js';
import { openBookDoc, saveBookDoc, bookDocSuggestion, undoBookDoc } from '../lib/course-book-doc-ops.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { assertMaterials, isLibraryListSource } from '../lib/exam-point-list.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const nodes = [{ id: 'c1', key: 'bk:c1', title: 'Introduction', leaf: false, children: [
  { id: 'what', key: 'bk:what', title: 'What architects do', leaf: true }, { id: 'who', key: 'bk:who', title: 'Stakeholders', leaf: true }] }];
const notes = { what: { id: 'what', body: { points: ['Architects decide [^1].'], explain: 'They keep a decision log [^1][^2].', cites: [
  { n: 1, sourceId: 's1', quote: 'the architect records this decision', title: 'Lecture 1' }, { n: 2, sourceId: 's1', quote: 'and its reasons', title: 'Lecture 1' }] } },
who: { id: 'who', exam: { tested: true, note: 'Asked as a short answer.' }, body: { points: ['Stakeholders have concerns [^1].'], explain: 'Each has a view.', cites: [{ n: 1, sourceId: 's2', quote: 'concerns', title: 'Lecture 1' }] } } };
const questions = { 'bk:what': [{ deckId: 'd', cardId: 'q1', prompt: 'What does an architect record?' }, { deckId: 'd', cardId: 'q2', prompt: 'Why a log?' }], 'bk:who': [] };
const book = (over = {}) => assembleBook({ title: COURSE, nodes, notesOf: id => (over.notes || notes)[id] ?? null, questionsOf: key => (over.questions || questions)[key] || [], language: over.language || 'zh' });

test('the book is Markdown: headings by the outline, notes and questions in generated sections, links that read as links, footnotes unique in the book', () => {
  const text = book();
  assert.match(text, /^# 复习全书 · SA\n/);
  assert.match(text, /<!-- sh:id bk:c1 -->\n## 1 Introduction/);
  assert.match(text, /<!-- sh:id bk:what -->\n### 1\.1 What architects do/);
  assert.deepEqual(genSections(text).map(section => [section.id, section.edited]), [['what.notes', false], ['what.q', false], ['who.notes', false], ['who.q', false]]);
  assert.match(text, /They keep a decision log \[\^1\]\[\^2\]\./);
  assert.match(text, /Stakeholders have concerns \[\^3\]\./, 'the next point numbers its footnotes on');
  assert.match(text, /\[\^3\]: \[「concerns」\]\(studyhub:\/\/source\/s2\) · Lecture 1/);
  assert.match(text, /- \[练习：What does an architect record\?\]\(studyhub:\/\/card\/d\/q1\)/);
  assert.match(text, /\[练 5 道：What architects do\]\(studyhub:\/\/practice\?node=bk%3Awhat&n=5\) · \[本节问答：What architects do\]\(studyhub:\/\/qa\?node=bk%3Awhat\)/);
  assert.match(text, /\*\*考情\*\* 样卷考过。 Asked as a short answer\./);
  assert.match(text, /这一节还没有题。/, 'a point without questions says so in plain text');
  assert.doesNotMatch(book({ notes: { what: notes.what, who: { id: 'who', body: notes.who.body } } }), /考情/, 'without sample papers nothing about exams');
  assert.match(book({ language: 'en' }), /# Review book · SA[\s\S]*\[Practise 5: What architects do\]/);
  assert.deepEqual(parseBookLink(bookLinks.card('d', 'q 1')), { kind: 'card', deckId: 'd', cardId: 'q 1' });
  assert.deepEqual(parseBookLink('studyhub://practice?node=bk%3Awhat&n=5'), { kind: 'practice', node: 'bk:what', n: 5 });
  assert.deepEqual(parseBookLink('studyhub://qa?node=bk%3Awhat'), { kind: 'qa', node: 'bk:what' });
  assert.equal(parseBookLink('https://example.com'), null);
  const plain = plainBook(text);
  assert.doesNotMatch(plain, /sh:/, 'the plain text has no marker');
  assert.match(plain, /\[练习：Why a log\?\]\(studyhub:\/\/card\/d\/q2\)/, 'and keeps every link as it is');
  assert.deepEqual(bookSections(text).map(section => section.id), ['line-0', 'bk:c1'], 'cut at the top headings for the page');
  assert.doesNotMatch(bookSections(text)[1].text, /sh:/);
});

test('updating: an untouched section is replaced, an edited one is kept with a suggestion (unless ignored), a deleted one stays deleted, a new one is placed in order', () => {
  const first = book(), { known } = mergeBook('', first);
  const changed = book({ notes: { ...notes, what: { ...notes.what, body: { ...notes.what.body, explain: 'A new explanation [^1].' } } },
    questions: { ...questions, 'bk:who': [{ deckId: 'd', cardId: 'q9', prompt: 'Who cares?' }] } });
  const untouched = mergeBook(first, changed, { known });
  assert.equal(untouched.text, changed, 'nobody edited it: the new text replaces the old one');
  assert.deepEqual(untouched.suggestions, []);
  const mine = first.replace('They keep a decision log', 'MY OWN WORDS: they keep a decision log') + '\nMy own closing note.\n';
  const kept = mergeBook(mine, changed, { known });
  assert.match(kept.text, /MY OWN WORDS/, 'an edited section keeps the learner\'s text');
  assert.match(kept.text, /My own closing note\./);
  assert.match(kept.text, /\[练习：Who cares\?\]/, 'the untouched sections around it are brought up to date');
  assert.deepEqual(kept.suggestions.map(item => item.id), ['what.notes']);
  assert.match(kept.suggestions[0].text, /A new explanation/);
  assert.deepEqual(mergeBook(mine, changed, { known, ignored: { 'what.notes': kept.suggestions[0].fp } }).suggestions, [], 'an ignored suggestion is not offered again');
  const accepted = acceptSuggestion(kept.text, changed, 'what.notes');
  assert.match(accepted, /A new explanation/);
  assert.doesNotMatch(accepted, /MY OWN WORDS/);
  assert.match(accepted, /My own closing note\./, 'accepting changes only that section');
  const deleted = first.slice(0, genSections(first)[3].start) + first.slice(genSections(first)[3].end);
  assert.equal(genSections(mergeBook(deleted, changed, { known }).text).some(section => section.id === 'who.q'), false, 'a section the learner deleted stays deleted');
  const withNew = book({ questions: { ...questions } }), more = assembleBook({ title: COURSE, nodes: [...nodes, { id: 'c2', key: 'bk:c2', title: 'Later', leaf: true }], notesOf: id => notes[id] ?? null, questionsOf: () => [], language: 'zh' });
  assert.deepEqual(genSections(mergeBook(withNew, more, { known }).text).map(section => section.id), ['what.notes', 'what.q', 'who.notes', 'who.q', 'c2.q'], 'a new point is added after the one before it');
});

test('a 追问 goes under the card\'s first link once, after the ones before it; no link, no change', () => {
  const text = book(), item = { deckId: 'd', cardId: 'q1', followupId: 'f1', question: 'Why?', answer: 'Line one.\nLine two.' };
  const once = insertFollowup(text, item);
  assert.match(once, /\(studyhub:\/\/card\/d\/q1\)\n\n<!-- sh:qa card=q1 fid=f1 -->\n> \*\*追问：\*\* Why\?\n>\n> \*\*答：\*\* Line one\.\n> Line two\.\n<!-- \/sh:qa -->\n- \[练习：Why a log/);
  assert.equal(insertFollowup(once, item), null, 'the same follow-up again is a no-op');
  assert.equal(insertFollowup(text, item, { written: ['f1'] }), null, 'one the learner deleted is not written again');
  const twice = insertFollowup(once, { ...item, followupId: 'f2', question: 'And then?' });
  assert.ok(twice.indexOf('fid=f1') < twice.indexOf('fid=f2') && twice.indexOf('fid=f2') < twice.indexOf('Why a log'), 'in the order they were asked');
  assert.equal(insertFollowup(text, { ...item, cardId: 'nope' }), null);
  assert.equal(genSections(once).find(section => section.id === 'what.q').edited, true, 'after it is written the section is the learner\'s');
});

/** The synthetic course with an outline (lecture 1's chapters 0 and 1) and notes of its first point. */
function library() {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } });
  state.sources.push({ ...outline, createdAt: '2026-10-09T00:00:00.000Z' });
  const page = sources.find(source => source.id === 'document-l1-p1');
  const leafId = outline.courseOutline.nodes[0].children[0].id;
  const record = courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: [{ id: leafId, title: 'What architects do', anchors: [`${lecture}#0`],
    body: { fingerprint: 'f'.repeat(16), points: ['Architects decide [^1].'], explain: 'Explained.', cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } }] });
  state.sources.push({ ...record, createdAt: '2026-10-09T01:00:00.000Z' });
  return state;
}

test('the record: created on open, the learner\'s text saved as written, suggestions taken or set aside, a conflict refused, never a material', () => {
  const state = library(), opened = openBookDoc(state, {});
  assert.equal(opened.status, 'ok');
  assert.equal(opened.notes, true);
  assert.match(opened.text, /Explained\./);
  const record = state.sources.find(source => source.provenance === 'course-book-doc');
  assert.ok(record && isLibraryListSource(record), 'a hidden record of the library');
  assert.throws(() => assertMaterials([record]), error => error.code === 'course-book-doc-not-material');
  assert.equal(openBookDoc(state, {}).revision, opened.revision, 'opening again changes nothing');
  const edited = opened.text.replace('Explained.', 'Explained, in my words.');
  const saved = saveBookDoc(state, { text: edited, revision: opened.revision });
  assert.equal(saved.text, edited);
  assert.throws(() => saveBookDoc(state, { text: 'x', revision: -5 }), error => error.code === 'course-book-doc-conflict', 'a version older than those kept is refused');
  // The notes are written again: the edited section is kept and offered.
  const notesRecord = state.sources.find(source => source.provenance === 'course-outline-notes');
  notesRecord.courseNotes.leaves[0].body = { ...notesRecord.courseNotes.leaves[0].body, explain: 'Explained better.' };
  const offered = openBookDoc(state, {});
  assert.match(offered.text, /in my words/);
  assert.deepEqual(offered.suggestions.map(item => item.id), [`${notesRecord.courseNotes.leaves[0].id}.notes`]);
  const ignored = bookDocSuggestion(state, { id: offered.suggestions[0].id, action: 'ignore', revision: offered.revision });
  assert.deepEqual(ignored.suggestions, []);
  assert.match(ignored.text, /in my words/);
  notesRecord.courseNotes.leaves[0].body = { ...notesRecord.courseNotes.leaves[0].body, explain: 'Explained best.' };
  const again = openBookDoc(state, {});
  const accepted = bookDocSuggestion(state, { id: again.suggestions[0].id, action: 'accept', revision: again.revision });
  assert.match(accepted.text, /Explained best\./);
  assert.doesNotMatch(accepted.text, /in my words/);
  assert.equal(openBookDoc({ ...state, sources: state.sources.filter(source => !source.courseOutline) }, {}).status, 'empty', 'no outline, no book text');
});

test('加入复习全书: a Q&A of practice goes into the book only when added, once, under its link; taken out again; the card keeps it; a card edited later leaves the block', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-book-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reply = JSON.stringify({ question: 'Why keep the log?', answer: 'So the reasons outlive the people.' });
  const complete = async () => reply;
  const service = new StudyService(root, { complete, completeLight: complete, coach: true });
  await service.call('snapshot');
  const state = library();
  await service.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  const opened = await service.call('course.book.doc.open');
  const [, deckId, cardId] = /studyhub:\/\/card\/([^/]+)\/([^)]+)\)/.exec(opened.text);
  const asked = await service.call('card.followup', { deckId, cardId, question: 'why the log' });
  const cardOf = async (deck, id) => (await service.store.read()).decks.find(item => item.id === deck).cards.find(item => item.id === id);
  assert.ok((await cardOf(deckId, cardId)).followups.some(item => item.id === asked.item.id), 'the card keeps it (its source of truth)');
  assert.equal((await service.call('course.book.doc.open')).text, opened.text, 'nothing goes into the book by itself');
  assert.deepEqual((await service.call('book.qa.list')).followupIds, []);
  const added = await service.call('book.qa.add', { deckId, cardId, followupId: asked.item.id });
  assert.equal(added.status, 'added');
  const book = (await service.call('course.book.doc.open')).text;
  assert.equal(book.split(`fid=${asked.item.id} -->`).length - 1, 1, 'the book holds it exactly once');
  assert.match(book, new RegExp(`card/${deckId}/${cardId}\\)\\n\\n<!-- sh:qa card=${cardId} fid=${asked.item.id} -->\\n> \\*\\*追问：\\*\\* Why keep the log\\?\\n>\\n> \\*\\*答：\\*\\* So the reasons outlive the people\\.`));
  assert.equal((await service.call('book.qa.add', { deckId, cardId, followupId: asked.item.id })).status, 'unchanged', 'adding twice is one block');
  assert.equal((await service.call('course.book.doc.open')).text, book);
  assert.deepEqual((await service.call('book.qa.list')).followupIds, [asked.item.id]);
  // Edited later (its wording, so its digest, changes): the block already in the book is the learner's text and stays.
  await service.call('card.update', { deckId, cardId, patch: { prompt: 'What does an architect write down, and why?' }, reason: 'clearer' });
  assert.match((await service.call('course.book.doc.open')).text, new RegExp(`fid=${asked.item.id} -->`));
  const removed = await service.call('book.qa.remove', { followupId: asked.item.id });
  assert.equal(removed.status, 'removed');
  const after = (await service.call('course.book.doc.open')).text;
  assert.doesNotMatch(after, /sh:qa/);
  assert.match(after, new RegExp(`card/${deckId}/${cardId}\\)`), 'the link stays');
  assert.ok((await cardOf(deckId, cardId)).followups.some(item => item.id === asked.item.id), 'the card\'s follow-up is untouched');
  // A card the book does not link yet (past the 20 links a point lists): its link is written under its knowledge point, then the block.
  const unlinked = state.decks.find(deck => deck.id === 'deck-l1').cards[22];
  const more = await service.call('card.followup.add', { deckId: 'deck-l1', cardId: unlinked.id, question: 'And this one?', answer: 'Also.' });
  assert.ok(!after.includes(`card/deck-l1/${unlinked.id})`));
  await service.call('book.qa.add', { deckId: 'deck-l1', cardId: unlinked.id, followupId: more.item.id });
  const linked = (await service.call('course.book.doc.open')).text, link = linked.indexOf(`card/deck-l1/${unlinked.id})`);
  assert.ok(link > linked.indexOf('### 1.1 What architects do') && link < linked.indexOf('<!-- sh:id bk:who -->'), 'under the point that holds the card');
  assert.ok(linked.indexOf(`fid=${more.item.id} -->`) > link);
  // A card of no knowledge point: under 「未归位」.
  const other = state.decks.find(deck => deck.id === 'deck-l6');
  const elsewhere = await service.call('card.followup.add', { deckId: other.id, cardId: other.cards[0].id, question: 'Not in the outline?', answer: 'No.' });
  await service.call('book.qa.add', { deckId: other.id, cardId: other.cards[0].id, followupId: elsewhere.item.id });
  const last = (await service.call('course.book.doc.open')).text;
  assert.match(last, new RegExp(`<!-- sh:id unplaced -->\\n## 未归位\\n\\n- \\[练习：[^\\n]+\\]\\(studyhub://card/${other.id}/${other.cards[0].id}\\)\\n\\n<!-- sh:qa card=${other.cards[0].id} fid=${elsewhere.item.id} -->`));
});

test('conflict rules: an AI write over an untouched region, over an edited one, an AI insert while the editor has unsaved edits, a broken marker', () => {
  const first = book(), { known } = mergeBook('', first);
  const newer = book({ notes: { ...notes, who: { ...notes.who, body: { ...notes.who.body, explain: 'Each has a different view.' } } } });
  // Untouched: replaced in place, nothing to ask.
  const plain = mergeBook(first, newer, { known });
  assert.match(plain.text, /Each has a different view\./);
  assert.deepEqual(plain.suggestions, []);
  // Edited: the learner's text stays, the new one waits as a suggestion.
  const edited = first.replace('Each has a view.', 'Each has a view (my note).');
  const kept = mergeBook(edited, newer, { known });
  assert.match(kept.text, /my note/);
  assert.deepEqual(kept.suggestions.map(item => item.id), ['who.notes']);
  // The editor saves over an AI insert that landed meanwhile: the learner's edits are kept, the inserted region comes in, nothing is duplicated.
  const base = first, theirs = insertRegion(base, { node: 'bk:who', id: 'who.more', body: 'An AI paragraph.' });
  assert.ok(theirs.indexOf('An AI paragraph.') > theirs.indexOf('### 1.2 Stakeholders'), 'an AI 加一段 goes into its point and edits nothing');
  assert.equal(insertRegion(theirs, { node: 'bk:who', id: 'who.more', body: 'Again.' }), null);
  const mine = base.replace('They keep a decision log', 'Typed while the AI wrote: they keep a decision log');
  const rebased = rebaseBook(mine, base, theirs);
  assert.match(rebased.text, /Typed while the AI wrote/);
  assert.equal(rebased.text.split('An AI paragraph.').length - 1, 1);
  assert.deepEqual(rebased.conflicts, []);
  // Both changed the same region: the learner's text stays, reported as a conflict (the program's text is offered by the next open).
  const theirsToo = mergeBook(base, newer, { known }).text, mineToo = base.replace('Each has a view.', 'Mine.');
  const both = rebaseBook(mineToo, base, theirsToo);
  assert.match(both.text, /Mine\./);
  assert.deepEqual(both.conflicts, ['who.notes']);
  // A broken marker: the region is the learner's text; a newer text is a suggestion, never a second copy.
  const broken = first.replace(/(<!-- sh:gen id=who\.notes fp=[0-9a-f]+ -->\n[\s\S]*?)\n<!-- \/sh:gen -->/, '$1');
  assert.equal(genSections(broken).some(section => section.id === 'who.notes'), false);
  const after = mergeBook(broken, newer, { known });
  assert.equal(after.text.split('Each has').length - 1, 1, 'no duplicate of the region');
  assert.deepEqual(after.suggestions.map(item => [item.id, item.missing]), [['who.notes', true]]);
  assert.ok(genSections(after.text).some(section => section.id === 'who.q'), 'the next region is still found');
});

test('heading ids are stable: given once, kept when sections are inserted before, moved or deleted; the 目录 tree lists each heading\'s question links', () => {
  const start = assignHeadingIds('# Book\n\n## One\ntext [练习：Q](studyhub://card/d/q1)\n\n## Two\n\n### Two a\n[练 5 道：Two](studyhub://practice?node=bk%3Atwo&n=5)\n```\n# not a heading\n```\n');
  const ids = text => bookIndex(text).flat.map(item => [item.title, item.id]);
  assert.deepEqual(ids(start.text).map(([title]) => title), ['Book', 'One', 'Two', 'Two a'], 'a # inside a code fence is no heading');
  const given = Object.fromEntries(ids(start.text));
  assert.ok(Object.values(given).every(id => /^h\d+$/.test(id)) && new Set(Object.values(given)).size === 4);
  const inserted = assignHeadingIds(start.text.replace('## One', '## Zero\n\n## One'), { next: start.next });
  assert.deepEqual(Object.fromEntries(ids(inserted.text).filter(([title]) => title !== 'Zero')), given, 'inserting before renumbers nothing');
  assert.ok(!Object.values(given).includes(Object.fromEntries(ids(inserted.text)).Zero), 'the new heading has a new id');
  const parts = start.text.split(/(?=<!-- sh:id )/), moved = assignHeadingIds([parts[0], parts[2], parts[3], parts[1]].join(''), { next: start.next });
  assert.deepEqual(Object.fromEntries(ids(moved.text)), given, 'moving a section keeps its id');
  const deleted = assignHeadingIds(start.text.replace(/<!-- sh:id \S+ -->\n## One\n[^\n]*\n/, ''), { next: start.next });
  assert.deepEqual(Object.fromEntries(ids(deleted.text)), { Book: given.Book, Two: given.Two, 'Two a': given['Two a'] });
  const typed = assignHeadingIds(`${deleted.text}\n## Back\n`, { next: deleted.next });
  assert.ok(!Object.values(given).includes(Object.fromEntries(ids(typed.text)).Back), 'an id is never reused, not even the deleted one');
  const copied = assignHeadingIds(`${start.text}\n<!-- sh:id ${given.One} -->\n## One again\n`, { next: start.next });
  assert.notEqual(Object.fromEntries(ids(copied.text))['One again'], given.One, 'a copied id is given anew on the later heading');
  assert.equal(Object.fromEntries(ids(copied.text)).One, given.One);
  assert.equal(assignHeadingIds(start.text, { next: start.next }).text, start.text, 'a text whose headings have ids is unchanged');
  const { tree } = bookIndex(start.text);
  assert.deepEqual(tree.map(node => [node.title, node.children.map(child => child.title)]), [['Book', ['One', 'Two']]]);
  assert.deepEqual(tree[0].children[0].links.map(link => [link.kind, link.cardId, link.text]), [['card', 'q1', '练习：Q']]);
  assert.deepEqual(tree[0].children[1].children[0].links.map(link => [link.kind, link.node]), [['practice', 'bk:two']]);
});

test('undo: any write, by the program or the learner, can be taken back; the program does not write the undone text again; at most 20 versions', () => {
  const state = library(), opened = openBookDoc(state, {});
  const notesRecord = state.sources.find(source => source.provenance === 'course-outline-notes');
  notesRecord.courseNotes.leaves[0].body = { ...notesRecord.courseNotes.leaves[0].body, explain: 'Rewritten by the program.' };
  const updated = openBookDoc(state, {});
  assert.match(updated.text, /Rewritten by the program\./);
  assert.equal(updated.versions[0].revision, opened.revision);
  const undone = undoBookDoc(state, { revision: updated.revision });
  assert.match(undone.text, /Explained\./);
  assert.doesNotMatch(undone.text, /Rewritten/);
  assert.match(openBookDoc(state, {}).text, /Explained\./, 'opening again does not write the undone text back');
  let current = openBookDoc(state, {});
  for (let i = 0; i < 25; i++) current = saveBookDoc(state, { text: `${current.text}\nline ${i}`, revision: current.revision });
  assert.equal(current.versions.length, 20);
  const back = undoBookDoc(state, { revision: current.revision });
  assert.doesNotMatch(back.text, /line 24/);
  assert.match(back.text, /line 23/);
});
