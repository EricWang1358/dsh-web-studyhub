/* 3.7 guidance step 3: 「今天先不」 on the home's 下一步 card hides it for the rest of the LOCAL day, in this browser, per library. The next day it is back. The memory
   is one key per library holding the day (study-next-card:<root> = "2026-10-28"), so 设置 › 引导 can list it and 再显示一次 can clear it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export * from './ui/study-map/next-dismiss.js';
  export { GUIDANCE_ITEMS, guidanceItem, itemSeen, clearItem } from './ui/guidance/registry.js';
  export { clearCount } from './ui/guidance/cleared.js';`);

/** A Storage stand-in with key()/length, like the browser's. */
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { get length() { return map.size; }, key: (index) => [...map.keys()][index] ?? null, getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); }, removeItem: (key) => { map.delete(key); }, map };
}
const refusing = () => ({ get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
const at = (day, hour = 10) => new Date(2026, 9, day, hour, 0, 0);

test('the key is one per library and holds the local day', () => {
  assert.equal(m.NEXT_CARD_PREFIX, 'study-next-card:');
  assert.equal(m.nextCardKey('D:/lib'), 'study-next-card:D:/lib');
  assert.equal(m.nextCardKey(''), 'study-next-card:local');
});

test('「今天先不」 hides the card for the rest of the local day and not for the next', () => {
  const store = storage();
  assert.equal(m.dismissedToday('/lib', { now: at(28), storage: store }), false, 'nothing stored: shown');
  assert.equal(m.dismissToday('/lib', { now: at(28), storage: store }), true);
  assert.equal(store.map.get('study-next-card:/lib'), '2026-10-28');
  assert.equal(m.dismissedToday('/lib', { now: at(28, 23), storage: store }), true, 'late the same evening: still hidden');
  assert.equal(m.dismissedToday('/lib', { now: at(28, 0), storage: store }), true, 'just after midnight of that day: hidden');
  assert.equal(m.dismissedToday('/lib', { now: at(29, 0), storage: store }), false, 'the next local day: back');
  assert.equal(m.dismissedToday('/other', { now: at(28), storage: store }), false, 'another library has its own day');
});

test('a value that is not today\'s day shows the card; a stale day is forgotten so Settings does not call it seen', () => {
  const store = storage({ 'study-next-card:/lib': '2026-10-20', 'study-next-card:/junk': '{"a":1}', 'study-next-card:/empty': '' });
  assert.equal(m.dismissedToday('/lib', { now: at(28), storage: store }), false);
  assert.equal(m.dismissedToday('/junk', { now: at(28), storage: store }), false);
  assert.equal(m.dismissedToday('/empty', { now: at(28), storage: store }), false);
  m.forgetStale('/lib', { now: at(28), storage: store });
  assert.equal(store.map.has('study-next-card:/lib'), false, 'yesterday\'s mark is removed');
  m.dismissToday('/lib', { now: at(28), storage: store });
  m.forgetStale('/lib', { now: at(28), storage: store });
  assert.equal(store.map.get('study-next-card:/lib'), '2026-10-28', 'today\'s mark stays');
});

test('a browser that cannot store: nothing throws, the card is shown, and the dismissal holds for this visit', () => {
  const blocked = refusing();
  assert.equal(m.dismissedToday('/lib', { now: at(28), storage: blocked }), false);
  assert.equal(m.dismissToday('/lib', { now: at(28), storage: blocked }), false, 'not stored');
  assert.equal(m.dismissedToday('/lib', { now: at(28), storage: blocked }), true, 'but this visit holds it');
  m.forgetStale('/lib', { now: at(28), storage: blocked });
  assert.equal(m.dismissedToday('/none', { now: at(28), storage: null }), false);
  assert.equal(m.dismissToday('/none', { now: at(28), storage: null }), false);
});

test('the visit remembers a dismissal the browser could not store, until 再显示一次 is used in this tab', () => {
  const blocked = refusing();
  m.rememberForVisit('/visit', { now: at(28), id: 'home.next' });
  assert.equal(m.dismissedToday('/visit', { now: at(28), storage: blocked }), true, 'held in memory for the visit');
  assert.equal(m.dismissedToday('/visit', { now: at(29), storage: blocked }), false, 'but only for that day');
  m.clearItem(m.guidanceItem('home.next'), { local: storage(), session: storage() });
  assert.equal(m.dismissedToday('/visit', { now: at(28), storage: blocked }), false, '再显示一次 gives the visit\'s memory up too');
});

test('设置 › 引导 lists the card, sees the mark, and 再显示一次 clears it', () => {
  const item = m.guidanceItem('home.next');
  assert.ok(item, 'registered');
  assert.equal(item.kind, 'card');
  assert.equal(item.proactive, false, 'a status computed from the library, not a tip: the daily budget and the master switch do not apply');
  assert.equal(item.dismiss, 'until-condition');
  const local = storage();
  const stores = { local, session: storage() };
  assert.equal(m.itemSeen(item, stores), false);
  m.dismissToday('/lib', { now: at(28), storage: local });
  assert.equal(m.itemSeen(item, stores), true);
  assert.equal(m.clearItem(item, stores), true);
  assert.equal(m.dismissedToday('/lib', { now: at(28), storage: local }), false, 'the card is back');
});
