/* 3.7 guidance, step 0: the guidance registry (ui/guidance/registry.js) and the daily budget with the master switch (ui/guidance/budget.js).
   The registry only points at the keys the surfaces already write; these tests pin those keys, prove a reset clears exactly them, and that a blocked
   storage never throws. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GUIDANCE_ITEMS, GUIDANCE_KINDS, clearItem, entryProblems, guidanceItem, guidanceItemsFor, itemKeys, itemSeen, resetAllGuidance } from '../ui/guidance/registry.js';
import { GUIDANCE_KEY, allowProactiveTip, guidanceAllows, guidanceOn, localDay, proactiveTipDecision, readGuidanceState, recordProactiveTip, setGuidanceOn, setItemMuted, itemMuted } from '../ui/guidance/budget.js';

/** A Storage stand-in with key()/length, like the browser's. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}
/** A storage that refuses everything, the way a blocked one does. */
const refusing = () => ({ get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
const both = (local, session = memoryStorage()) => ({ local, session });

/* What the surfaces write today, by hand: if a surface renames its key, this list (and the registry) must follow. */
const SEEN = {
  'study-tour:/lib': JSON.stringify({ stepId: 'practice', done: false }),
  'study-tour:/other': JSON.stringify({ stepId: 'welcome', done: true }),
  'study-welcome:/lib': 'dismissed',
  'study-setup-later:/lib:Cloud': JSON.stringify(['goal']),
  'study-setup-done:/lib:Cloud': '1',
  'study-reader-hints': JSON.stringify(['pdf-page', 'page-presets']),
  'study-original-notice': JSON.stringify(['doc-1']),
  'study-topic-group-later:/lib': '3:12',
  'study-archify-card:/lib': JSON.stringify('later'),
  'study-book-moves-seen:Cloud': '2026-10-01T00:00:00.000Z',
  'study-jev-guide-seen': '1',
};
/* Keys that look alike but are NOT guidance: a reset must leave them alone. */
const UNRELATED = {
  'study-ui-language': 'zh', 'study-theme': 'dark', 'study-tasks-seen:/lib': '123', 'study-tour-x': 'keep', 'study-welcomed': 'keep',
  'studyhub.welcomed.v1': '2026-10-01', 'study-reader-hints-extra': '[]', [GUIDANCE_KEY]: JSON.stringify({ day: '2026-10-26', shownToday: 1, off: true, muted: ['skeleton.archify'] }),
};

test('every entry is well formed, ids are unique, and every kind is one of tip/card/tour/nudge', () => {
  assert.ok(GUIDANCE_ITEMS.length >= 10, 'the existing surfaces are all registered');
  for (const item of GUIDANCE_ITEMS) assert.deepEqual(entryProblems(item), [], item.id);
  const ids = GUIDANCE_ITEMS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(GUIDANCE_ITEMS.every(item => GUIDANCE_KINDS.includes(item.kind)));
  assert.deepEqual(entryProblems({ id: 'x', kind: 'popup', dismiss: 'never', proactive: 'yes', memory: { store: 'cookie' } }).length > 3, true, 'a bad entry is caught');
  assert.equal(guidanceItem('reader.pdf-page').memory.item, 'pdf-page');
  assert.ok(!guidanceItemsFor().some(item => item.id === 'jev.guide'), 'an experiment is not listed by default');
  assert.ok(guidanceItemsFor({ experimental: true }).some(item => item.id === 'jev.guide'));
  assert.equal(guidanceItemsFor({ experimental: true }).length, GUIDANCE_ITEMS.length);
});

test('the registry points at the keys the surfaces really write (read from their source)', async () => {
  const sources = {
    'ui/tour/progress.js': ['study-tour:', 'study-welcome:'], 'ui/SetupChecklist.jsx': ['study-setup-'], 'ui/document-preview/reader/hints.js': ["'study-reader-hints'"],
    'ui/document-preview/original-file.js': ["'study-original-notice'"], 'ui/study-map/TopicGroupReminder.jsx': ['study-topic-group-later:'], 'ui/archify.js': ['study-archify-card:'],
    'ui/book/BookMoves.jsx': ['study-book-moves-seen:'], 'ui/JevSettings.jsx': ["'study-jev-guide-seen'"],
  };
  for (const [file, needles] of Object.entries(sources)) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const needle of needles) assert.ok(text.includes(needle), `${file} still writes ${needle}`);
  }
  // Every hand-written "seen" key above is matched by exactly the entries meant for it.
  const local = memoryStorage(SEEN);
  for (const item of GUIDANCE_ITEMS) assert.equal(itemSeen(item, both(local)), true, `${item.id} reads as seen`);
});

test('seen, clear one: only that entry goes; a shared list keeps the other id', () => {
  const local = memoryStorage({ ...SEEN, ...UNRELATED });
  const pdf = guidanceItem('reader.pdf-page'), presets = guidanceItem('reader.page-presets');
  assert.equal(clearItem(pdf, both(local)), true);
  assert.equal(itemSeen(pdf, both(local)), false);
  assert.equal(itemSeen(presets, both(local)), true, 'the other reader hint is still closed');
  assert.deepEqual(JSON.parse(local.getItem('study-reader-hints')), ['page-presets']);
  assert.equal(clearItem(presets, both(local)), true);
  assert.equal(local.getItem('study-reader-hints'), null, 'an emptied list is removed');
  const tour = guidanceItem('tour.progress');
  assert.deepEqual(itemKeys(tour, both(local)).sort(), ['study-tour:/lib', 'study-tour:/other']);
  assert.equal(clearItem(tour, both(local)), true);
  assert.equal(local.getItem('study-tour:/lib'), null);
  assert.equal(local.getItem('study-tour-x'), 'keep', 'a look-alike key is not a prefix match');
  assert.equal(clearItem(tour, both(local)), true, 'clearing what is already clear is fine');
});

test('重新显示全部提示 clears exactly the registered keys and nothing else', () => {
  const local = memoryStorage({ ...SEEN, ...UNRELATED }), session = memoryStorage({ 'study-draft:/lib': '{}' });
  const cleared = resetAllGuidance(both(local, session));
  assert.deepEqual(cleared, GUIDANCE_ITEMS.map(item => item.id), 'every seen entry is reported, in list order');
  for (const key of Object.keys(SEEN)) assert.equal(local.getItem(key), null, `${key} is cleared`);
  for (const [key, value] of Object.entries(UNRELATED)) assert.equal(local.getItem(key), value, `${key} survives`);
  assert.equal(session.getItem('study-draft:/lib'), '{}', 'the tab storage is untouched');
  assert.deepEqual(resetAllGuidance(both(local, session)), [], 'a second reset has nothing to clear');
  const state = readGuidanceState(local);
  assert.equal(state.off, true, 'the master switch is a choice, not a seen state: it stays');
  assert.deepEqual(state.muted, ['skeleton.archify'], 'so do the per-item switches');
});

test('a blocked or missing storage: nothing throws, nothing reads as seen, nothing is cleared', () => {
  for (const storage of [null, undefined, refusing()]) {
    const storages = { local: storage, session: storage };
    for (const item of GUIDANCE_ITEMS) {
      assert.doesNotThrow(() => itemSeen(item, storages));
      assert.equal(itemSeen(item, storages), false, item.id);
      assert.doesNotThrow(() => clearItem(item, storages));
      if (!storage) assert.equal(clearItem(item, storages), false, 'no storage: nothing could be cleared');
    }
    assert.deepEqual(resetAllGuidance(storages), []);
    assert.equal(readGuidanceState(storage ?? null), null);
    assert.equal(guidanceOn(storage ?? null), true, 'the master switch keeps its default');
    assert.equal(setGuidanceOn(false, storage ?? null), false, 'and cannot be stored');
    assert.equal(recordProactiveTip({ storage: storage ?? null }), false);
  }
});

/* ---------- the budget ---------- */

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const fresh = { day: '', shownToday: 0, off: false, muted: [] };

test('localDay is the local calendar day', () => {
  assert.equal(localDay(at(2026, 10, 26, 0, 1)), '2026-10-26');
  assert.equal(localDay(at(2026, 10, 26, 23, 59)), '2026-10-26');
  assert.equal(localDay(at(2026, 10, 27, 0, 0)), '2026-10-27');
  assert.equal(localDay(at(2026, 1, 5)), '2026-01-05');
});

test('the budget, as a table: one a day, midnight rollover, never in practice, never when off, never without storage', () => {
  const rows = [
    ['nothing shown yet today', { now: at(2026, 10, 26), seen: fresh }, true, 'ok'],
    ['one already shown today', { now: at(2026, 10, 26, 18), seen: { ...fresh, day: '2026-10-26', shownToday: 1 } }, false, 'used'],
    ['shown yesterday, a new day', { now: at(2026, 10, 27, 0, 0), seen: { ...fresh, day: '2026-10-26', shownToday: 1 } }, true, 'ok'],
    ['one minute before midnight', { now: at(2026, 10, 26, 23, 59), seen: { ...fresh, day: '2026-10-26', shownToday: 1 } }, false, 'used'],
    ['an explicit today wins over now', { now: at(2026, 10, 26), today: '2026-10-27', seen: { ...fresh, day: '2026-10-26', shownToday: 1 } }, true, 'ok'],
    ['in a practice run', { now: at(2026, 10, 26), seen: fresh, inPractice: true }, false, 'practice'],
    ['master switch off', { now: at(2026, 10, 26), seen: { ...fresh, off: true } }, false, 'off'],
    ['master off beats practice', { now: at(2026, 10, 26), seen: { ...fresh, off: true }, inPractice: true }, false, 'off'],
    ['storage blocked', { now: at(2026, 10, 26), seen: null }, false, 'no-storage'],
    ['a damaged count reads as none', { now: at(2026, 10, 26), seen: { day: '2026-10-26', shownToday: 'lots' } }, true, 'ok'],
  ];
  for (const [name, input, allow, reason] of rows) {
    assert.deepEqual(proactiveTipDecision(input), { allow, reason }, name);
    assert.equal(allowProactiveTip(input), allow, name);
  }
});

test('recording a tip spends the day and rolls over at midnight; the switches persist in one key', () => {
  const local = memoryStorage();
  assert.equal(allowProactiveTip({ now: at(2026, 10, 26, 9), seen: readGuidanceState(local) }), true);
  assert.equal(recordProactiveTip({ now: at(2026, 10, 26, 9), storage: local }), true);
  assert.equal(allowProactiveTip({ now: at(2026, 10, 26, 21), seen: readGuidanceState(local) }), false, 'the day is spent');
  assert.equal(allowProactiveTip({ now: at(2026, 10, 27, 7), seen: readGuidanceState(local) }), true, 'a new day');
  assert.equal(recordProactiveTip({ now: at(2026, 10, 27, 7), storage: local }), true);
  assert.deepEqual(readGuidanceState(local), { day: '2026-10-27', shownToday: 1, off: false, muted: [] });
  assert.equal(setGuidanceOn(false, local), true);
  assert.equal(guidanceOn(local), false);
  assert.equal(allowProactiveTip({ now: at(2026, 10, 28), seen: readGuidanceState(local) }), false, 'off: nothing proactive');
  assert.equal(setItemMuted('reader.pdf-page', true, local), true);
  assert.equal(itemMuted('reader.pdf-page', local), true);
  assert.equal(setGuidanceOn(true, local), true);
  assert.equal(guidanceAllows('reader.pdf-page', local), false, 'an item switched off stays off when the master is on');
  assert.equal(guidanceAllows('reader.page-presets', local), true);
  assert.equal(setItemMuted('reader.pdf-page', false, local), true);
  assert.equal(guidanceAllows('reader.pdf-page', local), true);
  assert.deepEqual([...local.map.keys()], [GUIDANCE_KEY], 'one key holds it all');
  local.setItem(GUIDANCE_KEY, '{not json');
  assert.deepEqual(readGuidanceState(local), fresh, 'a damaged value is the defaults');
  assert.equal(guidanceOn(local), true);
});

test('the budget module stays React-18 safe and storage-safe: no React 19 API, every storage touch guarded', async () => {
  for (const file of ['ui/guidance/budget.js', 'ui/guidance/registry.js']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\buse\(|useActionState|useOptimistic|useFormStatus/, `${file}: no React 19 API`);
    assert.doesNotMatch(text, /\blocalStorage\b|\bsessionStorage\b/, `${file}: storage only through ui/storage.js`);
  }
});
