import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceWeeklyItems,
  dayNumberOf,
  dayNumberOfDate,
  disperseReviewQueue,
  disperseSiblingsSchedule,
  fuzzRange,
  normalizeRestRules,
  pickBalancedDay,
  siblingGroupKeys,
  spreadBalancedDays,
} from '../lib/contexts/study/load-balance.js';
import { schedule, initialReview } from '../lib/sm2.js';
import { balanceCardReview, loadBalanceOn, siblingDispersalOn } from '../lib/card-schedule.js';
import { alignDueDates, disperseLibrarySiblings } from '../lib/exam-alignment.js';
import { weeklyChunks, weeksOf } from '../lib/plan-weekly.js';

const NOW = new Date(2026, 10, 2, 10, 0).getTime(); // 2026-11-02 (Monday)
const atDay = (offset, hh = 10) => {
  const base = new Date(NOW);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hh).toISOString();
};
const dateStr = (offset) => {
  const d = new Date(atDay(offset));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('fuzzRange matches FSRS4Anki piecewise bands and clamps to bounds', () => {
  assert.deepEqual(fuzzRange(1), { min: 1, max: 1, delta: 0 });
  assert.deepEqual(fuzzRange(2), { min: 2, max: 2, delta: 0 });
  const r10 = fuzzRange(10);
  assert.ok(r10.min < 10 && r10.max > 10, `expected fuzz window around 10d: ${JSON.stringify(r10)}`);
  assert.equal(r10.min, 8);
  assert.equal(r10.max, 12);
  const r30 = fuzzRange(30, { maxInterval: 31 });
  assert.equal(r30.max, 31, 'capped by maxInterval');
});

test('pickBalancedDay deterministically avoids overloaded days, rest days, and sibling days', () => {
  const today = dayNumberOf(NOW); // Mon 2026-11-02
  const restRules = normalizeRestRules({ restDates: [dateStr(5)], studyWeekdays: [1, 2, 3, 4, 5] }); // Sat/Sun + day+5 are off
  const dailyLoad = new Map([
    [today + 4, 25], // Fri overloaded
    [today + 7, 1],  // Mon light
    [today + 8, 12], // Tue busy
  ]);
  const picked = pickBalancedDay({
    targetDay: today + 5,
    minDay: today + 4,
    maxDay: today + 8,
    dailyLoad,
    restRules,
    dailyCap: 20,
    siblingDays: [today + 4],
    minSiblingGap: 2,
  });
  assert.equal(picked.day, today + 7, 'avoids rest day (+5,+6) and overloaded/sibling day (+4), picks lowest-load Mon (+7)');
  assert.equal(picked.moved, true);
});

test('balanceCardReview is opt-in, keeps FSRS memory pure, respects exam ceiling and disperses siblings', () => {
  const review10 = { ...schedule(schedule(initialReview(), 4, atDay(-10)), 4, atDay(0)), interval_days: 10, due_at: atDay(10) };
  const cardA = { id: 'cA', topic: 'Deadlocks', citations: [{ sourceId: 'src-p12', quote: 'Banker algorithm' }], review: { ...review10 } };
  const cardB = { id: 'cB', topic: 'Deadlocks', citations: [{ sourceId: 'src-p12', quote: 'Safe state' }], review: { ...review10 } };
  const state = {
    settings: { request_retention: 0.9, maximum_interval: 36500 },
    courses: [{ id: 'c-os', name: 'OS', exam: { date: dateStr(11) }, plan: { version: 1, restDates: [dateStr(10)] } }],
    sources: [{ id: 'src-p12', title: 'OS p.12', document: { materialId: 'doc-os', page: 12 } }],
    decks: [{ id: 'd-os', title: 'OS', course: 'OS', cards: [cardA, cardB] }],
  };

  assert.equal(loadBalanceOn(state.settings), false);
  assert.equal(siblingDispersalOn(state.settings), false);
  // Default off: untouched object reference
  assert.equal(balanceCardReview(state, state.decks[0], cardB, review10, { now: NOW }), review10);

  // Enabled: avoids rest date (day +10) and sibling cardA (day +10), stays <= exam date (day +11), leaves stability/difficulty/interval unchanged
  const balanced = balanceCardReview(state, state.decks[0], cardB, review10, {
    now: NOW,
    loadBalance: true,
    disperseSiblings: true,
  });
  const shiftedDay = dayNumberOf(Date.parse(balanced.due_at));
  assert.notEqual(shiftedDay, dayNumberOf(NOW) + 10, 'moved off rest + sibling day');
  assert.ok(shiftedDay <= dayNumberOfDate(dateStr(11)), 'never crosses exam date ceiling');
  assert.equal(balanced.stability, review10.stability, 'FSRS stability untouched');
  assert.equal(balanced.difficulty, review10.difficulty, 'FSRS difficulty untouched');
  assert.equal(balanced.interval_days, review10.interval_days, 'FSRS interval_days untouched');
});

test('alignDueDates with loadBalance + disperseSiblings avoids rest/heavy days and separates siblings', () => {
  const mkReview = (dueIn, ago = 15) => ({
    ...schedule(schedule(initialReview(), 4, atDay(-ago - 10)), 4, atDay(-ago)),
    interval_days: 20,
    due_at: atDay(dueIn),
  });
  const restDate = dateStr(2);
  const state = {
    settings: { request_retention: 0.9, maximum_interval: 36500, load_balance: true, disperse_siblings: true },
    courses: [{ id: 'c-os', name: 'OS', exam: { date: dateStr(7) }, plan: { version: 1, restDates: [restDate] } }],
    sources: [{ id: 'p5', title: 'OS p.5', document: { materialId: 'doc-os', page: 5 } }],
    decks: [{
      id: 'd-os',
      title: 'OS',
      course: 'OS',
      cards: [
        // Existing heavy load on day 0
        ...Array.from({ length: 6 }, (_, i) => ({ id: `busy-${i}`, topic: 'Intro', review: mkReview(0, 5 + i) })),
        // Three siblings from same source page p5 due after exam
        { id: 'sib-1', topic: 'Locks', citations: [{ sourceId: 'p5', quote: 'Mutex' }], review: mkReview(25, 10) },
        { id: 'sib-2', topic: 'Locks', citations: [{ sourceId: 'p5', quote: 'Spinlock' }], review: mkReview(26, 11) },
        { id: 'sib-3', topic: 'Locks', citations: [{ sourceId: 'p5', quote: 'Semaphore' }], review: mkReview(27, 12) },
      ],
    }],
  };

  const res = alignDueDates(state, NOW);
  assert.equal(res.pulled, 3);
  const sibDays = ['sib-1', 'sib-2', 'sib-3'].map(id => dayNumberOf(Date.parse(state.decks[0].cards.find(c => c.id === id).review.due_at)));
  const restDayNum = dayNumberOfDate(restDate);
  const todayNum = dayNumberOf(NOW);
  assert.equal(new Set(sibDays).size, 3, `all 3 siblings placed on distinct days: ${JSON.stringify(sibDays)}`);
  assert.ok(!sibDays.includes(restDayNum), 'none placed on rest day');
  assert.ok(!sibDays.includes(todayNum), 'none piled onto already-heavy day 0');
});

test('disperseLibrarySiblings and disperseSiblingsSchedule separate colliding future siblings within fuzz window', () => {
  const mkReview = (dueIn, interval = 12) => ({
    ...schedule(schedule(initialReview(), 4, atDay(-12)), 4, atDay(0)),
    interval_days: interval,
    due_at: atDay(dueIn),
  });
  const state = {
    settings: { request_retention: 0.9, maximum_interval: 36500 },
    courses: [{ id: 'c-db', name: 'DB' }],
    sources: [{ id: 'db-p8', title: 'DB p.8', document: { materialId: 'doc-db', page: 8 } }],
    decks: [{
      id: 'd-db',
      title: 'DB',
      course: 'DB',
      cards: [
        { id: 'a1', topic: 'MVCC', hid: 'h-mvcc', citations: [{ sourceId: 'db-p8', quote: 'snapshot' }], review: mkReview(12, 12) },
        { id: 'a2', topic: 'MVCC', hid: 'h-mvcc', citations: [{ sourceId: 'db-p8', quote: 'isolation' }], review: mkReview(12, 12) },
      ],
    }],
  };

  const result = disperseLibrarySiblings(state, NOW, { minSiblingGap: 2 });
  assert.equal(result.dispersed, 1);
  const d1 = dayNumberOf(Date.parse(state.decks[0].cards[0].review.due_at));
  const d2 = dayNumberOf(Date.parse(state.decks[0].cards[1].review.due_at));
  assert.ok(Math.abs(d1 - d2) >= 2, `siblings separated by >= 2 days: ${d1} vs ${d2}`);
  // Verify pure batch helper returns matching move shape
  const pure = disperseSiblingsSchedule([
    { deckId: 'd-db', card: { id: 'x1' }, dueDay: 100, intervalDays: 12, siblingKeys: ['src:db-p8'] },
    { deckId: 'd-db', card: { id: 'x2' }, dueDay: 100, intervalDays: 12, siblingKeys: ['src:db-p8'] },
  ], { today: 88, minSiblingGap: 2 });
  assert.equal(pure.moves.length, 1);
  assert.ok(Math.abs(pure.assignments.get('x1') - pure.assignments.get('x2')) >= 2);
});

test('disperseReviewQueue spaces same-source/same-page siblings apart while respecting prerequisites and tiers', () => {
  const sources = [
    { id: 's1', document: { materialId: 'm1', page: 1 } },
    { id: 's2', document: { materialId: 'm1', page: 2 } },
    { id: 's3', document: { materialId: 'm1', page: 3 } },
  ];
  const entries = [
    { deckId: 'd1', tier: 0, card: { id: 'p1-a', citations: [{ sourceId: 's1' }] } },
    { deckId: 'd1', tier: 0, card: { id: 'p1-b', citations: [{ sourceId: 's1' }] } },
    { deckId: 'd1', tier: 0, card: { id: 'p2-a', citations: [{ sourceId: 's2' }] } },
    { deckId: 'd1', tier: 0, card: { id: 'p3-a', citations: [{ sourceId: 's3' }] } },
    // Prerequisite pair in tier 1: c-post requires c-pre
    { deckId: 'd1', tier: 1, card: { id: 'c-pre', citations: [{ sourceId: 's1' }] } },
    { deckId: 'd1', tier: 1, card: { id: 'c-post', citations: [{ sourceId: 's2' }], requires: [{ deckId: 'd1', cardId: 'c-pre' }] } },
  ];

  const ordered = disperseReviewQueue(entries, { sources, tierOf: e => e.tier, minGap: 2 });
  const ids = ordered.map(e => e.card.id);
  const idxA = ids.indexOf('p1-a');
  const idxB = ids.indexOf('p1-b');
  assert.ok(Math.abs(idxA - idxB) >= 2, `siblings p1-a and p1-b separated in queue: ${JSON.stringify(ids)}`);
  assert.ok(ids.indexOf('c-pre') < ids.indexOf('c-post'), 'prerequisite order preserved');
  assert.ok(ids.indexOf('p1-b') < ids.indexOf('c-pre'), 'tier boundary preserved');

  // Verify siblingGroupKeys links variant origin to source card
  const keys = siblingGroupKeys({ id: 'v1', origin: { deckId: 'd1', cardId: 'p1-a' } }, { deckId: 'd1' });
  assert.ok(keys.includes('origin:d1:p1-a'));
  assert.ok(spreadBalancedDays([{ floor: 10 }], 10, 15).length === 1);
});

test('weeklyChunks with loadBalance / existingLoad / disperseSiblings smooths weekly load and separates siblings', () => {
  const start = '2026-10-12'; // Mon
  const chapters = [{ n: 1, title: 'Ch1', ids: ['p1', 'p2', 'p3', 'p4'] }];
  const weeks = weeksOf(chapters, 1, start);
  const pending = [
    { id: 'p1', minutes: 30, sourceId: 'src-1' },
    { id: 'p2', minutes: 30, sourceId: 'src-1' },
    { id: 'p3', minutes: 30, sourceId: 'src-2' },
    { id: 'p4', minutes: 30, sourceId: 'src-3' },
  ];
  const studyDates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
  // Monday already heavily loaded with 90 min of FSRS reviews
  const existingLoad = { '2026-10-12': 90, '2026-10-13': 0, '2026-10-14': 0, '2026-10-15': 0 };

  const balanced = weeklyChunks({
    weeks,
    pending,
    studyDates,
    today: start,
    cost: p => p.minutes,
    existingLoad,
    loadBalance: true,
    disperseSiblings: true,
  });

  // Heavy Monday gets 0 new items while lighter days absorb the 4 points
  assert.equal(balanced.chunkOf('2026-10-12').length, 0, 'avoids heavily loaded day');
  const dayOfPoint = id => studyDates.find(d => balanced.chunkOf(d).some(p => p.id === id));
  assert.notEqual(dayOfPoint('p1'), dayOfPoint('p2'), 'same-source sibling points p1 and p2 placed on different days');
  assert.equal(balanced.unplaced.length, 0);

  // Direct balanceWeeklyItems sanity check
  const direct = balanceWeeklyItems(pending, studyDates, { cost: p => p.minutes, existingLoad, disperseSiblings: true });
  assert.equal(direct.get('2026-10-12').length, 0);
});
