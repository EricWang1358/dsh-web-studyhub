// Round 86 comprehensive behavior & layout tests:
// - Track A5: Low-contrast eye-care theme #2 (`soft-sage`) — WCAG AA compliance, softer contrast than dsh-dark,
//             CLI --theme soft-sage, instant store switching, and 120x36 & 80x24 ASCII snapshots
// - Track B4: Global key unification & clean 4-key page footer cap (`AppShell` caps rendered page hints to top 4
//             and routes the rest into `[?] 全部键` while preserving full `store.footerHints`)
// - Track D3: Proactive 3-wrong consecutive streak attribution suggestion (`wrong-streak-nudge.ts` + live `ReviewView`
//             with disable toggle, rate limit/cooldown, reset on correct, and non-interrupting inline banner)
// node --test tests/round-86-ux.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  tokensMod,
  cliMod,
  streakMod,
  { AppShell },
  { ReviewView },
  storeMod,
] = await Promise.all([
  import('../src/theme/tokens.ts'),
  import('../src/cli-args.ts'),
  import('../src/views/review/wrong-streak-nudge.ts'),
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

const { THEME_IDS, getTheme } = tokensMod;
const { parseCliArgs } = cliMod;
const {
  createWrongStreakState,
  recordReviewOutcome,
  shouldTriggerWrongStreakNudge,
  buildWrongStreakBanner,
} = streakMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function hexLuminance(hex) {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(clean.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const l1 = hexLuminance(fg);
  const l2 = hexLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createTtyHarness(columns, rows) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns, rows });
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    stdout,
    stdin,
    getPlain: () => stripAnsi(output),
    async waitFor(pred, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const plain = stripAnsi(output);
        if (pred(plain)) return plain;
        await wait(20);
      }
      throw new Error(`waitFor timed out. Last output:\n${stripAnsi(output).slice(-800)}`);
    },
  };
}

describe('Round 86 Track A5 — soft-sage low-contrast eye-care theme', () => {
  test('registers soft-sage with gentler contrast than dsh-dark while passing WCAG AA & CLI parsing', () => {
    assert.ok(THEME_IDS.includes('soft-sage'));
    const sage = getTheme('soft-sage');
    const dark = getTheme('dsh-dark');
    assert.equal(sage.id, 'soft-sage');

    // Low-glare property: softer text/bg contrast than dsh-dark, yet still >= 10:1 (crisp readable AA/AAA)
    const sageContrast = contrastRatio(sage.text, sage.bg);
    const darkContrast = contrastRatio(dark.text, dark.bg);
    assert.ok(sageContrast < darkContrast, `soft-sage (${sageContrast.toFixed(2)}) should be gentler than dsh-dark (${darkContrast.toFixed(2)})`);
    assert.ok(sageContrast >= 10.0, `soft-sage text/bg contrast ${sageContrast.toFixed(2)} must stay >= 10:1`);

    for (const token of ['text', 'muted', 'primary', 'accent', 'success', 'warning', 'error', 'ai', 'info']) {
      const ratio = contrastRatio(sage[token], sage.bg);
      assert.ok(ratio >= 4.5, `soft-sage.${token} (${sage[token]}) contrast ${ratio.toFixed(2)} < 4.5`);
    }
    assert.ok(contrastRatio(sage.dim, sage.bg) >= 3.0);

    const parsed = parseCliArgs(['--theme', 'soft-sage']);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.theme, 'soft-sage');
  });
});

describe('Round 86 Track B4 — Global key unification & 4-key page footer cap', () => {
  test('AppShell renders at most 4 page hints in footer bar and folds remaining keys into [?] All at 120x36 & 80x24', async () => {
    const host = { async call() { return { ok: true, value: {} }; } };
    const manyHints = [
      { key: 'Enter', label: 'Start' },
      { key: 'R', label: 'Round' },
      { key: 'p', label: 'Plan' },
      { key: 'g', label: 'Guided' },
      { key: 'x', label: 'ExportMD' },
      { key: 'm', label: 'Manage' },
    ];

    useTuiStore.setState({
      page: 'library',
      preferences: {
        ...useTuiStore.getState().preferences,
        theme: 'soft-sage',
        language: 'zh',
        asciiMode: true,
        compactMode: true,
        showKeyHints: true,
      },
      footerHints: manyHints,
      loading: false,
      showLaunchpad: false,
      snapshot: { decks: [{ id: 'd1', title: 'Demo' }] },
      practiceStack: [],
    });

    const renderPage = () => React.createElement(Box, null, React.createElement(Text, null, 'BodyContent'));

    const wideTty = createTtyHarness(120, 36);
    const wide = render(React.createElement(AppShell, { host, renderPage, autoLaunchpad: false }), {
      stdout: wideTty.stdout,
      stdin: wideTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    const wideOut = await wideTty.waitFor((s) => s.includes('BodyContent') && s.includes('全部键'));
    assert.ok(wideOut.includes('Start') && wideOut.includes('Guided'), 'Top 4 page hints must render');
    assert.equal(wideOut.includes('ExportMD'), false, '5th+ page hints must be folded into [?] All');
    assert.equal(wideOut.includes('Manage'), false, '6th+ page hints must be folded into [?] All');
    assert.equal(useTuiStore.getState().footerHints.length, 6, 'store.footerHints keeps full list for HelpOverlay');
    wide.unmount();

    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(React.createElement(AppShell, { host, renderPage, autoLaunchpad: false }), {
      stdout: narrowTty.stdout,
      stdin: narrowTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    const narrowOut = await narrowTty.waitFor((s) => s.includes('BodyContent'));
    assert.equal(narrowOut.includes('ExportMD'), false);
    narrow.unmount();
  });
});

describe('Round 86 Track D3 — Proactive 3-wrong consecutive streak attribution suggestion', () => {
  test('enforces threshold=3, dedupe, reset on correct, disable toggle, max 2/round, cooldown, and non-interrupting guard', () => {
    let st = createWrongStreakState();
    st = recordReviewOutcome(st, { cardId: 'c1', prompt: 'Q1', topic: 'Matrices', correct: false });
    st = recordReviewOutcome(st, { cardId: 'c1', prompt: 'Q1', topic: 'Matrices', correct: false }); // duplicate ignored
    assert.equal(st.recentWrong.length, 1);

    st = recordReviewOutcome(st, { cardId: 'c2', prompt: 'Q2', topic: 'Matrices', grade: 1 });
    assert.equal(st.recentWrong.length, 2);
    assert.equal(
      shouldTriggerWrongStreakNudge({ enabled: true, isActive: true, isEditing: false, anyModalOpen: false, state: st }),
      false,
      'Must not trigger before 3 consecutive wrongs',
    );

    st = recordReviewOutcome(st, { cardId: 'c3', prompt: 'Q3', topic: 'Eigen', correct: false });
    assert.equal(st.recentWrong.length, 3);
    assert.equal(
      shouldTriggerWrongStreakNudge({ enabled: true, isActive: true, isEditing: false, anyModalOpen: false, state: st, now: 200_000 }),
      true,
    );

    // Guardrails: disable switch, typing, modal, max/round, cooldown
    assert.equal(
      shouldTriggerWrongStreakNudge({ enabled: false, isActive: true, isEditing: false, anyModalOpen: false, state: st, now: 200_000 }),
      false,
    );
    assert.equal(
      shouldTriggerWrongStreakNudge({ enabled: true, isActive: true, isEditing: true, anyModalOpen: false, state: st, now: 200_000 }),
      false,
    );
    assert.equal(
      shouldTriggerWrongStreakNudge({ enabled: true, isActive: true, isEditing: false, anyModalOpen: true, state: st, now: 200_000 }),
      false,
    );
    assert.equal(
      shouldTriggerWrongStreakNudge({
        enabled: true,
        isActive: true,
        isEditing: false,
        anyModalOpen: false,
        state: { ...st, roundNudgeCount: 2 },
        now: 200_000,
      }),
      false,
    );
    assert.equal(
      shouldTriggerWrongStreakNudge({
        enabled: true,
        isActive: true,
        isEditing: false,
        anyModalOpen: false,
        state: { ...st, lastNudgeAt: 150_000 },
        now: 200_000,
      }),
      false,
    );

    // Banner wording includes count, topic, and [t] (#1408)
    const zhBanner = buildWrongStreakBanner(st.recentWrong, 'zh', true);
    assert.match(zhBanner, /连续答错 3 题.*Matrices.*\[t\]/);

    // Correct answer resets streak
    st = recordReviewOutcome(st, { cardId: 'c4', prompt: 'Q4', correct: true, grade: 4 });
    assert.equal(st.recentWrong.length, 0);
  });

  test('ReviewView shows calm inline attribution banner after 3 consecutive wrong answers', async () => {
    const cards = [
      { id: 'w1', deckId: 'd1', kind: 'single', topic: 'Limits', prompt: 'Limit Q1', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }] },
      { id: 'w2', deckId: 'd1', kind: 'single', topic: 'Limits', prompt: 'Limit Q2', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }] },
      { id: 'w3', deckId: 'd1', kind: 'single', topic: 'Limits', prompt: 'Limit Q3', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }] },
    ];
    let idx = 0;
    const makeRun = (i, answeredWrong) => ({
      id: 'run-streak',
      title: 'Calculus Streak',
      mode: 'path',
      status: 'active',
      total: 3,
      answered: answeredWrong ? i + 1 : i,
      index: i,
      deckId: 'd1',
      card: cards[i],
      revealed: Boolean(answeredWrong),
      feedback: answeredWrong ? { correct: false, grade: 1, selected: ['B'] } : null,
      solution: { answer: 'A', explanation: 'Use L-Hopital.' },
    });

    let answerCalls = 0;
    let moveCalls = 0;
    const host = {
      async call(action) {
        if (action === 'review.get' || action === 'review.start') return { ok: true, value: makeRun(idx, false) };
        if (action === 'review.answer') {
          answerCalls += 1;
          return { ok: true, value: makeRun(idx, true) };
        }
        if (action === 'review.move') {
          moveCalls += 1;
          idx = Math.min(2, idx + 1);
          return { ok: true, value: makeRun(idx, false) };
        }
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      preferences: {
        ...useTuiStore.getState().preferences,
        theme: 'soft-sage',
        language: 'zh',
        asciiMode: true,
        proactiveHints: true,
      },
      activeRunId: 'run-streak',
    });

    const tty = createTtyHarness(120, 36);
    const inst = render(React.createElement(ReviewView, { host, width: 116, height: 34, isActive: true }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });

    await tty.waitFor((s) => s.includes('Limit Q1'));
    tty.stdin.write('2'); // wrong #1
    await tty.waitFor(() => answerCalls === 1);
    await wait(30);
    tty.stdin.write('.'); // move to Q2
    await tty.waitFor((s) => moveCalls === 1 && s.includes('Limit Q2'));
    await wait(30);
    tty.stdin.write('2'); // wrong #2
    await tty.waitFor(() => answerCalls === 2);
    await wait(30);
    tty.stdin.write('.'); // move to Q3
    await tty.waitFor((s) => moveCalls === 2 && s.includes('Limit Q3'));
    await wait(30);
    tty.stdin.write('2'); // wrong #3 -> triggers attribution banner!
    const finalOut = await tty.waitFor((s) => answerCalls === 3 && s.includes('连续答错 3 题'));
    assert.match(finalOut, /连续答错 3 题.*Limits.*\[t\]/);
    inst.unmount();
  });
});
