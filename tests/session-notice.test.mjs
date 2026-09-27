import test from "node:test";
import assert from "node:assert/strict";
import { createSessionNotifier } from "../lib/session-notice.js";

test("study context notices carry a producer-owned v4 source kind", () => {
  const received = [];
  const notify = createSessionNotifier({ inject: (message) => received.push(message) },
    (message) => ({ role: "user", ...message }), "daily-flashcard");
  notify({ text: "当前题已切换", summary: "题目状态" });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].source,
    { kind: "plugin:daily-flashcard", form: "notice", summary: "题目状态" });
  assert.equal(received[0].content[0].text, "当前题已切换");
});
