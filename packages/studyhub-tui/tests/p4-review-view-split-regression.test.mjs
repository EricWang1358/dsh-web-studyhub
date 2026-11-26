// P4 (#1354 D12): Behavioral & interaction regression suite protecting the ReviewView.tsx split.
// Exercises single/multiple choice, cloze editing + draft save + diff, open rubric grading + GradeAdjustModal + correction ack,
// flashcard reveal + FSRS rating + translation cache + focus toggle + quick flag + confirm end round,
// and ended practice-stack restore + assistant cardContext sync.
// Run: node --test tests/p4-review-view-split-regression.test.mjs
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

const [
  { ReviewView },
  reviewModel,
  { useTuiStore, DEFAULT_PREFERENCES },
  { useKeyDispatcherBridge },
] = await Promise.all([
  import('../src/views/review/ReviewView.tsx'),
  import('../src/views/review/review-view-model.ts'),
  import('../src/state/store.ts'),
  import('../src/input/hooks.ts'),
]);

function KeyBridgeRoot({ width, height, children }) {
  useKeyDispatcherBridge();
  return React.createElement(Box, { width, height }, children);
}

function createHarness(element, { cols = 116, rows = 34 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const instance = render(
    React.createElement(KeyBridgeRoot, { width: cols, height: rows }, element),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    write: (data) => stdin.write(data),
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
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetStore(overrides = {}) {
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    activeRunId: null,
    pendingReviewRun: null,
    pendingReviewRunSeq: 0,
    pendingPracticeRestore: null,
    practiceStack: [],
    snapshot: { decks: [], sources: [], settings: { practice: { selfGradeAdvance: false } } },
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true, proactiveHints: false },
    assistantOpen: false,
    assistantFocused: false,
    assistantFullscreen: false,
    assistantCardContext: null,
    inputCaptured: false,
    footerHints: [],
    toasts: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    ...overrides,
  });
}

function makeBaseHost(callImpl) {
  const calls = [];
  return {
    calls,
    host: {
      mode: 'embedded',
      snapshot: async () => null,
      call: async (name, args) => {
        calls.push({ name, args });
        return callImpl(name, args);
      },
      stream: async () => {},
      close: async () => {},
    },
  };
}

describe('P4 (#1354 D12): ReviewView Split Behavioral & Interaction Regressions', () => {
  test('1. Single/multiple choice answering, feedback progression, undo, and assistant cardContext sync', async () => {
    const card1 = {
      id: 'c-single',
      kind: 'single',
      prompt: '虚拟内存使用哪一种数据结构映射页号到页框号？',
      topic: '内存管理',
      options: [
        { id: 'opt-a', text: '页表' },
        { id: 'opt-b', text: '中断向量表' },
      ],
    };
    const card2 = {
      id: 'c-multi',
      kind: 'multiple',
      prompt: '死锁的必要条件包括哪些？',
      topic: '进程同步',
      options: [
        { id: 'm1', text: '互斥' },
        { id: 'm2', text: '循环等待' },
        { id: 'm3', text: '时间片轮转' },
      ],
    };

    const run1Initial = {
      id: 'run-choice',
      mode: 'path',
      title: '操作系统核心',
      deckId: 'd-os',
      index: 0,
      total: 2,
      answered: 0,
      queueVersion: 1,
      card: card1,
      revealed: false,
      navigation: [
        { index: 0, cardId: 'c-single', deckId: 'd-os', status: 'pending' },
        { index: 1, cardId: 'c-multi', deckId: 'd-os', status: 'pending' },
      ],
    };
    const run1Feedback = {
      ...run1Initial,
      answered: 1,
      revealed: true,
      undoable: { attemptId: 'att-1' },
      feedback: { correct: true, selected: ['opt-a'], grade: 5 },
      solution: {
        answer: '页表',
        explanation: '页表完成虚拟页号到物理页框号的映射。',
        options: [
          { id: 'opt-a', text: '页表', correct: true },
          { id: 'opt-b', text: '中断向量表', correct: false },
        ],
      },
    };
    const run2Initial = {
      ...run1Initial,
      index: 1,
      answered: 1,
      card: card2,
      revealed: false,
      feedback: null,
      solution: null,
      undoable: { attemptId: 'att-1' },
    };
    const run2Feedback = {
      ...run2Initial,
      answered: 2,
      revealed: true,
      feedback: { correct: true, selected: ['m1', 'm2'], grade: 5 },
      solution: {
        answer: '互斥、循环等待',
        explanation: '互斥与循环等待均为死锁四个必要条件之一。',
        options: [
          { id: 'm1', text: '互斥', correct: true },
          { id: 'm2', text: '循环等待', correct: true },
          { id: 'm3', text: '时间片轮转', correct: false },
        ],
      },
    };

    const { calls, host } = makeBaseHost(async (name, args) => {
      if (name === 'review.start') return { ok: true, value: run1Initial };
      if (name === 'review.answer' && args.cardId === 'c-single') return { ok: true, value: run1Feedback };
      if (name === 'review.move' && args.direction === 1) return { ok: true, value: run2Initial };
      if (name === 'review.answer' && args.cardId === 'c-multi') return { ok: true, value: run2Feedback };
      if (name === 'review.undo') return { ok: true, value: run1Initial };
      return { ok: true, value: run1Initial };
    });

    resetStore();
    const h = createHarness(React.createElement(ReviewView, { host, width: 116, height: 34, isActive: true }));
    try {
      await h.waitFor((s) => s.includes('虚拟内存使用哪一种数据结构'), 4000, 'card 1 loaded');
      await h.waitFor(() => useTuiStore.getState().assistantCardContext?.cardId === 'c-single', 2000, 'card 1 ctx');

      // Press 'a' to select & submit first option
      h.write('a');
      await h.waitFor((s) => s.includes('回答正确') && s.includes('页表完成虚拟页号'), 4000, 'card 1 feedback');
      const answerCall1 = calls.find((c) => c.name === 'review.answer' && c.args.cardId === 'c-single');
      assert.deepEqual(answerCall1?.args.selected, ['opt-a']);

      // Press Enter to move to card 2 (multiple choice)
      h.write('\r');
      await h.waitFor((s) => s.includes('死锁的必要条件包括哪些'), 4000, 'card 2 loaded');
      await h.waitFor(() => useTuiStore.getState().assistantCardContext?.cardId === 'c-multi', 2000, 'card 2 ctx');

      // Toggle option 1 and 2, then press Enter to submit
      h.write('1');
      await new Promise((r) => setTimeout(r, 30));
      h.write('2');
      await new Promise((r) => setTimeout(r, 30));
      h.write('\r');
      await h.waitFor((s) => s.includes('互斥与循环等待均为死锁'), 4000, 'card 2 feedback');
      const answerCall2 = calls.find((c) => c.name === 'review.answer' && c.args.cardId === 'c-multi');
      assert.deepEqual(answerCall2?.args.selected, ['m1', 'm2']);

      // Press 'u' to undo last rating
      h.write('u');
      await h.waitFor((s) => s.includes('虚拟内存使用哪一种数据结构') && !s.includes('回答正确'), 4000, 'undo applied');
      const undoCall = calls.find((c) => c.name === 'review.undo');
      assert.equal(undoCall?.args.attemptId, 'att-1');
    } finally {
      h.cleanup();
    }
  });

  test('2. Cloze multi-blank editing (i -> type -> Tab -> type -> Enter) submits answers and renders diff', async () => {
    const clozeRun = {
      id: 'run-cloze',
      mode: 'path',
      title: '计网填空',
      deckId: 'd-net',
      index: 0,
      total: 1,
      answered: 0,
      queueVersion: 2,
      revealed: false,
      card: {
        id: 'c-cloze',
        kind: 'fill_blank',
        prompt: 'TCP 建立连接采用 {{b1}} 次握手，释放连接采用 {{b2}} 次挥手。',
        cloze: {
          text: 'TCP 建立连接采用 {{b1}} 次握手，释放连接采用 {{b2}} 次挥手。',
          blanks: [
            { id: 'b1', answer: '3' },
            { id: 'b2', answer: '4' },
          ],
        },
      },
      navigation: [{ index: 0, cardId: 'c-cloze', deckId: 'd-net', status: 'pending' }],
    };
    const clozeFeedbackRun = {
      ...clozeRun,
      answered: 1,
      revealed: true,
      feedback: {
        correct: false,
        answers: { b1: '3', b2: '2' },
        details: [
          { id: 'b1', correct: true, expected: '3' },
          { id: 'b2', correct: false, expected: '4' },
        ],
        grade: 1,
      },
      solution: {
        answer: '3 / 4',
        cloze: {
          answers: [
            { id: 'b1', value: '3' },
            { id: 'b2', value: '4' },
          ],
        },
        explanation: '四次挥手保证全双工双方各自关闭写通道。',
      },
    };

    const { calls, host } = makeBaseHost(async (name) => {
      if (name === 'review.start') return { ok: true, value: clozeRun };
      if (name === 'review.answer') return { ok: true, value: clozeFeedbackRun };
      return { ok: true, value: {} };
    });

    resetStore();
    const h = createHarness(React.createElement(ReviewView, { host, width: 116, height: 34, isActive: true }));
    try {
      await h.waitFor((s) => s.includes('TCP 建立连接采用') && s.includes('#1'), 4000, 'cloze card loaded');

      // Enter cloze editing mode, type blank 1, Tab to blank 2, type blank 2, Enter to submit
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('3');
      await new Promise((r) => setTimeout(r, 30));
      h.write('\t');
      await new Promise((r) => setTimeout(r, 30));
      h.write('2');
      await new Promise((r) => setTimeout(r, 30));
      h.write('\r');

      await h.waitFor((s) => s.includes('回答有误') && s.includes('2 -> 4'), 4000, 'cloze diff rendered');
      const submitCall = calls.find((c) => c.name === 'review.answer');
      assert.deepEqual(submitCall?.args.answers, { b1: '3', b2: '2' });
    } finally {
      h.cleanup();
    }
  });

  test('3. Open short-answer rubric grading ([G]), GradeAdjustModal ([J]), and correction ack ([K])', async () => {
    const openRunInitial = {
      id: 'run-open',
      mode: 'path',
      title: '简答批改',
      deckId: 'd-open',
      index: 0,
      total: 1,
      answered: 0,
      queueVersion: 1,
      revealed: false,
      card: {
        id: 'c-open',
        kind: 'short_answer',
        prompt: '简述 TLB 的作用。',
      },
      draft: { text: '缓存页表项加速地址转换' },
      navigation: [{ index: 0, cardId: 'c-open', deckId: 'd-open', status: 'pending' }],
    };

    const openRunGraded = {
      ...openRunInitial,
      answered: 1,
      revealed: true,
      entry: { retry: false },
      feedback: {
        correct: false,
        grade: 2,
        gradeOriginal: 2,
        answer: '缓存页表项加速地址转换',
        correctionPending: true,
        rubric: {
          total: 3,
          max: 5,
          band: 'partial',
          criteria: [{ id: 'c1', label: '加速转换', score: 3, max: 5, suggestion: '补充局部性原理' }],
          summary: '答出了核心作用，但缺少局部性说明。',
        },
      },
      solution: { answer: '利用局部性原理缓存活跃页表项，减少访存次数。' },
    };

    const openRunAdjusted = {
      ...openRunGraded,
      feedback: {
        ...openRunGraded.feedback,
        grade: 4,
        gradeOriginal: 2,
      },
    };

    const openRunAcked = {
      ...openRunAdjusted,
      feedback: {
        ...openRunAdjusted.feedback,
        correctionPending: false,
      },
    };

    let currentRun = openRunInitial;
    const { calls, host } = makeBaseHost(async (name, args) => {
      if (name === 'review.start') return { ok: true, value: currentRun };
      if (name === 'card.grade') {
        currentRun = openRunGraded;
        return {
          ok: true,
          value: {
            grade: 2,
            total: 3,
            max: 5,
            rubric: openRunGraded.feedback.rubric,
          },
        };
      }
      if (name === 'review.get') return { ok: true, value: currentRun };
      if (name === 'review.grade.adjust') {
        assert.equal(args.grade, 4);
        currentRun = openRunAdjusted;
        return { ok: true, value: openRunAdjusted };
      }
      if (name === 'review.correction.ack') {
        currentRun = openRunAcked;
        return { ok: true, value: openRunAcked };
      }
      return { ok: true, value: currentRun };
    });

    resetStore();
    const h = createHarness(React.createElement(ReviewView, { host, width: 116, height: 34, isActive: true }));
    try {
      await h.waitFor((s) => s.includes('简述 TLB 的作用'), 4000, 'open card loaded');

      // Press 'G' to trigger AI rubric grading on restored draft
      h.write('G');
      await h.waitFor((s) => s.includes('Rubric 得分 3/5') && s.includes('待确认订正'), 4000, 'rubric graded');
      const gradeCall = calls.find((c) => c.name === 'card.grade');
      assert.equal(gradeCall?.args.answer, '缓存页表项加速地址转换');

      // Press 'J' to open GradeAdjustModal and pick '4'
      h.write('J');
      await h.waitFor((s) => s.includes('手动调整 AI 评分'), 4000, 'GradeAdjustModal opened');
      h.write('4');
      await h.waitFor((s) => s.includes('已改分 4 (AI 原评 2)'), 4000, 'grade adjusted');

      // Press 'K' to acknowledge correction
      h.write('K');
      await h.waitFor((s) => !s.includes('待确认订正'), 4000, 'correction acknowledged');
      assert.ok(calls.some((c) => c.name === 'review.correction.ack'));
    } finally {
      h.cleanup();
    }
  });

  test('4. Flashcard reveal, translation cache ([W]), focus ([*]), flag modal ([E]), FSRS grade, and end-round dialog ([X])', async () => {
    const flashInitial = {
      id: 'run-flash',
      mode: 'path',
      title: '闪卡轮次',
      deckId: 'd-flash',
      index: 0,
      total: 2,
      answered: 0,
      queueVersion: 1,
      revealed: false,
      card: { id: 'c-flash', kind: 'flashcard', prompt: '什么是写时复制？', focus: false },
      navigation: [
        { index: 0, cardId: 'c-flash', deckId: 'd-flash', status: 'pending' },
        { index: 1, cardId: 'c-flash-2', deckId: 'd-flash', status: 'pending' },
      ],
    };
    const flashRevealed = {
      ...flashInitial,
      revealed: true,
      solution: { answer: '仅在写入时才分配独立物理页。' },
    };
    const flashRated = {
      ...flashRevealed,
      answered: 1,
      feedback: { correct: true, grade: 4 },
    };
    const flashEnded = {
      ...flashRated,
      closed: true,
      summary: { answered: 1, correct: 1, total: 2 },
    };

    let translateCalls = 0;
    let current = flashInitial;
    const { calls, host } = makeBaseHost(async (name, args) => {
      if (name === 'review.start') return { ok: true, value: current };
      if (name === 'review.get') return { ok: true, value: current };
      if (name === 'card.translate') {
        translateCalls += 1;
        return { ok: true, value: { translation: { prompt: 'What is copy-on-write?', answer: 'Allocate on write.' } } };
      }
      if (name === 'card.focus') {
        current = { ...current, card: { ...current.card, focus: true } };
        return { ok: true, value: { ok: true, focus: true } };
      }
      if (name === 'card.flag') return { ok: true, value: { ok: true, args } };
      if (name === 'review.reveal') {
        current = flashRevealed;
        return { ok: true, value: flashRevealed };
      }
      if (name === 'review.answer') {
        current = flashRated;
        return { ok: true, value: flashRated };
      }
      if (name === 'review.end') {
        current = flashEnded;
        return { ok: true, value: flashEnded };
      }
      return { ok: true, value: current };
    });

    resetStore();
    const h = createHarness(React.createElement(ReviewView, { host, width: 116, height: 34, isActive: true }));
    try {
      await h.waitFor((s) => s.includes('什么是写时复制？'), 4000, 'flashcard loaded');

      // Translate twice (toggle off & back on) -> backend called only once due to LRU cache
      h.write('W');
      await h.waitFor((s) => s.includes('What is copy-on-write?'), 4000, 'translation shown');
      h.write('W');
      await h.waitFor((s) => !s.includes('What is copy-on-write?'), 4000, 'translation hidden');
      h.write('W');
      await h.waitFor((s) => s.includes('What is copy-on-write?'), 4000, 'translation restored from cache');
      assert.equal(translateCalls, 1, 'second translation toggle should reuse cache without re-calling card.translate');

      // Toggle focus (*)
      h.write('*');
      await h.waitFor((s) => s.includes('* 重点'), 4000, 'focus badge rendered');

      // Open quick flag modal (E), type reason, submit
      h.write('E');
      await h.waitFor((s) => s.includes('标记当前题目'), 4000, 'flag modal opened');
      h.write('需补充例子');
      await new Promise((r) => setTimeout(r, 30));
      h.write('\r');
      await h.waitFor((s) => !s.includes('标记当前题目'), 4000, 'flag modal closed');
      const flagCall = calls.find((c) => c.name === 'card.flag');
      assert.equal(flagCall?.args.reason, '需补充例子');

      // Reveal with Space, then rate with '4'
      h.write(' ');
      await h.waitFor((s) => s.includes('仅在写入时才分配独立物理页') && s.includes('FSRS'), 4000, 'flashcard revealed');
      h.write('4');
      await h.waitFor((s) => s.includes('回答正确'), 4000, 'flashcard rated');
      const rateCall = calls.find((c) => c.name === 'review.answer');
      assert.equal(rateCall?.args.grade, 4);

      // Press 'X' -> confirm dialog -> 'n' cancels -> 'X' again -> 'y' ends round
      h.write('X');
      await h.waitFor((s) => s.includes('结束本轮练习'), 4000, 'confirm end dialog shown');
      h.write('n');
      await h.waitFor((s) => !s.includes('结束本轮练习'), 4000, 'confirm end canceled');
      assert.equal(calls.some((c) => c.name === 'review.end'), false);

      h.write('X');
      await h.waitFor((s) => s.includes('结束本轮练习'), 4000, 'confirm end shown 2nd time');
      h.write('y');
      await h.waitFor(() => calls.some((c) => c.name === 'review.end'), 4000, 'review.end called');
    } finally {
      h.cleanup();
    }
  });

  test('5. Ended practice-stack restore prompt ([R] retries card) and [t] opens Guided Study preserving cardContext', async () => {
    const retriedRun = {
      id: 'run-retried',
      mode: 'path',
      title: '单题重练',
      deckId: 'd-retry',
      index: 0,
      total: 1,
      answered: 0,
      queueVersion: 1,
      revealed: false,
      card: { id: 'c-ended', kind: 'flashcard', prompt: '重练原题：缺页中断处理步骤' },
      navigation: [{ index: 0, cardId: 'c-ended', deckId: 'd-retry', status: 'pending' }],
    };

    const { calls, host } = makeBaseHost(async (name) => {
      if (name === 'review.get') return { ok: true, value: { id: 'run-old', closed: true } };
      if (name === 'review.start') return { ok: true, value: retriedRun };
      return { ok: true, value: retriedRun };
    });

    resetStore({
      pendingPracticeRestore: {
        kind: 'review',
        returnPage: 'review',
        runId: 'run-old',
        cardId: 'c-ended',
        deckId: 'd-retry',
        cardIndex: 2,
        promptPreview: '缺页中断处理步骤',
        originKind: 'source',
        pushedAt: Date.now(),
      },
    });

    const h = createHarness(React.createElement(ReviewView, { host, width: 116, height: 34, isActive: true }));
    try {
      await h.waitFor((s) => s.includes('原题所在练习已结束') && s.includes('第 3 题'), 4000, 'ended restore prompt');

      // Press 'R' to retry this specific card
      h.write('R');
      await h.waitFor((s) => s.includes('重练原题：缺页中断处理步骤'), 4000, 'retried card loaded');
      const startCall = calls.find((c) => c.name === 'review.start');
      assert.deepEqual(startCall?.args.scope, [{ deckId: 'd-retry', cardId: 'c-ended' }]);

      // Press 't' to open AssistantPanel in guided tab
      h.write('t');
      await new Promise((r) => setTimeout(r, 40));
      const st = useTuiStore.getState();
      assert.equal(st.assistantOpen, true);
      assert.equal(st.assistantTab, 'guided');
      assert.equal(st.assistantCardContext?.cardId, 'c-ended');
      assert.equal(st.assistantCardContext?.runId, 'run-retried');
    } finally {
      h.cleanup();
    }
  });

  test('6. review-view-model edge cases: null/finished runs, submitted stack-draft protection, choice key claims, followup dedupe', () => {
    // Inactive / finished / missing run claims zero keys and returns empty footer hints
    assert.deepEqual(
      reviewModel.buildCardClaimedKeys({
        isActive: false,
        hasRun: true,
        isFinished: false,
        isRubricEligibleKind: true,
        canAdjustGrade: true,
        canAckCorrection: true,
        kind: 'single',
      }),
      [],
    );
    assert.deepEqual(
      reviewModel.buildReviewFooterHints({
        loading: false,
        run: null,
        isFinished: false,
        revealed: false,
        feedback: null,
        kind: 'single',
        isRubricEligibleKind: false,
        needsRating: false,
        canRubricGrade: false,
        activeRubric: null,
        canAdjustGrade: false,
        canAckCorrection: false,
        canCoachNudge: false,
        canRedo: false,
        canUndo: false,
        mathUnicode: true,
        hasCitation: false,
        lang: 'zh',
      }),
      [],
    );

    // Choice cards keep a-f claimed alongside conditional G/J/K keys
    const singleKeys = reviewModel.buildCardClaimedKeys({
      isActive: true,
      hasRun: true,
      isFinished: false,
      isRubricEligibleKind: false,
      canAdjustGrade: true,
      canAckCorrection: true,
      kind: 'single',
    });
    assert.ok(singleKeys.includes('b') && singleKeys.includes('c') && singleKeys.includes('J') && singleKeys.includes('K'));
    assert.equal(singleKeys.includes('G'), false);

    // Practice-stack restore ignores draft when card was already submitted or run already has feedback
    const submittedRestore = reviewModel.resolveInitialCardDraft({
      run: { id: 'r1', index: 0, card: { id: 'c1', kind: 'short_answer', prompt: 'q' }, feedback: { correct: true } },
      stackRestore: {
        cardId: 'c1',
        submitted: true,
        draft: { openDraft: 'stale unsaved text', selected: ['opt-1'] },
      },
    });
    assert.equal(submittedRestore.consumedStackRestore, true);
    assert.equal(submittedRestore.openDraft, '');
    assert.deepEqual(submittedRestore.selected, []);

    // Unsubmitted practice-stack restore overlays persisted run draft for the matching card
    const activeRestore = reviewModel.resolveInitialCardDraft({
      run: {
        id: 'r2',
        index: 0,
        card: {
          id: 'c2',
          kind: 'fill_blank',
          prompt: '{{b1}} / {{b2}}',
          cloze: { text: '{{b1}} / {{b2}}', blanks: [{ id: 'b1' }, { id: 'b2' }] },
        },
        draft: { stepInputs: { b1: 'persisted-1' } },
      },
      stackRestore: {
        cardId: 'c2',
        submitted: false,
        draft: { clozeDrafts: ['', 'restored-2'] },
      },
    });
    assert.equal(activeRestore.consumedStackRestore, true);
    assert.deepEqual(activeRestore.clozeInputs, { b1: 'persisted-1', b2: 'restored-2' });

    // countSavedFollowups deduplicates extra saved items by id and question
    const count = reviewModel.countSavedFollowups(
      {
        id: 'r3',
        solution: {
          followups: [
            { id: 'f1', question: 'Q1', answer: 'A1' },
            { id: 'f2', question: 'Q2', answer: 'A2' },
          ],
        },
      },
      [
        { id: 'f1', question: 'Q1-renamed', answer: 'A1' },
        { id: 'f-new-same-q', question: 'Q2', answer: 'A2' },
        { id: 'f3', question: 'Q3', answer: 'A3' },
      ],
    );
    assert.equal(count, 3);
  });
});
