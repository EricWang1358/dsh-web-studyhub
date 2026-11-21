import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export * from './ui/review/today-pace.js';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);

const {
  COLD_START_ELAPSED_MS,
  MAX_CARD_ELAPSED_MS,
  MIN_CARD_ELAPSED_MS,
  computeTodayPace,
  formatPomodoroCount,
  formatTodayPaceLine,
  formatWallClockMinutes,
  readDailyGoal,
  writeDailyGoal,
  setUiLanguage,
} = mod.exports;

const TODAY = '2026-11-22';
const NOW = Date.parse('2026-11-22T06:00:00.000Z');
const TZ = 'UTC';

function makeAttempt({ day = TODAY, elapsed_ms = 50_000, voidedAt, implicit } = {}) {
  return {
    timestamp: `${day}T04:00:00.000Z`,
    elapsed_ms,
    ...(voidedAt ? { voidedAt } : {}),
    ...(implicit ? { implicit } : {}),
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('cold-start (0 attempts): defaults to ~30 cards / 25m and marks preliminary in ZH & EN', () => {
  const pace = computeTodayPace({
    attempts: [],
    goal: 60,
    focusMinutes: 25,
    breakMinutes: 5,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });

  assert.equal(pace.todayCount, 0);
  assert.equal(pace.medianElapsedMs, COLD_START_ELAPSED_MS);
  assert.equal(pace.cardsPerPomodoro, 30);
  assert.equal(pace.preliminary, true);
  assert.equal(pace.paceSource, 'cold-start');
  assert.equal(pace.remainingCards, 60);
  assert.equal(pace.remainingPomodoros, 2);
  assert.equal(pace.wallClockMinutes, 60);
  assert.equal(pace.goalMet, false);

  setUiLanguage('zh');
  const zh = formatTodayPaceLine(pace);
  assert.equal(zh, '今日 0 / 60 题 · 当前约 30 题/番茄（初步） · 还需约 2 个番茄（含休息约 1 小时）');

  setUiLanguage('en');
  try {
    const en = formatTodayPaceLine(pace);
    assert.equal(en, 'Today 0 / 60 questions · ~30 questions/pomodoro (preliminary) · ~2 pomodoros left (~1 h incl. breaks)');
  } finally {
    setUiLanguage('zh');
  }
});

test('<5 today attempts smoothly blend with last-7-days median', () => {
  // 2 today attempts at 30s each (weight 2/5 = 0.4), 6 prior-week attempts at 80s each (weight 3/5 = 0.6)
  // Expected blended median = 0.4 * 30_000 + 0.6 * 80_000 = 12_000 + 48_000 = 60_000 ms (1 min/card -> 25 cards/25m)
  const attempts = [
    makeAttempt({ day: TODAY, elapsed_ms: 30_000 }),
    makeAttempt({ day: TODAY, elapsed_ms: 30_000 }),
    ...Array.from({ length: 6 }, () => makeAttempt({ day: '2026-11-19', elapsed_ms: 80_000 })),
    // Attempts older than 7 days must not enter the 7-day baseline
    makeAttempt({ day: '2026-11-10', elapsed_ms: 180_000 }),
  ];

  const pace = computeTodayPace({
    attempts,
    goal: 100,
    focusMinutes: 25,
    breakMinutes: 5,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });

  assert.equal(pace.todayCount, 2);
  assert.equal(pace.paceSource, 'blended');
  assert.equal(pace.preliminary, false, 'combined today + 7-day sample count >= 5');
  assert.equal(pace.medianElapsedMs, 60_000);
  assert.equal(pace.cardsPerPomodoro, 25);
  // remaining = 98 -> 98 / 25 = 3.92 -> rounded to nearest 0.5 = 4
  assert.equal(pace.remainingPomodoros, 4);
  assert.equal(pace.wallClockMinutes, 120);

  // Without prior 7-day history, <5 today samples blends with cold-start and stays preliminary
  const thinPace = computeTodayPace({
    attempts: [makeAttempt({ day: TODAY, elapsed_ms: 30_000 })],
    goal: 30,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });
  assert.equal(thinPace.paceSource, 'blended');
  assert.equal(thinPace.preliminary, true);
  // 0.2 * 30_000 + 0.8 * 50_000 = 46_000 ms -> 25 / (46/60) = 32.6 -> 33
  assert.equal(thinPace.medianElapsedMs, 46_000);
  assert.equal(thinPace.cardsPerPomodoro, 33);
});

test('caps AFK elapsed_ms outliers at 3 min (180s), floors ultra-fast clicks, and excludes voided/implicit attempts', () => {
  const attempts = [
    // Voided and implicit must be ignored completely
    makeAttempt({ day: TODAY, elapsed_ms: 10_000, voidedAt: '2026-11-22T04:01:00.000Z' }),
    makeAttempt({ day: TODAY, elapsed_ms: 10_000, implicit: true }),
    // 5 active AFK attempts (10 min each -> capped at 180s = 3 min)
    ...Array.from({ length: 5 }, () => makeAttempt({ day: TODAY, elapsed_ms: 600_000 })),
  ];

  const afkPace = computeTodayPace({
    attempts,
    goal: 30,
    focusMinutes: 25,
    breakMinutes: 5,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });

  assert.equal(afkPace.todayCount, 5);
  assert.equal(afkPace.medianElapsedMs, MAX_CARD_ELAPSED_MS);
  assert.equal(afkPace.cardsPerPomodoro, Math.round(25 / 3)); // 8 cards/pomodoro
  assert.equal(afkPace.preliminary, false);

  // Floor check: 500ms clicks clamp to MIN_CARD_ELAPSED_MS
  const fastPace = computeTodayPace({
    attempts: Array.from({ length: 5 }, () => makeAttempt({ day: TODAY, elapsed_ms: 500 })),
    focusMinutes: 25,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });
  assert.equal(fastPace.medianElapsedMs, MIN_CARD_ELAPSED_MS);
  assert.equal(fastPace.cardsPerPomodoro, Math.round(25 / (MIN_CARD_ELAPSED_MS / 60_000)));
});

test('exact goal met and exceeded emit calm completion state with zero remaining pomodoros', () => {
  const attempts = Array.from({ length: 30 }, () => makeAttempt({ day: TODAY, elapsed_ms: 45_000 }));
  const exact = computeTodayPace({ attempts, goal: 30, now: NOW, today: TODAY, timeZone: TZ });

  assert.equal(exact.todayCount, 30);
  assert.equal(exact.remainingCards, 0);
  assert.equal(exact.remainingPomodoros, 0);
  assert.equal(exact.wallClockMinutes, 0);
  assert.equal(exact.goalMet, true);

  setUiLanguage('zh');
  assert.equal(formatTodayPaceLine(exact), '今日 30 / 30 题 · 今日目标已达成');
  setUiLanguage('en');
  try {
    assert.equal(formatTodayPaceLine(exact), 'Today 30 / 30 questions · Daily goal reached');
  } finally {
    setUiLanguage('zh');
  }

  // Exceeding the goal also stays calmly met with 0 remaining
  const exceeded = computeTodayPace({ attempts, goal: 25, now: NOW, today: TODAY, timeZone: TZ });
  assert.equal(exceeded.goalMet, true);
  assert.equal(exceeded.remainingCards, 0);
  assert.equal(exceeded.remainingPomodoros, 0);
});

test('0.5-pomodoro rounding and custom focus/break durations calculate wall-clock minutes accurately', () => {
  // 38 completed today, 53.6s/card -> ~28 cards / 25m; goal = 108 -> remaining = 70 -> 70/28 = 2.5 pomodoros
  // 2.5 * (25 + 5) = 75 min = 1 小时 15 分
  const attempts = Array.from({ length: 38 }, () => makeAttempt({ day: TODAY, elapsed_ms: 53_571 }));
  const pace = computeTodayPace({
    attempts,
    goal: 108,
    focusMinutes: 25,
    breakMinutes: 5,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });

  assert.equal(pace.cardsPerPomodoro, 28);
  assert.equal(pace.remainingPomodoros, 2.5);
  assert.equal(pace.wallClockMinutes, 75);
  assert.equal(formatPomodoroCount(2.5), '2.5');
  assert.equal(formatPomodoroCount(2), '2');

  setUiLanguage('zh');
  assert.equal(formatWallClockMinutes(75), '1 小时 15 分');
  assert.equal(
    formatTodayPaceLine(pace),
    '今日 38 / 108 题 · 当前约 28 题/番茄 · 还需约 2.5 个番茄（含休息约 1 小时 15 分）',
  );

  // Custom 45+10 durations: 45 / (53.571/60) = 50 cards/pomodoro; remaining = 70 -> 70/50 = 1.4 -> 1.5 pomodoros
  // wallClockMinutes = round(1.5 * (45 + 10)) = round(82.5) = 83 min -> 1 小时 23 分
  const custom = computeTodayPace({
    attempts,
    goal: 108,
    focusMinutes: 45,
    breakMinutes: 10,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });
  assert.equal(custom.cardsPerPomodoro, 50);
  assert.equal(custom.remainingPomodoros, 1.5);
  assert.equal(custom.wallClockMinutes, 83);
  assert.equal(formatWallClockMinutes(83), '1 小时 23 分');

  // Tiny remainder (1 card left) still rounds to minimum 0.5 pomodoro, never 0
  const almostDone = computeTodayPace({
    attempts,
    goal: 39,
    focusMinutes: 25,
    breakMinutes: 5,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });
  assert.equal(almostDone.remainingCards, 1);
  assert.equal(almostDone.remainingPomodoros, 0.5);
  assert.equal(almostDone.wallClockMinutes, 15);

  // Singular pomodoro formatting in EN (1 pomodoro)
  const onePomo = computeTodayPace({
    attempts,
    goal: 66, // remaining 28 / 28 = 1
    focusMinutes: 25,
    breakMinutes: 5,
    now: NOW,
    today: TODAY,
    timeZone: TZ,
  });
  assert.equal(onePomo.remainingPomodoros, 1);
  setUiLanguage('en');
  try {
    assert.match(formatTodayPaceLine(onePomo), /~1 pomodoro left \(~30 min incl\. breaks\)/);
  } finally {
    setUiLanguage('zh');
  }
});

test('daily goal storage persists per local date & library root, expires next day, and clears cleanly', () => {
  const storage = memoryStorage();
  assert.equal(readDailyGoal({ today: TODAY, root: '/lib-a', storage }), null);

  assert.equal(writeDailyGoal(60, { today: TODAY, root: '/lib-a', storage }), 60);
  assert.equal(readDailyGoal({ today: TODAY, root: '/lib-a', storage }), 60);
  assert.equal(readDailyGoal({ today: TODAY, root: '/lib-b', storage }), null, 'isolated per library root');
  assert.equal(readDailyGoal({ today: '2026-11-23', root: '/lib-a', storage }), null, 'expires automatically on a new local date');

  // Invalid values clear or return null
  assert.equal(writeDailyGoal(0, { today: TODAY, root: '/lib-a', storage }), null);
  assert.equal(readDailyGoal({ today: TODAY, root: '/lib-a', storage }), null);

  writeDailyGoal(100, { today: TODAY, root: '/lib-a', storage });
  assert.equal(readDailyGoal({ today: TODAY, root: '/lib-a', storage }), 100);
  writeDailyGoal(null, { today: TODAY, root: '/lib-a', storage });
  assert.equal(readDailyGoal({ today: TODAY, root: '/lib-a', storage }), null);
});
