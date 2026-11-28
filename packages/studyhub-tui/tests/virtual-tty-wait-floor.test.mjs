// The shared `waitFor` raises every explicit timeout of 2_000 ms or more to a 20_000 ms floor (PR #1762).
// This pins that rule so a caller's `timeoutMs: 8_000` cannot silently change meaning again.
// Run: node --test tests/virtual-tty-wait-floor.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  WAIT_FOR_FLOOR_MS,
  WAIT_FOR_VERBATIM_BELOW_MS,
  effectiveWaitTimeoutMs,
} from './helpers/virtual-tty.mjs';

describe('virtual-tty waitFor deadline floor', () => {
  test('an explicit timeout of 2_000 ms or more is raised to the floor, a larger one is kept', () => {
    assert.equal(WAIT_FOR_FLOOR_MS, 20_000);
    assert.equal(effectiveWaitTimeoutMs(2_000), 20_000);
    assert.equal(effectiveWaitTimeoutMs(8_000), 20_000, 'an explicit 8_000 really waits 20_000');
    assert.equal(effectiveWaitTimeoutMs(19_999), 20_000);
    assert.equal(effectiveWaitTimeoutMs(20_000), 20_000);
    assert.equal(effectiveWaitTimeoutMs(30_000), 30_000);
  });

  test('a timeout below 2_000 ms is honored verbatim', () => {
    assert.equal(WAIT_FOR_VERBATIM_BELOW_MS, 2_000);
    assert.equal(effectiveWaitTimeoutMs(1_999), 1_999);
    assert.equal(effectiveWaitTimeoutMs(250), 250);
  });
});
