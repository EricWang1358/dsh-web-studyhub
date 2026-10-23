/* Preloaded into each test file's own process by scripts/qa/run-tests.mjs (`--import <this file>?ms=N`), never through NODE_OPTIONS.
   A per-test time limit: a test still running after N ms is named on stderr, and its file's process ends at once, so the run fails with
   that test's name instead of holding the machine until CI's job limit.

   Why not node's own: `node --test --test-timeout` and `run({ timeout })` time each whole file when files run in their own process
   (Node 22: run() gives the limit to the file, and the file's process ignores --test-timeout because it is not started with --test).
   So the limit is set here, in the file's process, around each test (root-level beforeEach/afterEach hooks, inherited by every test and
   subtest). A hang outside a test (a hook, an import, a handle left open after the last test) is caught by the per-file limit instead. */
import { afterEach, beforeEach } from 'node:test';
import { writeSync } from 'node:fs';

/** What starts the stderr line, so the runner can find it among a file's output. */
export const TIMEOUT_MARK = 'TEST TIMEOUT';

const ms = Number(new URL(import.meta.url).searchParams.get('ms'));
// The real timers, taken before any test file's code runs: tests swap the global ones (a setTimeout that calls back at once, mock.timers
// ticked 20 minutes), and a test or subtest that starts under such a swap is still timed by the real clock.
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
// Only the test file's own process: a program a test starts may forward execArgv, but it is no *.test.mjs file.
if (ms > 0 && process.env.NODE_TEST_CONTEXT && /\.test\.[cm]?js$/.test(process.argv[1] || '')) {
  const running = new Map();
  beforeEach(t => {
    const timer = realSetTimeout(() => expire(t), ms);
    timer.unref();
    running.set(t, timer);
  });
  afterEach(t => { realClearTimeout(running.get(t)); running.delete(t); });
  function expire(over) {
    // The test whose own time ran out is the one named. A parent runs as long as its subtests, so its time can run out while a subtest
    // that started later is running: that subtest (the newest one still running inside it) is added as where it is now.
    const now = [...running.keys()].reverse().find(t => t !== over && t.fullName.startsWith(`${over.fullName} > `));
    const where = now ? ` (running now: "${now.fullName}")` : '';
    writeSync(2, `\n${TIMEOUT_MARK}: "${over.fullName}" was still running after ${ms} ms${where}; the rest of this file was not run.`
      + ' Limit per test: --test-timeout=<ms> or STUDY_TEST_TIMEOUT_MS.\n');
    process.exit(1);
  }
}
