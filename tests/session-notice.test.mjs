import test from "node:test";
import assert from "node:assert/strict";
import { createSessionNotifier } from "../lib/session-notice.js";
import { createJobNotifier } from "../lib/runtime/job-notice.js";

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

test("only the final generation receipt wakes its initiating session once", () => {
  const pending = [], turns = [];
  const notify = createSessionNotifier({ inject: message => pending.push(message),
    followup: message => turns.push(message) }, message => ({ role: 'user', ...message }), 'daily-flashcard');
  const announce = createJobNotifier(notify);
  const job = { id: 'parent', count: 10, status: 'running', stage: 'Reviewing', savedCount: 4 };
  announce(job);
  assert.equal(pending.length, 0);
  assert.equal(turns.length, 0);
  Object.assign(job, { status: 'complete', stage: 'Draft ready', draftId: 'draft', savedCount: 10 });
  announce(job); announce(job);
  assert.equal(turns.length, 1, 'an idle parent must receive a new reporting turn, not pending context');
  assert.match(turns[0].content[0].text, /10\/10/);
  assert.equal(pending.length, 0);
  notify({ summary: 'Current question', text: 'Passive panel observation' });
  assert.equal(pending.length, 1);
  assert.equal(turns.length, 1, 'panel observations must stay passive');
});

test("UI jobs without an initiating chat callback never wake a registered session", () => {
  const turns = [];
  const notify = createSessionNotifier({ inject() {}, followup: message => turns.push(message) }, message => message, 'daily-flashcard');
  createJobNotifier(undefined)({ id: 'ui', status: 'complete', count: 10 });
  assert.equal(turns.length, 0);
  createJobNotifier(notify)({ id: 'chat', status: 'failed', count: 10, stage: 'Review failed' });
  assert.equal(turns.length, 1);
});

test('rejected host delivery never escapes the background completion path', async () => {
  const notify = createSessionNotifier({ inject() {}, followup: async () => { throw new Error('session closed'); } }, message => message, 'daily-flashcard');
  assert.doesNotThrow(() => createJobNotifier(notify)({ id: 'closed', status: 'complete', count: 1 }));
  assert.doesNotThrow(() => createJobNotifier(async () => { throw new Error('transport closed'); })({ id: 'transport', status: 'failed', count: 1 }));
  await new Promise(resolve => setImmediate(resolve));
});
