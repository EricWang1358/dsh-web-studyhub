import test from 'node:test';

/* A fixture suite for tests/test-runner-timeout.test.mjs: subtests that start while a test has swapped the global timers (as
   tests/marker-external-ui.test.mjs and mock.timers do). The per-test limit keeps using the real timers, so these pass. */
test('a subtest under a setTimeout that calls back at once', async t => {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = callback => { callback(); return 1; };
  try { await t.test('runs under the swapped setTimeout', () => {}); } finally { globalThis.setTimeout = real; }
});
test('a subtest under mock timers ticked 20 minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await t.test('ticks the mocked clock', () => { t.mock.timers.tick(20 * 60_000); });
});
