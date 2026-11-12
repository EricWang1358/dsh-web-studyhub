/* 重读 N 段 (#1018): the reader's highlighter and bold marks come back in 今日 where the learner is weak. materials.marks.reread lists them across
   materials: marks of the current revision whose words are still there, not seen for 3 days (made or re-read), in a section (the chapter, else the
   page, else the material) with a due or weak question, the riskiest section first, at most 3 a day. materials.marks.seen records 已重读 on the mark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { capabilityIndex, filterCapabilities } from '../lib/runtime/tools.js';

const DAY = 86400000, NOW = Date.now(), OLD = new Date(NOW - 5 * DAY).toISOString();
const PAGES = [
  'Page one explains the caretaker, which keeps the history of snapshots.',
  'Page two explains the originator, which makes and restores a snapshot.',
  'Page three explains the memento, the snapshot itself, opaque to others.',
  'Page four explains the bridge, which separates abstraction and implementation.',
];

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-marks-reread-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.call('snapshot');
  await service.store.update(state => {
    // A converted PDF of four pages in course SA, and one page of another course.
    PAGES.forEach((text, at) => state.sources.push({ id: `book-p${at + 1}`, title: `Patterns · p. ${at + 1}`, text, courses: ['SA'], createdAt: OLD,
      document: { materialId: 'document-patterns', page: at + 1, totalPages: 4, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Patterns.pdf', extractionVersion: 2 } }));
    state.sources.push({ id: 'other-p1', title: 'Other · p. 1', text: 'Another course explains caching and its expiry rules here.', courses: ['OS'], createdAt: OLD,
      document: { materialId: 'document-other', page: 1, totalPages: 1, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Other.pdf', extractionVersion: 2 } });
    const card = (id, sourceId) => ({ id, kind: 'flashcard', topic: 't', prompt: `Q ${id}`, answer: 'A', citations: [{ sourceId, quote: state.sources.find(s => s.id === sourceId).text.slice(0, 30) }] });
    // Page 1: two weak questions; page 2: one weak; page 3: one question never answered (no risk); page 4: none. Other course: one weak.
    state.decks.push({ id: 'deck', title: 'Patterns', course: 'SA', cards: [card('a1', 'book-p1'), card('a2', 'book-p1'), card('b1', 'book-p2'), card('c1', 'book-p3')] });
    state.decks.push({ id: 'other', title: 'Other', course: 'OS', cards: [card('o1', 'other-p1')] });
    for (const [deckId, id] of [['deck', 'a1'], ['deck', 'a2'], ['deck', 'b1'], ['other', 'o1']]) state.attempts.push({ deckId, quiz_id: id, grade: 1, at: OLD });
  });
  const mark = async (sourceId, quote, style) => {
    const saved = await service.call('materials.marks.save', { sourceId, selection: { sourceId, quote }, style });
    assert.equal(saved.status, 'saved', `${quote} ${style}`);
    return saved;
  };
  /** Every mark made 5 days ago (a mark is "seen" when it is made). */
  const age = () => service.store.update(state => { for (const source of state.sources) for (const item of source.marks?.items || []) item.at = OLD; });
  const reread = (args = {}) => service.call('materials.marks.reread', { now: NOW, todayStart: NOW - 60000, ...args });
  return { service, mark, age, reread };
}

test('highlighter and bold marks in weak sections come back, the riskiest page first; underline, queue and safe pages do not', async t => {
  const { mark, age, reread } = await library(t);
  await mark('book-p2', 'originator, which makes', 'highlight');
  await mark('book-p1', 'keeps the history of snapshots', 'bold');
  await mark('book-p1', 'Page one explains', 'underline');
  await mark('book-p1', 'the caretaker', 'queue');
  await mark('book-p3', 'the snapshot itself', 'highlight');
  await mark('book-p4', 'separates abstraction', 'highlight');
  await age();
  const listed = await reread({ course: 'SA' });
  assert.deepEqual(listed.items.map(item => [item.selection.quote, item.style]),
    [['keeps the history of snapshots', 'bold'], ['originator, which makes', 'highlight']], 'page 1 (2 weak) before page 2 (1 weak); no risk, no line');
  const first = listed.items[0];
  assert.equal(first.selection.sourceId, 'book-p1');
  assert.equal(first.page, 1);
  assert.equal(first.title, 'Patterns.pdf');
  assert.deepEqual(first.risk, { due: 0, weak: 2 });
  assert.ok(first.documentId && first.revision && first.id, 'what the reader and materials.marks.seen need');
  assert.equal(first.selection.revision, first.revision, 'the passage names its revision, so the reader does not call it an older one');
  assert.equal(listed.count, 2);
});

test('a mark made or re-read in the last 3 days, a mark of another course and a mark of an older revision are not offered', async t => {
  const { service, mark, age, reread } = await library(t);
  await mark('book-p1', 'keeps the history of snapshots', 'highlight');
  await mark('other-p1', 'caching and its expiry', 'highlight');
  assert.equal((await reread({ course: 'SA' })).count, 0, 'just made: the learner has just read it');
  await age();
  assert.equal((await reread({ course: 'SA' })).count, 1);
  assert.equal((await reread({ course: 'OS' })).items[0].selection.quote, 'caching and its expiry');
  assert.equal((await reread({})).count, 2, 'no course: every course');
  // The page's words change: a new revision of the material; what the old one kept is stale and never offered.
  await service.store.update(state => { state.sources.find(source => source.id === 'book-p1').text += ' Edited.'; });
  assert.equal((await reread({ course: 'SA' })).count, 0);
});

test('at most 3 a day; 已重读 records the time on the mark, takes it off the list and counts toward the day', async t => {
  const { service, mark, age, reread } = await library(t);
  await mark('book-p1', 'Page one explains the caretaker', 'highlight');
  await mark('book-p1', 'keeps the history of snapshots', 'bold');
  await mark('book-p2', 'Page two explains', 'highlight');
  await mark('book-p2', 'makes and restores a snapshot', 'bold');
  await age();
  const listed = await reread({ course: 'SA' });
  assert.equal(listed.items.length, 3, 'three a day');
  assert.equal(listed.total, 4, 'of four waiting');
  // The reader addresses the mark by its source: a material with no document record (this one) has no documentId the materials ops know.
  const target = { sourceId: listed.items[0].selection.sourceId, revision: listed.items[0].revision };
  const done = await service.call('materials.marks.seen', { ...target, id: listed.items[0].id });
  assert.equal(done.status, 'saved');
  assert.ok(Date.parse(done.item.rereadAt) >= NOW - 1000, 'the time is kept beside the mark');
  const after = await reread({ course: 'SA' });
  assert.equal(after.items.length, 2, 'two left today: three a day, one done');
  assert.ok(!after.items.some(item => item.id === listed.items[0].id), 'the re-read one waits 3 days');
  const kept = await service.call('materials.marks.list', target);
  assert.equal(kept.items.find(item => item.id === listed.items[0].id).rereadAt, done.item.rereadAt, 'the reader keeps it too');
  assert.equal((await service.call('materials.marks.seen', { ...target, id: 'gone' })).status, 'missing');
});

test('a library without marks answers at once with nothing', async t => {
  const { reread } = await library(t);
  assert.deepEqual(await reread({ course: 'SA' }), { items: [], count: 0, total: 0 });
});

test('an imported document keeps its marks on its version: listed with its document id, and 已重读 by that id', async t => {
  const { service, reread } = await library(t);
  const text = '# Tactics\n\nAvailability tactics detect faults and recover from them quickly.\n';
  const imported = await service.call('materials.document.import', { filename: 'tactics.md', courses: ['SA'], dataBase64: Buffer.from(text).toString('base64') });
  const document = await service.call('materials.document.get', { id: imported.documentId }), sourceId = document.sources[0].id;
  await service.store.update(state => {
    state.decks.push({ id: 'tactics', title: 'Tactics', course: 'SA', cards: [{ id: 't1', kind: 'flashcard', topic: 't', prompt: 'Q', answer: 'A', citations: [{ sourceId, quote: 'detect faults' }] }] });
    state.attempts.push({ deckId: 'tactics', quiz_id: 't1', grade: 1, at: OLD });
  });
  const id = { documentId: document.documentId, revision: document.revision };
  assert.equal((await service.call('materials.marks.save', { ...id, selection: { ...id, sourceId, quote: 'recover from them quickly' }, style: 'highlight' })).status, 'saved');
  await service.store.update(state => { for (const version of state.documents.flatMap(item => item.versions)) for (const item of version.marks?.items || []) item.at = OLD; });
  const listed = await reread({ course: 'SA' });
  assert.deepEqual(listed.items.map(item => [item.documentId, item.selection.quote]), [[document.documentId, 'recover from them quickly']]);
  assert.equal(listed.items[0].page, undefined, 'a text has no pages to name');
  assert.equal((await service.call('materials.marks.seen', { ...id, id: listed.items[0].id })).status, 'saved');
  assert.equal((await reread({ course: 'SA' })).count, 0);
});

test('the reread list is the home page read: the main chat is refused it and sees it neither in the index nor in a context listing', () => {
  assert.match(assistantRefusal('materials.marks.reread') || '', /not available to the assistant/);
  assert.equal(assistantRefusal('materials.marks.seen'), null);
  const domain = { id: 'library', api: 'library.v1', operations: ['materials.marks.list', 'materials.marks.reread', 'materials.marks.seen'].map((name) => ({ name, available: true })) };
  assert.doesNotMatch(JSON.stringify(capabilityIndex([domain])), /marks\.reread/);
  const listed = JSON.stringify(filterCapabilities([domain], { context: 'library' }));
  assert.doesNotMatch(listed, /marks\.reread/);
  assert.match(listed, /marks\.seen/);
});
