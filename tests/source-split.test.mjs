import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_MIN, QUESTION_MIN, SPLIT_MIN, columnWidth, dockReducer, dockedPlace, openDock, questionPlace, questionRoom, readColumnWidth, saveColumnWidth, sameMaterial,
  sourcePlacement }
  from '../ui/review/source-dock.js';
import { stripOf } from '../ui/review/question-strip.js';
import { keysElsewhere } from '../ui/review/session-logic.js';

/* #1012 对照栏: where a source opened from a question goes, how the column follows the questions without mounting the reader again, the 题干条 of the
   narrow reader (nothing of the answer), and whose keys a press is. */

const page = (n, doc = 'book') => ({ id: `${doc}-p${n}`, title: `${doc} p.${n}`, document: { id: `${doc}-hash`, page: n, totalPages: 60, format: 'pdf' } });
const note = { id: 'note-1', title: 'A note' };
const sources = [page(1), page(2), page(25), page(1, 'other'), note];
const run = (extra = {}) => ({ id: 'r', index: 0, mode: 'path', card: { id: 'c', kind: 'quiz' }, cardSource: { sourceId: 'book-p2', page: 2 }, ...extra });
const modal = (source, extra = {}) => ({ type: 'source', source, back: true, ...extra });

test('one decision: a source opened from a question docks on a wide page while a question is on it, else the dialog', () => {
  assert.equal(SPLIT_MIN, COLUMN_MIN + QUESTION_MIN, 'the split is there when both the column and the question fit');
  assert.equal(sourcePlacement({ modal: modal(page(2)), wide: true, run: run() }), 'column');
  assert.equal(sourcePlacement({ modal: modal(page(2)), wide: false, run: run() }), 'dialog', 'a narrow page keeps the dialog');
  assert.equal(sourcePlacement({ modal: modal(page(2), { back: false }), wide: true, run: run() }), 'dialog', 'not opened from a question');
  assert.equal(sourcePlacement({ modal: modal(page(2)), wide: true, run: run({ mode: 'exam' }) }), 'dialog', 'an exam has its own rules');
  assert.equal(sourcePlacement({ modal: modal(page(2)), wide: true, run: run({ complete: true, card: null }) }), 'dialog', 'the result page has no question');
  assert.equal(sourcePlacement({ modal: modal(page(2), { reread: { items: [], index: 0 } }), wide: true, run: run() }), 'dialog', '重读 walks its passages in the dialog');
  assert.equal(sourcePlacement({ modal: { type: 'flag' }, wide: true, run: run() }), 'dialog', 'not a source');
  assert.equal(sourcePlacement({ modal: modal(null), wide: true, run: run() }), 'dialog', 'a source that is gone');
});

test('a question\'s place is its page, without its answer; none in an exam or without a page', () => {
  assert.equal(questionPlace(run(), sources).id, 'book-p2');
  assert.equal(questionPlace(run({ cardSource: { sourceId: 'gone', documentSourceId: 'book-p1', page: 1 } }), sources).id, 'book-p1', 'the document\'s page when the source is gone');
  assert.equal(questionPlace(run({ mode: 'exam' }), sources), null);
  assert.equal(questionPlace(run({ cardSource: null }), sources), null);
  assert.equal(questionPlace(run({ cardSource: { sourceId: 'gone', page: 3 } }), sources), null);
  assert.ok(sameMaterial(page(1), page(25)), 'pages of one PDF are one material');
  assert.ok(!sameMaterial(page(1), page(1, 'other')), 'another PDF is another material');
  assert.ok(!sameMaterial(page(1), note));
});

test('the column follows the questions: within the material a seek (same key: the reader is not mounted again), another material a swap', () => {
  let state = openDock(modal(page(2), { pickPages: true }));
  assert.deepEqual([state.key, state.seek, state.at], [1, null, 'book-p2']);
  // The next question is on page 25 of the same book: a seek, the same key.
  state = dockReducer(state, { type: 'follow', place: page(25) });
  assert.equal(state.key, 1, 'no new reader for a place of the same material');
  assert.deepEqual(state.seek, { source: page(25), quote: '', nonce: 1 });
  assert.equal(state.modal.source.id, 'book-p2', 'the reader keeps the source it loaded');
  // The same place again (a re-ask, the next question on the same page) with no quote of an answer on screen: nothing moves.
  assert.equal(dockReducer(state, { type: 'follow', place: page(25) }), state);
  assert.equal(dockReducer(state, { type: 'follow', place: null }), state, 'a question without a page leaves the column where it is');
  // Another material: a swap, a new key.
  const swapped = dockReducer(state, { type: 'follow', place: page(1, 'other') });
  assert.deepEqual([swapped.key, swapped.seek, swapped.modal.source.id, !!swapped.modal.pickPages], [2, null, 'other-p1', false]);
});

test('a new question takes down the quote of an earlier answer, even on the same page: nothing of an answer stays on screen', () => {
  // 看原文 after a wrong answer opened the column at the answer's passage (its opening quote).
  let state = openDock(modal(page(2), { quote: 'EVIDENCE OF THE ANSWER' }));
  // The next question (or the same card asked again) is on the same page: the column stays, the quote goes, and the reader drops its marks.
  state = dockReducer(state, { type: 'follow', place: page(2) });
  assert.deepEqual([state.key, state.modal.quote, state.at], [1, '', 'book-p2'], 'the same reader, without the quote');
  assert.deepEqual(state.seek, { nonce: 1 }, 'a seek with no place: the reader only takes its marks down');
  // 看原文 while docked (a quoted seek), then a question with no page: the seek's quote goes too.
  state = dockReducer(state, { type: 'open', modal: modal(page(25), { quote: 'EVIDENCE 2' }) });
  assert.equal(state.seek.quote, 'EVIDENCE 2');
  state = dockReducer(state, { type: 'follow', place: null });
  assert.deepEqual(state.seek, { nonce: 3 }, 'no quote left, nothing sought');
  assert.equal(dockReducer(state, { type: 'follow', place: null }), state, 'nothing to take down twice');
  // Folded, the quote goes all the same (the place waits for the unfolding).
  let folded = dockReducer(openDock(modal(page(2), { quote: 'EVIDENCE' })), { type: 'collapse' });
  folded = dockReducer(folded, { type: 'follow', place: page(2) });
  assert.deepEqual([folded.modal.quote, folded.seek, folded.collapsed], ['', { nonce: 1 }, true]);
  folded = dockReducer(dockReducer(openDock(modal(page(2), { quote: 'EVIDENCE' })), { type: 'collapse' }), { type: 'follow', place: page(25) });
  assert.deepEqual([folded.modal.quote, folded.seek, folded.pending.id], ['', { nonce: 1 }, 'book-p25']);
});

test('a link opened while docked: same material a seek with its quote (the opening quote goes), another a swap; the column unfolds', () => {
  let state = openDock(modal(page(2), { quote: 'first quote' }));
  state = dockReducer(state, { type: 'collapse' });
  state = dockReducer(state, { type: 'open', modal: modal(page(25), { quote: 'cited words', peekPage: 25 }) });
  assert.deepEqual([state.key, state.collapsed, state.modal.quote], [1, false, '']);
  assert.deepEqual(state.seek, { source: page(25), quote: 'cited words', peekPage: 25, nonce: 1 });
  state = dockReducer(state, { type: 'open', modal: modal(note, { quote: 'q' }) });
  assert.deepEqual([state.key, state.seek, state.modal.quote], [2, null, 'q']);
});

test('folded, the column waits: the place of the last question is shown when it unfolds', () => {
  let state = dockReducer(openDock(modal(page(2))), { type: 'collapse' });
  state = dockReducer(state, { type: 'follow', place: page(25) });
  state = dockReducer(state, { type: 'follow', place: page(1) });
  assert.deepEqual([state.seek, state.pending.id, state.collapsed], [null, 'book-p1', true], 'nothing is sought while folded');
  state = dockReducer(state, { type: 'expand' });
  assert.deepEqual([state.collapsed, state.pending, state.key, state.seek.source.id], [false, null, 1, 'book-p1']);
  assert.equal(dockReducer(state, { type: 'expand' }), state);
});

test('a seek the reader cannot place mounts that place\'s material; a stale one is ignored', () => {
  const state = dockReducer(openDock(modal(page(2))), { type: 'follow', place: page(25) });
  const missed = dockReducer(state, { type: 'missed', seek: state.seek });
  assert.deepEqual([missed.key, missed.seek, missed.modal.source.id], [2, null, 'book-p25']);
  assert.equal(dockReducer(state, { type: 'missed', seek: { ...state.seek, nonce: 99 } }), state);
});

test('a page turning narrow hands the column\'s place to the reader dialog: where it is, with the quote of this question\'s link, nothing that waited', () => {
  let state = openDock(modal(page(2), { quote: 'cited', pickPages: true }));
  assert.deepEqual(dockedPlace(state), { type: 'source', source: page(2), back: true, quote: 'cited' });
  state = dockReducer(state, { type: 'follow', place: page(25) });
  assert.deepEqual(dockedPlace(state), { type: 'source', source: page(25), back: true }, 'the place it followed to, not the one it loaded');
  state = dockReducer(state, { type: 'open', modal: modal(page(1), { quote: 'answer passage' }) });
  assert.deepEqual(dockedPlace(state), { type: 'source', source: page(1), back: true, quote: 'answer passage' });
  state = dockReducer(dockReducer(state, { type: 'collapse' }), { type: 'follow', place: page(2) });
  assert.equal(dockedPlace(state), null, 'folded: the learner put the reader away, a narrower page does not bring it back');
  assert.deepEqual(dockedPlace(dockReducer(state, { type: 'expand' })), { type: 'source', source: page(2), back: true }, 'unfolded: the place that waited');
});

test('the split is decided on the room the question really shares with the column: the page less its padding, less the tick rail and both gaps when shown', () => {
  const page = { width: 1026, paddingLeft: 14, paddingRight: 16 };
  assert.equal(questionRoom(page), 996, 'no rail: the page\'s content box');
  assert.equal(questionRoom({ ...page, rail: 36, gap: 12 }), 996 - 36 - 2 * 12, 'the rail, the gap after it and the gap before the column');
  assert.ok(questionRoom({ ...page, rail: 36, gap: 12 }) >= SPLIT_MIN, 'a 1280 px window with the sidebar open still docks');
  // A page of SPLIT_MIN with the rail left the question about 406 px once the column took its 360: that is the dialog now.
  const tight = questionRoom({ width: SPLIT_MIN, paddingLeft: 14, paddingRight: 16, rail: 36, gap: 12 });
  assert.ok(tight < SPLIT_MIN && tight - COLUMN_MIN < QUESTION_MIN);
  assert.equal(questionRoom({ width: 0 }), 0);
});

test('the column width: 45% of the room by default, the kept one otherwise, within the limits; kept per viewer, a blocked storage is no error', () => {
  assert.equal(columnWidth(null, 1280), 576);
  assert.equal(columnWidth(500, 1280), 500);
  assert.equal(columnWidth(100, 1280), COLUMN_MIN);
  assert.equal(columnWidth(900, 1280), 1280 - QUESTION_MIN, 'the question keeps its room');
  const map = new Map(), storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  assert.equal(readColumnWidth(storage), null);
  saveColumnWidth(512.4, storage);
  assert.equal(readColumnWidth(storage), 512);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readColumnWidth(blocked), null);
  assert.equal(saveColumnWidth(400, blocked), false);
});

test('the 题干条 shows the stem and the options, never what answers them', () => {
  const quiz = { kind: 'quiz', prompt: 'Which **one**?', options: [{ id: 'a', text: 'First', correct: true, explanation: 'Because A.' }, { id: 'b', text: 'Second', correct: false, explanation: 'No.' }] };
  const strip = stripOf(quiz);
  assert.equal(strip.stem, 'Which **one**?');
  assert.deepEqual(strip.options.map(option => [option.mark, option.text]), [['A', 'First'], ['B', 'Second']]);
  assert.doesNotMatch(JSON.stringify(strip), /Because A|correct|No\./, 'no correctness and no explanation');
  const cloze = stripOf({ kind: 'cloze', prompt: 'Fill', cloze: { text: 'The {{b1}} rises when {{b2}} falls.', blanks: [{ id: 'b1' }, { id: 'b2' }] }, answer: 'price' });
  assert.equal(cloze.stem, 'The ＿＿ rises when ＿＿ falls.');
  assert.deepEqual(cloze.options, []);
  const flash = stripOf({ kind: 'flashcard', prompt: 'Front side', answer: 'Back side', back: 'Back side' });
  assert.equal(flash.stem, 'Front side');
  assert.doesNotMatch(JSON.stringify(flash), /Back side/, 'never the back of a flashcard');
  const verdict = stripOf({ kind: 'truefalse', prompt: 'The sky is green.', options: [{ id: 'true', text: 'true' }, { id: 'false', text: 'false' }] });
  assert.equal(verdict.options.length, 0, 'a 判断题 has nothing to summarise beyond its statement');
  assert.equal(stripOf(null), null);
});

test('whose keys: a press inside the 对照栏 or a dialog the question is not in is not the question\'s; one inside the question is', () => {
  const node = (attrs, parent = null) => ({ attrs, parent, contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
    closest(selector) { for (let at = this; at; at = at.parent) if (selector.split(',').some(part => at.attrs.includes(part.trim()))) return at; return null; } });
  const app = node(['.study-app']), question = node(['.review-body'], app), button = node(['button'], question);
  const column = node(['[data-own-keys]'], app), text = node(['.reader-scroll'], column);
  const dialog = node(['dialog'], app), inDialog = node(['button'], dialog);
  assert.equal(keysElsewhere(button, app), false, 'the question\'s own keys');
  assert.equal(keysElsewhere(text, app), true, 'the reader beside it owns its keys');
  assert.equal(keysElsewhere(inDialog, app), true, 'a dialog over the page takes the keys');
  const readerRound = node(['[data-inline-run]'], dialog);
  assert.equal(keysElsewhere(node(['button'], readerRound), readerRound), false, 'a question inside the reader (its 本节题目) keeps its keys');
});
