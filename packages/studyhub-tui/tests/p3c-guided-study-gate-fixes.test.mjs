/**
 * PR #1504 gate-review fixes for Guided Study (`AssistantPanel` guided tab driving backend `teach.*`).
 *
 * 1. The 「请先作答原题」 refusal must not re-fire on every keystroke of the learner's answer: a new
 *    `teach.start` is sent only when the card's answer state (revealed / graded) changes.
 * 2. A `teach.answer` / `teach.skip` refused with `teaching-step-changed` (the backend moved on: an Esc-dropped
 *    reply, or the main chat advanced the session) resyncs the step via `teach.get` instead of offering a
 *    retry that can only fail again with the stale step index.
 * 3. Error classification by backend code: `teaching-no-model` (and the zh 「请先在设置里连接模型」 text) is a
 *    model error that points to Settings, not an [A] retry.
 * 4. While the answer box has the keyboard, S/X/M type text, so the hints name the keys that work there.
 *
 * Run: node --test tests/p3c-guided-study-gate-fixes.test.mjs
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [aiDialogue, { AssistantPanel, _resetAssistantSessionMemory }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/host/ai-dialogue.ts'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/state/store.ts'),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mountPanel(host, { isActive = true, rows = 40 } = {}) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  const stdout = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns: 104, rows, getColorDepth: () => 1 });
  let lastFrame = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) lastFrame = plain;
  });
  const element = (active) =>
    React.createElement(
      Box,
      { width: 104, height: rows },
      React.createElement(AssistantPanel, { host, width: 100, height: rows, isActive: active, onClose: () => {} }),
    );
  const inst = render(element(isActive), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  return {
    write: (data) => stdin.write(data),
    frame: () => lastFrame,
    async waitFor(pred, label, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred(lastFrame)) return lastFrame;
        await sleep(20);
      }
      throw new Error(`Timed out waiting for ${label}.\nLast frame:\n${lastFrame}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function baseHost(call) {
  return {
    mode: 'embedded',
    call,
    async snapshot() {
      return null;
    },
    getConfig() {
      return { effective: { ready: true, provider: 'stub', model: 'stub' } };
    },
    async close() {},
  };
}

function resetStore(cardCtx, { focused = true } = {}) {
  _resetAssistantSessionMemory();
  useTuiStore.setState({
    page: 'review',
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
    assistantOpen: true,
    assistantFocused: focused,
    assistantTab: 'guided',
    assistantStage: 'question',
    assistantFullscreen: false,
    assistantCardContext: cardCtx,
    toasts: [],
  });
}

const ANSWER_FIRST = { message: '请先作答原题，再开始引导练习。', code: 'teaching-answer-first' };
const STEP_CHANGED = { message: '引导步骤已变化，请刷新页面后继续。', code: 'teaching-step-changed' };

describe('PR #1504 Guided Study gate fixes', () => {
  test('Fix 1: the answer-first refusal is sent once per answer state, never once per keystroke', async (t) => {
    const starts = [];
    let graded = false;
    const host = baseHost(async (action, args) => {
      if (action === 'teach.start') {
        starts.push(args);
        if (!graded) return { ok: false, error: ANSWER_FIRST };
        return { ok: true, value: { id: 'ts-1', mode: args.mode, index: 0, total: 2, lesson: 'LESSON_AFTER_GRADE', check: 'C?', complete: false } };
      }
      return { ok: true, value: {} };
    });
    const ctx = (extra) => ({ runId: 'r1', deckId: 'd1', cardId: 'c1', cardIndex: 0, queueVersion: 0, revealed: false, prompt: 'Q', ...extra });
    resetStore(ctx({}), { focused: false });
    const h = mountPanel(host, { isActive: false });
    t.after(() => h.cleanup());

    await h.waitFor((s) => s.includes('请先在刷题页完成本题作答'), 'first refusal');
    assert.equal(starts.length, 1, 'opening Guided Study before answering sends one teach.start');

    // The learner types an open answer in Review: ReviewView re-syncs userAnswer on every keystroke.
    for (const ua of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      useTuiStore.getState().setAssistantCardContext(ctx({ userAnswer: ua }));
      await sleep(60);
    }
    assert.equal(starts.length, 1, `typing must not resend teach.start (sent ${starts.length})`);
    const refusals = (h.frame().match(/请先在刷题页完成本题作答/g) || []).length;
    assert.equal(refusals, 1, `exactly one refusal turn is shown, got ${refusals}`);

    // Revealing without a grade changes the answer state: one more try (the backend still refuses).
    useTuiStore.getState().setAssistantCardContext(ctx({ userAnswer: 'abcde', revealed: true }));
    await h.waitFor(() => starts.length === 2, 'retry after reveal');
    await sleep(80);
    assert.equal(starts.length, 2, 'reveal sends exactly one more teach.start');

    // Grading gives the card feedback: one more try, which now succeeds.
    graded = true;
    useTuiStore.getState().setAssistantCardContext(ctx({ userAnswer: 'abcde', revealed: true, answered: true }));
    await h.waitFor((s) => s.includes('LESSON_AFTER_GRADE'), 'lesson after grading');
    assert.equal(starts.length, 3, 'grading sends exactly one more teach.start');
  });

  test('Fix 1b: a failed start (service busy) is not resent by keystrokes either; [A] stays the retry', async (t) => {
    let starts = 0;
    const host = baseHost(async (action) => {
      if (action === 'teach.start') {
        starts += 1;
        return { ok: false, error: { message: '临时服务繁忙，请稍后重试' } };
      }
      return { ok: true, value: {} };
    });
    const ctx = (extra) => ({ runId: 'r2', deckId: 'd2', cardId: 'c2', cardIndex: 0, queueVersion: 0, revealed: true, answered: true, prompt: 'Q', ...extra });
    resetStore(ctx({}), { focused: false });
    const h = mountPanel(host, { isActive: false });
    t.after(() => h.cleanup());
    await h.waitFor((s) => s.includes('临时服务繁忙'), 'start failure');
    for (const ua of ['x', 'xy', 'xyz']) {
      useTuiStore.getState().setAssistantCardContext(ctx({ userAnswer: ua }));
      await sleep(60);
    }
    assert.equal(starts, 1, `a failed start is not resent on re-render (sent ${starts})`);
  });

  test('Fix 2: an answer refused with teaching-step-changed resyncs the step from teach.get; the next answer uses the backend step', async (t) => {
    let idx = 0;
    let release;
    const calls = [];
    const view = () => ({ id: 'ts', mode: 'understanding', index: idx, total: 3, lesson: `LESSON_${idx}`, check: `CHECK_${idx}?`, complete: false });
    const host = baseHost(async (action, a = {}) => {
      calls.push({ action, stepIndex: a.stepIndex });
      if (action === 'teach.start') return { ok: true, value: view() };
      if (action === 'teach.get') return { ok: true, value: view() };
      if (action === 'teach.answer') {
        if (a.stepIndex !== idx) return { ok: false, error: STEP_CHANGED };
        idx += 1;
        if (calls.filter((c) => c.action === 'teach.answer').length === 1) await new Promise((r) => (release = r));
        return { ok: true, value: view() };
      }
      return { ok: true, value: {} };
    });
    resetStore({ runId: 'r', deckId: 'd', cardId: 'c1', cardIndex: 0, queueVersion: 0, revealed: true, answered: true, userAnswer: 'x', prompt: 'Q' });
    const h = mountPanel(host);
    t.after(() => h.cleanup());
    await h.waitFor((s) => s.includes('CHECK_0?'), 'step 1 loaded');

    // Answer step 1, then Esc while the reply is in flight: the backend advances, the TUI drops the reply.
    h.write('first');
    await sleep(50);
    h.write('\r');
    await h.waitFor(() => typeof release === 'function', 'first answer in flight');
    h.write('\x1b');
    await sleep(60);
    release();
    await sleep(120);
    assert.equal(idx, 1, 'backend advanced to step 2 behind the dropped reply');

    // The next answer still carries the old step index; the backend refuses it with teaching-step-changed.
    h.write('i');
    await sleep(40);
    h.write('second');
    await sleep(40);
    h.write('\r');
    await h.waitFor((s) => s.includes('CHECK_1?'), 'step resynced from teach.get');
    assert.ok(calls.some((c) => c.action === 'teach.get'), 'a stale step is resynced with teach.get');
    assert.ok(!h.frame().includes('引导步骤已变化'), `the step-changed error is not shown:\n${h.frame()}`);

    // The learner's next answer goes to the backend's current step.
    calls.length = 0;
    h.write('third');
    await sleep(40);
    h.write('\r');
    await h.waitFor(() => calls.some((c) => c.action === 'teach.answer'), 'third answer sent');
    const third = calls.find((c) => c.action === 'teach.answer');
    assert.equal(third.stepIndex, 1, 'the answer after a resync uses the backend step index');
    await sleep(80);
    assert.ok(!h.frame().includes('引导步骤已变化'), 'no step-changed error after the resync');
  });

  test('Fix 5: teach errors are classified by backend code; the zh no-model text points to Settings', async () => {
    assert.equal(aiDialogue.isModelUnavailableError('请先在设置里连接模型，再使用引导练习。'), true, 'zh no-model text is a model error');
    assert.equal(aiDialogue.isModelUnavailableError('请先在设置里连接模型，再检查讲解内容。'), true, 'zh retell no-model text is a model error');

    const failing = (error) => baseHost(async () => ({ ok: false, error }));
    const started = await aiDialogue.loadTeachSession(failing({ message: 'whatever', code: 'teaching-no-model' }), {
      runId: 'r', cardId: 'c', index: 0, language: 'zh',
    });
    assert.equal(started.ok, false);
    assert.equal(started.isModelError, true, 'teaching-no-model code marks a model error');

    const refused = await aiDialogue.loadTeachSession(failing({ message: 'whatever', code: 'teaching-answer-first' }), {
      runId: 'r', cardId: 'c', index: 0, language: 'en',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.needsAnswerFirst, true, 'teaching-answer-first code is recognised whatever the text');

    const answered = await aiDialogue.submitTeachAnswer(failing({ message: '请先在设置里连接模型，再使用引导练习。', code: 'teaching-no-model' }), {
      id: 't', answer: 'a', stepIndex: 0, language: 'zh',
    });
    assert.equal(answered.ok, false);
    assert.equal(answered.isModelError, true);
    assert.equal(answered.stale, false);

    const stale = await aiDialogue.submitTeachAnswer(failing(STEP_CHANGED), { id: 't', answer: 'a', stepIndex: 0, language: 'zh' });
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, true, 'teaching-step-changed marks the local step as stale');
    const staleSkip = await aiDialogue.skipTeachStep(failing(STEP_CHANGED), { id: 't', stepIndex: 0, language: 'zh' });
    assert.equal(staleSkip.ok, false);
    assert.equal(staleSkip.stale, true);
  });

  test('Fix 6: while the answer box has the keyboard the hints name Ctrl+N and Esc, not bare S/X/M', async (t) => {
    let tries = 0;
    const host = baseHost(async (action) => {
      if (action === 'teach.start') return { ok: true, value: { id: 'ts', mode: 'understanding', index: 0, total: 2, lesson: 'L0', check: 'CHECK_0?', complete: false } };
      if (action === 'teach.answer') {
        tries += 1;
        return { ok: true, value: { id: 'ts', mode: 'understanding', index: 0, total: 2, lesson: 'L0', check: 'CHECK_0?', complete: false, wrongTries: tries, feedback: `WRONG_${tries}` } };
      }
      return { ok: true, value: {} };
    });
    resetStore({ runId: 'r', deckId: 'd', cardId: 'c1', cardIndex: 0, queueVersion: 0, revealed: true, answered: true, userAnswer: 'x', prompt: 'Q' });
    const h = mountPanel(host);
    t.after(() => h.cleanup());
    await h.waitFor((s) => s.includes('CHECK_0?'), 'step loaded');
    await sleep(60);
    assert.ok(!h.frame().includes('[S/Ctrl+N]跳过 [X]全跳 [M]模式'), `strip must not advertise S/X/M while typing:\n${h.frame()}`);
    assert.match(h.frame(), /Ctrl\+N跳过/, 'strip names Ctrl+N while typing');

    for (const answer of ['w1', 'w2']) {
      h.write(answer);
      await sleep(40);
      h.write('\r');
      await sleep(120);
    }
    await h.waitFor((s) => s.includes('WRONG_2'), 'second wrong try');
    const frame = h.frame();
    assert.ok(!frame.includes('按 [S] 或 Ctrl+N 跳过单步'), `2-tries tip must not offer [S] while typing:\n${frame}`);
    assert.match(frame, /Ctrl\+N 跳过单步；/, '2-tries tip names Ctrl+N');
    assert.match(frame, /Esc/, '2-tries tip says to press Esc before [X]');
  });
});
