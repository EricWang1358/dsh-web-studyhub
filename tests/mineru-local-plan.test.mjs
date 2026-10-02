import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL, halveWindow, localEta, localEtaRange, localPace, nextWindow } from '../lib/mineru-local.js';

/* The adaptive plan of the local route: the first window is small so the first progress, the first measured pace and the first estimate arrive
   quickly; the next ones ramp up; then each is sized from the measured seconds per page so that it lasts about LOCAL.targetWindowSeconds, clamped
   to [LOCAL.minWindowPages, LOCAL.maxWindowPages]. Pure functions: no CLI, no clock. */

const MIN = LOCAL.minWindowPages, MAX = LOCAL.maxWindowPages;
const second = ms => ms * 1000;
const win = (pages, seconds) => ({ pages, ms: second(seconds) });

/** Run the planner against a simulated machine: `seconds(pages, index)` is how long a window of that many pages takes. */
function simulate({ total, seconds, covered = [], limits }) {
  const windows = [], plan = [];
  let from = 1;
  for (let guard = 0; guard < 1000; guard++) {
    const next = nextWindow({ total, covered: [...covered, ...plan.map(item => [item.startPage, item.endPage])], from, windows, tier: 'basic', limits });
    if (!next) break;
    plan.push(next);
    windows.push({ pages: next.pages, ms: second(seconds(next.pages, plan.length - 1)) });
    from = next.endPage + 1;
  }
  return { plan, windows };
}
const tiles = (plan, total) => plan.every((item, index) => item.startPage === (index ? plan[index - 1].endPage + 1 : 1)) && plan.at(-1)?.endPage === total;

test('the constants live in one place and are what the owner asked for: a first window of 10, a ramp of 10-20-20, about a minute a window, never under 5 or over 50', () => {
  assert.equal(LOCAL.firstWindowPages, 10);
  assert.deepEqual([...LOCAL.rampPages], [10, 20, 20]);
  assert.ok(LOCAL.targetWindowSeconds >= 60 && LOCAL.targetWindowSeconds <= 90);
  assert.equal(LOCAL.minWindowPages, 5);
  assert.equal(LOCAL.maxWindowPages, 50);
  assert.equal(LOCAL.windowPages, 50, 'the old fixed size is still the largest a window may be');
});

test('the first window is 10 pages, whatever the machine', () => {
  const first = nextWindow({ total: 562, tier: 'basic' });
  assert.deepEqual([first.startPage, first.endPage, first.pages, first.reason], [1, 10, 10, 'first']);
});

test('a small book is one window: 7 pages is 1-7, never a window past the end', () => {
  const only = nextWindow({ total: 7, tier: 'basic' });
  assert.deepEqual([only.startPage, only.endPage], [1, 7]);
  assert.equal(nextWindow({ total: 7, from: 8, tier: 'basic' }), null, 'nothing is left');
  assert.deepEqual([nextWindow({ total: 1, tier: 'standard' }).startPage, nextWindow({ total: 1, tier: 'standard' }).endPage], [1, 1]);
});

test('the ramp: 10, then at most 20, then at most 20, each also limited by what the measured speed allows', () => {
  const { plan } = simulate({ total: 562, seconds: pages => pages * 0.5 });
  assert.deepEqual(plan.slice(0, 3).map(item => item.pages), [10, 20, 20]);
  assert.deepEqual(plan.slice(0, 3).map(item => item.reason), ['first', 'ramp', 'ramp']);
  // a slow machine: 6 s a page means 20 pages would take two minutes, so the ramp is held back to what lasts about a minute
  const slow = simulate({ total: 562, seconds: pages => pages * 6 });
  assert.equal(slow.plan[0].pages, 10);
  assert.ok(slow.plan[1].pages < 20, `the second window is held back: ${slow.plan[1].pages}`);
});

test('after the ramp a window lasts about the target: a fast machine reaches 50 pages, a slow one stays small', () => {
  const fast = simulate({ total: 562, seconds: pages => 2 + pages * 0.3 });
  assert.equal(Math.max(...fast.plan.map(item => item.pages)), MAX);
  assert.ok(fast.plan.slice(3, -1).every(item => item.pages >= 40), 'on a fast machine the steady windows are large');
  const slow = simulate({ total: 562, seconds: pages => 10 + pages * 6 });
  for (const item of slow.plan.slice(3, -1)) assert.ok(item.pages >= MIN && item.pages <= 14, `slow window of ${item.pages}`);
  const slower = simulate({ total: 562, seconds: pages => pages * 30 });
  for (const item of slower.plan.slice(3, -1)) assert.ok(item.pages >= MIN && item.pages < 2 * MIN, `never below the minimum, whatever the speed: ${item.pages}`);
  // the seconds each steady window takes stay near the target on the slow machine
  const steady = slow.windows.slice(3, -1).map(item => item.ms / 1000);
  assert.ok(steady.every(value => value < LOCAL.targetWindowSeconds * 2), `a window lasted ${Math.max(...steady)} s`);
});

test('the windows always tile the book exactly, from page 1 to the last page, on any machine and any size of book', () => {
  for (const total of [1, 4, 5, 7, 10, 11, 29, 50, 51, 53, 54, 55, 99, 120, 562, 1001])
    for (const seconds of [pages => pages * 0.05, pages => pages * 1.6, pages => 5 + pages * 6, pages => pages * 40]) {
      const { plan } = simulate({ total, seconds });
      assert.ok(tiles(plan, total), `a plan for ${total} pages tiles it: ${plan.map(item => `${item.startPage}-${item.endPage}`).join(' ')}`);
      assert.equal(plan.reduce((sum, item) => sum + item.pages, 0), total, 'the page count is the source page count');
      for (const item of plan.slice(0, -1)) assert.ok(item.pages >= Math.min(MIN, total) && item.pages <= MAX, `window of ${item.pages}`);
      assert.ok(plan.every(item => item.pages <= MAX));
    }
});

test('the last window takes the remainder, and never leaves a tail of fewer than 5 pages', () => {
  // 53 pages left with a window of 50: 3 would be left, so the window gives 5 of its pages to the tail
  const tail = nextWindow({ total: 53, from: 1, windows: [win(50, 15), win(50, 15), win(50, 15), win(50, 15)], tier: 'basic' });
  assert.equal(tail.pages, 48);
  assert.equal(53 - tail.pages, 5);
  // 12 left with a window of 10: the last window takes all 12
  const rest = nextWindow({ total: 52, from: 41, windows: [win(10, 5), win(20, 10), win(10, 5)], tier: 'basic', limits: { rampPages: [] } });
  assert.equal(rest.endPage, 52);
  assert.ok(rest.pages >= MIN);
});

test('pages that are already converted are never planned again: a window stops before them and the next one starts after them', () => {
  const covered = [[11, 30]];
  const first = nextWindow({ total: 100, covered, tier: 'basic' });
  assert.deepEqual([first.startPage, first.endPage], [1, 10], 'it stops at the page before the converted ones');
  const after = nextWindow({ total: 100, covered, from: 11, windows: [win(10, 5)], tier: 'basic' });
  assert.equal(after.startPage, 31, 'and the next one starts after them');
  assert.equal(nextWindow({ total: 30, covered: [[1, 30]], tier: 'basic' }), null, 'a book converted in full has nothing left to plan');
  const hole = nextWindow({ total: 100, covered: [[1, 40], [46, 100]], from: 41, tier: 'basic' });
  assert.deepEqual([hole.startPage, hole.endPage], [41, 45], 'a gap smaller than a window is filled exactly');
});

test('the pace is the measured seconds per page, over the latest windows; the first window, which also loads the model, is left out when it was much slower per page', () => {
  assert.equal(localPace([]), null, 'nothing measured yet');
  assert.equal(localPace([{ pages: 10, ms: 0 }]), null, 'a window without a measurement says nothing');
  assert.deepEqual(localPace([win(10, 60)]), { secondsPerPage: 6, windows: 1, basis: 'measured', skippedFirst: false });
  const loaded = localPace([win(10, 200), win(20, 40)]);
  assert.equal(loaded.secondsPerPage, 2, 'window 2 onward, because window 1 paid for loading the model');
  assert.equal(loaded.skippedFirst, true);
  const alike = localPace([win(10, 25), win(20, 40)]);
  assert.equal(alike.skippedFirst, false);
  assert.equal(alike.secondsPerPage, Math.round((65 / 30) * 100) / 100);
  // it follows the machine: only the latest three windows count
  const slowing = localPace([win(10, 5), win(10, 5), win(10, 5), win(10, 5), win(10, 100), win(10, 100), win(10, 100)]);
  assert.equal(slowing.secondsPerPage, 10);
});

test('the plan reacts to a machine that gets slower or faster', () => {
  const steady = [win(10, 40), win(20, 80), win(20, 80)];
  const before = nextWindow({ total: 562, from: 51, windows: steady, tier: 'basic' }).pages;
  const slower = nextWindow({ total: 562, from: 51, windows: [...steady, win(before, before * 16)], tier: 'basic' }).pages;
  const faster = nextWindow({ total: 562, from: 51, windows: [...steady, win(before, before * 0.2), win(40, 8), win(50, 10)], tier: 'basic' }).pages;
  assert.ok(slower < before, `${slower} < ${before}`);
  assert.ok(faster > before, `${faster} > ${before}`);
});

test('windows restored from an earlier attempt carry no measurement, so the planner falls back to the tier\'s published estimate rather than guess', () => {
  const sized = nextWindow({ total: 562, from: 101, windows: [{ pages: 50, ms: 0 }, { pages: 50, ms: 0 }, { pages: 0, ms: 0 }, { pages: 0, ms: 0 }], tier: 'basic' });
  assert.equal(sized.reason, 'estimate');
  assert.equal(sized.pages, Math.round(LOCAL.targetWindowSeconds / LOCAL.secondsPerPage.basic) > MAX ? MAX : Math.round(LOCAL.targetWindowSeconds / LOCAL.secondsPerPage.basic));
  const standard = nextWindow({ total: 562, from: 101, windows: [{ pages: 0, ms: 0 }, { pages: 0, ms: 0 }, { pages: 0, ms: 0 }, { pages: 0, ms: 0 }], tier: 'standard' });
  assert.equal(standard.pages, Math.round(LOCAL.targetWindowSeconds / LOCAL.secondsPerPage.standard));
});

test('a window that failed is halved once: two windows that tile it exactly; one page cannot be halved', () => {
  assert.deepEqual(halveWindow({ startPage: 11, endPage: 30 }), [{ startPage: 11, endPage: 20 }, { startPage: 21, endPage: 30 }]);
  assert.deepEqual(halveWindow({ startPage: 1, endPage: 7 }), [{ startPage: 1, endPage: 3 }, { startPage: 4, endPage: 7 }]);
  assert.deepEqual(halveWindow({ startPage: 5, endPage: 6 }), [{ startPage: 5, endPage: 5 }, { startPage: 6, endPage: 6 }]);
  assert.equal(halveWindow({ startPage: 9, endPage: 9 }), null);
});

test('the estimate of what is left: measured pace when there is one, the tier\'s published figure before, nothing for a tier without one', () => {
  const none = localEta({ remainingPages: 500, windows: [], tier: 'basic' });
  assert.deepEqual([none.basis, none.secondsPerPage, none.etaSeconds, none.windowsMeasured], ['estimate', 1.6, 800, 0]);
  const std = localEta({ remainingPages: 100, windows: [], tier: 'standard' });
  assert.deepEqual([std.basis, std.secondsPerPage, std.etaSeconds], ['estimate', 2.5, 250]);
  const measured = localEta({ remainingPages: 482, windows: [win(10, 60)], tier: 'basic' });
  assert.deepEqual([measured.basis, measured.secondsPerPage, measured.etaSeconds, measured.windowsMeasured], ['measured', 6, 2892, 1]);
  const unknown = localEta({ remainingPages: 100, windows: [], tier: 'advanced' });
  assert.deepEqual([unknown.basis, unknown.secondsPerPage, unknown.etaSeconds], ['none', null, null]);
  assert.equal(localEta({ remainingPages: 0, windows: [win(10, 60)], tier: 'basic' }).etaSeconds, 0);
  const afterLoad = localEta({ remainingPages: 100, windows: [win(10, 200), win(20, 40)], tier: 'basic' });
  assert.equal(afterLoad.secondsPerPage, 2, 'the model load of the first window does not inflate the estimate');
});

test('the sentence the card says about the plan comes from the same numbers: pace, pages per window, how often it moves', () => {
  const { plan, windows } = simulate({ total: 562, seconds: pages => pages * 6 });
  const pace = localPace(windows.slice(0, 4));
  assert.equal(pace.secondsPerPage, 6);
  const upcoming = nextWindow({ total: 562, from: plan.slice(0, 4).reduce((sum, item) => sum + item.pages, 1), windows: windows.slice(0, 4), tier: 'basic' });
  assert.ok(Math.abs(upcoming.pages * pace.secondsPerPage - LOCAL.targetWindowSeconds) <= pace.secondsPerPage, 'about a target window long');
});

test('the estimate is "about": one figure when the windows agree, a range when one window (it also loaded the model) or windows that differ much are all there is to go on', () => {
  const stable = localEtaRange({ remainingPages: 300, windows: [win(10, 100), win(20, 40), win(20, 42)], tier: 'basic' });
  assert.equal(stable.stable, true);
  assert.equal(stable.lowSeconds, stable.highSeconds);
  assert.equal(stable.etaSeconds, stable.lowSeconds);
  const one = localEtaRange({ remainingPages: 300, windows: [win(10, 20)], tier: 'basic' });
  assert.equal(one.stable, false);
  assert.ok(one.lowSeconds < one.etaSeconds && one.etaSeconds < one.highSeconds, 'a first reading is a band around the figure');
  const swinging = localEtaRange({ remainingPages: 300, windows: [win(20, 20), win(20, 80), win(20, 30)], tier: 'basic' });
  assert.equal(swinging.stable, false);
  assert.equal(swinging.lowSeconds, 300, 'the fastest window: 1 s a page');
  assert.equal(swinging.highSeconds, 1200, 'the slowest window: 4 s a page');
  const unmeasured = localEtaRange({ remainingPages: 300, windows: [], tier: 'basic' });
  assert.deepEqual([unmeasured.basis, unmeasured.stable], ['estimate', false], 'a published figure is never called steady');
  assert.deepEqual([localEtaRange({ remainingPages: 5, windows: [], tier: 'advanced' }).lowSeconds], [null]);
});
