/* One document, one set of questions (2.6.2). The 资料 row (`materialMasteryIndex`) and the reader's 整份资料 range (`pagesCardsView`)
   used to read different sources of the same material, so the row said 未学 · 30 题 while the reader said 15 题 · 4 道到期.
   Both now take the questions of a document from `documentCardSet`: every question that cites ANY version / source record of it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as mastery from '../lib/material-mastery.js';

const { materialMasteryIndex, pagesCardsView, summarizeLinked } = mastery;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const day = 86400000;
const iso = ms => new Date(ms).toISOString();
const cite = (sourceId, start = 0, end = 3) => ({ sourceId, quote: 'q', selection: { sourceId, start, end, quote: 'q', revision: 'r' } });
const card = (id, sourceIds, answered = false) => ({ id, kind: 'flashcard', topic: 't', prompt: `Q ${id}`, answer: 'A', citations: sourceIds.map(sourceId => cite(sourceId)),
  ...(answered ? { review: { repetitions: 2, interval_days: 3, due_at: iso(NOW - day) } } : {}) });
const cards = (prefix, count, sourceIds, answeredCount = 0) => Array.from({ length: count }, (_, index) => card(`${prefix}${index}`, sourceIds, index < answeredCount));
const textSource = (id, materialId, extra = {}) => ({ id, title: `Lecture ${id}`, text: `text of ${id}`, document: { materialId, format: 'txt', filename: 'lecture.txt' }, ...extra });
const only = (state, key) => materialMasteryIndex(state, { now: NOW })[key];

/** The recording imported again: version r1 (15 questions, 4 answered) was replaced by r2 (30 questions, all new). `parts` source records per version. */
function twoVersions(parts = 1) {
  const oldIds = Array.from({ length: parts }, (_, index) => `old${index + 1}`), newIds = Array.from({ length: parts }, (_, index) => `new${index + 1}`);
  return { oldIds, newIds, state: {
    sources: [...oldIds, ...newIds].map(id => textSource(id, 'document-A')),
    documents: [{ id: 'document-A', title: 'Lecture', format: 'txt', currentRevision: 'r2',
      versions: [{ revision: 'r1', sourceIds: oldIds }, { revision: 'r2', sourceIds: newIds }] }],
    decks: [{ id: 'old', title: 'Old run', cards: cards('o', 15, oldIds, 4) }, { id: 'fresh', title: 'New run', cards: cards('n', 30, newIds) }],
    attempts: [], drafts: [], courses: [] } };
}
const view = (state, args) => pagesCardsView(state, args, { now: NOW });

test('a re-imported document counts the questions of every version, in the row and in the reader, from either version', () => {
  const { state, oldIds, newIds } = twoVersions();
  const row = only(state, 'doc:document-A').document;
  assert.equal(row.total, 45, 'the row counts the questions of all versions');
  for (const sourceId of [newIds[0], oldIds[0]]) {
    const reading = view(state, { documentId: 'document-A', sourceId });
    assert.equal(reading.cards.length, 45, `reader anchored at ${sourceId}`);
    assert.deepEqual(reading.summary, row, `reader anchored at ${sourceId} says what the row says`);
  }
  assert.equal(row.state, 'learning');
  assert.equal(row.fresh, 41);
  assert.equal(row.due, 4);
});

test('a document made of several source records (audio parts) is one set, whatever record the reader is anchored at', () => {
  const { state, oldIds, newIds } = twoVersions(2);
  const row = only(state, 'doc:document-A').document;
  assert.equal(row.total, 45);
  for (const sourceId of [...newIds, ...oldIds]) assert.deepEqual(view(state, { documentId: 'document-A', sourceId }).summary, row, sourceId);
  assert.deepEqual(view(state, { documentId: 'document-A' }).summary, row, 'a document alone opens the same set');
  assert.deepEqual(view(state, { sourceId: newIds[1] }).summary, row, 'a source alone opens the same set');
});

/** The recording as the library really holds it: no documents[] entry, two audio parts, and another material that comes first in the list. */
function legacyAudio() {
  const pdf = [1, 2].map(page => ({ id: `pdf${page}`, title: `Book · p.${page}`, text: `page ${page}`,
    document: { id: 'h'.repeat(64), page, format: 'pdf', materialId: `document-${'h'.repeat(64)}-pdf`, filename: 'book.pdf' } }));
  const audio = [1, 2].map(volume => ({ id: `audio-x-p${volume}`, title: `Training (${volume}/2)`, text: `speech ${volume}`,
    audio: { batch: { id: 'batch-1', title: 'Training', volume, volumes: 2 }, sourceIds: ['audio-x-p1', 'audio-x-p2'] } }));
  return { sources: [...pdf, ...audio], documents: [], attempts: [], drafts: [], courses: [],
    decks: [{ id: 'book', title: 'Book', cards: cards('b', 15, ['pdf1'], 4) }, { id: 'speech', title: 'Speech', cards: [...cards('s', 15, ['audio-x-p1']), ...cards('t', 15, ['audio-x-p2'])] }] };
}

test('the reader never shows another material\'s questions for a legacy document id (source-<id>), and sees all parts of the recording', () => {
  const state = legacyAudio();
  const key = 'audio:batch-1', row = only(state, key).document;
  assert.deepEqual([row.total, row.state], [30, 'unlearned']);
  for (const sourceId of ['audio-x-p1', 'audio-x-p2']) {
    const reading = view(state, { documentId: `source-${sourceId}`, sourceId });
    assert.equal(reading.status, 'ok');
    assert.deepEqual(reading.sourceIds, ['audio-x-p1', 'audio-x-p2']);
    assert.equal(reading.cards.length, 30, `anchored at ${sourceId}: the whole recording, not the first material of the library`);
    assert.ok(reading.cards.every(entry => /^[st]\d+$/.test(entry.cardId)));
    assert.deepEqual(reading.summary, row);
  }
});

test('an unknown document id with an anchor that is nowhere is reported missing', () => {
  assert.equal(view(legacyAudio(), { documentId: 'document-nope', sourceId: 'nope' }).status, 'missing');
});

test('for every document of a library the row and the reader agree (total, due, new, mastery), versions and parts included', () => {
  const versioned = twoVersions(2), legacy = legacyAudio();
  const state = { ...legacy, sources: [...legacy.sources, ...versioned.state.sources], documents: versioned.state.documents,
    decks: [...legacy.decks, ...versioned.state.decks] };
  const index = materialMasteryIndex(state, { now: NOW });
  assert.equal(Object.keys(index).length, 3);
  const expected = { 'audio:batch-1': 30, 'doc:document-A': 45 };
  for (const [key, total] of Object.entries(expected)) assert.equal(index[key].document.total, total, key);
  for (const item of [{ documentId: 'document-A', sourceId: 'new2' }, { documentId: 'source-audio-x-p2', sourceId: 'audio-x-p2' }, { sourceId: 'pdf2' }]) {
    const reading = view(state, item), key = reading.key;
    assert.ok(index[key], `${JSON.stringify(item)} has a row (${key})`);
    assert.deepEqual(index[key].document, summarizeLinked(reading.cards), JSON.stringify(item));
  }
});

test('the row\'s pages and chapters keep their per-source meaning: only the version that is listed, every page by itself', () => {
  const { state, oldIds, newIds } = twoVersions(2);
  const entry = only(state, 'doc:document-A');
  assert.deepEqual(Object.keys(entry.pages).sort(), newIds);
  assert.equal(entry.pages.new1.total, 30, 'every card cites both parts');
  assert.equal(entry.pages[oldIds[0]], undefined, 'an old version has no page entry');
  const narrowed = view(state, { documentId: 'document-A', sourceId: newIds[0], sourceIds: [newIds[0]] });
  assert.equal(narrowed.cards.length, 30, 'a page range still reads only those pages');
  assert.ok(narrowed.cards.every(entry => entry.cardId.startsWith('n')));
});

test('the reader says how many of the counted questions belong to other versions of the document (olderCards)', () => {
  const { state, oldIds, newIds } = twoVersions();
  const current = view(state, { documentId: 'document-A', sourceId: newIds[0] });
  assert.equal(current.olderCards, 15);
  assert.equal(current.cards.filter(entry => entry.otherVersion).length, 15);
  assert.ok(current.cards.filter(entry => entry.otherVersion).every(entry => entry.cardId.startsWith('o')));
  const old = view(state, { documentId: 'document-A', sourceId: oldIds[0] });
  assert.equal(old.olderCards, 30, 'reading the old version: the new version\'s questions are the "other" ones');
  assert.deepEqual(view(legacyAudio(), { sourceId: 'audio-x-p1' }).olderCards, 0);
});

test('a card citing both versions counts once and is not "older"', () => {
  const { state, oldIds, newIds } = twoVersions();
  state.decks[0].cards.push(card('both', [oldIds[0], newIds[0]]));
  const reading = view(state, { documentId: 'document-A', sourceId: newIds[0] });
  assert.equal(reading.cards.length, 46);
  assert.equal(reading.cards.find(entry => entry.cardId === 'both').otherVersion, undefined);
  assert.equal(reading.olderCards, 15);
  assert.equal(only(state, 'doc:document-A').document.total, 46);
});

test('suspended cards and archived decks stay out of the document set', () => {
  const { state, newIds } = twoVersions();
  state.decks[0].cards[0].suspended = true;
  state.decks[0].archived = false;
  state.decks.push({ id: 'gone', title: 'Gone', archived: true, cards: cards('g', 5, ['old1']) });
  const row = only(state, 'doc:document-A').document;
  assert.equal(row.total, 44);
  assert.equal(view(state, { documentId: 'document-A', sourceId: newIds[0] }).cards.length, 44);
});

test('drafts follow the same document-wide rule in the row and in the reader', () => {
  const { state, oldIds, newIds } = twoVersions();
  state.drafts = [{ id: 'dr1', title: 'Run', cards: [card('x', [oldIds[0]]), card('y', [newIds[0]]), card('z', [oldIds[0], newIds[0]])] }];
  const entry = only(state, 'doc:document-A');
  assert.equal(entry.document.draftCards, 3);
  assert.deepEqual(entry.drafts, { cards: 3, draftIds: ['dr1'] });
  for (const sourceId of [oldIds[0], newIds[0]]) {
    const reading = view(state, { documentId: 'document-A', sourceId });
    assert.equal(reading.draftCards, 3, sourceId);
    assert.deepEqual(reading.drafts, entry.drafts);
    assert.equal(reading.draftEntries.length, 3);
  }
});

test('documentCardSet is the one definition: the cards, their summary, the source ids and the draft questions of a document', () => {
  const { state, oldIds, newIds } = twoVersions(2);
  state.drafts = [{ id: 'dr1', cards: [card('x', [oldIds[0]])] }];
  assert.equal(typeof mastery.documentCardSet, 'function');
  const item = { sourceIds: [...newIds] };
  const set = mastery.documentCardSet(state, item, { now: NOW });
  assert.deepEqual(new Set(set.sourceIds), new Set([...oldIds, ...newIds]));
  assert.equal(set.cards.length, 45);
  assert.deepEqual(set.summary, summarizeLinked(set.cards));
  assert.equal(set.drafts.length, 1);
  assert.equal(new Set(set.cards.map(entry => `${entry.deckId}|${entry.cardId}`)).size, 45, 'each card once');
  const same = mastery.documentCardSet(state, { sourceIds: [...oldIds] }, { now: NOW });
  assert.deepEqual(same.cards.map(entry => entry.cardId).sort(), set.cards.map(entry => entry.cardId).sort(), 'any version of the document gives the same set');
});

/* ---------- the same recording, and the recordings a merged material consists of ---------- */

const HASH = { 1: '1'.repeat(64), 2: '2'.repeat(64), 3: '3'.repeat(64), 9: '9'.repeat(64) };
const single = (n, key = 'k1') => ({ id: `audio-${HASH[n].slice(0, 16)}-${key}`, title: `Rec ${n}`, text: `speech of recording ${n} (${key})`,
  audio: { hash: HASH[n], filename: `rec${n}.mp3`, sourceIds: [`audio-${HASH[n].slice(0, 16)}-${key}`] } });
const merged = (hashes, id = 'b1') => [1, 2].map(volume => ({ id: `audio-batch-${id}${volume > 1 ? `-p${volume}` : ''}`, title: `rec.mp3 + 2 (${volume}/2)`, text: `merged text ${volume}`,
  audio: { batch: { id, title: 'rec.mp3 + 2', volume, volumes: 2, sourceIds: [`audio-batch-${id}`, `audio-batch-${id}-p2`],
    ...(hashes ? { members: hashes.map((n, index) => ({ order: index + 1, filename: `rec${n}.mp3`, hash: HASH[n] })) } : {}) } } }));
const ID = { s1: single(1).id, s2: single(2).id, s3: single(3).id, d1: single(1, 'k2').id, o: single(9).id, m1: 'audio-batch-b1', m2: 'audio-batch-b1-p2' };

function recordings({ withMembers = true } = {}) {
  return { sources: [single(1), single(2), single(3), single(9), ...merged(withMembers ? [1, 2, 3] : null)], documents: [], attempts: [], drafts: [], courses: [],
    decks: [{ id: 'r1', title: 'Rec 1', cards: cards('a', 15, [ID.s1], 4) }, { id: 'r2', title: 'Rec 2', cards: cards('b', 15, [ID.s2], 3) }, { id: 'r3', title: 'Rec 3', cards: cards('c', 15, [ID.s3]) },
      { id: 'rm', title: 'Merged', cards: [...cards('m', 15, [ID.m1]), ...cards('n', 15, [ID.m2])] }, { id: 'ro', title: 'Other', cards: cards('z', 20, [ID.o]) }] };
}
const rowOf = (state, sourceId) => materialMasteryIndex(state, { now: NOW })[sourceId.startsWith('audio-batch-') ? 'audio:b1' : `source:${sourceId}`];
const readerOf = (state, sourceId) => view(state, { documentId: `source-${sourceId}`, sourceId });

test('a merged recording counts the questions of the single recordings it consists of; each single recording counts only itself', () => {
  const state = recordings();
  const mergedRow = rowOf(state, ID.m1).document;
  assert.equal(mergedRow.total, 75, '30 of its own + 15 + 15 + 15 of the three recordings');
  assert.deepEqual([rowOf(state, ID.s1).document.total, rowOf(state, ID.s2).document.total, rowOf(state, ID.s3).document.total], [15, 15, 15], 'never the merged material\'s questions');
  assert.equal(rowOf(state, ID.o).document.total, 20, 'a different recording stays itself');
  const reading = readerOf(state, ID.m2);
  assert.equal(reading.cards.length, 75);
  assert.deepEqual(reading.summary, mergedRow);
  assert.equal(reading.partCards, 45);
  assert.equal(reading.sameRecordingCards, 0);
  assert.equal(reading.olderCards, 0);
  assert.equal(reading.cards.filter(entry => entry.otherMaterial === 'part').length, 45);
  assert.ok(!reading.cards.some(entry => entry.cardId.startsWith('z')), 'the other recording never leaks in');
  for (const id of [ID.s1, ID.s2, ID.s3, ID.o]) {
    const single = readerOf(state, id);
    assert.deepEqual(single.summary, rowOf(state, id).document, id);
    assert.equal(single.partCards + single.sameRecordingCards, 0, `${id}: no other material counted`);
    assert.ok(!single.cards.some(entry => /^[mn]\d/.test(entry.cardId)), `${id}: the merged questions are not counted`);
  }
});

test('the same recording imported twice (another text key) is counted for each other, both ways', () => {
  const state = recordings();
  state.sources.push(single(1, 'k2'));
  state.decks.push({ id: 'dup', title: 'Dup', cards: cards('d', 5, [ID.d1]) });
  assert.equal(rowOf(state, ID.s1).document.total, 20);
  assert.equal(rowOf(state, ID.d1).document.total, 20);
  assert.equal(rowOf(state, ID.s2).document.total, 15);
  assert.equal(rowOf(state, ID.m1).document.total, 80, 'the merged material counts both single imports of recording 1');
  const reading = readerOf(state, ID.d1);
  assert.deepEqual(reading.summary, rowOf(state, ID.d1).document);
  assert.equal(reading.sameRecordingCards, 15);
  assert.equal(readerOf(state, ID.s1).sameRecordingCards, 5);
  assert.equal(readerOf(state, ID.m1).partCards, 50);
});

test('a card that cites two related sources counts once; unplaced or not, it is one question of the merged material', () => {
  const state = recordings();
  state.decks[0].cards.push(card('both', [ID.s1, ID.s2]));
  assert.equal(rowOf(state, ID.m1).document.total, 76);
  assert.equal(readerOf(state, ID.m1).cards.length, 76);
  assert.equal(rowOf(state, ID.s1).document.total, 16);
  assert.equal(rowOf(state, ID.s2).document.total, 16);
});

test('an older merged import that never recorded its members cannot be linked: it counts only itself (no guessing by title)', () => {
  const state = recordings({ withMembers: false });
  assert.equal(rowOf(state, ID.m1).document.total, 30);
  assert.equal(readerOf(state, ID.m1).cards.length, 30);
  assert.equal(rowOf(state, ID.s1).document.total, 15);
});

test('a single import with no audio.hash is linked by the recording hash in its source id; a source with neither is isolated', () => {
  const state = recordings();
  const noHash = single(1, 'k2'); delete noHash.audio.hash;
  state.sources.push(noHash, { id: 'plain', title: 'Rec 1', text: 'same title, no recording', document: { materialId: 'document-plain', format: 'txt' } });
  state.decks.push({ id: 'dup', title: 'Dup', cards: cards('d', 5, [ID.d1]) }, { id: 'pl', title: 'Plain', cards: cards('p', 4, ['plain']) });
  assert.equal(rowOf(state, ID.s1).document.total, 20);
  assert.equal(materialMasteryIndex(state, { now: NOW })['doc:document-plain'].document.total, 4, 'the same title alone relates nothing');
});

test('the shared function gives the same set to the row and to the reader for every material of the library', () => {
  const state = recordings();
  state.sources.push(single(1, 'k2'));
  state.decks.push({ id: 'dup', title: 'Dup', cards: cards('d', 5, [ID.d1]) });
  const index = materialMasteryIndex(state, { now: NOW });
  for (const id of [ID.s1, ID.s2, ID.s3, ID.o, ID.m1, ID.d1]) {
    const reading = readerOf(state, id);
    assert.ok(index[reading.key], id);
    assert.deepEqual(index[reading.key].document, summarizeLinked(reading.cards), id);
  }
});
