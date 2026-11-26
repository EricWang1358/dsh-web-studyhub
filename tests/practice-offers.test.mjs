import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PRACTICE_OFFER, PRACTICE_OFFER_ORDER, practiceOfferFor, chapterHintFor, freshTermsDeeper, chapterHintSeen, markChapterHintSeen, forgetChapterHintVisit } from '../ui/guidance/practice-offers.js';
import { useChapterHint } from '../ui/review/use-chapter-hint.js';

const ALL = [PRACTICE_OFFER.chapterBasics];

test('practiceOfferFor: yields to practice tips, exam mode, and tourRunning', () => {
  assert.equal(practiceOfferFor({ tip: 'practice.help-after-wrong', allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ exam: true, allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ tourRunning: true, allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
});

test('practiceOfferFor: skips muted/disallowed offers and returns null when none match', () => {
  assert.equal(practiceOfferFor({ allowed: [], moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ allowed: new Set(), moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: false } }), null);
  assert.equal(practiceOfferFor({ allowed: ALL, moments: {} }), null);
});

test('practiceOfferFor: returns the first allowed matching offer in order', () => {
  assert.deepEqual(PRACTICE_OFFER_ORDER, [PRACTICE_OFFER.chapterBasics]);
  assert.equal(
    practiceOfferFor({ allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }),
    PRACTICE_OFFER.chapterBasics,
  );
  assert.equal(
    practiceOfferFor({
      allowed: [PRACTICE_OFFER.chapterBasics, 'practice.future-second'],
      moments: { [PRACTICE_OFFER.chapterBasics]: true, 'practice.future-second': true },
      order: [PRACTICE_OFFER.chapterBasics, 'practice.future-second'],
    }),
    PRACTICE_OFFER.chapterBasics,
  );
  assert.equal(
    practiceOfferFor({
      allowed: ['practice.future-first', PRACTICE_OFFER.chapterBasics],
      moments: { 'practice.future-first': true, [PRACTICE_OFFER.chapterBasics]: true },
      order: ['practice.future-first', PRACTICE_OFFER.chapterBasics],
    }),
    'practice.future-first',
  );
  assert.equal(
    practiceOfferFor({ allowed: new Set(ALL), moments: { [PRACTICE_OFFER.chapterBasics]: true } }),
    PRACTICE_OFFER.chapterBasics,
  );
});

test('chapterHintFor: triggers only on non-empty deeper or refill === true', () => {
  const ok = { allowed: true, seenChapters: new Set(), chapterKey: 'doc-1:ch-1' };
  assert.equal(chapterHintFor({ ...ok, deeper: ['底层前提'], refill: false }), true);
  assert.equal(chapterHintFor({ ...ok, deeper: [], refill: true }), true);
  assert.equal(chapterHintFor({ ...ok, deeper: undefined, refill: true }), true);
  assert.equal(chapterHintFor({ ...ok, deeper: [], refill: false }), false);
  assert.equal(chapterHintFor({ ...ok, deeper: undefined, refill: false }), false);
  assert.equal(chapterHintFor({ ...ok, deeper: null, refill: false }), false);
});

test('chapterHintFor: suppressed by exam, tourRunning, !allowed, or chapter already seen in round', () => {
  const base = { deeper: ['x'], refill: true, allowed: true, seenChapters: new Set(), chapterKey: 'doc-1:ch-2' };
  assert.equal(chapterHintFor(base), true);
  assert.equal(chapterHintFor({ ...base, exam: true }), false);
  assert.equal(chapterHintFor({ ...base, tourRunning: true }), false);
  assert.equal(chapterHintFor({ ...base, allowed: false }), false);
  assert.equal(chapterHintFor({ ...base, seenChapters: new Set(['doc-1:ch-2']) }), false);
  assert.equal(chapterHintFor({ ...base, seenChapters: ['doc-1:ch-2'] }), false);
  assert.equal(chapterHintFor({ ...base, seenChapters: new Set(['doc-1:ch-1']) }), true);
});

test('chapterHintSeen / markChapterHintSeen: persists under study-chapter-basics-seen and survives memory reset', () => {
  const entries = new Map();
  const storage = {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)); },
  };
  try {
    forgetChapterHintVisit();
    assert.equal(chapterHintSeen(storage), false);
    assert.equal(markChapterHintSeen(storage), true);
    assert.equal(entries.get('study-chapter-basics-seen'), '1');
    assert.equal(chapterHintSeen(storage), true);
    forgetChapterHintVisit();
    assert.equal(chapterHintSeen(storage), true, 'reads persisted key back after clearing in-memory cache');
    entries.delete('study-chapter-basics-seen');
    assert.equal(chapterHintSeen(storage), false);
  } finally {
    forgetChapterHintVisit();
  }
});

test('freshTermsDeeper: rejects missing, invalid, or pre-entry timestamps (#1216)', () => {
  const enteredAt = 1_700_000_000_000;
  assert.deepEqual(freshTermsDeeper(null, enteredAt), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: [], at: new Date(enteredAt + 500).toISOString() }, enteredAt), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: ['x'] }, enteredAt), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: ['x'], at: '' }, enteredAt), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: ['x'], at: 'not-a-date' }, enteredAt), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: ['x'], at: new Date(enteredAt - 1).toISOString() }, enteredAt), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: ['x'], at: new Date(enteredAt + 1000).toISOString() }, 0), []);
  assert.deepEqual(freshTermsDeeper({ kind: 'terms', deeper: ['x'], at: new Date(enteredAt + 1000).toISOString() }, Number.NaN), []);
});

test('freshTermsDeeper: returns deeper when followup timestamp is at or after entry (#1216)', () => {
  const enteredAt = 1_700_000_000_000;
  assert.deepEqual(
    freshTermsDeeper({ kind: 'terms', deeper: ['底层前提'], at: new Date(enteredAt).toISOString() }, enteredAt),
    ['底层前提'],
  );
  assert.deepEqual(
    freshTermsDeeper({ kind: 'terms', deeper: ['底层前提', '二进制'], at: new Date(enteredAt + 250).toISOString() }, enteredAt),
    ['底层前提', '二进制'],
  );
  assert.deepEqual(
    freshTermsDeeper({ kind: 'terms', deeper: ['底层前提'], at: enteredAt + 1 }, enteredAt),
    ['底层前提'],
  );
});

function mountHookSync(hookFn, initialArgs) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  let currentArgs = initialArgs;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const render = (nextArgs = currentArgs) => {
    currentArgs = nextArgs;
    cursor = 0;
    pending = [];
    const prev = internals.H;
    internals.H = {
      useState: (init) => {
        const i = cursor++;
        if (!(i in hooks)) {
          hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
            hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
          }];
        }
        return hooks[i];
      },
      useReducer: (reducer, init) => {
        const i = cursor++;
        if (!(i in hooks)) hooks[i] = [init, (act) => { hooks[i][0] = reducer(hooks[i][0], act); }];
        return hooks[i];
      },
      useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
      useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
      useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
      useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
    };
    let result;
    try { result = hookFn(currentArgs); } finally { internals.H = prev; }
    for (const eff of pending) {
      cleanups[eff.i]?.();
      cleanups[eff.i] = undefined;
      const done = eff.fn();
      hooks[eff.i] = { deps: eff.deps };
      if (typeof done === 'function') cleanups[eff.i] = done;
    }
    return result;
  };
  const unmount = () => { for (const c of cleanups) c?.(); };
  return { render, unmount };
}

test('useChapterHint: suppresses historical deeper followups on open/revisit/new-round while firing on fresh completion and second fill (#1216)', async () => {
  forgetChapterHintVisit();
  const cardPlace = { chapter: { key: 'doc-1:ch-1', title: '第一章' }, document: { sourceId: 'doc-1' } };
  const historicalFollowup = {
    id: 'f-old',
    kind: 'terms',
    at: new Date(Date.now() - 60_000).toISOString(),
    terms: ['旧词'],
    deeper: ['底层前提'],
  };
  const run1Card1 = { id: 'run-1', index: 0, deckId: 'd1', card: { id: 'c1' } };
  const mounted = mountHookSync(useChapterHint, {
    run: run1Card1,
    cardPlace,
    allFollowups: [historicalFollowup],
    currentTerms: ['新词'],
  });

  // 1. Opening a card that already has a historical terms followup with deeper must NOT flash or show, yet keeps hand-off terms/deeper.
  let state = mounted.render();
  assert.equal(state.visible, false, 'historical followup never triggers on initial render');
  assert.deepEqual(state.deeper, ['底层前提']);
  assert.deepEqual(state.terms, ['旧词', '新词']);

  // 2. Clicking "补齐" a second time on the card (condition b) still triggers immediately.
  state.noteFillTerms();
  state = mounted.render();
  assert.equal(state.visible, true, 'condition (b) refill remains intact');
  state.dismiss();
  state = mounted.render();
  assert.equal(state.visible, false);

  // 3. New round on the same card still suppresses the old deeper followup.
  const run2Card1 = { id: 'run-2', index: 0, deckId: 'd1', card: { id: 'c1' } };
  state = mounted.render({ run: run2Card1, cardPlace, allFollowups: [historicalFollowup] });
  assert.equal(state.visible, false, 'new round suppresses pre-existing deeper followup');

  // 4. Fresh completion on a clean card (at >= enteredAt) triggers the hint.
  const run3Card1 = { id: 'run-3', index: 0, deckId: 'd1', card: { id: 'c1' } };
  state = mounted.render({ run: run3Card1, cardPlace, allFollowups: [] });
  assert.equal(state.visible, false);
  await new Promise((r) => setTimeout(r, 15));
  const freshFollowup = {
    id: 'f-fresh',
    kind: 'terms',
    at: new Date().toISOString(),
    terms: ['底层前置'],
    deeper: ['二进制'],
  };
  state = mounted.render({ run: run3Card1, cardPlace, allFollowups: [freshFollowup] });
  assert.equal(state.visible, true, 'fresh completion during this visit shows hint');

  // 5. Leaving to another card and returning in the same round suppresses the hint even if tipShown hid it before.
  const run3Card1Suppressed = { id: 'run-4', index: 0, deckId: 'd1', card: { id: 'c1' } };
  state = mounted.render({ run: run3Card1Suppressed, cardPlace, allFollowups: [], tipShown: 'practice.help-first' });
  await new Promise((r) => setTimeout(r, 15));
  const freshButHiddenByTip = {
    id: 'f-fresh-2',
    kind: 'terms',
    at: new Date().toISOString(),
    terms: ['词A'],
    deeper: ['前置B'],
  };
  state = mounted.render({ run: run3Card1Suppressed, cardPlace, allFollowups: [freshButHiddenByTip], tipShown: 'practice.help-first' });
  assert.equal(state.visible, false, 'suppressed by practice tip');
  await new Promise((r) => setTimeout(r, 15));
  const run3Card2 = { id: 'run-4', index: 1, deckId: 'd1', card: { id: 'c2' } };
  mounted.render({ run: run3Card2, cardPlace: { chapter: { key: 'doc-1:ch-2', title: '第二章' } }, allFollowups: [] });
  state = mounted.render({ run: run3Card1Suppressed, cardPlace, allFollowups: [freshButHiddenByTip], tipShown: null });
  assert.equal(state.visible, false, 'leaving and returning in same round resets enteredAt so old completion does not show');

  mounted.unmount();
  forgetChapterHintVisit();
});
