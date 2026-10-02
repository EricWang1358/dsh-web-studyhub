import test from "node:test";
import assert from "node:assert/strict";
import { pollDelay, POLL_FAST_MS } from "../ui/poll-schedule.js";

test("the panel polls quickly until the host has answered unchanged for a while", () => {
  assert.equal(pollDelay({ unchanged: 0 }), POLL_FAST_MS);
  assert.equal(pollDelay({ unchanged: 11 }), POLL_FAST_MS);
  assert.equal(pollDelay({ unchanged: 12 }), 5000);
  assert.equal(pollDelay({ unchanged: 47 }), 5000);
  assert.equal(pollDelay({ unchanged: 48 }), 10000);
  assert.equal(pollDelay({ unchanged: 5000 }), 10000, "never slower than ten seconds, so another writer's change shows within one poll");
});

test("a running job keeps the quick rhythm whatever the streak", () => {
  assert.equal(pollDelay({ unchanged: 500, running: true }), POLL_FAST_MS);
});

test("defaults are the quick rhythm", () => {
  assert.equal(pollDelay(), POLL_FAST_MS);
});
