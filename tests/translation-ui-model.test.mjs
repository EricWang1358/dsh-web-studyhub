/* The bilingual reading in the reader, the pure side (ui/document-preview/translation/model.js): the display setting and how
   it is remembered, the state of a paragraph's 译 button, the reducer that applies the answers of materials.translation.*, and
   how a job is read. The markup and the layout are checked in the markup tests and the browser journey. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { paragraphKey } from '../lib/passage-translation.js';
import {
  DISPLAY_MODES, SIDE_MIN_COLUMN, SIDE_MIN_WIDTH, TRANSLATION_SETTINGS_KEY, blockState, buttonState, countTranslated, effectiveMode, failureKind, initialState, isShown, jobActive, jobClock,
  jobFraction, jobToShow, keyedParagraphs, loadTranslationSettings, normalizeTranslationSettings, passageOf, reducer, saveTranslationSettings, shortQuote, versionOf,
} from '../ui/document-preview/translation/model.js';

const item = (key, extra = {}) => ({ key, kind: 'paragraph', sourceId: 's1', text: '译文', version: 1, history: [], warnings: [], outdated: false, ...extra });
const loaded = (items = [], extra = {}) => reducer(initialState, { type: 'loaded', list: { target: 'zh', targetSource: 'default', glossary: [], modelAvailable: true, items, stale: [], ...extra } });

test('four display modes, one remembered choice; anything stored that is not a mode falls back to 逐段对照', () => {
  assert.deepEqual(DISPLAY_MODES, ['pairs', 'side', 'only', 'hidden']);
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(loadTranslationSettings(storage), { mode: 'pairs' });
  saveTranslationSettings({ mode: 'side' }, storage);
  assert.equal(JSON.parse(store.get(TRANSLATION_SETTINGS_KEY)).mode, 'side');
  assert.deepEqual(loadTranslationSettings(storage), { mode: 'side' });
  store.set(TRANSLATION_SETTINGS_KEY, '{"mode":"sideways"}');
  assert.deepEqual(loadTranslationSettings(storage), { mode: 'pairs' });
  store.set(TRANSLATION_SETTINGS_KEY, 'not json');
  assert.deepEqual(loadTranslationSettings(storage), { mode: 'pairs' });
  assert.deepEqual(normalizeTranslationSettings(null), { mode: 'pairs' });
  assert.doesNotThrow(() => saveTranslationSettings({ mode: 'only' }, { setItem() { throw new Error('blocked'); } }), 'blocked storage never breaks the reader');
  assert.deepEqual(loadTranslationSettings({ getItem() { throw new Error('blocked'); } }), { mode: 'pairs' });
});

test('左右分栏 needs room: under the reader\'s narrow width it is drawn as 逐段对照, the other modes never change', () => {
  assert.equal(SIDE_MIN_WIDTH, 900);
  assert.equal(SIDE_MIN_COLUMN, 640, 'the reading column needs room for two columns too');
  assert.equal(effectiveMode('side', 1200), 'side');
  assert.equal(effectiveMode('side', 900), 'side');
  assert.equal(effectiveMode('side', 899), 'pairs');
  assert.equal(effectiveMode('side', undefined), 'pairs');
  for (const mode of ['pairs', 'only', 'hidden']) assert.equal(effectiveMode(mode, 300), mode);
});

test('paragraphs get their ordinal and key the way the backend keys them, the second copy of a paragraph apart from the first', () => {
  const list = keyedParagraphs([{ sourceId: 's1', text: 'Same.' }, { sourceId: 's1', text: 'Other.' }, { sourceId: 's1', text: ' Same. ' }, { sourceId: 's2', text: 'Same.' }]);
  assert.deepEqual(list.map(paragraph => paragraph.ordinal), [0, 0, 1, 0]);
  assert.equal(list[0].key, paragraphKey('s1', { text: 'Same.', ordinal: 0 }));
  assert.equal(list[2].key, paragraphKey('s1', { text: 'Same.', ordinal: 1 }));
  assert.equal(list[3].key, paragraphKey('s2', { text: 'Same.', ordinal: 0 }));
  assert.deepEqual(passageOf(list[2]), { sourceId: 's1', text: ' Same. ', ordinal: 1 });
  assert.equal(shortQuote('  A   long\nsentence about the thing. '.repeat(5), 20).length, 20);
  assert.equal(shortQuote('Short.'), 'Short.');
});

test('the 译 button shows none, translating, has, stale or error for each paragraph', () => {
  let state = loaded([item('a'), item('b', { outdated: true })]);
  assert.equal(buttonState(state, 'a'), 'has');
  assert.equal(buttonState(state, 'b'), 'stale');
  assert.equal(buttonState(state, 'c'), 'none');
  state = reducer(state, { type: 'pending', keys: ['c', 'a'], kind: 'retranslate' });
  assert.equal(buttonState(state, 'c'), 'translating');
  assert.equal(buttonState(state, 'a'), 'translating', 'a paragraph being translated again is translating, not has');
  state = reducer(state, { type: 'failed', keys: ['c'], code: 'refusal', message: 'x' });
  assert.equal(buttonState(state, 'c'), 'error');
  assert.equal(buttonState(state, 'a'), 'translating');
  state = reducer(state, { type: 'cancelled', keys: ['a'] });
  assert.equal(buttonState(state, 'a'), 'has', 'cancelling a retranslation keeps the translation it had');
  state = reducer(state, { type: 'settled', results: [{ key: 'z', status: 'skipped', code: 'same-language' }] });
  assert.equal(buttonState(state, 'z'), 'none', 'a passage that needs no translation is not an error');
});

test('the answers of a translate call fill the state: kept items and the reasons for the rest; in 隐藏译文 a fresh translation is revealed', () => {
  let state = loaded([]);
  state = reducer(state, { type: 'pending', keys: ['a', 'b', 'c', 'd'] });
  state = reducer(state, { type: 'settled', reveal: true, results: [
    { key: 'a', status: 'translated', item: item('a') }, { key: 'b', status: 'cached', item: item('b') }, { key: 'c', status: 'rejected', code: 'refusal', message: 'no' }, { key: 'd', status: 'unlocated', code: 'ambiguous' }] });
  assert.deepEqual(Object.keys(state.items), ['a', 'b']);
  assert.deepEqual(state.pending, {});
  assert.equal(state.errors.c.code, 'refusal');
  assert.equal(state.errors.d.code, 'ambiguous');
  assert.equal(state.shown.a, true, 'what was just translated is shown even in 隐藏译文');
  assert.equal(state.shown.b, undefined, 'what was already there follows the mode');
  assert.equal(reducer(loaded([]), { type: 'settled', results: [{ key: 'a', status: 'translated', item: item('a') }] }).shown.a, undefined, 'without the reveal the mode decides');
  state = reducer(state, { type: 'unavailable', keys: ['e'] });
  assert.equal(state.modelAvailable, false);
  assert.equal(state.errors.e.code, 'model');
  assert.equal(failureKind('model'), 'model');
  assert.equal(failureKind('refusal'), 'answer');
  assert.equal(failureKind('ambiguous'), 'place');
  assert.equal(failureKind('whatever'), 'other');
});

test('a block is open, collapsed to its bar, or hidden: the learner\'s choice wins, otherwise the mode decides', () => {
  let state = loaded([item('a')]);
  assert.equal(blockState(state, 'a', 'pairs'), 'open');
  assert.equal(blockState(state, 'a', 'only'), 'open');
  assert.equal(blockState(state, 'a', 'hidden'), 'hidden');
  assert.equal(isShown(state, 'a', 'hidden'), false);
  state = reducer(state, { type: 'show', keys: ['a'], value: true });
  assert.equal(blockState(state, 'a', 'hidden'), 'open', 'asking for one translation shows it in 隐藏译文');
  state = reducer(state, { type: 'show', keys: ['a'], value: false });
  assert.equal(blockState(state, 'a', 'pairs'), 'collapsed', 'a folded one keeps its bar, it is not hidden');
  assert.equal(isShown(state, 'a', 'pairs'), false);
  assert.equal(blockState(reducer(state, { type: 'show', keys: ['a'], value: undefined }), 'a', 'hidden'), 'hidden', 'forgetting the choice returns to the mode');
  assert.equal(blockState(reducer(state, { type: 'show-reset' }), 'a', 'pairs'), 'open', 'changing the mode clears every choice');
});

test('deleting keeps what is needed to undo for a few seconds; undoing puts it back; letting it expire drops it', () => {
  let state = loaded([item('a'), item('b')]);
  state = reducer(state, { type: 'removed', keys: ['a'], removed: [item('a', { text: '旧' })] });
  assert.equal(buttonState(state, 'a'), 'none');
  assert.equal(state.undo.a[0].text, '旧');
  assert.equal(countTranslated(state, ['a', 'b']), 1);
  const back = reducer(state, { type: 'undone', keys: ['a'], items: state.undo.a });
  assert.equal(buttonState(back, 'a'), 'has');
  assert.deepEqual(back.undo, {});
  assert.deepEqual(reducer(state, { type: 'undo-expired', keys: ['a'] }).undo, {});
});

test('the glossary and the target travel with the state; a reload replaces the items but keeps what is open', () => {
  let state = loaded([item('a')]);
  state = reducer(state, { type: 'show', keys: ['a'], value: false });
  state = reducer(state, { type: 'glossary', glossary: [{ term: 'CQRS', to: '' }], target: 'en' });
  assert.deepEqual([state.glossary.length, state.target, state.targetSource], [1, 'en', 'document']);
  state = reducer(state, { type: 'loaded', list: { target: 'en', targetSource: 'document', glossary: state.glossary, modelAvailable: false, items: [item('b')], stale: [{ revision: 'r0', count: 3 }], otherTarget: 2 } });
  assert.deepEqual(Object.keys(state.items), ['b']);
  assert.equal(state.shown.a, false);
  assert.equal(state.modelAvailable, false);
  assert.equal(state.stale[0].count, 3);
  assert.equal(state.otherTarget, 2);
});

test('a version line appears from the second version on, with the learner\'s comment', () => {
  assert.equal(versionOf(item('a')), null);
  assert.deepEqual(versionOf(item('a', { version: 2, comment: 'More formal.' })), { version: 2, comment: 'More formal.' });
  assert.deepEqual(versionOf(item('a', { version: 3 })), { version: 3, comment: '' });
});

test('a job is read as active or finished, with its clock and its fraction; the newest finished one is shown when none runs', () => {
  const running = { id: 'j1', status: 'running', startedAt: '2026-10-01T08:00:00.000Z', runStartedAt: '2026-10-01T08:00:10.000Z', total: 15, done: 6 };
  assert.equal(jobActive(running), true);
  assert.equal(jobActive({ status: 'complete' }), false);
  assert.equal(jobClock(running, Date.parse('2026-10-01T08:01:15.000Z')), '1:05');
  assert.equal(jobClock({ ...running, finishedAt: '2026-10-01T08:00:40.000Z', status: 'complete' }, Date.parse('2026-10-01T09:00:00.000Z')), '0:30', 'frozen at the end');
  assert.equal(jobClock({ status: 'queued' }), '');
  assert.equal(jobFraction(running), 0.4);
  assert.equal(jobFraction({ total: 0, done: 0 }), 0);
  assert.equal(jobFraction({ total: 4, done: 9 }), 1);
  const old = { id: 'j0', status: 'complete', startedAt: '2026-10-01T07:00:00.000Z' }, newer = { id: 'j2', status: 'cancelled', startedAt: '2026-10-01T07:30:00.000Z' };
  assert.equal(jobToShow([old, newer, running]).id, 'j1');
  assert.equal(jobToShow([old, newer]).id, 'j2');
  assert.equal(jobToShow([]), null);
});
