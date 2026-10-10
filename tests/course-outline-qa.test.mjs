/* `course.outline.qa`: the questions and answers kept about one knowledge point of the 总纲 (the 复习全书's 「本节问答」), read on demand: a card's 追问
   (only those of its current wording), the reader's 批注 on a passage inside the point's places, and 问答卡 (card.sourceQa, an ordinary card). The library
   is the synthetic one shaped like the owner's (tests/helpers/course-outline-library.mjs); no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { courseOutline } from '../lib/course-outline.js';
import { courseOutlineQa, QA_CARD_LIMIT } from '../lib/course-outline-qa.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { followupDigest } from '../lib/followup.js';
import { textHash } from '../lib/annotation.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const NOW = Date.parse('2026-10-10T08:00:00.000Z');
const L1 = 'document-l1';

/** The library with an outline of lecture 1 (two points: its chapters 0 and 1, the rest of the course in 其他), a 追问, a 问答卡 and 批注. */
function library() {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const book = groupSourcesByDocument(sources).find(item => item.sourceIds.includes(`${L1}-p1`)).key;
  const record = courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${book}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${book}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } });
  state.sources.push({ ...record, createdAt: '2026-10-09T00:00:00.000Z' });
  const deck = state.decks.find(item => item.id === 'deck-l1'), first = deck.cards[0];
  first.followups = [{ id: 'f-old', question: 'Asked about an older wording?', answer: 'Stale.', at: '2026-10-02T00:00:00.000Z', digest: 'older' },
    { id: 'f1', question: 'Why keep a decision log?', answer: 'So the reasons survive the people.', at: '2026-10-03T00:00:00.000Z', digest: followupDigest(first) }];
  const page1 = state.sources.find(source => source.id === `${L1}-p1`), page3 = state.sources.find(source => source.id === `${L1}-p3`);
  const quote = page1.text.slice(0, 40);
  state.decks.push({ id: 'deck-qa', title: '问答', course: COURSE, purpose: 'source-qa', cards: [{ id: 'qa1', kind: 'flashcard', sourceQa: true, prompt: 'What is a decision log?', answer: 'Where the reasons are kept.',
    createdAt: '2026-10-04T00:00:00.000Z', citations: [{ sourceId: page1.id, quote, selection: { sourceId: page1.id, start: 0, end: 40, quote } }] }] });
  const note = (id, source, start, end, extra = {}) => ({ id, key: `${source.id}|${start}|${end}`, sourceId: source.id, start, end, hash: textHash(source.text.slice(start, end)),
    quote: source.text.slice(start, end), question: `Note ${id}?`, answer: `Answer ${id}.`, at: `2026-10-05T00:00:0${id.length}.000Z`, ...extra });
  page1.annotations = { revision: 'r1', items: [note('a1', page1, 10, 30), note('a2', page1, 10, 30, { parentId: 'a1' }), { ...note('gone', page1, 0, 5), hash: 'changed-since' }] };
  page3.annotations = { revision: 'r1', items: [note('b1', page3, 0, 20)] };
  return state;
}
const leafKey = (state, title) => {
  const find = nodes => nodes.flatMap(node => [node, ...find(node.children || [])]);
  return find(courseOutline(state, { course: COURSE }, { now: NOW }).book.nodes).find(node => node.title === title).key;
};

test('a knowledge point answers its 追问, 批注 and 问答卡, normalised and in reading order (then by when they were kept); other points and stale entries are left out', () => {
  const state = library(), key = leafKey(state, 'What architects do');
  const answer = courseOutlineQa(state, { course: COURSE, keys: [key] }, { now: NOW });
  assert.equal(answer.status, 'ok');
  assert.equal(answer.course, COURSE);
  assert.deepEqual(answer.cards, { total: 26, read: 26, capped: false, limit: QA_CARD_LIMIT }, '25 questions of the chapter and the 问答卡');
  assert.deepEqual(answer.items.map(item => [item.kind, item.question]), [
    ['card', 'Why keep a decision log?'], ['qa-card', 'What is a decision log?'], ['passage', 'Note a1?'], ['passage', 'Note a2?']]);
  for (const item of answer.items) assert.deepEqual(Object.keys(item).filter(field => ['kind', 'question', 'answer', 'at', 'place', 'openRef'].includes(field)).length, 6, `${item.kind} has the common shape`);
  const [followup, qa, passage, child] = answer.items, first = state.decks.find(deck => deck.id === 'deck-l1').cards[0];
  assert.deepEqual(qa.openRef, { deckId: 'deck-qa', cardId: 'qa1' });
  assert.equal(qa.answer, 'Where the reasons are kept.');
  assert.deepEqual([passage.place.sourceId, passage.place.start, passage.place.end], [`${L1}-p1`, 10, 30]);
  assert.deepEqual(passage.openRef, { sourceId: `${L1}-p1`, start: 10, end: 30, quote: passage.place.quote });
  assert.equal(child.parentId, 'a1', 'a follow-up inside a 批注 says which one it follows');
  assert.deepEqual([followup.openRef, followup.prompt, followup.answer], [{ deckId: 'deck-l1', cardId: first.id }, first.prompt, 'So the reasons survive the people.']);
  assert.equal(followup.place.sourceId, `${L1}-p1`, 'a card item is placed where the card cites');
  assert.ok(!answer.items.some(item => item.question === 'Asked about an older wording?'), 'a 追问 of an older wording is not current');
  assert.ok(!answer.items.some(item => item.question === 'Note gone?'), 'a 批注 whose passage changed is not shown');
  assert.ok(!answer.items.some(item => item.question === 'Note b1?'), 'a 批注 of the next chapter belongs to the next point');
  const next = courseOutlineQa(state, { course: COURSE, keys: [leafKey(state, 'Stakeholders')] }, { now: NOW });
  assert.deepEqual(next.items.map(item => item.question), ['Note b1?']);
});

test('explicit cards are read too; at most 200 cards, the cap is said; no course or nothing asked is empty', () => {
  const state = library();
  const cards = courseOutlineQa(state, { course: COURSE, cards: [{ deckId: 'deck-l1', cardId: state.decks.find(deck => deck.id === 'deck-l1').cards[0].id }, { deckId: 'nope', cardId: 'x' }] }, { now: NOW });
  assert.deepEqual(cards.items.map(item => item.kind), ['card']);
  assert.equal(cards.cards.total, 1);
  const all = groupSourcesByDocument(state.sources).filter(item => item.sourceIds.some(id => /^document-l\d-p/.test(id))).map(item => item.key);
  const big = courseOutlineQa(state, { course: COURSE, keys: all }, { now: NOW });
  assert.equal(big.cards.read, QA_CARD_LIMIT);
  assert.ok(big.cards.total > QA_CARD_LIMIT && big.cards.capped);
  assert.deepEqual(courseOutlineQa(state, { course: COURSE }, { now: NOW }).items, []);
  assert.equal(courseOutlineQa(state, { course: null }, { now: NOW }).status, 'empty');
  assert.throws(() => courseOutlineQa(state, { course: 3 }), /course must be/);
});

test('course.outline.qa through the runtime: registered, read-only, documented for agents, never in the snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-outline-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('snapshot');
  const state = library();
  await service.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  const key = leafKey(await service.store.read(), 'What architects do');
  const before = JSON.stringify((await service.store.read()).decks);
  const answer = await service.call('course.outline.qa', { keys: [key] });
  assert.deepEqual(answer.items.map(item => item.kind), ['card', 'qa-card', 'passage', 'passage']);
  assert.equal(JSON.stringify((await service.store.read()).decks), before, 'reading writes nothing');
  assert.equal(JSON.stringify(await service.call('snapshot')).includes('Why keep a decision log?'), false, 'the 问答 are read on demand, not carried by the snapshot');
  assert.match(libraryContracts.learning, /course\.outline\.qa \{course\?,keys\?,cards\?/);
  assert.match(studyToolDescription, /course\.outline, course\.outline\.qa/);
});
