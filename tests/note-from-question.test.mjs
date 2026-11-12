import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { followupDigest } from '../lib/followup.js';

/* 写笔记 / 存进笔记 from a question (#1017): the note starts with what the learner just worked through (stem and answer, the misconception and the
   wrong options, the explanation with its page, each Q&A), written from the card with no model call; a Q&A saved again is never added twice; a learner's
   unsaved writing is never overwritten (the revision check of note.save). */

const QUOTE = 'Caretaker keeps the history of snapshots without looking inside them.';

async function library(t, language = 'en') {
  const root = await mkdtemp(join(tmpdir(), 'study-note-question-'));
  let calls = 0;
  const service = new StudyService(root, { complete: async () => { calls++; return '{}'; } });
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update(state => {
    state.sources.push({ id: 'book-p3', title: 'Patterns · p.3', text: `Intro. ${QUOTE} More.`, document: { id: 'a'.repeat(64), format: 'pdf', page: 3, materialId: `document-${'a'.repeat(64)}-pdf` } });
    const card = { id: 'c1', kind: 'quiz', topic: 'Memento', prompt: 'Which part manages the history?', answer: 'Caretaker',
      explanation: 'The caretaker stores snapshots; the originator makes and restores them.',
      misconception: 'Taking the memento itself for the history manager.',
      citations: [{ sourceId: 'book-p3', quote: QUOTE }],
      options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It keeps the history.' },
        { id: 'b', text: 'Memento', correct: false, explanation: 'It is one snapshot, not the history.' },
        { id: 'c', text: 'Originator', correct: false, explanation: '' }] };
    card.followups = [{ id: 'f1', digest: followupDigest(card), question: 'Why can the caretaker not read it?', answer: 'The narrow interface hides the state.' }];
    state.decks.push({ id: 'deck', title: 'Deck', cards: [card, { id: 'c2', prompt: 'Other', answer: 'x' }] });
  });
  return { service, calls: () => calls, language };
}

const addFollowup = (service, id, question, answer) => service.store.update(state => {
  const card = state.decks[0].cards[0];
  card.followups.push({ id, digest: followupDigest(card), question, answer });
});

test('写笔记 from a question fills the four headings from the card, in the language of the page, with no model call', async t => {
  const { service, calls } = await library(t);
  const note = await service.call('note.create', { title: 'Study note', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true, prefill: true, language: 'en' });
  const text = note.markdown;
  assert.equal(calls(), 0, 'deterministic: no model call');
  const at = heading => text.indexOf(`\n## ${heading}\n`);
  for (const heading of ['Core concepts', 'Common misconceptions', 'Explanation and examples', 'Study log']) assert.ok(at(heading) > 0, heading);
  assert.doesNotMatch(text, /\p{Script=Han}/u, 'an English page writes English headings and labels');
  const section = (from, to) => text.slice(at(from), to ? at(to) : undefined);
  assert.match(section('Core concepts', 'Common misconceptions'), /Which part manages the history\?/);
  assert.match(section('Core concepts', 'Common misconceptions'), /Caretaker/);
  const misconceptions = section('Common misconceptions', 'Explanation and examples');
  assert.match(misconceptions, /Taking the memento itself/);
  assert.match(misconceptions, /Memento.*It is one snapshot, not the history\./, 'a wrong option with its explanation');
  assert.doesNotMatch(misconceptions, /It keeps the history\./, 'the right option is no misconception');
  const log = section('Study log');
  assert.match(log, /The caretaker stores snapshots/);
  assert.match(log, /\[page 3\]\(#studyhub-cite\/deck\/c1\/0\)/, 'the page of the citation, as a link the note page opens at the quote');
  assert.match(log, /Why can the caretaker not read it\?[\s\S]*The narrow interface hides the state\./);
  assert.deepEqual(note.followupIds, ['f1'], 'the Q&A it holds, so 存进笔记 does not add it again');
});

test('the Chinese page writes the Chinese headings; a plain note.create (挑题成文) stays the empty template without the question', async t => {
  const { service } = await library(t);
  const zh = await service.call('note.create', { title: '学习笔记', cards: [{ deckId: 'deck', cardId: 'c1' }], prefill: true, language: 'zh' });
  for (const heading of ['核心概念', '常见误区', '解析与例子', '学习记录']) assert.match(zh.markdown, new RegExp(`\\n## ${heading}\\n`));
  assert.match(zh.markdown, /来源：\[第 3 页\]\(#studyhub-cite\/deck\/c1\/0\)/);
  const plain = await service.call('note.create', { title: 'Public', cards: [{ deckId: 'deck', cardId: 'c1' }] });
  assert.ok(!plain.markdown.includes('Which part manages'), 'a note for a public article is not prefilled with the question');
});

test('存进笔记 makes the note when there is none, adds a new Q&A once, and a repeated click changes nothing', async t => {
  const { service } = await library(t);
  const ref = { deckId: 'deck', cardId: 'c1', title: 'Study note', language: 'en' };
  const first = await service.call('note.qa.add', { ...ref, followupId: 'f1' });
  assert.equal(first.status, 'created');
  assert.match(first.note.markdown, /Why can the caretaker not read it\?/);
  const again = await service.call('note.qa.add', { ...ref, followupId: 'f1' });
  assert.equal(again.status, 'unchanged');
  assert.equal(again.note.revision, first.note.revision);
  await addFollowup(service, 'f2', 'What does the originator need?', 'Access to its own state.');
  const added = await service.call('note.qa.add', { ...ref, followupId: 'f2' });
  assert.equal(added.status, 'added');
  assert.equal(added.note.id, first.note.id, 'the same note: the open draft of exactly this question (the one 写笔记 opens)');
  assert.equal(added.note.revision, first.note.revision + 1);
  const twice = await service.call('note.qa.add', { ...ref, followupId: 'f2' });
  assert.equal(twice.status, 'unchanged');
  const text = (await service.call('note.get', { id: first.note.id })).markdown;
  assert.equal(text.split('What does the originator need?').length, 2, 'the Q&A is in the note once');
  assert.equal(text.split('Why can the caretaker not read it?').length, 2);
  assert.deepEqual((await service.call('snapshot')).noteBadges.c1[0].followupIds, ['f1', 'f2'], 'the practice page knows what is saved');
  await assert.rejects(service.call('note.qa.add', { ...ref, followupId: 'gone' }), /问答/);
});

test('存进笔记 never overwrites what the learner is writing: their stale save is refused and keeps the Q&A', async t => {
  const { service } = await library(t);
  const opened = await service.call('note.create', { title: 'Study note', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true, prefill: true, language: 'en' });
  await addFollowup(service, 'f2', 'What does the originator need?', 'Access to its own state.');
  await service.call('note.qa.add', { deckId: 'deck', cardId: 'c1', followupId: 'f2', title: 'Study note', language: 'en' });
  await assert.rejects(service.call('note.save', { id: opened.id, expectedRevision: opened.revision, markdown: 'typed in the open editor' }), /更新/);
  assert.match((await service.call('note.get', { id: opened.id })).markdown, /What does the originator need\?/);
});

test('a published note is finished: 存进笔记 starts a new draft instead of touching it', async t => {
  const { service } = await library(t);
  const ref = { deckId: 'deck', cardId: 'c1', title: 'Study note', language: 'en', followupId: 'f1' };
  const first = await service.call('note.qa.add', ref);
  await service.call('note.home', { home: 'https://blog.csdn.net/example' });
  await service.call('note.link', { id: first.note.id, url: 'https://blog.csdn.net/example/article/details/1' });
  const next = await service.call('note.qa.add', ref);
  assert.equal(next.status, 'created');
  assert.notEqual(next.note.id, first.note.id);
});
