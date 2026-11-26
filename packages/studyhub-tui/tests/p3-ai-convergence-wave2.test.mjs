// #1354 P3 AI Convergence Wave 2 — behavioral & interactive Ink runtime guardrails:
// 1) Shared Feynman Retell & Book AI evaluation/rendering core (`src/host/retell-dialogue.ts`)
// 2) `RetellModal` synchronous double-submit guard + stale-card race protection
// 3) `BookRetellModal` partial-verdict resilience + error normalization + stale-hid guard
// 4) `BookExplainModal` normalized error & model-unavailable retry guidance + stale-hid guard
// 5) D8 Typed Assistant Action Registry (`src/shell/assistant-action-registry.ts` + `assistant-intent.ts`)
//
// Zero source-grep assertions; exercises real modules and interactive Ink rendering.
// node --test tests/p3-ai-convergence-wave2.test.mjs
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { createVirtualTty, disposeTerminalPool } from './helpers/virtual-tty.mjs';

const unregisterTsx = register();
after(() => {
  try {
    disposeTerminalPool();
  } finally {
    unregisterTsx?.();
  }
});

const [
  retellDialogue,
  actionRegistry,
  intentMod,
  retellModalMod,
  bookRetellMod,
  bookExplainMod,
  storeMod,
] = await Promise.all([
  import('../src/host/retell-dialogue.ts'),
  import('../src/shell/assistant-action-registry.ts'),
  import('../src/shell/assistant-intent.ts'),
  import('../src/views/review/RetellModal.tsx'),
  import('../src/views/book/BookRetellModal.tsx'),
  import('../src/views/book/BookExplainModal.tsx'),
  import('../src/state/store.ts'),
]);

const {
  RETELL_TEXT_MAX,
  normalizeRetellVerdict,
  classifyRetellVerdict,
  retellVerdictBadge,
  formatRetellVerdictMarkdown,
  submitBookRetellEvaluation,
  submitBookExplainJob,
} = retellDialogue;

const {
  ASSISTANT_ACTION_REGISTRY,
  getAssistantActionMeta,
  formatAssistantActionLabel,
  requiresActionConfirm,
  listAssistantActions,
  validateIntentAgainstRegistry,
} = actionRegistry;

const { parseAssistantIntent } = intentMod;
const { RetellModal, RETELL_TEXT_MAX: MODAL_RETELL_MAX } = retellModalMod;
const { BookRetellModal, BOOK_RETELL_TEXT_MAX } = bookRetellMod;
const { BookExplainModal } = bookExplainMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function resetStore(lang = 'zh') {
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    snapshot: {
      courses: [{ id: 'course-os', name: '操作系统' }],
      decks: [{ id: 'deck-os', title: '操作系统', course: '操作系统', cards: [] }],
      sources: [{ id: 'src-os-1', title: 'OS Notes' }],
      jobs: [],
    },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode: false, mathUnicode: true },
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountInk(element, { columns = 100, rows = 30 } = {}) {
  const tty = createVirtualTty(columns, rows);
  const wrap = (el) => React.createElement(Box, { width: columns, height: rows }, el);
  const inst = render(wrap(element), {
    stdin: tty.stdin,
    stdout: tty.stdout,
    stderr: tty.stderr,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    tty,
    rerender: (nextEl) => inst.rerender(wrap(nextEl)),
    send: (ch) => tty.send(ch),
    frame: () => tty.readScreen(),
    waitFor: (pred, label, timeoutMs = 4000) => tty.waitFor(pred, { timeoutMs, label }),
    cleanup: () => {
      try {
        inst.unmount();
      } finally {
        tty.dispose();
      }
    },
  };
}

function makeBookItem(hid, number, title) {
  return {
    key: `bk:${hid}`,
    hid,
    number,
    title,
    depth: 1,
    leaf: true,
    node: { key: `bk:${hid}`, hid, number, title, leaf: true },
  };
}

function makeReviewRun(cardId, prompt) {
  return {
    id: `run-${cardId}`,
    deckId: 'deck-os',
    index: 0,
    total: 2,
    answered: 0,
    revealed: false,
    card: {
      id: cardId,
      deckId: 'deck-os',
      kind: 'short_answer',
      topic: '虚拟内存',
      prompt,
      citations: [{ sourceId: 'src-os-1', pageNumber: 12, title: 'OS Notes', quote: 'TLB caches page translations' }],
    },
  };
}

describe('#1354 P3 AI Wave 2 — Retell & Book AI convergence + D8 Action Registry', () => {
  test('1) retell-dialogue pure core: shared limit, safe verdict normalization, tier classification, badges & markdown', () => {
    assert.equal(MODAL_RETELL_MAX, RETELL_TEXT_MAX, 'RetellModal must share RETELL_TEXT_MAX');
    assert.equal(BOOK_RETELL_TEXT_MAX, RETELL_TEXT_MAX, 'BookRetellModal must share RETELL_TEXT_MAX');

    // Partial/malformed backend payload must normalize safely without throwing
    const partialPass = normalizeRetellVerdict({ passed: true });
    assert.deepEqual(partialPass, {
      passed: true,
      right: [],
      missed: [],
      wrong: [],
      cite: null,
      gap: 'none',
    });
    assert.equal(classifyRetellVerdict(partialPass), 'pass');

    // Contradiction (`wrong` non-empty) must classify as 'gap' even if backend sends passed=true
    const wrongVerdict = normalizeRetellVerdict({
      passed: true,
      right: ['提到页表'],
      wrong: ['把 TLB 说成了磁盘缓存'],
    });
    assert.equal(wrongVerdict.gap, 'wrong');
    assert.equal(classifyRetellVerdict(wrongVerdict), 'gap');

    // Missed items without wrong items classify as 'partial'
    const missedVerdict = normalizeRetellVerdict({
      passed: false,
      right: ['提到缺页中断'],
      missed: ['未说明页面置换策略'],
    });
    assert.equal(missedVerdict.gap, 'missed');
    assert.equal(classifyRetellVerdict(missedVerdict), 'partial');

    // Badge tones & ASCII safety across card & book surfaces
    for (const surface of ['card', 'book']) {
      for (const lang of ['zh', 'en']) {
        const passBadge = retellVerdictBadge('pass', { surface, lang, asciiMode: true });
        const partialBadge = retellVerdictBadge('partial', { surface, lang, asciiMode: true });
        const gapBadge = retellVerdictBadge('gap', { surface, lang, asciiMode: true });
        assert.equal(passBadge.tone, 'success');
        assert.equal(partialBadge.tone, 'warning');
        assert.equal(gapBadge.tone, 'error');
        assert.equal(/[✓✕▲]/.test(passBadge.label + partialBadge.label + gapBadge.label), false, 'asciiMode badges must stay ASCII');
      }
    }

    // Markdown rendering preserves 3-part book contract and card citation/hint contract
    const bookMd = formatRetellVerdictMarkdown(missedVerdict, { surface: 'book', lang: 'zh' });
    assert.match(bookMd, /### 1\. 讲对了/);
    assert.match(bookMd, /### 2\. 遗漏与需纠正/);
    assert.match(bookMd, /### 3\. 下一步提示/);
    assert.match(bookMd, /原话不会被保存/);
    assert.match(bookMd, /未说明页面置换策略/);

    const cardMd = formatRetellVerdictMarkdown(wrongVerdict, {
      surface: 'card',
      lang: 'zh',
      cardHint: 'TLB 是 CPU 内部高速相联缓存',
      targetCitation: { sourceId: 'src-os-1', title: 'OS Notes', pageNumber: 12 },
      citedQuote: 'TLB caches page translations',
    });
    assert.match(cardMd, /### 讲对了/);
    assert.match(cardMd, /### 理解偏差 \/ 需纠正/);
    assert.match(cardMd, /### 模型提示/);
    assert.match(cardMd, /TLB 是 CPU 内部高速相联缓存/);
    assert.match(cardMd, /### 原文定位/);
    assert.match(cardMd, /第 12 页/);
    assert.match(cardMd, /TLB caches page translations/);
  });

  test('2) submitBookRetellEvaluation & submitBookExplainJob normalize errors and classify model-unavailable', async () => {
    const calls = [];
    const host = {
      call: async (action, args) => {
        calls.push({ action, args });
        if (action === 'book.retell' && args.hid === 'h-partial') {
          return { ok: true, value: { passed: true, record: { tries: 1, passes: 1 } } };
        }
        if (action === 'book.retell' && args.hid === 'h-unknown-err') {
          return { ok: false, error: { code: 'ERR', message: 'Unknown error' } };
        }
        if (action === 'book.retell' && args.hid === 'h-401') {
          return { ok: false, error: { code: 'AUTH', message: '401 Unauthorized: API key missing' } };
        }
        if (action === 'generation.courseBook.explain' && args.heading === 'h-ok') {
          return { ok: true, value: { jobId: 'job-explain-1', status: 'queued' } };
        }
        if (action === 'generation.courseBook.explain' && args.heading === 'h-timeout') {
          return { ok: false, error: { code: 'TIMEOUT', message: 'Request timed out' } };
        }
        return { ok: false, error: { code: 'BAD', message: 'Unknown error' } };
      },
    };

    const okRetell = await submitBookRetellEvaluation(host, {
      course: '操作系统',
      hid: 'h-partial',
      text: '页表映射虚拟地址到物理地址',
      language: 'zh',
    });
    assert.equal(okRetell.ok, true);
    assert.deepEqual(okRetell.verdict.right, []);
    assert.deepEqual(okRetell.verdict.wrong, []);
    assert.equal(okRetell.verdict.gap, 'none');

    const unknownRetell = await submitBookRetellEvaluation(host, {
      course: '操作系统',
      hid: 'h-unknown-err',
      text: 'test',
      language: 'zh',
    });
    assert.equal(unknownRetell.ok, false);
    assert.notEqual(unknownRetell.error, 'Unknown error', 'Must normalize Unknown error via describeAiDialogueError');
    assert.match(unknownRetell.error, /模型设置|重试/);

    const authRetell = await submitBookRetellEvaluation(host, {
      hid: 'h-401',
      text: 'test',
      language: 'en',
    });
    assert.equal(authRetell.ok, false);
    assert.equal(authRetell.isModelError, true);

    const okExplain = await submitBookExplainJob(host, {
      course: '操作系统',
      heading: 'h-ok',
      mode: 'here',
      instruction: '加一个 TLB 例子',
      language: 'zh',
    });
    assert.equal(okExplain.ok, true);
    assert.equal(okExplain.value.jobId, 'job-explain-1');

    const timeoutExplain = await submitBookExplainJob(host, {
      course: '操作系统',
      heading: 'h-timeout',
      mode: 'explain',
      words: 'TLB',
      language: 'zh',
    });
    assert.equal(timeoutExplain.ok, false);
    assert.equal(timeoutExplain.isModelError, true);

    const unknownExplain = await submitBookExplainJob(host, {
      course: '操作系统',
      heading: 'h-other',
      mode: 'here',
      instruction: 'x',
      language: 'zh',
    });
    assert.equal(unknownExplain.ok, false);
    assert.notEqual(unknownExplain.error, 'Unknown error');
  });

  test('3) RetellModal runtime: synchronous double-submit guard & stale card switch isolation', async (t) => {
    resetStore('zh');
    const deferred1 = createDeferred();
    let retellCalls = 0;
    const host = {
      call: async (action) => {
        if (action === 'card.get') return { ok: true, value: { card: { citations: [], hint: '' } } };
        if (action === 'teach.retell') {
          retellCalls += 1;
          return deferred1.promise;
        }
        return { ok: true, value: {} };
      },
      subscribeEvents: () => () => {},
    };

    const runA = makeReviewRun('card-a', '解释什么是 TLB？');
    const runB = makeReviewRun('card-b', '解释什么是缺页中断？');
    const mounted = mountInk(
      React.createElement(RetellModal, {
        host,
        run: runA,
        cardId: 'card-a',
        kind: 'short_answer',
        width: 96,
        height: 28,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
        onNavigateToSource: () => {},
      }),
    );
    t.after(() => mounted.cleanup());

    await mounted.waitFor((s) => s.includes('用自己的话讲一遍') && s.includes('解释什么是 TLB'), 'RetellModal mounted');

    // Type explanation and press Ctrl+S twice in back-to-back ticks before async submit settles
    mounted.send('TLB 是快表缓存');
    await mounted.waitFor((s) => s.includes('9/4000'), 'draft entered');
    mounted.send('\x13');
    await new Promise((r) => setImmediate(r));
    mounted.send('\x13');

    await mounted.waitFor((s) => s.includes('正在评估你的费曼复述'), 'submitting state visible');
    assert.equal(retellCalls, 1, 'Synchronous double Enter must trigger exactly 1 teach.retell call');

    // Switch to card-b while card-a request is still in-flight
    mounted.rerender(
      React.createElement(RetellModal, {
        host,
        run: runB,
        cardId: 'card-b',
        kind: 'short_answer',
        width: 96,
        height: 28,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
        onNavigateToSource: () => {},
      }),
    );
    await mounted.waitFor((s) => s.includes('解释什么是缺页中断') && s.includes('0/4000'), 'switched to card-b');

    // Now resolve stale card-a verdict -> must NOT overwrite card-b editing screen
    deferred1.resolve({
      ok: true,
      value: {
        passed: true,
        right: ['STALE_CARD_A_VERDICT_SHOULD_NOT_APPEAR'],
        missed: [],
        wrong: [],
        cite: null,
        gap: 'none',
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    const afterStale = mounted.frame();
    assert.equal(afterStale.includes('STALE_CARD_A_VERDICT_SHOULD_NOT_APPEAR'), false, 'Stale card-a verdict must be ignored');
    assert.ok(afterStale.includes('0/4000'), 'card-b must remain clean in editing state');
  });

  test('4) BookRetellModal runtime: partial verdict safe render, normalized Unknown error + retry, stale hid guard', async (t) => {
    resetStore('zh');
    const deferredStale = createDeferred();
    let mode = 'unknown-error';
    let calls = 0;
    const host = {
      call: async (action) => {
        if (action !== 'book.retell') return { ok: true, value: {} };
        calls += 1;
        if (mode === 'unknown-error') {
          return { ok: false, error: { code: 'ERR', message: 'Unknown error' } };
        }
        if (mode === 'partial-verdict') {
          // Intentionally omit right/missed/wrong/gap to verify normalization prevents crash
          return { ok: true, value: { passed: true, record: { tries: 2, passes: 1 } } };
        }
        return deferredStale.promise;
      },
      subscribeEvents: () => () => {},
    };

    const itemA = makeBookItem('h1', '1.1', '虚拟内存');
    const itemB = makeBookItem('h2', '1.2', '页面置换');
    const mounted = mountInk(
      React.createElement(BookRetellModal, {
        host,
        course: '操作系统',
        selectedItem: itemA,
        isActive: true,
        width: 96,
        height: 28,
        mathUnicode: true,
        onClose: () => {},
      }),
    );
    t.after(() => mounted.cleanup());

    await mounted.waitFor((s) => s.includes('1.1 虚拟内存') && s.includes('0/4000'), 'BookRetellModal mounted');

    // Type & confirm -> receives 'Unknown error' -> must show friendly localized error, NOT raw 'Unknown error'
    mounted.send('虚拟内存通过页表实现地址映射');
    await mounted.waitFor((s) => s.includes('14/4000'), 'book retell draft entered');
    mounted.send('\r');
    await mounted.waitFor((s) => s.includes('确认提交费曼复述评估'), 'confirm dialog open');
    mounted.send('y');

    const errFrame = await mounted.waitFor((s) => s.includes('评估暂不可用'), 'error frame visible');
    assert.equal(errFrame.includes('Unknown error'), false, 'BookRetellModal must not leak raw Unknown error');
    assert.equal(calls, 1);

    // Retry via [r] -> ConfirmDialog -> receives partial verdict -> must render pass verdict cleanly without crashing
    mode = 'partial-verdict';
    mounted.send('r');
    await mounted.waitFor((s) => s.includes('确认提交费曼复述评估'), 'retry confirm dialog open');
    mounted.send('y');

    const verdictFrame = await mounted.waitFor(
      (s) => s.includes('讲清楚过') && s.includes('1. 讲对了'),
      'partial verdict rendered safely',
    );
    assert.ok(verdictFrame.includes('讲清楚过'));
    assert.equal(calls, 2);

    // Start a slow request on h1, switch to h2 mid-flight -> stale completion must not hijack h2 or leave it busy
    mode = 'deferred';
    mounted.send('i');
    await mounted.waitFor((s) => s.includes('14/4000'), 'back to editing');
    mounted.send('\r');
    await mounted.waitFor((s) => s.includes('确认提交费曼复述评估'), 'confirm slow request');
    mounted.send('y');
    await mounted.waitFor((s) => s.includes('正在评估你的费曼复述'), 'slow request submitting');

    mounted.rerender(
      React.createElement(BookRetellModal, {
        host,
        course: '操作系统',
        selectedItem: itemB,
        isActive: true,
        width: 96,
        height: 28,
        mathUnicode: true,
        onClose: () => {},
      }),
    );
    await mounted.waitFor((s) => s.includes('1.2 页面置换') && s.includes('0/4000'), 'switched to h2');

    deferredStale.resolve({
      ok: true,
      value: { passed: true, right: ['STALE_H1_RESULT'], missed: [], wrong: [], gap: 'none' },
    });
    await new Promise((r) => setTimeout(r, 60));
    const h2Frame = mounted.frame();
    assert.equal(h2Frame.includes('STALE_H1_RESULT'), false, 'Stale h1 verdict must not pollute h2');
    assert.ok(h2Frame.includes('1.2 页面置换'));
  });

  test('5) BookExplainModal runtime: normalized error + model settings guidance + stale hid guard', async (t) => {
    resetStore('zh');
    const deferredStale = createDeferred();
    let mode = 'auth-error';
    let startedCount = 0;
    let closeCount = 0;
    const host = {
      call: async (action) => {
        if (action !== 'generation.courseBook.explain') return { ok: true, value: {} };
        if (mode === 'auth-error') {
          return { ok: false, error: { code: 'AUTH', message: '401 Unauthorized: API key invalid' } };
        }
        return deferredStale.promise;
      },
      subscribeEvents: () => () => {},
    };

    const itemA = makeBookItem('h1', '1.1', '虚拟内存');
    const itemB = makeBookItem('h2', '1.2', '页面置换');
    const mounted = mountInk(
      React.createElement(BookExplainModal, {
        host,
        course: '操作系统',
        selectedItem: itemA,
        isActive: true,
        width: 96,
        height: 28,
        onClose: () => {
          closeCount += 1;
        },
        onStarted: () => {
          startedCount += 1;
        },
      }),
    );
    t.after(() => mounted.cleanup());

    await mounted.waitFor((s) => s.includes('AI 补充复习全书讲解') && s.includes('1.1 虚拟内存'), 'BookExplainModal mounted');
    mounted.send('补充一个 TLB 命中例子');
    await mounted.waitFor((s) => s.includes('13/600'), 'instruction typed');
    mounted.send('\r');
    await mounted.waitFor((s) => s.includes('将发起 1 次 AI 模型调用'), 'explain confirm open');
    mounted.send('y');

    const errFrame = await mounted.waitFor(
      (s) => s.includes('401') && s.includes('[,]'),
      'auth error with model settings hint rendered',
    );
    assert.ok(errFrame.includes('[,]'), 'Model-unavailable error must guide learner to [,] settings');
    assert.equal(startedCount, 0);
    assert.equal(closeCount, 0);

    // Start slow explain on h1, switch to h2 mid-flight -> stale resolution must NOT trigger onStarted/onClose
    mode = 'deferred';
    mounted.send('\r');
    await mounted.waitFor((s) => s.includes('将发起 1 次 AI 模型调用'), 're-confirm slow explain');
    mounted.send('y');
    await mounted.waitFor((s) => s.includes('正在启动 AI 讲解任务'), 'slow explain submitting');

    mounted.rerender(
      React.createElement(BookExplainModal, {
        host,
        course: '操作系统',
        selectedItem: itemB,
        isActive: true,
        width: 96,
        height: 28,
        onClose: () => {
          closeCount += 1;
        },
        onStarted: () => {
          startedCount += 1;
        },
      }),
    );
    await mounted.waitFor((s) => s.includes('1.2 页面置换'), 'switched to h2 in BookExplainModal');

    deferredStale.resolve({ ok: true, value: { jobId: 'stale-job-1', status: 'queued' } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(startedCount, 0, 'Stale explain completion must not invoke onStarted after hid change');
    assert.equal(closeCount, 0, 'Stale explain completion must not invoke onClose after hid change');
  });

  test('6) D8 Typed Assistant Action Registry: effect levels, learner labels, confirm invariant & parseAssistantIntent parity', () => {
    const ctx = {
      lang: 'zh',
      currentCardId: 'card-1',
      currentDeckId: 'deck-1',
      card: {
        cardId: 'card-1',
        deckId: 'deck-1',
        runId: 'run-1',
        cardIndex: 0,
        prompt: '什么是虚拟内存？',
        topic: '虚拟内存',
      },
      snapshot: {
        focus: { course: '操作系统' },
        sources: [{ id: 'src-1', title: 'OS Notes' }],
      },
    };

    // Representative write/destructive commands must all map to registered write/destructive actions with requiresConfirm=true
    const writeCommands = [
      '把这题加入错题本并标记为粗心',
      '导出本课错题 Markdown',
      '讲解新增通俗讲解',
      '出前置题：页表',
      '这题答案有问题，帮我修一下',
      '把刚才的讲解存到笔记',
      '标记这道题有问题',
      '把这道题改判为4分',
      '确认订正',
      '练错题变式',
      '把所有错题重练',
      '斩掉这道题',
      '暂停这道题',
      '标记为考纲重点',
      '撤销上一题评分',
      '提取本题核心术语',
      '翻译这道题',
    ];

    for (const cmd of writeCommands) {
      const intent = parseAssistantIntent(cmd, ctx);
      assert.ok(
        intent.kind === 'write_confirm' || intent.kind === 'generate_plain_explain',
        `Expected write confirm intent for "${cmd}", got ${intent.kind}`,
      );
      assert.equal(intent.requiresConfirm, true, `Write command "${cmd}" must require confirmation`);
      assert.equal(requiresActionConfirm(intent.actionName), true, `Registry must require confirm for ${intent.actionName}`);
      const meta = getAssistantActionMeta(intent.actionName);
      assert.ok(meta, `Action ${intent.actionName} must exist in ASSISTANT_ACTION_REGISTRY`);
      assert.ok(meta.effect === 'write' || meta.effect === 'destructive', `Action ${intent.actionName} must be write/destructive`);
      assert.ok(meta.label.zh.length > 0 && meta.label.en.length > 0, `Action ${intent.actionName} must have bilingual labels`);
      assert.equal(/^[a-z]+\.[a-z.]+$/.test(meta.label.zh), false, `Learner label must not be raw action id: ${meta.label.zh}`);
      const validation = validateIntentAgainstRegistry(intent);
      assert.equal(validation.ok, true, `Intent validation failed for "${cmd}": ${validation.reason ?? ''}`);
    }

    // Representative read-only commands must all map to readonly registry entries with requiresConfirm=false
    const readCommands = [
      '查看统计',
      '找同类题',
      '跳过这道题',
      '把这道题挪到最后',
      '把这道题讲清楚一点',
      '这题判对了吗',
      '打开错题本',
      '切换到护眼模式',
      '进入带学',
      '什么是虚拟内存？',
    ];

    for (const cmd of readCommands) {
      const intent = parseAssistantIntent(cmd, ctx);
      assert.equal(intent.requiresConfirm, false, `Readonly command "${cmd}" must not require confirm`);
      const validation = validateIntentAgainstRegistry(intent);
      assert.equal(validation.ok, true, `Readonly intent validation failed for "${cmd}": ${validation.reason ?? ''}`);
    }

    // Registry invariant: EVERY write/destructive entry must enforce requiresConfirm=true
    const writeEntries = listAssistantActions({ effect: 'write' });
    const destructiveEntries = listAssistantActions({ effect: 'destructive' });
    assert.ok(writeEntries.length >= 14, `Expected >=14 write entries, got ${writeEntries.length}`);
    assert.ok(destructiveEntries.length >= 1, `Expected >=1 destructive entry, got ${destructiveEntries.length}`);
    for (const entry of [...writeEntries, ...destructiveEntries]) {
      assert.equal(entry.requiresConfirm, true, `Registry invariant violated: ${entry.actionName} must requireConfirm`);
    }

    // Guardrail check: validateIntentAgainstRegistry MUST catch an unconfirmed write intent
    const forgedBypass = {
      kind: 'write_confirm',
      actionName: 'card.slay',
      params: {},
      previewTitle: 'x',
      previewMessage: 'x',
      paramsSummary: 'x',
      requiresConfirm: false,
    };
    const forgedCheck = validateIntentAgainstRegistry(forgedBypass);
    assert.equal(forgedCheck.ok, false, 'Registry validator must reject write intent with requiresConfirm=false');

    // Display label helper works in both zh/en and never returns raw action id for registered actions
    assert.ok(ASSISTANT_ACTION_REGISTRY['card.followup.add']);
    assert.notEqual(formatAssistantActionLabel('card.followup.add', 'zh'), 'card.followup.add');
    assert.notEqual(formatAssistantActionLabel('card.followup.add', 'en'), 'card.followup.add');
    assert.ok(getAssistantActionMeta('card.slay')?.undoHint?.zh.includes('[z]'));
  });
});
