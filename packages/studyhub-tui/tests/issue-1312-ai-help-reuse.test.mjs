// Behavior tests for #1312: AI Help Drawer explanation caching/reuse & explicit regeneration.
// node --test tests/issue-1312-ai-help-reuse.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ ReviewView }, { AiHelpDrawer }, storeMod] = await Promise.all([
  import('../src/views/review/ReviewView.tsx'),
  import('../src/views/review/AiHelpDrawer.tsx'),
  import('../src/state/store.ts'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function createInkHarness(element, { cols = 120, rows = 30 } = {}) {
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

  const frames = [];
  const waiters = new Set();
  const notify = () => {
    const latest = frames.at(-1) ?? '';
    for (const w of [...waiters]) {
      if (w.predicate(latest)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(latest);
      }
    }
  };
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      frames.push(plain);
      notify();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });

  return {
    latest: () => frames.at(-1) ?? '',
    write: (s) => stdin.write(s),
    waitFor: (predicate, timeoutMs = 1500) => {
      const cur = frames.at(-1) ?? '';
      if (predicate(cur)) return Promise.resolve(cur);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(entry);
            reject(new Error(`Timed out waiting for frame. Last frame:\n${frames.at(-1) ?? '<empty>'}`));
          }, timeoutMs),
        };
        waiters.add(entry);
      });
    },
    cleanup: () => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetStore() {
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    showLaunchpad: false,
    snapshot: { courses: [], decks: [], sources: [], jobs: [] },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
    },
  });
}

async function pollUntil(pred, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`);
}

describe('#1312 AI Help Drawer explanation reuse & explicit regeneration', () => {
  test('1. Card with no saved followups auto-explains once; closing and reopening in same round reuses history (0 extra model calls)', async () => {
    resetStore();
    let modelCalls = 0;
    const savedCalls = [];

    const mockRun = {
      id: 'run-reuse-1',
      deckId: 'deck-u1',
      title: 'OS Memory',
      index: 0,
      total: 3,
      answered: 1,
      revealed: true,
      card: {
        id: 'card-u1',
        deckId: 'deck-u1',
        kind: 'single',
        prompt: 'What is TLB?',
        options: [{ id: 'A', text: 'Translation Lookaside Buffer' }],
      },
      feedback: { correct: true, selected: ['A'] },
      solution: { answer: 'A', explanation: 'Hardware cache for page table.' },
    };

    const mockHost = {
      call: async (name, payload) => {
        if (name === 'review.start' || name === 'study.start') return { ok: true, value: mockRun };
        if (name === 'note.qa.save') {
          savedCalls.push(payload);
          return { ok: true, value: { item: { id: `fu-${savedCalls.length}` }, status: 'created', note: { id: 'n1', title: payload?.title } } };
        }
        if (name === 'card.followup.add') {
          savedCalls.push(payload);
          return { ok: true, value: { item: { id: `fu-${savedCalls.length}` } } };
        }
        if (name === 'note.qa.add') return { ok: true, value: { status: 'ok' } };
        return { ok: true, value: {} };
      },
      streamComplete: async () => {
        modelCalls += 1;
        return `EXPLANATION_V${modelCalls}`;
      },
      getSnapshot: async () => ({ courses: [], decks: [], jobs: [] }),
    };

    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 120, height: 28, isActive: true }),
      { cols: 120, rows: 28 },
    );

    try {
      await h.waitFor((s) => s.includes('What is TLB?'));
      // Open AI drawer -> triggers initial auto-explain (modelCalls = 1)
      h.write('h');
      const openFrame = await h.waitFor((s) => s.includes('EXPLANATION_V1'));
      assert.equal(modelCalls, 1, 'Unsaved card should call model once on first open');
      assert.ok(openFrame.includes('[N]') && openFrame.includes('[R]'), 'Drawer must show save & regenerate hints');

      // Save with N
      h.write('N');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(savedCalls.length, 1, 'N must save followup');

      // Close drawer with h, then verify ReviewView shows saved explanation hint
      h.write('h');
      const closedFrame = await h.waitFor((s) => s.includes('已存讲解 1 条，按 [h] 查看'));
      assert.ok(closedFrame.includes('已存讲解 1 条，按 [h] 查看'));

      // Reopen drawer -> must reuse lifted history with ZERO additional model calls!
      h.write('h');
      const reopenedFrame = await h.waitFor((s) => s.includes('EXPLANATION_V1'));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(modelCalls, 1, 'Reopening drawer in same round must NOT call model again');
      assert.ok(reopenedFrame.includes('EXPLANATION_V1'));

      // Explicit Regenerate (R) triggers a new model call without overwriting saved records
      h.write('R');
      const regenFrame = await h.waitFor((s) => s.includes('EXPLANATION_V2'));
      assert.equal(modelCalls, 2, 'Pressing R must explicitly invoke model');
      assert.equal(savedCalls.length, 1, 'Regenerate must NOT overwrite saved followup until user presses N again');
      assert.ok(regenFrame.includes('EXPLANATION_V2'));
    } finally {
      h.cleanup();
    }
  });

  test('2. Freshly mounted ReviewView / AiHelpDrawer with saved run.solution.followups reuses saved explanation with 0 model calls', async () => {
    resetStore();
    let modelCalls = 0;

    const persistedRun = {
      id: 'run-reuse-2',
      title: 'OS Memory (Next Session)',
      index: 0,
      total: 2,
      answered: 1,
      revealed: true,
      card: {
        id: 'card-persisted',
        deckId: 'deck-u1',
        kind: 'single',
        prompt: 'What is a page fault?',
        options: [{ id: 'A', text: 'Trap to OS when page not in RAM' }],
      },
      feedback: { correct: true, selected: ['A'] },
      solution: {
        answer: 'A',
        explanation: 'Handled by OS page fault handler.',
        followups: [
          {
            id: 'fu-saved-1',
            question: '为什么缺页中断后能继续执行原指令？',
            answer: 'SAVED_PERSISTED_EXPLANATION_ALPHA',
          },
          {
            id: 'fu-saved-2',
            question: '缺页和段错误有什么区别？',
            answer: 'SAVED_PERSISTED_EXPLANATION_BETA',
          },
        ],
      },
    };

    const mockHost = {
      call: async (name) => {
        if (name === 'review.start' || name === 'study.start') return { ok: true, value: persistedRun };
        return { ok: true, value: {} };
      },
      streamComplete: async () => {
        modelCalls += 1;
        return `FRESH_GEN_${modelCalls}`;
      },
      getSnapshot: async () => ({ courses: [], decks: [], jobs: [] }),
    };

    // Mount fresh ReviewView (simulating restart)
    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 120, height: 28, isActive: true }),
      { cols: 120, rows: 28 },
    );

    try {
      const reviewFrame = await h.waitFor((s) => s.includes('已存讲解 2 条，按 [h] 查看'));
      assert.ok(reviewFrame.includes('已存讲解 2 条，按 [h] 查看'));

      // Open drawer -> directly displays saved followups, 0 model calls!
      h.write('h');
      const drawerFrame = await h.waitFor((s) => s.includes('SAVED_PERSISTED_EXPLANATION_ALPHA'));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(modelCalls, 0, 'Saved followups must be shown with 0 model calls');
      assert.ok(drawerFrame.includes('已复用讲解'));

      // Explicit R calls model once and keeps previous saved content visible
      h.write('R');
      const afterRegen = await h.waitFor((s) => s.includes('FRESH_GEN_1'));
      assert.equal(modelCalls, 1, 'Explicit R calls model exactly once');
      assert.ok(afterRegen.includes('FRESH_GEN_1'));
    } finally {
      h.cleanup();
    }

    // Also verify standalone AiHelpDrawer with saved followups makes 0 calls
    const hStandalone = createInkHarness(
      React.createElement(AiHelpDrawer, {
        host: mockHost,
        run: persistedRun,
        cardId: 'card-persisted',
        kind: 'single',
        userAnswer: 'A',
        width: 56,
        height: 24,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
      }),
      { cols: 56, rows: 24 },
    );
    try {
      await hStandalone.waitFor((s) => s.includes('SAVED_PERSISTED_EXPLANATION_ALPHA'));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(modelCalls, 1, 'Standalone AiHelpDrawer with saved followups must make 0 additional model calls');
    } finally {
      hStandalone.cleanup();
    }
  });

  test('3. (#1335) Before revealing answer, saved run.followups is reused with 0 model calls and shows card hint', async () => {
    resetStore();
    let modelCalls = 0;

    const preRevealRun = {
      id: 'run-reuse-3',
      deckId: 'deck-u1',
      title: 'OS Memory (Before Reveal)',
      index: 0,
      total: 2,
      answered: 0,
      revealed: false,
      card: {
        id: 'card-pre-reveal',
        deckId: 'deck-u1',
        kind: 'single',
        prompt: 'What is thrashing?',
        options: [
          { id: 'A', text: 'Excessive paging activity' },
          { id: 'B', text: 'CPU overclocking' },
        ],
      },
      followups: [
        {
          id: 'fu-pre-1',
          question: '请先给我一点解题启发',
          answer: 'PRE_REVEAL_SAVED_HINT_XYZ',
        },
      ],
    };

    const mockHost = {
      call: async (name) => {
        if (name === 'review.start' || name === 'study.start') return { ok: true, value: preRevealRun };
        return { ok: true, value: {} };
      },
      streamComplete: async () => {
        modelCalls += 1;
        return `UNWANTED_GEN_${modelCalls}`;
      },
      getSnapshot: async () => ({ courses: [], decks: [], jobs: [] }),
    };

    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 120, height: 28, isActive: true }),
      { cols: 120, rows: 28 },
    );

    try {
      const reviewFrame = await h.waitFor((s) => s.includes('已存讲解 1 条，按 [h] 查看'));
      assert.ok(reviewFrame.includes('已存讲解 1 条，按 [h] 查看'), 'Card must show saved explanation hint before reveal');

      h.write('h');
      const drawerFrame = await h.waitFor((s) => s.includes('PRE_REVEAL_SAVED_HINT_XYZ'));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(modelCalls, 0, 'Opening AI help before reveal with run.followups must make 0 model calls');
      assert.ok(drawerFrame.includes('已复用讲解'), 'Drawer should indicate saved explanation is reused');
    } finally {
      h.cleanup();
    }
  });

  test('4. (#1336 / #1354 D7) Pressing N passes non-empty title to atomic note.qa.save and reports atomic failure if note drafting blocks save', async () => {
    resetStore();
    useTuiStore.setState({
      snapshot: { courses: [{ id: 'c1', name: '操作系统' }], decks: [{ id: 'deck-u1', title: '内存管理', course: '操作系统' }], sources: [], jobs: [] },
    });
    const noteCalls = [];
    let failNote = false;

    const mockRun = {
      id: 'run-note-title',
      deckId: 'deck-u1',
      title: '内存管理',
      index: 0,
      total: 1,
      answered: 1,
      revealed: true,
      card: { id: 'card-n1', deckId: 'deck-u1', kind: 'single', prompt: 'What is paging?', options: [{ id: 'A', text: 'Fixed frames' }] },
      feedback: { correct: true, selected: ['A'] },
      solution: { answer: 'A' },
    };

    const mockHost = {
      call: async (name, payload) => {
        if (name === 'review.start' || name === 'study.start') return { ok: true, value: mockRun };
        if (name === 'note.qa.save') {
          noteCalls.push(payload);
          if (!payload?.title || !String(payload.title).trim()) {
            return { ok: false, error: { message: '文章标题 is required' } };
          }
          if (failNote) {
            return { ok: false, error: { message: 'AI 正在起草这篇笔记' } };
          }
          return { ok: true, value: { item: { id: 'fu-n1' }, status: 'created', note: { id: 'note-1', title: payload.title } } };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async () => 'EXPLANATION_FOR_NOTE',
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };

    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 120, height: 28, isActive: true }),
      { cols: 120, rows: 28 },
    );

    try {
      await h.waitFor((s) => s.includes('What is paging?'));
      h.write('h');
      await h.waitFor((s) => s.includes('EXPLANATION_FOR_NOTE') && s.includes('已就绪'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('N');
      await pollUntil(() => noteCalls.length >= 1, 4000, 'first note.qa.save call');
      await pollUntil(
        () => useTuiStore.getState().toasts.some((toast) => String(toast.text ?? '').includes('已保存')),
        4000,
        'first save toast',
      );
      assert.equal(noteCalls.length, 1);
      assert.ok(typeof noteCalls[0].title === 'string' && noteCalls[0].title.includes('操作系统'), 'note.qa.save must receive a non-empty daily course note title');
      assert.equal(noteCalls[0].replace, true, 'note.qa.save must pass replace: true');

      // Now simulate atomic note.qa.save failing -> surfaces error cleanly without claiming partial write
      failNote = true;
      useTuiStore.setState({ toasts: [] });
      await new Promise((r) => setTimeout(r, 30));
      h.write('N');
      await pollUntil(
        () =>
          useTuiStore
            .getState()
            .toasts.some((toast) => String(toast.text ?? '').includes('AI 正在起草这篇笔记')),
        4000,
        'atomic failure toast',
      );
    } finally {
      h.cleanup();
    }
  });

  test('5. (#1337) Regenerating explanation for the same question and pressing N replaces saved answer on backend StudyService', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StudyService } = await import('../../../lib/service.js');

    const root = await mkdtemp(join(tmpdir(), 'studyhub-1337-'));
    const service = new StudyService(root, { complete: async () => '{}' });
    try {
      await service.store.update((state) => {
        state.decks.push({
          id: 'd-1337',
          title: 'OS',
          course: '操作系统',
          cards: [
            {
              id: 'c-1337',
              kind: 'quiz',
              prompt: 'What is a semaphore?',
              answer: 'Synchronization primitive',
              options: [{ id: 'A', text: 'Synchronization primitive', correct: true }],
            },
          ],
        });
      });

      resetStore();
      useTuiStore.setState({
        snapshot: { courses: [{ id: 'c1', name: '操作系统' }], decks: [{ id: 'd-1337', title: 'OS', course: '操作系统' }], sources: [], jobs: [] },
      });

      const run = await service.call('review.start', { mode: 'quiz', deckId: 'd-1337', fresh: true });
      const revealedRun = await service.call('review.answer', { runId: run.id, cardId: 'c-1337', selected: ['A'] });

      let genCount = 0;
      let followupSaveCount = 0;
      const realHost = {
        call: async (action, payload) => {
          if (action === 'review.start' || action === 'study.start') return { ok: true, value: revealedRun };
          try {
            const value = await service.call(action, payload);
            if (action === 'note.qa.save') followupSaveCount += 1;
            return { ok: true, value };
          } catch (err) {
            return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
          }
        },
        streamComplete: async () => {
          genCount += 1;
          return genCount === 1 ? 'EXPLANATION_OLD_A' : 'EXPLANATION_NEW_B';
        },
        getSnapshot: async () => useTuiStore.getState().snapshot,
      };

      const h = createInkHarness(
        React.createElement(ReviewView, { host: realHost, width: 120, height: 28, isActive: true }),
        { cols: 120, rows: 28 },
      );

      try {
        await h.waitFor((s) => s.includes('What is a semaphore?'));
        // First generation A -> press N to save and wait deterministically for backend commit
        h.write('h');
        await h.waitFor((s) => s.includes('EXPLANATION_OLD_A') && s.includes('已就绪'));
        await new Promise((r) => setTimeout(r, 40));
        h.write('N');
        await pollUntil(() => followupSaveCount >= 1, 5000, 'first card.followup.add');
        await pollUntil(() => useTuiStore.getState().toasts.length > 0, 5000, 'first save finished');

        // Regenerate B (same default question) -> press N to save again and wait deterministically
        useTuiStore.setState({ toasts: [] });
        h.write('R');
        await h.waitFor((s) => s.includes('EXPLANATION_NEW_B') && s.includes('已就绪'), 5000);
        await new Promise((r) => setTimeout(r, 40));
        h.write('N');
        await pollUntil(() => followupSaveCount >= 2, 5000, 'second card.followup.add');
        await pollUntil(() => useTuiStore.getState().toasts.length > 0, 5000, 'second save finished');
      } finally {
        h.cleanup();
      }

      // Reload from disk via a fresh review.get — must persist B, not stale A!
      const reloaded = await service.call('review.get', { runId: run.id });
      const savedAnswers = (reloaded.followups || []).map((f) => f.answer);
      assert.ok(
        savedAnswers.includes('EXPLANATION_NEW_B'),
        `Expected regenerated answer EXPLANATION_NEW_B to be persisted, got: ${JSON.stringify(savedAnswers)}`,
      );
      assert.ok(
        !savedAnswers.includes('EXPLANATION_OLD_A'),
        `Expected stale EXPLANATION_OLD_A to be replaced, got: ${JSON.stringify(savedAnswers)}`,
      );
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
