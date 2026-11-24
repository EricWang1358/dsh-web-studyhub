// Round 90 Milestone Audit (Rounds 82-90 batch gate):
// - Track 1: Visual Consistency Audit (all 6 themes WCAG AA, eye-care traits, 96-col prose cap,
//            density modes, stat tables, long-form prose rhythm, bundle budget)
// - Track 2: Keymap & Terminal Consistency Audit (reserved global keys, practice stack,
//            shared #1315 NL + multi-step P2 guard, tmux/screen/WT/NO_COLOR/dumb/ascii matrix)
// - Track 3: Proactive AI Guardrail Audit (all 4 proactive prompts enforce disable toggle +
//            strict rate limits + non-interrupting execution with zero idle polling)
// node --test tests/round-90-milestone-audit.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  tokensMod,
  layoutMod,
  chartsMod,
  longformMod,
  focusMod,
  stackMod,
  intentMod,
  workflowMod,
  paletteMod,
  compatMod,
  stuckMod,
  briefMod,
  streakMod,
  nextStepMod,
  cliMod,
] = await Promise.all([
  import('../src/theme/tokens.ts'),
  import('../src/components/Layout.tsx'),
  import('../src/render/charts.ts'),
  import('../src/render/longform.ts'),
  import('../src/components/focus.ts'),
  import('../src/state/practice-stack.ts'),
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-workflow.ts'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/render/terminal-compat.ts'),
  import('../src/views/review/stuck-nudge.ts'),
  import('../src/views/library/daily-briefing.ts'),
  import('../src/views/review/wrong-streak-nudge.ts'),
  import('../src/views/review/round-next-step.ts'),
  import('../src/cli-args.ts'),
]);

function hexLum(hex) {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(clean.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.7152 * 0 + 0.0722 * b;
}

function contrast(a, b) {
  const la = hexLum(a);
  const lb = hexLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('Round 90 Milestone Audit 1 — Visual Consistency (A1–A8)', () => {
  test('all 6 themes pass WCAG AA, both eye-care palettes hold their ergonomic invariants, and typography helpers align', () => {
    assert.deepEqual(
      [...tokensMod.THEME_IDS],
      ['dsh-dark', 'warm-paper', 'nord', 'high-contrast', 'warm-amber', 'soft-sage'],
    );
    for (const id of tokensMod.THEME_IDS) {
      const th = tokensMod.getTheme(id);
      assert.ok(contrast(th.text, th.bg) >= 10.0, `${id} text/bg >= 10:1`);
      assert.ok(contrast(th.text, th.surface) >= 8.0, `${id} text/surface >= 8:1`);
      assert.ok(contrast(th.selectionFg, th.selectionBg) >= 7.0, `${id} selection >= 7:1`);
      assert.ok(contrast(th.dim, th.bg) >= 3.0, `${id} dim >= 3:1`);
      for (const tok of ['primary', 'accent', 'success', 'warning', 'error', 'ai', 'info', 'muted']) {
        assert.ok(contrast(th[tok], th.bg) >= 4.5, `${id}.${tok} >= 4.5:1`);
      }
      assert.equal(cliMod.parseCliArgs(['--theme', id]).theme, id);
    }

    // Eye-care theme #1 (warm-amber): low-blue dark canvas
    const amber = tokensMod.getTheme('warm-amber');
    assert.ok(parseInt(amber.bg.slice(1, 3), 16) > parseInt(amber.bg.slice(5, 7), 16));

    // Eye-care theme #2 (soft-sage): softer contrast than dsh-dark
    const sage = tokensMod.getTheme('soft-sage');
    const dark = tokensMod.getTheme('dsh-dark');
    assert.ok(contrast(sage.text, sage.bg) < contrast(dark.text, dark.bg));

    // Layout & Typography invariants
    assert.equal(layoutMod.PROSE_MAX_COLS, 96);
    assert.equal(layoutMod.computeProseLayout(160).proseWidth, 96);
    assert.equal(layoutMod.computeProseLayout(160).centered, true);
    assert.equal(layoutMod.resolveDensitySpacing(false).mode, 'relaxed');
    assert.equal(layoutMod.resolveDensitySpacing(true).mode, 'compact');
    assert.ok(longformMod.formatLongformProse('A\n\nB', 40, { relaxed: true }).includes(''));

    const tbl = chartsMod.renderStatTable(
      [{ key: 'k', label: '指标' }, { key: 'v', label: '值', align: 'right' }],
      [{ k: '到期', v: 12 }],
      40,
      sage,
      { ascii: true },
    );
    assert.equal(tbl.length, 3);
  });
});

describe('Round 90 Milestone Audit 2 — Keymap, Navigation & Terminal Consistency (B0–B6, C2–C5)', () => {
  test('reserved keys, practice stack, shared NL/workflow P2 gate, and tmux/screen matrix hold across all boundaries', () => {
    assert.deepEqual([...focusMod.RESERVED_GLOBAL_KEYS], ['r', 'q', '?']);

    // Practice stack push/pop lifecycle (#1319)
    let stack = [];
    stack = stackMod.pushPracticeFrame(stack, {
      kind: 'review',
      returnPage: 'review',
      runId: 'r1',
      cardId: 'c1',
      cardIndex: 2,
      originKind: 'source',
    });
    assert.match(stackMod.formatReturnHintLabel(stack, 'zh') || '', /第 3 题/);
    const { frame, rest } = stackMod.popPracticeFrame(stack);
    assert.equal(frame?.cardId, 'c1');
    assert.equal(rest.length, 0);

    // Shared NL & workflow P2 safety (#1315 + B6 + D4)
    const writeIntent = intentMod.parseAssistantIntent('导出错题本', { lang: 'zh' });
    assert.equal(writeIntent.kind, 'write_confirm');
    assert.equal(writeIntent.requiresConfirm, true);
    const wf = workflowMod.planAssistantWorkflow('先跳到统计，再导出错题本', { lang: 'zh' });
    assert.equal(wf?.steps.length, 2);
    assert.equal(wf?.steps[1].intent.requiresConfirm, true);
    const palItem = paletteMod.buildNaturalLanguagePaletteItem('跳到错题本', {
      snapshot: null,
      lang: 'zh',
      asciiMode: true,
    });
    assert.ok(palItem && palItem.id.startsWith('nl:'));

    // Terminal compatibility matrix
    assert.equal(compatMod.detectMultiplexer({ TMUX: '/tmp/t,1,0' }), 'tmux');
    assert.equal(compatMod.detectMultiplexer({ STY: '123.pts' }), 'screen');
    assert.equal(compatMod.probeTerminalCompatMatrix({ env: { TERM: 'dumb' }, isTTY: true }).osc8Hyperlink, false);
    assert.equal(compatMod.probeTerminalCompatMatrix({ env: { WT_SESSION: '1', NO_COLOR: '1' }, isTTY: true }).osc2Title, false);
    assert.equal(compatMod.probeTerminalCompatMatrix({ env: { WT_SESSION: '1' }, isTTY: true }).osc9Notify, true);
  });
});

describe('Round 90 Milestone Audit 3 — Proactive AI 3-Guardrail Compliance (D0–D5)', () => {
  test('every proactive AI prompt strictly enforces disable toggle, rate limit, and zero idle polling', async () => {
    const today = new Date(2026, 4, 20, 9, 0, 0);
    const todayKey = briefMod.formatLocalDateKey(today);

    // 1. Disable toggle (`proactiveHints = false`) suppresses ALL 4 proactive prompts
    assert.equal(
      stuckMod.shouldScheduleStuckNudge({
        enabled: false,
        isActive: true,
        revealed: false,
        hasFeedback: false,
        isEditing: false,
        anyModalOpen: false,
        cardId: 'c1',
        nudgedCardIds: new Set(),
        roundNudgeCount: 0,
        lastNudgeAt: null,
      }),
      false,
    );
    assert.equal(
      briefMod.buildDailyBriefing({
        snapshot: { decks: [{ id: 'd1', title: 'Calc', due: 5 }] },
        course: null,
        lang: 'zh',
        proactiveHints: false,
        now: today,
      }),
      null,
    );
    let streak = streakMod.createWrongStreakState();
    streak = streakMod.recordReviewOutcome(streak, { cardId: 'a', prompt: '1', correct: false });
    streak = streakMod.recordReviewOutcome(streak, { cardId: 'b', prompt: '2', correct: false });
    streak = streakMod.recordReviewOutcome(streak, { cardId: 'c', prompt: '3', correct: false });
    assert.equal(
      streakMod.shouldTriggerWrongStreakNudge({
        enabled: false,
        isActive: true,
        isEditing: false,
        anyModalOpen: false,
        state: streak,
      }),
      false,
    );
    assert.equal(
      nextStepMod.buildRoundNextStepSuggestion({
        answered: 5,
        correct: 1,
        weakCount: 4,
        weakTopics: ['T'],
        remainingDue: 5,
        lang: 'zh',
        asciiMode: true,
        proactiveHints: false,
      }),
      null,
    );

    // 2. Rate limits enforced on every proactive prompt
    assert.equal(
      stuckMod.shouldScheduleStuckNudge({
        enabled: true,
        isActive: true,
        revealed: false,
        hasFeedback: false,
        isEditing: false,
        anyModalOpen: false,
        cardId: 'c2',
        nudgedCardIds: new Set(),
        roundNudgeCount: stuckMod.MAX_STUCK_NUDGES_PER_ROUND,
        lastNudgeAt: null,
      }),
      false,
    );
    assert.equal(
      briefMod.buildDailyBriefing({
        snapshot: { decks: [{ id: 'd1', title: 'Calc', due: 5 }] },
        course: null,
        lang: 'zh',
        proactiveHints: true,
        dismissedBriefingDate: todayKey,
        now: today,
      }),
      null,
    );
    assert.equal(
      streakMod.shouldTriggerWrongStreakNudge({
        enabled: true,
        isActive: true,
        isEditing: false,
        anyModalOpen: false,
        state: { ...streak, roundNudgeCount: streakMod.WRONG_STREAK_MAX_PER_ROUND },
      }),
      false,
    );
    assert.equal(
      nextStepMod.buildRoundNextStepSuggestion({
        answered: 5,
        correct: 1,
        weakCount: 4,
        weakTopics: ['T'],
        remainingDue: 5,
        lang: 'zh',
        asciiMode: true,
        proactiveHints: true,
        dismissed: true,
      }),
      null,
    );

    // 3. Zero idle polling (`setInterval` must never appear in any proactive module or AssistantPanel)
    const proactiveFiles = [
      'src/views/review/stuck-nudge.ts',
      'src/views/library/daily-briefing.ts',
      'src/views/review/wrong-streak-nudge.ts',
      'src/views/review/round-next-step.ts',
      'src/shell/AssistantPanel.tsx',
      'src/shell/assistant-workflow.ts',
    ];
    for (const rel of proactiveFiles) {
      const src = await readFile(join(process.cwd(), rel), 'utf8');
      assert.equal(/\bsetInterval\s*\(/.test(src), false, `${rel} must never use idle setInterval polling`);
    }
  });
});
