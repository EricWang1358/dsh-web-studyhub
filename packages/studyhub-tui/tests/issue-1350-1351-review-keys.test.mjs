// Regression tests for #1350 (choice letters b/c leaking to board/course picker)
// and #1351 (all digit keys 0-9 claimed inside ReviewView so digits never cause accidental page jumps).
// node --test tests/issue-1350-1351-review-keys.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ AppShell }, { ReviewView }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

function makeReviewHarness(cards) {
  let idx = 0;
  const submitted = [];
  const makeRun = (i) => {
    const c = cards[i];
    if (!c) {
      return {
        id: 'run-1350',
        deckId: 'd-1',
        mode: 'quiz',
        index: i,
        total: cards.length,
        done: true,
        card: null,
        revealed: false,
        feedback: null,
        selected: null,
      };
    }
    return {
      id: 'run-1350',
      deckId: 'd-1',
      mode: 'quiz',
      index: i,
      total: cards.length,
      done: false,
      card: c,
      revealed: Boolean(c._revealed),
      feedback: c._feedback ?? null,
      selected: c._selected ?? null,
      position: { at: i + 1, total: cards.length },
    };
  };

  const snapshot = {
    root: '/tmp/test-1350',
    decks: [{ id: 'd-1', title: '测试题组', course: '计算机基础', cards }],
    courses: [{ id: 'course-1', name: '计算机基础' }],
    today: { due: cards.length, new: 0, weak: 0, done: 0 },
    progress: { 'd-1': { total: cards.length, due: cards.length, mastered: 0, learning: 0, new: 0, weak: 0 } },
    inbox: [],
  };

  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name, args) => {
      if (name === 'review.start' || name === 'review.get') {
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.reveal') {
        cards[idx]._revealed = true;
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.answer') {
        submitted.push({ cardId: args.cardId, selected: args.selected, grade: args.grade });
        cards[idx]._revealed = true;
        cards[idx]._selected = args.selected ?? null;
        cards[idx]._feedback = { correct: true, grade: args.grade ?? 4 };
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.move') {
        idx = Math.max(0, Math.min(cards.length - 1, idx + (args.delta ?? 1)));
        return { ok: true, value: makeRun(idx) };
      }
      if (name === 'review.draft.save') return { ok: true, value: { ok: true } };
      return { ok: true, value: {} };
    },
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'review',
    activeRunId: 'run-1350',
    navContext: { runId: 'run-1350' },
    coursePickerOpen: false,
    commandPaletteOpen: false,
    helpOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    assistantOpen: false,
    assistantFocused: false,
    showLaunchpad: false,
    inputCaptured: false,
    practiceStack: [],
    toasts: [],
  });

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 36;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const renderPage = (page, viewProps) => {
    if (page === 'review') return React.createElement(ReviewView, viewProps);
    return React.createElement('ink-text', null, `PAGE:${page}`);
  };

  const inst = render(
    React.createElement(AppShell, {
      host,
      renderPage,
      onRefresh: async () => {},
      onQuit: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    submitted,
    write: (s) => stdin.write(s),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test('#1350: pressing b or c on single-choice question selects option without jumping to board or opening course picker', async (t) => {
  const cards = [
    {
      id: 'q1',
      kind: 'quiz',
      topic: '操作系统',
      prompt: '第一题：哪种调度算法不会产生饥饿？',
      options: [
        { id: 'A', text: '优先级调度' },
        { id: 'B', text: '时间片轮转' },
        { id: 'C', text: '最短作业优先' },
      ],
      answer: 'B',
    },
    {
      id: 'q2',
      kind: 'quiz',
      topic: '计算机网络',
      prompt: '第二题：TCP 三次握手第三次发送的是？',
      options: [
        { id: 'A', text: 'SYN' },
        { id: 'B', text: 'FIN' },
        { id: 'C', text: 'ACK' },
      ],
      answer: 'C',
    },
  ];
  const h = makeReviewHarness(cards);
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('第一题') && s.includes('时间片轮转'), 4000, 'q1 visible');
  await new Promise((r) => setTimeout(r, 50));

  // Press 'b' -> must select option B and STAY on 'review' (NOT jump to 'board')
  h.write('b');
  await h.waitFor(() => h.submitted.length === 1, 3000, 'q1 submitted');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(h.submitted[0].selected, ['B']);
  assert.equal(useTuiStore.getState().page, 'review', 'pressing b on choice card must NOT jump to board');

  // After answering (feedback / explanation visible): pressing 'b' or 'c' must STILL stay on 'review'
  // and must NOT jump to board or open course picker!
  h.write('b');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(useTuiStore.getState().page, 'review', 'pressing b AFTER answering choice card must NOT jump to board');
  h.write('c');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(useTuiStore.getState().coursePickerOpen, false, 'pressing c AFTER answering choice card must NOT open course picker');
  assert.equal(useTuiStore.getState().page, 'review');

  // Advance to q2
  h.write('\r');
  await h.waitFor((s) => s.includes('第二题') && s.includes('ACK'), 4000, 'q2 visible');
  await new Promise((r) => setTimeout(r, 50));

  // Press 'c' -> must select option C and NOT open coursePickerOpen
  h.write('c');
  await h.waitFor(() => h.submitted.length === 2, 3000, 'q2 submitted');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(h.submitted[1].selected, ['C']);
  assert.equal(useTuiStore.getState().coursePickerOpen, false, 'pressing c on choice card must NOT open course picker');
  assert.equal(useTuiStore.getState().page, 'review');
});

test('#1351: digit keys 0-9 inside ReviewView never jump to other pages (before flip, during rating, or on TF cards)', async (t) => {
  const cards = [
    {
      id: 'fc1',
      kind: 'flashcard',
      topic: '数据结构',
      prompt: '红黑树的黑高性质是什么？',
      answer: '任意节点到叶子的所有简单路径包含相同数量的黑节点。',
    },
  ];
  const h = makeReviewHarness(cards);
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('红黑树的黑高性质'), 4000, 'flashcard visible');
  await new Promise((r) => setTimeout(r, 50));

  // Before flip: pressing '2' (sources) or '6' (stats) must stay on review and not submit
  h.write('2');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(useTuiStore.getState().page, 'review', 'digit 2 before flip must NOT jump to sources');
  h.write('6');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(useTuiStore.getState().page, 'review', 'digit 6 before flip must NOT jump to stats');
  assert.equal(h.submitted.length, 0);

  // Flip flashcard (Space), now rating 0-5 is active: pressing '6', '7', '8', '9' must NOT jump pages!
  h.write(' ');
  await h.waitFor((s) => s.includes('任意节点到叶子'), 3000, 'flashcard revealed');
  await new Promise((r) => setTimeout(r, 50));

  for (const d of ['6', '7', '8', '9']) {
    h.write(d);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(useTuiStore.getState().page, 'review', `digit ${d} during flashcard rating must NOT jump pages`);
  }
  assert.equal(h.submitted.length, 0, 'unmapped digits 6-9 must not submit a rating');
});
