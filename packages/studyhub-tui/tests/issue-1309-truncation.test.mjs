// Regression tests for #1309: Review page & TopBar text truncation and code block hard-wrapping.
// node --test tests/issue-1309-truncation.test.mjs
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

const [
  { displayWidth },
  { renderMarkdownLines, clearMarkdownCache },
  { getTheme },
  { TopBar },
  { Panel },
  { AiHelpDrawer },
  { ReviewView },
  { featureShortcuts },
  storeMod,
] = await Promise.all([
  import('../src/render/cjk.ts'),
  import('../src/render/markdown.ts'),
  import('../src/theme/tokens.ts'),
  import('../src/shell/TopBar.tsx'),
  import('../src/components/Panel.tsx'),
  import('../src/views/review/AiHelpDrawer.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/shell/HelpOverlay.tsx'),
  import('../src/state/store.ts'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const theme = getTheme('dsh-dark');

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

function resetStore({ language = 'zh', asciiMode = false, snapshot = null, desktopConfig = null, binding = null } = {}) {
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
    showLaunchpad: false,
    snapshot,
    binding,
    desktopConfig,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      language,
      asciiMode,
    },
  });
}

describe('#1309 text truncation & code wrapping regressions', () => {
  test('1. fenced code blocks break at space/comma/dot instead of splitting identifiers like RoundingMode', () => {
    clearMarkdownCache();
    const md = [
      '```java',
      'BigDecimal res = BigDecimal.valueOf(amount).setScale(2, RoundingMode.HALF_UP);',
      '```',
    ].join('\n');

    for (const ascii of [false, true]) {
      for (const w of [30, 35, 42]) {
        const lines = renderMarkdownLines(md, { width: w, theme, ascii });
        const plainLines = lines.map((l) => stripAnsi(l));
        for (const l of plainLines) {
          assert.ok(displayWidth(l) <= w, `code line exceeded width ${w}: "${l}"`);
        }
        const joined = plainLines.join('\n');
        assert.ok(joined.includes('RoundingMode'), `Expected RoundingMode intact on one line (w=${w}, ascii=${ascii}), got:\n${joined}`);
        assert.ok(joined.includes('BigDecimal'), `Expected BigDecimal intact on one line (w=${w}, ascii=${ascii}), got:\n${joined}`);
        assert.ok(joined.includes('HALF_UP'), `Expected HALF_UP intact on one line (w=${w}, ascii=${ascii}), got:\n${joined}`);
      }
    }
  });

  test('2. TopBar uses available width instead of hardcoded 18/30 col caps for course & model', async () => {
    const longCourse = '软件工程与分布式系统架构课程';
    const longModel = 'gpt-4.1-mini-2025-04-14-preview';
    for (const [language, asciiMode] of [['zh', false], ['en', false], ['zh', true]]) {
      resetStore({
        language,
        asciiMode,
        snapshot: {
          focus: { course: longCourse },
          courses: [{ id: 'c1', name: longCourse }],
          decks: [],
          jobs: [],
        },
        desktopConfig: {
          mode: 'openai',
          openai: { providerId: 'openai', baseUrl: '', model: longModel },
          agy: { executablePath: '', model: '', effort: 'medium' },
          codex: { executablePath: '', model: '', effort: 'medium' },
          libraryRoot: '/tmp',
          libraryPlaceConfirmed: true,
          reasoningEffort: 'medium',
          effective: { ready: true, label: longModel, reason: '', provider: 'OpenAI', model: longModel },
        },
        binding: { root: '/tmp' },
      });

      const h = createInkHarness(React.createElement(TopBar, { width: 150 }), { cols: 150, rows: 3 });
      try {
        const frame = await h.waitFor((s) => s.includes('StudyHub'));
        assert.ok(frame.includes(longCourse), `Expected full course name at 150 cols (${language}, ascii=${asciiMode}), got:\n${frame}`);
        assert.ok(frame.includes(longModel), `Expected full model name at 150 cols (${language}, ascii=${asciiMode}), got:\n${frame}`);
      } finally {
        h.cleanup();
      }
    }
  });

  test('3. Panel header does not truncate subtitle when title + subtitle fit in panel width', async () => {
    resetStore({ language: 'zh', asciiMode: false });
    const title = 'Java 核心题组';
    const subtitle = '多选题 · BigDecimal 精度与舍入模式';
    const h = createInkHarness(
      React.createElement(Panel, {
        title,
        icon: '▶',
        badge: '1/10',
        subtitle,
        width: 80,
        height: 5,
      }),
      { cols: 80, rows: 6 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes(title));
      assert.ok(frame.includes(subtitle), `Expected full subtitle when width=80 has plenty of room, got:\n${frame}`);
    } finally {
      h.cleanup();
    }
  });

  test('4. AiHelpDrawer wraps 3 long recommended follow-up questions completely without pushing input off screen', async () => {
    const q1 = '为什么金融金额计算必须优先使用 BigDecimal 而不是 double 浮点类型？结尾标记ONE';
    const q2 = '如果两个 BigDecimal 数值相等但精度不同，equals 和 compareTo 的区别是什么？结尾标记TWO';
    const q3 = '在除法运算出现无限循环小数时，如果不指定 RoundingMode 会抛出什么异常？结尾标记THREE';

    const mockRun = {
      id: 'run-1',
      title: 'Java 数值计算',
      index: 0,
      total: 5,
      answered: 1,
      revealed: true,
      card: {
        id: 'card-1',
        deckId: 'deck-1',
        type: 'single',
        question: '下列关于 BigDecimal 的说法正确的是？',
      },
      solution: {
        answer: 'A',
        explanation: 'BigDecimal 适合高精度计算。',
      },
    };

    for (const [language, asciiMode] of [['zh', false], ['en', false], ['zh', true]]) {
      resetStore({ language, asciiMode });
      const mockHost = {
        call: async (name) => {
          if (name === 'card.followup.suggest') {
            return { ok: true, value: { questions: [q1, q2, q3] } };
          }
          return { ok: true, value: {} };
        },
        streamComplete: async () => '这是简短讲解。',
      };

      const h = createInkHarness(
        React.createElement(AiHelpDrawer, {
          host: mockHost,
          run: mockRun,
          cardId: 'card-1',
          kind: 'single',
          userAnswer: 'A',
          width: 48,
          height: 24,
          isActive: true,
          mathUnicode: true,
          onClose: () => {},
        }),
        { cols: 48, rows: 24 },
      );

      try {
        await h.waitFor((s) => s.includes('这是简短讲解'));
        h.write('s');
        const frame = await h.waitFor((s) => s.includes('[1]') && s.includes('[3]'));
        const compact = frame.replace(/[│|\r\n\s]+/g, '');
        assert.ok(compact.includes('结尾标记ONE'), `q1 truncated (${language}, ascii=${asciiMode}):\n${frame}`);
        assert.ok(compact.includes('结尾标记TWO'), `q2 truncated (${language}, ascii=${asciiMode}):\n${frame}`);
        assert.ok(compact.includes('结尾标记THREE'), `q3 truncated (${language}, ascii=${asciiMode}):\n${frame}`);
        // Input box must remain visible on screen
        assert.ok(
          frame.includes('按 [i] 输入追问') || frame.includes('Press [i] to ask'),
          `Input box was pushed off screen (${language}, ascii=${asciiMode}):\n${frame}`,
        );
      } finally {
        h.cleanup();
      }
    }
  });

  test('5. ReviewView wraps long user answer completely, shows ? hint on narrow bottom bar, and HelpOverlay lists all review keys', async () => {
    const mockRun = {
      id: 'run-review-1',
      title: 'Java 并发与高精度数值计算深度强化专项题组',
      index: 0,
      total: 10,
      answered: 1,
      revealed: true,
      canUndo: true,
      card: {
        id: 'card-r1',
        deckId: 'deck-r1',
        kind: 'multiple',
        topic: 'BigDecimal 精度控制与舍入策略详解',
        prompt: '关于 BigDecimal 的最佳实践，以下哪些正确？',
        options: [
          { id: 'A', text: '使用 BigDecimal(String) 构造避免精度损失' },
          { id: 'B', text: '除法必须指定 RoundingMode.HALF_UP' },
          { id: 'C', text: '数值比较大小使用 compareTo 结尾完整可见' },
        ],
      },
      feedback: {
        correct: false,
        level: 'weak',
        selected: ['A', 'B', 'C'],
      },
      solution: {
        answer: 'A, B, C',
        options: [
          { id: 'A', correct: true },
          { id: 'B', correct: true },
          { id: 'C', correct: true },
        ],
        explanation: '三项均正确。',
      },
    };

    const mockHost = {
      call: async (name) => {
        if (name === 'review.start' || name === 'study.start' || name === 'study.state') {
          return { ok: true, value: mockRun };
        }
        return { ok: true, value: {} };
      },
      getSnapshot: async () => ({ decks: [], courses: [], jobs: [] }),
    };

    // 80x24 narrow viewport (zh, en, ascii)
    for (const [language, asciiMode, expectedHint, answerPrefix] of [
      ['zh', false, '按?看全部', '你的作答'],
      ['en', false, '[?]All', 'Yours'],
      ['zh', true, '按?看全部', '你的作答'],
    ]) {
      resetStore({ language, asciiMode });
      const h80 = createInkHarness(
        React.createElement(ReviewView, {
          host: mockHost,
          width: 78,
          height: 22,
          isActive: true,
        }),
        { cols: 80, rows: 24 },
      );
      try {
        const frame = await h80.waitFor((s) => s.includes(answerPrefix));
        const compact = frame.replace(/[│|\r\n\s]+/g, '');
        assert.ok(compact.includes('结尾完整可见'), `Long userAnswer was truncated at 80 cols (${language}, ascii=${asciiMode}):\n${frame}`);
        assert.ok(compact.includes('舍入策略详解'), `Full panel subtitle should remain readable at 80 cols (${language}, ascii=${asciiMode}):\n${frame}`);
        assert.ok(
          frame.includes(expectedHint),
          `Expected "${expectedHint}" on truncated narrow bottom strip (${language}, ascii=${asciiMode}):\n${frame}`,
        );
      } finally {
        h80.cleanup();
      }
    }

    // 150-col wide viewport
    resetStore({ language: 'zh', asciiMode: false });
    const h150 = createInkHarness(
      React.createElement(ReviewView, {
        host: mockHost,
        width: 146,
        height: 36,
        isActive: true,
      }),
      { cols: 150, rows: 38 },
    );
    try {
      const frame = await h150.waitFor((s) => s.includes('你的作答'));
      assert.ok(frame.includes('结尾完整可见'), `Long userAnswer was truncated at 150 cols:\n${frame}`);
      assert.ok(frame.includes('[E]标记') && frame.includes('[,/.]换题'), `Full bottom strip should fit at 150 cols:\n${frame}`);
    } finally {
      h150.cleanup();
    }

    // HelpOverlay Review section must include all bottom strip keys
    for (const lang of ['zh', 'en']) {
      const sections = featureShortcuts(lang);
      const reviewSec = sections.find((s) => s.title.includes('Review'));
      assert.ok(reviewSec, `HelpOverlay missing Review section for ${lang}`);
      const keysText = reviewSec.items.map((x) => x.key).join(' ');
      for (const expectedKey of ['h', 't', '*', 'A', 'W', 'S', 'D', 'Q', 'E', 's', 'u', ',']) {
        assert.ok(
          keysText.includes(expectedKey),
          `HelpOverlay Review section (${lang}) missing key "${expectedKey}" in: ${keysText}`,
        );
      }
    }
  });
});
