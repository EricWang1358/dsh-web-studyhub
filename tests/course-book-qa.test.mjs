/* 复习全书 M3 (docs/plans/review-book.md): a follow-up of practice goes into the book only when asked (「加入复习全书」, or 自动加入 calling the same op
   from the practice page), once, into the point's Q&A file under the question's link; taken out again; the card keeps its follow-ups; an unplaced card goes
   to 未归位; an add while the Q&A file is open in the editor merges with the editor's save. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { qaBlocks, withoutQaMarkers } from '../lib/course-book-qa-text.js';
import { plainBook, stitchBook } from '../lib/course-book-links.js';
import { BOOK_DEFAULTS, mergeBookSettings, resolveBookSettings } from '../lib/book-settings.js';
import { autoAddPlan } from '../ui/book/qa-auto.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

function library() {
  const { sources, decks } = outlineLibrary();
  const state = { sources, decks, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex({ ...state, documents: [], drafts: [], attempts: [] }, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
  sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } })) }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  return state;
}
const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));

async function service(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  const complete = async () => JSON.stringify({ question: `Why number ${++n}?`, answer: `Because ${n}.\nA second line.` });
  const study = new StudyService(root, { complete, completeLight: complete, coach: true });
  await study.call('snapshot');
  const state = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  await study.call('course.book.open');
  const deck = state.decks.find(item => item.id === 'deck-l1');
  return { study, deck, card: deck.cards[0], other: state.decks.find(item => item.id === 'deck-l6').cards[0] };
}
const cardOf = async (study, deckId, cardId) => (await study.store.read()).decks.find(deck => deck.id === deckId).cards.find(card => card.id === cardId);

test('manual: a follow-up stays on the card and nothing goes into the book by itself; 加入复习全书 puts it in once, under its link; 撤回 takes it out', async t => {
  const { study, deck, card } = await service(t);
  const before = await study.call('course.book.open');
  const asked = await study.call('card.followup', { deckId: deck.id, cardId: card.id, question: 'why' });
  const after = await study.call('course.book.open');
  assert.equal(after.revision, before.revision, 'nothing written into the book');
  assert.equal(leaves(after.nodes)[0].files.qa, undefined, 'no Q&A file yet');
  assert.deepEqual((await study.call('book.qa.list')).followupIds, []);
  assert.deepEqual((await study.call('book.qa.list')).courses, [COURSE]);
  const added = await study.call('book.qa.add', { deckId: deck.id, cardId: card.id, followupId: asked.item.id });
  assert.equal(added.write, 'added');
  const point = leaves(added.nodes)[0];
  assert.ok(point.files.qa.endsWith('.qa.md'), 'the Q&A file is made on the first add');
  assert.match(point.qa, new RegExp(`^- \\[练习：[^\\]]+\\]\\(studyhub://card/${deck.id}/${card.id}\\)\\n\\n<!-- sh:qa card=${card.id} fid=${asked.item.id} -->\\n> \\*\\*追问：\\*\\* Why number 1\\?\\n>\\n> \\*\\*答：\\*\\* Because 1\\.\\n> A second line\\.\\n<!-- /sh:qa -->`));
  assert.ok((await cardOf(study, deck.id, card.id)).followups.some(item => item.id === asked.item.id), 'the card keeps it');
  assert.equal((await study.call('book.qa.add', { deckId: deck.id, cardId: card.id, followupId: asked.item.id })).write, 'unchanged', 'a second add is nothing');
  const twice = await study.call('course.book.open');
  assert.equal(qaBlocks(leaves(twice.nodes)[0].qa).length, 1, 'one block');
  assert.deepEqual((await study.call('book.qa.list')).followupIds, [asked.item.id]);
  // A second follow-up of the same question goes under the same link, after the first.
  const second = await study.call('card.followup', { deckId: deck.id, cardId: card.id, question: 'and then' });
  const both = leaves((await study.call('book.qa.add', { cardId: card.id, followupId: second.item.id })).nodes)[0].qa;
  assert.deepEqual(qaBlocks(both).map(block => block.fid), [asked.item.id, second.item.id]);
  assert.equal(both.split(`card/${deck.id}/${card.id})`).length - 1, 1, 'the link once');
  // The preview and plain Markdown hide the markers; the stitched book holds the Q&A file after the own file.
  assert.doesNotMatch(withoutQaMarkers(both), /sh:qa/);
  assert.doesNotMatch(plainBook(both), /sh:qa/);
  // Editing the card later keeps the block (it is the learner's text now).
  await study.store.update(own => { own.decks.find(item => item.id === deck.id).cards.find(item => item.id === card.id).prompt = 'A rewritten question?'; });
  assert.match(leaves((await study.call('course.book.open')).nodes)[0].qa, /Why number 1\?/);
  const removed = await study.call('book.qa.remove', { followupId: asked.item.id });
  assert.equal(removed.write, 'removed');
  const left = leaves(removed.nodes)[0].qa;
  assert.deepEqual(qaBlocks(left).map(block => block.fid), [second.item.id], 'only that block');
  assert.ok((await cardOf(study, deck.id, card.id)).followups.some(item => item.id === asked.item.id), 'the card\'s follow-up is untouched');
  assert.equal((await study.call('book.qa.remove', { followupId: asked.item.id })).write, 'unchanged');
  const view = await study.call('course.book.open'), stitched = stitchBook({ title: view.title, nodes: view.nodes, unplaced: view.unplaced });
  assert.ok(stitched.indexOf('About What architects do') < stitched.indexOf('Why number 2?') && stitched.indexOf('Why number 2?') < stitched.indexOf('1.2 Stakeholders'));
  assert.ok(view.history[point.files.qa] >= 1, 'the writes are in the version history');
});

test('a card already linked under its point gets only the block; a card of no point goes to 未归位 with its link', async t => {
  const { study, deck, card, other } = await service(t);
  const book = await study.call('course.book.open'), point = leaves(book.nodes)[0];
  await study.call('course.book.save', { file: point.files.mine, text: `See [练习：mine](studyhub://card/${deck.id}/${card.id}).`, version: book.files[point.files.mine].version });
  const asked = await study.call('card.followup.add', { deckId: deck.id, cardId: card.id, question: 'Linked?', answer: 'Yes.' });
  const qa = leaves((await study.call('book.qa.add', { cardId: card.id, followupId: asked.item.id })).nodes)[0].qa;
  assert.doesNotMatch(qa, /studyhub:\/\/card\//, 'the point links it already: no second link');
  assert.equal(qaBlocks(qa).length, 1);
  const away = await study.call('card.followup.add', { deckId: 'deck-l6', cardId: other.id, question: 'Placed?', answer: 'No.' });
  const unplaced = (await study.call('book.qa.add', { deckId: 'deck-l6', cardId: other.id, followupId: away.item.id })).unplaced.text;
  assert.match(unplaced, new RegExp(`^- \\[练习：[^\\]]+\\]\\(studyhub://card/deck-l6/${other.id}\\)\\n\\n<!-- sh:qa card=${other.id} fid=${away.item.id} -->`));
  await assert.rejects(study.call('book.qa.add', { deckId: deck.id, cardId: card.id, followupId: 'nope' }), error => error.code === 'book-qa-missing');
});

test('an add while the Q&A file is open in the editor with unsaved edits: the editor\'s save keeps both', async t => {
  const { study, deck, card } = await service(t);
  const first = await study.call('card.followup.add', { deckId: deck.id, cardId: card.id, question: 'First?', answer: 'One.' });
  const opened = await study.call('book.qa.add', { cardId: card.id, followupId: first.item.id }), point = leaves(opened.nodes)[0];
  const editorVersion = opened.files[point.files.qa].version, editorText = `${point.qa}\n\nMy note under the answers.`;
  const second = await study.call('card.followup.add', { deckId: deck.id, cardId: card.id, question: 'Second?', answer: 'Two.' });
  await study.call('book.qa.add', { cardId: card.id, followupId: second.item.id });
  const saved = await study.call('course.book.save', { file: point.files.qa, text: editorText, version: editorVersion });
  const qa = leaves(saved.nodes)[0].qa;
  assert.match(qa, /My note under the answers\./, 'the learner\'s edit is kept');
  assert.deepEqual(qaBlocks(qa).map(block => block.fid), [first.item.id, second.item.id], 'and the block added meanwhile');
  assert.deepEqual(saved.files[point.files.qa].suggestions, [], 'nothing else changed: no suggestion to choose');
});

test('自动加入: only in auto, only where there is a book, only new Q&A, each once; the setting is manual by default and checked', () => {
  assert.deepEqual(autoAddPlan({ mode: 'manual', withBook: true, fresh: ['f1'] }), [], 'manual adds nothing by itself');
  assert.deepEqual(autoAddPlan({ mode: 'auto', withBook: false, fresh: ['f1'] }), []);
  const tried = new Set();
  const first = autoAddPlan({ mode: 'auto', withBook: true, fresh: ['f1', 'f1'], tried, added: new Set() });
  assert.deepEqual(first, ['f1']);
  first.forEach(id => tried.add(id));
  assert.deepEqual(autoAddPlan({ mode: 'auto', withBook: true, fresh: ['f1', 'f2'], tried, added: new Set(['f2']) }), [], 'once per follow-up; not one already in the book');
  assert.deepEqual(BOOK_DEFAULTS, { qaToBook: 'manual' });
  assert.deepEqual(resolveBookSettings(undefined), { qaToBook: 'manual' });
  assert.deepEqual(resolveBookSettings({ qaToBook: 'sometimes' }), { qaToBook: 'manual' });
  assert.deepEqual(mergeBookSettings(undefined, { qaToBook: 'auto' }), { qaToBook: 'auto' });
  assert.throws(() => mergeBookSettings(undefined, { qaToBook: 'yes' }), /Invalid book setting/);
  assert.throws(() => mergeBookSettings(undefined, { other: 1 }), /Unknown book setting/);
});

test('settings.book.set saves the setting in the library settings; a reload keeps it', async t => {
  const { study } = await service(t);
  assert.deepEqual(await study.call('settings.book.set', { patch: { qaToBook: 'auto' } }), { qaToBook: 'auto' });
  assert.deepEqual((await study.store.read()).settings.book, { qaToBook: 'auto' });
  assert.equal((await study.call('snapshot')).settings.book.qaToBook, 'auto');
  await assert.rejects(study.call('settings.book.set', { patch: { qaToBook: 'x' } }));
});
