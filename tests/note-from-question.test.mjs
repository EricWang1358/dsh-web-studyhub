import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { followupDigest } from '../lib/followup.js';
import { renderNoteMarkdown } from '../ui/note-markdown.js';

/* 写笔记 / 存进笔记 from a question (#1017): the note starts with what the learner just worked through (stem and answer, the misconception and the
   wrong options, the explanation with its page, each Q&A), written from the card with no model call; a Q&A saved again is never added twice; a learner's
   unsaved writing is never overwritten (the revision check of note.save). */

const QUOTE = 'Caretaker keeps the history of snapshots without looking inside them.';

async function library(t, language = 'en', { complete } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-note-question-'));
  let calls = 0;
  const service = new StudyService(root, { complete: complete || (async () => { calls++; return '{}'; }) });
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

/* ---------- gate review of #1024 ---------- */

const editCard = (service, change) => service.store.update(state => { change(state.decks[0].cards[0]); });
const html = markdown => renderNoteMarkdown(markdown);
const count = (text, pattern) => (text.match(pattern) || []).length;

test('a stem with an open code fence, heading lines or a multi-line option explanation leaves the note\'s own headings intact', async t => {
  const { service } = await library(t);
  await editCard(service, card => {
    card.prompt = '```js\nconst memento = save();\n';
    card.misconception = '# Big claim\nThe memento manages history.';
    card.options[1].explanation = 'It is one snapshot.\n```\nopen fence in an option';
  });
  const note = await service.call('note.create', { title: 'Study note', cards: [{ deckId: 'deck', cardId: 'c1' }], prefill: true, language: 'en' });
  const page = html(note.markdown);
  assert.equal(count(page, /<h1>/g), 1, 'one title: a heading line of the card is not a note heading of that level');
  for (const heading of ['Core concepts', 'Common misconceptions', 'Explanation and examples', 'Study log']) assert.match(page, new RegExp(`<h2>${heading}</h2>`), heading);
  assert.match(page, /<li>[^]*?Memento[^]*?It is one snapshot\.[^]*?open fence in an option[^]*?<\/li>/, 'a multi-line explanation stays in its list item');
  assert.match(page, /The caretaker stores snapshots/);
  assert.doesNotMatch(page.slice(page.indexOf('<h2>Study log</h2>')), /<pre>/, 'nothing after the stem sits in a code block');
  assert.match(note.markdown, /\*\*Question:\*\*\n\n```js/, 'the label on its own line, the value as its own block');
});

test('a Q&A counts as saved only while its question is still in the note: deleted by the learner, or lost to a recovered draft, it is added again', async t => {
  const { service } = await library(t);
  const ref = { deckId: 'deck', cardId: 'c1', title: 'Study note', language: 'en' };
  const first = await service.call('note.qa.add', { ...ref, followupId: 'f1' });
  // The learner deletes the section (or a recovered local draft, saved over the current revision, never had it).
  const without = first.note.markdown.split('> **Follow-up:**')[0];
  const saved = await service.call('note.save', { id: first.note.id, expectedRevision: first.note.revision, markdown: without });
  assert.deepEqual((await service.call('snapshot')).noteBadges.c1[0].followupIds, [], 'the practice page no longer says 已存进笔记');
  const again = await service.call('note.qa.add', { ...ref, followupId: 'f1' });
  assert.equal(again.status, 'added');
  assert.equal(again.note.revision, saved.revision + 1);
  assert.equal(again.note.markdown.split('Why can the caretaker not read it?').length, 2, 'back once');
  assert.deepEqual(again.note.followupIds, ['f1'], 'the id is recorded once');
  assert.equal((await service.call('note.qa.add', { ...ref, followupId: 'f1' })).status, 'unchanged');
});

test('an AI draft that replaces the text forgets the Q&A it held; 存进笔记 during a running draft is refused and the draft goes on', async t => {
  let release;
  const draft = '# Study note\n\n' + 'A clear explanation of the caretaker and the memento, with an example of saving and restoring. '.repeat(4);
  const { service } = await library(t, 'en', { complete: () => new Promise(resolve => { release = () => resolve(draft); }) });
  const ref = { deckId: 'deck', cardId: 'c1', title: 'Study note', language: 'en' };
  const first = await service.call('note.qa.add', { ...ref, followupId: 'f1' });
  await service.call('note.generate', { id: first.note.id });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await addFollowup(service, 'f2', 'What does the originator need?', 'Access to its own state.');
  await assert.rejects(service.call('note.qa.add', { ...ref, followupId: 'f2' }), /AI/, 'a new Q&A is refused with a plain message while the draft is written');
  release();
  let ready;
  for (let i = 0; i < 60; i++) {
    ready = await service.call('note.get', { id: first.note.id });
    if (ready.generation?.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(ready.generation.status, 'done', 'the draft was not superseded');
  assert.equal(ready.markdown.trim(), draft.trim());
  assert.deepEqual(ready.followupIds || [], [], 'the new text holds no Q&A');
  assert.equal((await service.call('note.qa.add', { ...ref, followupId: 'f1' })).status, 'added');
});

test('a prefilled note keeps within the note length: the newest Q&A that fit, and a line saying how many were left out', async t => {
  const { service } = await library(t);
  await editCard(service, card => {
    for (let n = 2; n <= 6; n++) card.followups.push({ id: `f${n}`, digest: followupDigest(card), question: `Question ${n}?`, answer: `${'long answer '.repeat(4000)}${n}` });
  });
  const note = await service.call('note.create', { title: 'Study note', cards: [{ deckId: 'deck', cardId: 'c1' }], prefill: true, language: 'en' });
  assert.ok(note.markdown.length <= 200000, `within the limit (${note.markdown.length})`);
  assert.match(note.markdown, /Question 6\?/, 'the newest Q&A is kept');
  assert.doesNotMatch(note.markdown, /Why can the caretaker not read it\?/, 'the oldest is left out');
  assert.match(note.markdown, /\d+ earlier Q&A (was|were) left out/);
  assert.ok(!note.followupIds.includes('f1') && note.followupIds.includes('f6'), 'only what the note holds is recorded');
});

test('a 挑题成文 draft of the same question is not the question\'s note: 写笔记 and 存进笔记 make their own; the badge says saved only for that note', async t => {
  const { service } = await library(t);
  const article = await service.call('note.create', { title: 'Public', cards: [{ deckId: 'deck', cardId: 'c1' }] });
  const created = await service.call('note.qa.add', { deckId: 'deck', cardId: 'c1', title: 'Study note', language: 'en', followupId: 'f1' });
  assert.equal(created.status, 'created');
  assert.notEqual(created.note.id, article.id, 'the public-article draft is left alone');
  const reused = await service.call('note.create', { title: 'Study note', cards: [{ deckId: 'deck', cardId: 'c1' }], reuse: true, prefill: true, language: 'en' });
  assert.equal(reused.id, created.note.id);
  const badges = (await service.call('snapshot')).noteBadges.c1;
  assert.deepEqual(badges.find(badge => badge.noteId === article.id).followupIds, []);
  assert.deepEqual(badges.find(badge => badge.noteId === created.note.id).followupIds, ['f1']);
  assert.equal(badges.filter(badge => badge.qa).length, 1, 'one badge is the note 存进笔记 writes to');
  assert.equal(badges.find(badge => badge.qa).noteId, created.note.id);
});
