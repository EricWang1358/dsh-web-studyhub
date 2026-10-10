/* 复习全书 M5: 「加入复习全书」 of a 分析题答案卡 goes through the M3 writer (book.qa.add { cardId, answerCard: true }): once per question, its rendered
   Markdown as an `sh:card` block in the point's Q&A file under the question's link (else 未归位), taken out again with 撤回; no heading is added; the
   markers are hidden by the preview and plain Markdown; an editor save that met it keeps both. No model, no network. */
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
import { cardBlocks, qaBlocks, withoutQaMarkers } from '../lib/course-book-qa-text.js';
import { bookIndex, plainBook } from '../lib/course-book-links.js';
import { CASE_TYPES } from '../lib/case-types.js';
import { answerCardBasis, checkAnswerCard, finishAnswerCard, normalizeAnswerCard, renderAnswerCard } from '../lib/answer-card.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { MATERIAL, SCENARIO, caseCard, caseLibrary, criteria, goodCard } from './helpers/answer-card-library.mjs';

const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));
const answerCardFor = card => finishAnswerCard(checkAnswerCard(normalizeAnswerCard(goodCard(), { types: CASE_TYPES, language: 'en' }),
  { stem: [{ id: 'prompt', text: card.prompt }, { id: 'case', text: SCENARIO }], materials: [{ id: 'mat1', ref: 'M1', title: 'Lecture 4', text: MATERIAL }], criteria: criteria() }),
{ review: { ran: true, issues: [], repaired: false }, basis: answerCardBasis(card) });

async function service(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-answer-card-book-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose());
  await study.call('snapshot');
  const { sources, decks } = outlineLibrary();
  const state = { sources, decks, documents: [], drafts: [], attempts: [] };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }] }], other: { anchors: [] }, counts: { units: 1, leftover: 0, invalid: 0, repeated: 0 } }),
  createdAt: '2026-10-09T00:00:00.000Z' };
  const page = sources.find(source => source.id === 'document-l1-p1');
  sources.push(outline, { ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: [{ id: 'what', title: 'What architects do',
    anchors: [`${lecture}#0`], body: { fingerprint: 'f'.repeat(16), points: ['Architects decide [^1].'], explain: 'About architects.', cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } }] }),
  createdAt: '2026-10-09T01:00:00.000Z' });
  // A question of the point gets an answer card (any card may hold one); a case deck of the same course is placed nowhere in the outline.
  const deck = decks.find(item => item.id === 'deck-l1'), card = deck.cards[0];
  card.answerCard = answerCardFor(card);
  const cases = caseLibrary({ card: { ...caseCard(), answerCard: answerCardFor(caseCard()) } });
  cases.deck.course = COURSE;
  await study.store.update(own => { own.sources.push(...sources, ...cases.sources); own.decks.push(...decks, cases.deck); own.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] }; });
  await study.call('course.book.open');
  return { study, deck, card, plain: deck.cards[1] };
}

test('加入复习全书: the rendered card once, in the point\'s Q&A file under the question\'s link, no new heading; 撤回 takes it out', async t => {
  const { study, deck, card, plain } = await service(t);
  assert.deepEqual((await study.call('book.qa.list')).answerCardIds, []);
  const added = await study.call('book.qa.add', { deckId: deck.id, cardId: card.id, answerCard: true });
  assert.equal(added.write, 'added');
  const qa = leaves(added.nodes)[0].qa;
  assert.match(qa, new RegExp(`^- \\[练习：[^\\]]+\\]\\(studyhub://card/${deck.id}/${card.id}\\)\\n\\n<!-- sh:card card=${card.id} -->\\n\\*\\*Answer card\\*\\*\\n\\n\\*\\*Question type: \\*\\*Availability`));
  const [block] = cardBlocks(qa);
  assert.equal(block.cardId, card.id);
  assert.ok(block.raw.includes(renderAnswerCard(card.answerCard)), 'the rendered Markdown, as it is');
  assert.equal(bookIndex(qa).flat.length, 0, 'no heading added');
  assert.equal((await study.call('book.qa.add', { cardId: card.id, answerCard: true })).write, 'unchanged', 'once per question');
  assert.deepEqual((await study.call('book.qa.list')).answerCardIds, [card.id]);
  assert.doesNotMatch(withoutQaMarkers(qa), /sh:card/);
  assert.doesNotMatch(plainBook(qa), /sh:card/);
  assert.match(plainBook(qa), /\| Calculation · c1\.k1 \| 2 \|/);
  // A follow-up of the same question goes under the same link, after the card.
  const asked = await study.call('card.followup.add', { deckId: deck.id, cardId: card.id, question: 'Why?', answer: 'Because.' });
  const both = leaves((await study.call('book.qa.add', { cardId: card.id, followupId: asked.item.id })).nodes)[0].qa;
  assert.ok(both.indexOf('sh:card') < both.indexOf('sh:qa'), 'after the card');
  assert.equal(both.split(`card/${deck.id}/${card.id})`).length - 1, 1, 'the link once');
  const removed = await study.call('book.qa.remove', { cardId: card.id, answerCard: true });
  assert.equal(removed.write, 'removed');
  const left = leaves(removed.nodes)[0].qa;
  assert.deepEqual([cardBlocks(left).length, qaBlocks(left).length], [0, 1], 'only the card');
  assert.equal((await study.call('book.qa.remove', { cardId: card.id, answerCard: true })).write, 'unchanged');
  assert.ok((await study.store.read()).decks.find(item => item.id === deck.id).cards.find(item => item.id === card.id).answerCard, 'the question keeps its card');
  await assert.rejects(study.call('book.qa.add', { deckId: deck.id, cardId: plain.id, answerCard: true }), error => error.code === 'book-qa-no-card');
});

test('a case question of no point goes to 未归位 with its link; an editor save that met the add keeps both', async t => {
  const { study, deck, card } = await service(t);
  const unplaced = (await study.call('book.qa.add', { deckId: 'case1', cardId: 'q1', answerCard: true })).unplaced.text;
  assert.match(unplaced, /^- \[练习：Does the booking service[^\]]*\]\(studyhub:\/\/card\/case1\/q1\)\n\n<!-- sh:card card=q1 -->/);
  const opened = await study.call('book.qa.add', { deckId: deck.id, cardId: card.id, followupId: (await study.call('card.followup.add', { deckId: deck.id, cardId: card.id, question: 'First?', answer: 'One.' })).item.id });
  const point = leaves(opened.nodes)[0], version = opened.files[point.files.qa].version;
  await study.call('book.qa.add', { deckId: deck.id, cardId: card.id, answerCard: true });
  const saved = await study.call('course.book.save', { file: point.files.qa, text: `${point.qa}\n\nMy note.`, version });
  const qa = leaves(saved.nodes)[0].qa;
  assert.match(qa, /My note\./);
  assert.deepEqual(cardBlocks(qa).map(block => block.cardId), [card.id], 'the card added meanwhile came along');
  assert.deepEqual(saved.files[point.files.qa].suggestions, []);
});
