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
import { markReread } from '../lib/contexts/library/mark-reread.js';
import { materialMasteryOf } from '../lib/material-mastery.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { groupRevision } from '../lib/document-outline.js';
import { textHash } from '../lib/passage-translation.js';

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

test('an archived material is not offered', async t => {
  const { service, mark, age, reread } = await library(t);
  await mark('book-p1', 'keeps the history of snapshots', 'highlight');
  await age();
  assert.equal((await reread({ course: 'SA' })).count, 1);
  await service.store.update(state => { for (const source of state.sources) if (source.id.startsWith('book-')) source.archived = true; });
  assert.equal((await reread({ course: 'SA' })).count, 0);
});

/* The host has one event loop: the list must not hold it. A made-up library of 10 books of 500 pages (frozen, as the store shares it), 4000 questions
   and 600 marks. The yardstick is measured in the same process (grouping the library once with its texts, what the 资料 page pays per revision), so a
   slow machine moves both. The very first answer must check every marked book's revision once (the hash of its pages, as materials does when
   the book opens), so it stays under one grouping; a repeated answer costs about nothing, and the answer after 已重读 (one page of one book changed,
   the rest shared and their revisions kept) well under half of one. */
const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); } return value; };
function bigLibrary() {
  const at = new Date(Date.now() - 6 * DAY).toISOString(), sources = [], decks = [], attempts = [];
  for (let book = 0; book < 10; book++) {
    for (let page = 1; page <= 500; page++) sources.push({ id: `b${book}-p${page}`, title: `Book ${book} · p. ${page}`, courses: ['SA'], createdAt: at,
      text: `Page ${page} of book ${book}. ${'Lorem ipsum dolor sit amet consectetur. '.repeat(40)}`,
      document: { materialId: `document-b${book}`, page, totalPages: 500, format: 'pdf', origin: 'converted', converter: 'marker', filename: `b${book}.pdf`, extractionVersion: 2 } });
    const cards = [];
    for (let n = 0; n < 400; n++) cards.push({ id: `c${book}-${n}`, kind: 'flashcard', topic: 't', prompt: `Q${n}`, answer: 'A', citations: [{ sourceId: `b${book}-p${1 + (n * 7) % 500}`, quote: `Page ${1 + (n * 7) % 500} of book ${book}.` }] });
    decks.push({ id: `deck${book}`, title: `Deck ${book}`, course: 'SA', cards });
    for (let n = 0; n < 400; n += 3) attempts.push({ deckId: `deck${book}`, quiz_id: `c${book}-${n}`, grade: 1, at });
  }
  const byId = new Map(sources.map(source => [source.id, source]));
  for (let book = 0; book < 10; book++) {
    const members = sources.filter(source => source.document.materialId === `document-b${book}`), items = [];
    for (let m = 0; m < 60; m++) {
      const sourceId = `b${book}-p${1 + (m * 13) % 500}`, quote = `Page ${1 + (m * 13) % 500} of book ${book}.`;
      items.push({ id: `${m % 2 ? 'bold' : 'highlight'}|${sourceId}:${m}`, key: `${sourceId}:${m}`, style: m % 2 ? 'bold' : 'highlight', sourceId, start: 0, end: quote.length, hash: textHash(byId.get(sourceId).text.slice(0, quote.length)), quote, at });
    }
    byId.get(`b${book}-p1`).marks = { revision: groupRevision(members), items };
  }
  return { revision: 1, sources, documents: [], decks, drafts: [], attempts, courses: [], settings: {} };
}
const timed = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };

test('the list costs little on a large library: well under one grouping of it when new, about nothing when asked again', () => {
  const state = deepFreeze(bigLibrary()), now = Date.now(), root = 'timing-guard';
  // Warm the code first on a library of its own (another root, other objects), so the cold answer measures the work, not the JIT: run alone, the
  // test was slower than the yardstick 2 times in 8.
  { const warm = deepFreeze(bigLibrary()); materialMasteryOf(warm, { root: 'timing-warm', now }); markReread(warm, { course: 'SA', now }, { root: 'timing-warm' }); }
  const yardstick = Math.min(...[0, 1].map(() => timed(() => groupSourcesByDocument(state.sources)).ms));
  materialMasteryOf(state, { root, now }); // the snapshot of the same revision pays this before the home asks
  const cold = timed(() => markReread(state, { course: 'SA', now }, { root }));
  assert.equal(cold.value.count, 3);
  const hit = timed(() => markReread(state, { course: 'SA', now }, { root }));
  // 已重读 on one book: its first page (the holder) is a new object, every other page the same; the library's revision moves on.
  const holder = state.sources.find(source => source.id === 'b0-p1');
  const marks = { ...holder.marks, items: holder.marks.items.map((item, at) => (at === 0 ? { ...item, rereadAt: new Date(now).toISOString() } : item)) };
  const next = deepFreeze({ ...state, revision: 2, sources: state.sources.map(source => (source === holder ? { ...holder, marks } : source)) });
  materialMasteryOf(next, { root, now });
  const after = timed(() => markReread(next, { course: 'SA', now }, { root }));
  assert.equal(after.value.count, 2, 'one re-read today: two more');
  const report = `yardstick ${yardstick.toFixed(1)} ms, new ${cold.ms.toFixed(1)} ms, again ${hit.ms.toFixed(2)} ms, after 已重读 ${after.ms.toFixed(1)} ms`;
  // Twice the yardstick: the cold answer is about one grouping (CI measured 42.5 against 42.4 ms), and the stall this guards against was 18 times it.
  assert.ok(cold.ms < 2 * yardstick, report);
  assert.ok(hit.ms < Math.max(2, yardstick / 50), report);
  assert.ok(after.ms < yardstick / 2, report);
});
