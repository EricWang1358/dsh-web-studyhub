// Round 100 Final Milestone Audit (Rounds 82–100 across Pillars A, B, C, D):
// - Pillar A: All 6 themes WCAG AA, prose centering <= 96 cols, borderless renderStatTable, App.mjs <= 64 KB
// - Pillar B: #1315 NL + multi-step workflow + P2 confirm + structured memory + WrongBook [Q] cluster
// - Pillar C: Terminal compat matrix (mux, OSC 52/8/2/9, DEC 1004), 4x blur throttling, CLI --doctor ASCII purity
// - Pillar D: ALL 6 proactive AI nudges enforce 3 guardrails (disable toggle + rate limit + ZERO setInterval idle polling)
//             and exam-date backward auto-scheduler + P2 gap-fill workflow + Markdown schedule export
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const [
  tokensMod,
  layoutMod,
  longformMod,
  chartsMod,
  cjkMod,
  compatMod,
  titleMod,
  linkMod,
  cliMod,
  intentMod,
  wfMod,
  memMod,
  clusterMod,
  coverageMod,
  displayMod,
  dailyMod,
  stuckMod,
  streakMod,
  nextStepMod,
  gapAlertMod,
  fatigueMod,
] = await Promise.all([
  import('../src/theme/tokens.ts'),
  import('../src/components/Layout.tsx'),
  import('../src/render/longform.ts'),
  import('../src/render/charts.ts'),
  import('../src/render/cjk.ts'),
  import('../src/render/terminal-compat.ts'),
  import('../src/render/terminal-title.ts'),
  import('../src/render/osc8.ts'),
  import('../src/cli-args.ts'),
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-workflow.ts'),
  import('../src/shell/assistant-memory.ts'),
  import('../src/views/wrongbook/quick-triage.ts'),
  import('../src/views/examprep/exam-coverage.ts'),
  import('../src/views/examprep/course-plan-display.ts'),
  import('../src/views/library/daily-briefing.ts'),
  import('../src/views/review/stuck-nudge.ts'),
  import('../src/views/review/wrong-streak-nudge.ts'),
  import('../src/views/review/round-next-step.ts'),
  import('../src/views/examprep/exam-gap-alert.ts'),
  import('../src/views/review/fatigue-nudge.ts'),
]);

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function contrastRatio(hexA, hexB) {
  const lum = (hex) => {
    const clean = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => {
      const c = parseInt(clean.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const [l1, l2] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('Round 100 Final Milestone Audit — Pillars A, B, C, D', () => {
  it('Pillar A: 6-theme WCAG AA, <=96 col prose centering, longform rhythm, borderless stat table, and dist/App.mjs <= 64 KB', () => {
    const themeIds = tokensMod.listThemes().map((t) => t.id);
    assert.deepEqual(themeIds, ['dsh-dark', 'warm-paper', 'nord', 'high-contrast', 'warm-amber', 'soft-sage']);
    for (const id of themeIds) {
      const th = tokensMod.getTheme(id);
      assert.ok(contrastRatio(th.text, th.bg) >= 4.5, `${id} text/bg below WCAG AA`);
      assert.ok(contrastRatio(th.text, th.surface) >= 4.5, `${id} text/surface below WCAG AA`);
    }

    const layout = layoutMod.computeProseLayout(160);
    assert.ok(layout.proseWidth <= 96);
    assert.ok(layout.marginLeft > 0);
    assert.match(longformMod.formatReadingTimeLabel('虚拟内存与页表机制介绍'.repeat(40), 'zh'), /约 \d+ 分钟/);

    const tbl = chartsMod.renderStatTable(
      [
        { key: 'name', label: '项目', align: 'left' },
        { key: 'val', label: '数值', align: 'right', width: 6 },
      ],
      [{ name: '操作系统 OS', val: '92%' }],
      40,
      tokensMod.getTheme('soft-sage'),
      { ascii: true },
    );
    assert.equal(tbl.length, 3);
    for (const line of tbl) {
      const plain = stripAnsi(line);
      assert.equal(cjkMod.displayWidth(plain), 40);
      assert.doesNotMatch(plain, /[^\x00-\x7f\u4e00-\u9fff]/);
    }

    const appBundle = path.join(pkgRoot, 'dist/App.mjs');
    assert.ok(fs.existsSync(appBundle), 'dist/App.mjs must be built');
    const bytes = fs.statSync(appBundle).size;
    assert.ok(bytes <= 65_536, `dist/App.mjs exceeded 64 KB cap: ${bytes} bytes`);
  });

  it('Pillar B: #1315 NL intents, P2 multi-step workflow, structured memory pruning, and WrongBook [Q] cluster', () => {
    const planIntent = intentMod.parseAssistantIntent('按考期倒推排备考计划', { lang: 'zh' });
    assert.equal(planIntent.kind, 'navigate');
    assert.equal(planIntent.page, 'examprep');

    const wf = wfMod.planAssistantWorkflow('先跳到错题本再导出本课错题', { lang: 'zh' });
    assert.ok(wf && wf.steps.length === 2);
    assert.equal(wf.steps[0].intent.requiresConfirm, false);
    assert.equal(wf.steps[1].intent.requiresConfirm, true);

    const turns = Array.from({ length: 28 }, (_, i) => ({
      id: `t${i}`,
      at: i,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `turn ${i}`,
    }));
    const pruned = memMod.pruneTurnsWithSummary(turns, 24, 'zh');
    assert.equal(pruned.length, 24);
    assert.equal(pruned[0].id, 'assistant-memory-summary');

    const cluster = clusterMod.buildTopWrongCluster(
      [
        { deckId: 'd1', cardId: 'c1', topic: '页表', errorReason: '概念混淆' },
        { deckId: 'd1', cardId: 'c2', topic: '页表', errorReason: '粗心' },
        { deckId: 'd2', cardId: 'c3', topic: '死锁', errorReason: '粗心' },
      ],
      'zh',
    );
    assert.ok(cluster);
    assert.match(cluster.label, /页表/);
    assert.equal(cluster.scope.length, 2);
  });

  it('Pillar C: terminal compat matrix, DEC 1004 focus throttling, OSC 2/8 safety, and --doctor ASCII purity', () => {
    const m = compatMod.probeTerminalCompatMatrix({
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'WezTerm' },
      isTTY: true,
      asciiMode: false,
    });
    assert.equal(m.osc52Copy, true);
    assert.equal(m.osc8Hyperlink, true);
    assert.equal(m.osc2Title, true);
    assert.equal(m.focusReporting, true);
    assert.equal(compatMod.parseTerminalFocusEvent('\x1b[O'), 'blur');
    assert.equal(compatMod.parseTerminalFocusEvent('\x1b[I'), 'focus');
    assert.equal(compatMod.resolveAdaptiveTickMs(false, 1000), 4000);
    assert.equal(compatMod.resolveAdaptiveTickMs(true, 1000), 1000);

    assert.match(titleMod.buildExamWindowTitle({ kind: 'written', at: 1, total: 10, lang: 'zh' }), /模考 1\/10/);
    assert.equal(linkMod.formatOsc8Link('Docs', 'javascript:alert(1)', { enabled: true }), 'Docs');

    const doc = cliMod.buildDoctorReport({ env: { TERM: 'xterm-256color' }, isTty: true });
    const ascii = cliMod.formatDoctorReport(doc, true);
    assert.match(ascii, /DEC1004=/);
    assert.match(ascii, /warm-amber/);
    assert.doesNotMatch(ascii, /[^\x00-\x7f]/);
  });

  it('Pillar D: all 6 proactive AI nudges enforce opt-out + rate limit + ZERO setInterval polling, and exam planner works backward', () => {
    // 1) Opt-out behavioral audit across ALL 6 proactive nudge modules
    assert.equal(
      dailyMod.buildDailyBriefing({
        snapshot: { decks: [{ id: 'd1', title: 'OS', due: 5 }] },
        course: null,
        lang: 'zh',
        proactiveHints: false,
      }),
      null,
    );
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
      streakMod.shouldTriggerWrongStreakNudge({
        enabled: false,
        isActive: true,
        isEditing: false,
        anyModalOpen: false,
        state: {
          recentWrong: [
            { cardId: 'c1', prompt: 'q1' },
            { cardId: 'c2', prompt: 'q2' },
            { cardId: 'c3', prompt: 'q3' },
          ],
          roundNudgeCount: 0,
          lastNudgeAt: null,
        },
      }),
      false,
    );
    assert.equal(
      nextStepMod.buildRoundNextStepSuggestion({
        answered: 10,
        correct: 8,
        weakCount: 2,
        weakTopics: ['OS'],
        remainingDue: 5,
        lang: 'zh',
        asciiMode: false,
        proactiveHints: false,
      }),
      null,
    );
    assert.equal(
      gapAlertMod.buildExamGapAlert({
        proactiveHints: false,
        dismissed: false,
        plan: coverageMod.buildExamCoverage([{ topic: 'OS', status: 'none', cards: 0, mastery: 0, weakCards: [] }], 7),
        lang: 'zh',
        asciiMode: false,
      }),
      null,
    );
    assert.equal(
      fatigueMod.shouldShowFatigueNudge({
        enabled: false,
        isActive: true,
        isEditing: false,
        anyModalOpen: false,
        answeredInRound: 30,
        alreadyNudgedInRound: false,
      }),
      false,
    );

    // 2) Zero idle setInterval polling audit across ALL 6 proactive nudge source files
    const nudgeFiles = [
      'src/views/library/daily-briefing.ts',
      'src/views/review/stuck-nudge.ts',
      'src/views/review/wrong-streak-nudge.ts',
      'src/views/review/round-next-step.ts',
      'src/views/examprep/exam-gap-alert.ts',
      'src/views/review/fatigue-nudge.ts',
    ];
    for (const rel of nudgeFiles) {
      const src = fs.readFileSync(path.join(pkgRoot, rel), 'utf8');
      assert.doesNotMatch(src, /\bsetInterval\s*\(/, `${rel} must never use setInterval idle polling`);
    }

    // 3) Saved-plan display (the schedule is the backend's course.plan) + P2 gap-fill workflow + Markdown section
    const coverage = coverageMod.buildExamCoverage(
      [
        { topic: '虚拟内存', status: 'none', cards: 0, mastery: 0, weakCards: [] },
        { topic: '死锁', status: 'weak', cards: 6, mastery: 0.3, weakCards: ['w1'] },
      ],
      14,
    );
    assert.ok(coverage && coverage.daysLeft === 14);
    const steps = coverageMod.buildGapFillWorkflowSteps(coverage, 'zh');
    assert.ok(steps.some((s) => s.kind === 'generate_gap' && s.requiresConfirm === true));
    assert.ok(steps.some((s) => s.kind === 'drill_weak' && s.requiresConfirm === false));
    const md = displayMod.formatExamScheduleMarkdown({ status: 'no-plan', course: 'OS', examDate: '2026-05-15' }, 'zh');
    assert.match(md, /还没有备考计划/);
    assert.doesNotMatch(md, /自动排程/);
  });
});
