/* 3.7 guidance, step 0: the guidance registry (ui/guidance/registry.js) and the daily budget with the master switch (ui/guidance/budget.js).
   The registry only points at the keys the surfaces already write (imported from them); these tests prove a reset clears exactly those keys, that a
   blocked storage never throws, and that the budget's one claim a day holds. The surfaces' own writers and readers are in guidance-surfaces.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export * from './ui/guidance/registry.js'; export * from './ui/guidance/budget.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { GUIDANCE_ITEMS, GUIDANCE_KINDS, canComeBack, clearItem, entryProblems, guidanceItem, guidanceItemsFor, itemKeys, itemSeen, resetAllGuidance,
  GUIDANCE_KEY, allowProactiveTip, claimProactiveTip, forgetVisitClaim, guidanceAllows, guidanceOn, localDay, proactiveTipDecision, readGuidanceState,
  setGuidanceOn, setItemMuted, itemMuted } = module.exports;

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
/** A storage that reads but refuses writes (full). */
const readOnly = (initial = {}) => { const storage = memoryStorage(initial); storage.setItem = () => { throw new Error('full'); }; return storage; };
const both = (local, session = memoryStorage()) => ({ local, session });

/* What the surfaces write today (their own writers are exercised in guidance-surfaces.test.mjs). */
const SEEN = {
  'study-welcome:/lib': 'dismissed',
  'study-next-card:/lib': '2026-10-28',
  'study-setup-later:/lib:Cloud': JSON.stringify(['goal']),
  'study-setup-done:/lib:Cloud': '1',
  'study-reader-hints': JSON.stringify(['pdf-page', 'page-presets']),
  'study-original-notice': JSON.stringify(['doc-1']),
  'study-topic-group-later:/lib': '3:12',
  'study-archify-card:/lib': JSON.stringify('later'),
  'study-book-moves-seen:Cloud': '2026-10-01T00:00:00.000Z',
  'study-jev-guide-seen': '1',
  'study-nav-start:v1': JSON.stringify(['library', 'sources']),
  'study-nav-reorder-hint:v1': 'true',
};
/* Keys that look alike but are NOT registered guidance: a reset must leave them alone (the tour's resume point included: it is not in the registry). */
const UNRELATED = {
  'study-ui-language': 'zh', 'study-theme': 'dark', 'study-tasks-seen:/lib': '123', 'study-tour:/lib': JSON.stringify({ stepId: 'practice', done: false }),
  'study-welcomed': 'keep', 'studyhub.welcomed.v1': '2026-10-01', 'study-reader-hints-extra': '[]',
  [GUIDANCE_KEY]: JSON.stringify({ day: '2026-10-26', shownToday: 1, off: true, muted: ['skeleton.archify'] }),
};

test('every entry is well formed, ids are unique, kinds are tip/card/tour/nudge, and the tour resume point is not an entry', () => {
  assert.equal(GUIDANCE_ITEMS.length, 13);
  for (const item of GUIDANCE_ITEMS) assert.deepEqual(entryProblems(item), [], item.id);
  const ids = GUIDANCE_ITEMS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(GUIDANCE_ITEMS.every(item => GUIDANCE_KINDS.includes(item.kind)));
  assert.ok(!ids.some(id => id.startsWith('tour.')), 'a paused tour is not "seen guidance"; 重新开始 in 学习画像与导览 owns it');
  assert.ok(entryProblems({ id: 'x', kind: 'popup', dismiss: 'never', proactive: 'yes', memory: { store: 'cookie' } }).length > 3, 'a bad entry is caught');
  assert.equal(guidanceItem('reader.pdf-page').memory.item, 'pdf-page');
  assert.deepEqual(GUIDANCE_ITEMS.filter(item => item.proactive).map(item => item.id).sort(),
    ['book.moves', 'library.topic-groups', 'reader.original-notice', 'reader.page-presets', 'reader.pdf-page', 'skeleton.archify'],
    'what appears by itself (the master switch hint names exactly these; the setup "all done" note is a status, not a tip)');
});

test('设置 › 引导 owns the same key the sidebar writes, so 再显示一次 brings the step-5 dots back', async () => {
  const { NAV_START_KEY, readStarts, startHere } = await import('../ui/nav-start.js');
  const local = memoryStorage(SEEN), storages = both(local);
  const item = guidanceItem('nav.start');
  assert.ok(item, 'the step-5 marker is registered guidance');
  assert.equal(itemSeen(item, storages), true);
  assert.deepEqual(readStarts(local), ['library', 'sources']);
  assert.equal(clearItem(item, storages), true);
  assert.deepEqual(readStarts(local), [], '再显示一次 forgets which pages were opened');
  assert.equal(startHere('sources', readStarts(local)), true, 'so its dot is back');
  assert.equal(itemSeen(item, storages), false);
  assert.equal(local.getItem(NAV_START_KEY), null, 'the emptied list is removed, not left as []');
});

test('the experiment entry needs both the experiments switch and the system component; 入门三步 cannot come back once there is an own deck', () => {
  const ids = context => guidanceItemsFor(context).map(item => item.id);
  assert.ok(!ids().includes('jev.guide'));
  assert.ok(!ids({ experimental: true }).includes('jev.guide'), 'no system component: no 实验性功能 category, so no entry');
  assert.ok(!ids({ system: true }).includes('jev.guide'));
  assert.ok(ids({ experimental: true, system: true }).includes('jev.guide'));
  assert.equal(guidanceItemsFor({ experimental: true, system: true }).length, GUIDANCE_ITEMS.length);
  assert.equal(canComeBack(guidanceItem('first-run.later'), { ownDeck: true }), false);
  assert.equal(canComeBack(guidanceItem('first-run.later'), { ownDeck: false }), true);
  assert.ok(GUIDANCE_ITEMS.filter(item => item.id !== 'first-run.later').every(item => canComeBack(item, { ownDeck: true })));
});

test('seen, clear one: only that entry goes; a shared list keeps the other id; a prefix does not match a look-alike', () => {
  const local = memoryStorage({ ...SEEN, ...UNRELATED });
  for (const item of GUIDANCE_ITEMS) assert.equal(itemSeen(item, both(local)), true, `${item.id} reads as seen`);
  const pdf = guidanceItem('reader.pdf-page'), presets = guidanceItem('reader.page-presets');
  assert.equal(clearItem(pdf, both(local)), true);
  assert.equal(itemSeen(pdf, both(local)), false);
  assert.equal(itemSeen(presets, both(local)), true, 'the other reader hint is still closed');
  assert.deepEqual(JSON.parse(local.getItem('study-reader-hints')), ['page-presets']);
  assert.equal(clearItem(presets, both(local)), true);
  assert.equal(local.getItem('study-reader-hints'), null, 'an emptied list is removed');
  const welcome = guidanceItem('first-run.later');
  local.setItem('study-welcome:/other', 'dismissed');
  assert.deepEqual(itemKeys(welcome, both(local)).sort(), ['study-welcome:/lib', 'study-welcome:/other']);
  assert.equal(clearItem(welcome, both(local)), true);
  assert.equal(local.getItem('study-welcomed'), 'keep', 'a look-alike key is not a prefix match');
  assert.equal(clearItem(welcome, both(local)), true, 'clearing what is already clear is fine');
});

test('重新显示全部提示 clears exactly the registered keys and nothing else (the tour resume point survives)', () => {
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
  const partial = memoryStorage(SEEN);
  assert.deepEqual(resetAllGuidance(both(partial), guidanceItemsFor()), guidanceItemsFor().map(item => item.id), 'only the items handed in');
  assert.equal(partial.getItem('study-jev-guide-seen'), '1', 'a hidden experiment keeps its memory');
});

test('a blocked or missing storage: nothing throws, nothing reads as seen, nothing is cleared, nothing is claimed', () => {
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
    forgetVisitClaim();
    assert.equal(claimProactiveTip({ storage: storage ?? null }), false);
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

test('the rule, as a table (pure, nothing spent): one a day, midnight rollover, never in practice, never when off, never without storage', () => {
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

test('claimProactiveTip reads, decides and writes in one call: one claim a day, the second loses, a failed write shows nothing', () => {
  const rows = [
    ['first claim of the day', () => { forgetVisitClaim(); return memoryStorage(); }, [{ id: 'step4.tip', now: at(2026, 10, 26, 9) }], [true]],
    ['two claims the same day in one visit (two tips in one render)', () => { forgetVisitClaim(); return memoryStorage(); },
      [{ id: 'a.one', now: at(2026, 10, 26, 9) }, { id: 'a.two', now: at(2026, 10, 26, 9) }], [true, false]],
    ['a second visit (tab) the same day finds the stored count', () => { forgetVisitClaim(); return memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ day: '2026-10-26', shownToday: 1 }) }); },
      [{ id: 'a.one', now: at(2026, 10, 26, 20) }], [false]],
    ['after midnight a new claim wins', () => { forgetVisitClaim(); return memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ day: '2026-10-26', shownToday: 1 }) }); },
      [{ id: 'a.one', now: at(2026, 10, 27, 0, 1) }], [true]],
    ['in practice', () => { forgetVisitClaim(); return memoryStorage(); }, [{ id: 'a.one', now: at(2026, 10, 26), inPractice: true }], [false]],
    ['master off', () => { forgetVisitClaim(); return memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ off: true }) }); }, [{ id: 'a.one', now: at(2026, 10, 26) }], [false]],
    ['the item switched off', () => { forgetVisitClaim(); return memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ muted: ['a.one'] }) }); }, [{ id: 'a.one', now: at(2026, 10, 26) }], [false]],
    ['the write fails (full storage): nothing shows, nothing is spent in this visit', () => { forgetVisitClaim(); return readOnly(); }, [{ id: 'a.one', now: at(2026, 10, 26) }], [false]],
  ];
  for (const [name, setup, claims, expected] of rows) {
    const storage = setup();
    assert.deepEqual(claims.map(claim => claimProactiveTip({ ...claim, storage })), expected, name);
  }
  // The per-visit claim on its own: a second claim the same day loses even where the stored count says nothing was shown (a fresh storage B).
  forgetVisitClaim();
  assert.equal(claimProactiveTip({ id: 'a.one', now: at(2026, 10, 26, 9), storage: memoryStorage() }), true, 'A');
  assert.equal(claimProactiveTip({ id: 'a.two', now: at(2026, 10, 26, 10), storage: memoryStorage() }), false, 'B: this visit already gave today\'s tip away');
  forgetVisitClaim();
  const storage = memoryStorage();
  assert.equal(claimProactiveTip({ id: 'a.one', now: at(2026, 10, 26, 9), storage }), true);
  assert.deepEqual(readGuidanceState(storage), { day: '2026-10-26', shownToday: 1, off: false, muted: [] }, 'the claim is stored');
  forgetVisitClaim();
  forgetVisitClaim();
  const failing = readOnly();
  assert.equal(claimProactiveTip({ id: 'a.one', now: at(2026, 10, 26), storage: failing }), false);
  assert.equal(claimProactiveTip({ id: 'a.one', now: at(2026, 10, 26), storage: memoryStorage() }), true, 'a failed write did not use up the visit');
  forgetVisitClaim();
});

test('the switches persist in one key; a damaged value is the defaults', () => {
  const local = memoryStorage();
  assert.equal(setGuidanceOn(false, local), true);
  assert.equal(guidanceOn(local), false);
  assert.equal(setItemMuted('reader.pdf-page', true, local), true);
  assert.equal(itemMuted('reader.pdf-page', local), true);
  assert.equal(setGuidanceOn(true, local), true);
  assert.equal(guidanceAllows('reader.pdf-page', local), false, 'an item switched off stays off when the master is on');
  assert.equal(guidanceAllows('reader.page-presets', local), true);
  assert.equal(setItemMuted('reader.pdf-page', false, local), true);
  assert.equal(guidanceAllows('reader.pdf-page', local), true);
  assert.deepEqual([...local.map.keys()], [GUIDANCE_KEY], 'one key holds it all');
  local.setItem(GUIDANCE_KEY, '{not json');
  assert.deepEqual(readGuidanceState(local), fresh);
  assert.equal(guidanceOn(local), true);
});

test('the guidance modules stay React-18 safe and storage-safe: no React 19 API, every storage touch through ui/storage.js', async () => {
  for (const file of ['ui/guidance/budget.js', 'ui/guidance/registry.js', 'ui/guidance/cleared.js']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\buse\(|useActionState|useOptimistic|useFormStatus/, `${file}: no React 19 API`);
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), /\blocalStorage\b|\bsessionStorage\b/, `${file}: storage only through ui/storage.js`);
  }
  const registry = await readFile(new URL('../ui/guidance/registry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(registry.replace(/\/\*[\s\S]*?\*\//g, ''), /'study-[a-z-]+[:']/, 'no key copied as a string: every key is imported from its surface');
});
