import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_ADVANCE_MS, advanceKeyOf, autopilotPlan, keepAutopilotHold } from '../ui/review/session-logic.js';

/* The learner follows a letter in the 信箱 to a question whose 帮我弄懂 / Q&A answer is ready. That question was answered right earlier, and 自动跳下一步 is on:
   it must not take them off the question before they have read the explanation. The hold belongs to that one question; 回到第 N 题 (or any other move) ends it,
   and the switch itself is never turned off. The rule is in ui/review/session-logic.js, read by useReviewSession (the round/session model), not by the toolbar. */

const jumped = { id: 'r', index: 2, queueVersion: 0, feedback: { correct: true, grade: 4 } };
const back = { id: 'r', index: 0, queueVersion: 0, feedback: { correct: true, grade: 4 } };
const base = (run, extra = {}) => ({ autopilot: true, page: 'review', passed: true, complete: false, teaching: false, skippedKey: '', advanceKey: advanceKeyOf(run), ...extra });

test('without a hold the autopilot counts down on an answered-right question, as before', () => {
  assert.deepEqual(autopilotPlan(base(jumped)), { schedule: true, key: 'r:2:0', ms: AUTO_ADVANCE_MS });
});

test('a held question never counts down, though the switch stays on', () => {
  const hold = advanceKeyOf(jumped);
  assert.deepEqual(autopilotPlan(base(jumped, { holdKey: hold })), { schedule: false, key: '', ms: 0 });
  assert.equal(autopilotPlan(base(jumped, { holdKey: hold, autopilot: true })).schedule, false, 'the setting is read, not changed');
});

test('after 回到第 N 题 the hold is gone and the autopilot works again, on the question the learner returns to', () => {
  const hold = advanceKeyOf(jumped);
  const released = keepAutopilotHold(hold, advanceKeyOf(back));
  assert.equal(released, '', 'a different question ends the hold');
  assert.equal(autopilotPlan(base(back, { holdKey: released })).schedule, true);
});

test('the hold stays while the learner is still on the question (a new Q&A arriving, the poll, a re-render)', () => {
  const hold = advanceKeyOf(jumped);
  assert.equal(keepAutopilotHold(hold, advanceKeyOf(jumped)), hold);
  assert.equal(keepAutopilotHold('', advanceKeyOf(jumped)), '', 'no hold stays no hold');
});

test('the held question is held only once: moving on and coming back to it later counts down again', () => {
  const hold = advanceKeyOf(jumped);
  const away = keepAutopilotHold(hold, advanceKeyOf(back));
  assert.equal(keepAutopilotHold(away, advanceKeyOf(jumped)), '');
  assert.equal(autopilotPlan(base(jumped, { holdKey: keepAutopilotHold(away, advanceKeyOf(jumped)) })).schedule, true);
});
