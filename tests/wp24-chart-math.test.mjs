import test from 'node:test';
import assert from 'node:assert/strict';
import { linearScale, niceTicks, recentDays, fillTrend, linePath, lineRuns, shortDeckTitles, dateLabel, evenTicks }
  from '../ui/charts/chart-math.js';

// WP24: the dashboard charts are plain SVG; every number they draw comes from
// these pure helpers so the maths is testable without a browser.

test('linearScale maps a domain onto a range, clamps nothing, and survives a flat domain', () => {
  const x = linearScale([0, 10], [100, 300]);
  assert.equal(x(0), 100);
  assert.equal(x(5), 200);
  assert.equal(x(10), 300);
  assert.equal(x(20), 500, 'values outside the domain extrapolate instead of clamping');
  const flat = linearScale([4, 4], [0, 100]);
  assert.equal(flat(4), 50, 'a flat domain draws in the middle instead of dividing by zero');
  const inverted = linearScale([0, 5], [200, 20]);
  assert.equal(inverted(5), 20, 'svg y grows downwards: a reversed range works');
});

test('niceTicks gives round steps that always cover the max', () => {
  assert.deepEqual(niceTicks(5), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(23, 4), [0, 10, 20, 30]);
  assert.deepEqual(niceTicks(0), [0, 1], 'an empty chart still has a usable axis');
  const ticks = niceTicks(137);
  assert.ok(ticks.at(-1) >= 137);
  assert.ok(ticks.length <= 7);
});

test('recentDays lists local date keys oldest first and crosses month and year ends', () => {
  assert.deepEqual(recentDays('2026-10-02', 3), ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(recentDays('2027-01-02', 4), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(recentDays('2026-10-02', 90).length, 90);
  assert.equal(recentDays('2024-03-01', 2)[0], '2024-02-29', 'leap day');
});

test('fillTrend puts the stats rows on a continuous day axis and leaves holes for days without data', () => {
  const trend = [{ date: '2026-09-30', gradedAvg: 4, gradedCount: 3, selfAvg: null, selfCount: 0 },
    { date: '2026-10-02', gradedAvg: null, gradedCount: 0, selfAvg: 2.5, selfCount: 2 },
    { date: '2025-01-01', gradedAvg: 1, gradedCount: 1, selfAvg: null, selfCount: 0 }];
  const rows = fillTrend(trend, '2026-10-02', 4);
  assert.deepEqual(rows.map(r => r.date), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(rows.map(r => r.gradedAvg), [null, 4, null, null]);
  assert.deepEqual(rows.map(r => r.selfAvg), [null, null, null, 2.5]);
  assert.deepEqual(rows.map(r => r.gradedCount + r.selfCount), [0, 3, 0, 2]);
});

test('lineRuns splits a series at every gap and linePath draws no line across empty days', () => {
  const points = [{ x: 0, y: 10 }, { x: 10, y: 20 }, { x: 20, y: null }, { x: 30, y: 5 }, { x: 40, y: null }, { x: 50, y: 7 }, { x: 60, y: 9 }];
  assert.deepEqual(lineRuns(points).map(run => run.map(p => p.x)), [[0, 10], [30], [50, 60]]);
  assert.equal(linePath(points), 'M0 10L10 20M50 7L60 9', 'single isolated points get a dot, not a path');
  assert.equal(linePath([{ x: 1, y: null }]), '');
  assert.equal(linePath([]), '');
  assert.equal(linePath([{ x: 1.2345, y: 2.3456 }, { x: 3, y: 4 }]), 'M1.23 2.35L3 4', 'coordinates are rounded to two decimals');
});

test('evenTicks picks a handful of evenly spaced labels and always includes the last day', () => {
  assert.deepEqual(evenTicks(30, 5), [0, 7, 14, 21, 29]);
  assert.deepEqual(evenTicks(3, 5), [0, 1, 2]);
  assert.deepEqual(evenTicks(1, 5), [0]);
  assert.deepEqual(evenTicks(0, 5), []);
});

test('dateLabel is a compact M/D for axes', () => {
  assert.equal(dateLabel('2026-10-02'), '10/2');
  assert.equal(dateLabel('2026-01-15'), '1/15');
});

test('shortDeckTitles drops the shared course prefix and the question count, keeping the distinguishing part', () => {
  const titles = ['Platform Engineering｜期末综合卷04｜90题', 'Platform Engineering｜期末综合卷05｜90题', 'Platform Engineering｜单元测验｜20题'];
  assert.deepEqual(shortDeckTitles(titles), ['期末综合卷04', '期末综合卷05', '单元测验']);
});

test('shortDeckTitles leaves titles alone when nothing is shared', () => {
  assert.deepEqual(shortDeckTitles(['行为型模式', 'Memento notes']), ['行为型模式', 'Memento notes']);
  assert.deepEqual(shortDeckTitles(['Same｜Same']), ['Same'], 'a title never loses its last segment');
  assert.deepEqual(shortDeckTitles(['A｜90题']), ['A'], 'a lone count segment is dropped, the name is kept');
  assert.deepEqual(shortDeckTitles(['Platform Engineering｜期末综合卷04｜90题']), ['期末综合卷04'], 'one title shares the prefix with itself');
  assert.deepEqual(shortDeckTitles(['A｜x', 'B｜y']), ['A｜x', 'B｜y'], 'different prefixes are kept');
  assert.deepEqual(shortDeckTitles([]), []);
  assert.deepEqual(shortDeckTitles(['Plain', 'Plain']), ['Plain', 'Plain']);
});
