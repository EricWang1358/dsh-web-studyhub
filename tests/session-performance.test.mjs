import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PERFORMANCE_LIMITS, createPerformanceLog, snapshotChars } from '../ui/session-performance.js';
import { PAGE_IDS } from '../ui/pages.js';

/* #893 S4: the numbers a bug report carries about this session. The log is a pure value (no clock, no DOM): the callers hand it times they read,
   so its limits and its summary are tested here as functions. The hooks that feed it are checked in tests/page-boundary-browser.test.mjs. */

const switched = (log, page, ms, from = 1000) => { log.startSwitch(page, from); log.endSwitch(page, from + ms); };

test('a page switch is the time from the call that switches the page to the frame that draws it, kept by page', () => {
  const log = createPerformanceLog();
  switched(log, 'library', 30);
  switched(log, 'library', 90);
  switched(log, 'library', 50);
  switched(log, 'sources', 12.6);
  const { switches } = log.summary();
  assert.deepEqual(switches.all, { count: 4, median: 30, worst: 90 });
  assert.deepEqual(switches.byPage, [{ page: 'library', count: 3, median: 50, worst: 90 }, { page: 'sources', count: 1, median: 13, worst: 13 }],
    'the pages come in the order of the page registry, durations are whole milliseconds, an even count takes the lower middle');
});

test('the lists are bounded and the oldest entry goes first', () => {
  const log = createPerformanceLog();
  for (let index = 0; index < 10; index++) switched(log, 'exam', 5000);
  for (let index = 0; index < PERFORMANCE_LIMITS.switches; index++) switched(log, 'exam', 5);
  assert.deepEqual(log.summary().switches.all, { count: PERFORMANCE_LIMITS.switches, median: 5, worst: 5 }, 'the ten slow ones were pushed out');
  for (let index = 0; index < PERFORMANCE_LIMITS.snapshots + 25; index++) log.recordSnapshot(index < 25 ? 900000 : 100, 1);
  assert.deepEqual(log.summary().snapshots.chars, { count: PERFORMANCE_LIMITS.snapshots, median: 100, worst: 100 });
});

test('a switch that did not happen, or cannot be timed, is not recorded', () => {
  const log = createPerformanceLog();
  log.endSwitch('library', 50);                                  // no start
  log.startSwitch('library', 10); log.endSwitch('sources', 50);  // another page drew
  log.startSwitch('not-a-page', 10); log.endSwitch('not-a-page', 50);
  log.startSwitch('__proto__', 10); log.endSwitch('__proto__', 50);
  log.startSwitch('exam', 'soon'); log.endSwitch('exam', 50);
  log.startSwitch('exam', 100); log.endSwitch('exam', 40);       // a clock that went back
  log.startSwitch('exam', 10); log.endSwitch('exam', 40); log.endSwitch('exam', 90); // the second end has no start left
  assert.deepEqual(log.summary().switches.all, { count: 1, median: 30, worst: 30 });
  assert.deepEqual(log.summary().switches.byPage.map(entry => entry.page), ['exam']);
});

test('a newer switch replaces one that never drew, so a stale start cannot lengthen the next', () => {
  const log = createPerformanceLog();
  log.startSwitch('library', 0);
  switched(log, 'sources', 20, 60000);
  assert.deepEqual(log.summary().switches.all, { count: 1, median: 20, worst: 20 });
});

test('long tasks are counted only where the webview reports them: elsewhere the summary says unknown, not zero', () => {
  const log = createPerformanceLog();
  assert.equal(log.summary().longTasks, null);
  log.observeLongTasks();
  assert.deepEqual(log.summary().longTasks, { count: 0, totalMs: 0, worstMs: 0 }, 'observed and none seen is a real zero');
  for (const ms of [60, 180.4, 75, -3, NaN, 'long']) log.recordLongTask(ms);
  assert.deepEqual(log.summary().longTasks, { count: 3, totalMs: 315, worstMs: 180 });
  log.observeLongTasks(); // the observer started again (it re-delivers what it buffered): the count starts over instead of doubling
  assert.deepEqual(log.summary().longTasks, { count: 0, totalMs: 0, worstMs: 0 });
});

test('a snapshot is its size and the time it took to apply, medians and worst computed on read', () => {
  const log = createPerformanceLog();
  assert.deepEqual(log.summary().snapshots, { chars: { count: 0, median: 0, worst: 0 }, applyMs: { count: 0, median: 0, worst: 0 } });
  for (const [chars, ms] of [[1000, 2], [250000, 40.2], [3000, 4], [-1, 1], [NaN, 1], [2000, NaN]]) log.recordSnapshot(chars, ms);
  const { snapshots } = log.summary();
  assert.deepEqual(snapshots.chars, { count: 3, median: 3000, worst: 250000 });
  assert.deepEqual(snapshots.applyMs, { count: 3, median: 4, worst: 40 });
});

test('the size of a snapshot is read from the texts the diff already made, only for the keys the answer carried', () => {
  const texts = { sources: 'x'.repeat(100), decks: 'y'.repeat(20), progress: '{}' };
  assert.equal(snapshotChars(texts, { sources: [], decks: [], progress: {} }), 122, 'a whole snapshot');
  assert.equal(snapshotChars(texts, { progress: {}, partial: true }), 2, 'a partial answer is its own keys only: the rest was not sent');
  assert.equal(snapshotChars(undefined, { a: 1 }), 0);
  assert.equal(snapshotChars(texts, null), 0);
});

test('the summary holds only numbers and the ids of the app\'s own pages', () => {
  const log = createPerformanceLog();
  for (const page of PAGE_IDS) switched(log, page, 7);
  log.startSwitch('Q: what is a transaction? /home/student/notes.pdf', 1); log.endSwitch('Q: what is a transaction? /home/student/notes.pdf', 9);
  log.observeLongTasks(); log.recordLongTask(80); log.recordSnapshot(500, 3);
  const leaves = [];
  (function walk(value, path) {
    if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`); return; }
    leaves.push([path, value]);
  })(log.summary(), 'summary');
  assert.ok(leaves.length > PAGE_IDS.length);
  for (const [path, value] of leaves) {
    if (path.endsWith('.page')) assert.ok(PAGE_IDS.includes(value), `${path} = ${value}`);
    else assert.ok(Number.isSafeInteger(value) && value >= 0, `${path} = ${value}`);
  }
});

test('the log lives in memory and goes nowhere: no storage, no network, no file, in the log or in the hooks that feed it', () => {
  for (const file of ['../ui/session-performance.js', '../ui/use-session-performance.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|writeFile|appendFile|\.rpc\b|\bcall\(/, file);
  }
});

test('every way of switching page starts the clock in the one setter, the page view ends it, and a snapshot is recorded where it is applied', () => {
  const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
  const navigation = read('../ui/app/use-navigation.js');
  assert.match(navigation, /const rawSetPage = useCallback\(\(id\) => \{ markPageSwitch\(id\); setPageState\(id\); \}, \[\]\)/);
  assert.equal((navigation.match(/setPageState\(/g) ?? []).length, 1, 'the raw state setter is used in that one place only');
  assert.match(read('../ui/app/page-views.jsx'), /useSessionPerformance\(page\);/);
  const connection = read('../ui/app/use-library-connection.js');
  assert.match(connection, /sessionPerformance\.recordSnapshot\(snapshotChars\(shared\.texts, next\), performance\.now\(\) - applyStarted\)/);
  assert.match(connection, /if \(!sameExceptFingerprint\(cur, value\)\) sessionPerformance/, 'a snapshot where only the clock moved is not a change worth timing');
});
