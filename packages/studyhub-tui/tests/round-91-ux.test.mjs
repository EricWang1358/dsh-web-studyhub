// Round 91 comprehensive behavior & layout tests:
// - Track D6: Exam countdown backward auto-scheduler (`exam-planner.ts` phase split, gap detection,
//             daily quota, 7-day rolling schedule) + live ExamPrepView countdown banner
// - Track A9: DashboardView `[T]` borderless CJK-aligned `renderStatTable` toggle at 120x36 & 80x24 ASCII
// - Track C6: CommandPalette `/terminal` live terminal capability diagnostic toast
// node --test tests/round-91-ux.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  plannerMod,
  paletteMod,
  { DashboardView },
  storeMod,
] = await Promise.all([
  import('../src/views/examprep/exam-planner.ts'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/views/dashboard/DashboardView.tsx'),
  import('../src/state/store.ts'),
]);

const { buildExamCountdownPlan, formatExamCountdownSummary } = plannerMod;
const { buildPaletteItems } = paletteMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
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

describe('Round 91 Track D6 — Exam Countdown Auto-Scheduler & Gap-Fill Planner', () => {
  test('works backward from examDate into 3 phases, detects coverage gaps, and builds 7-day rolling schedule', () => {
    const today = new Date(2026, 4, 1); // 2026-05-01
    const topics = [
      { topic: 'Eigenvalues', status: 'none', cards: 0, mastery: 0, weakCards: [] },
      { topic: 'SVD Decomposition', status: 'weak', cards: 10, mastery: 0.3, weakCards: [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }] },
      { topic: 'Orthogonality', status: 'todo', cards: 12, mastery: 0.5, weakCards: [] },
      { topic: 'Determinants', status: 'done', cards: 8, mastery: 0.95, weakCards: [] },
    ];

    const plan = buildExamCountdownPlan({ examDate: '2026-05-15', topics, dailyMinutes: 45, lang: 'zh', today });
    assert.ok(plan);
    assert.equal(plan.status, 'ok');
    assert.equal(plan.daysLeft, 14);
    assert.deepEqual(plan.gapTopics, ['Eigenvalues']);
    assert.deepEqual(plan.weakTopics, ['SVD Decomposition']);
    assert.deepEqual(plan.pendingTopics, ['Orthogonality']);
    assert.equal(plan.phases.length, 3, '14 days with gap+weak+pending splits into 3 phases');
    assert.deepEqual(plan.phases.map((p) => p.kind), ['gap_fill', 'consolidate', 'mock_polish']);
    assert.equal(plan.phases.reduce((n, p) => n + p.days, 0), 14);
    assert.equal(plan.next7Days.length, 7);
    assert.match(plan.next7Days[0].note, /\[g\]/);

    const banner = formatExamCountdownSummary(plan, 'zh', true);
    assert.match(banner, /考期倒推 \(14天\).*补缺攻坚.*缺题 1 项/);

    // Past date & exam day boundaries
    const past = buildExamCountdownPlan({ examDate: '2026-04-20', topics, lang: 'zh', today });
    assert.equal(past?.status, 'past');
    assert.equal(formatExamCountdownSummary(past, 'zh', true), '');

    const examDay = buildExamCountdownPlan({ examDate: '2026-05-01', topics, lang: 'en', today });
    assert.equal(examDay?.status, 'today');
    assert.match(formatExamCountdownSummary(examDay, 'en', true), /Exam Day/);
  });
});

describe('Round 91 Track A9 — DashboardView [T] Stat Table Toggle', () => {
  test('toggles between Bar Chart and borderless CJK-aligned renderStatTable at 120x36 & 80x24 ASCII', async () => {
    const host = {
      async call(action) {
        if (action === 'stats') {
          return {
            ok: true,
            value: {
              totals: { attempts: 30, activeDays: 7, streak: 4, correctRate: 0.8, cards: 25, due: 6, mastered: 15, weak: 3 },
              heatmap: [],
              weakTopics: [],
              forecast: { days: [] },
            },
          };
        }
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true, theme: 'soft-sage' },
      snapshot: {
        decks: [
          { id: 'd1', title: 'LA', course: '线性代数', cardCount: 15 },
          { id: 'd2', title: 'Calc', course: '微积分', cardCount: 10 },
        ],
        progress: {
          d1: { total: 15, mastery: 82, due: 4, counts: { mastered: 12, weak: 1 } },
          d2: { total: 10, mastery: 64, due: 2, counts: { mastered: 6, weak: 2 } },
        },
      },
    });

    const wideTty = createTtyHarness(120, 36);
    const wide = render(React.createElement(DashboardView, { host, width: 116, height: 34, isActive: true }), {
      stdout: wideTty.stdout,
      stdin: wideTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    await wideTty.waitFor((s) => s.includes('线性代数'));

    wideTty.stdin.write('T');
    const tblOut = await wideTty.waitFor((s) => s.includes('课程掌握度统计表') && s.includes('82%') && s.includes('64%'));
    assert.match(tblOut, /课程.*题数.*到期.*掌握/);
    wide.unmount();

    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(React.createElement(DashboardView, { host, width: 76, height: 22, isActive: true }), {
      stdout: narrowTty.stdout,
      stdin: narrowTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    await narrowTty.waitFor((s) => s.includes('学习统计'));
    narrowTty.stdin.write('T');
    const narrowTbl = await narrowTty.waitFor((s) => s.includes('掌握度表'));
    assert.match(narrowTbl, /82%/);
    narrow.unmount();
  });
});

describe('Round 91 Track C6 — CommandPalette /terminal live capability diagnostic', () => {
  test('registers /terminal command and notifies with OSC 52/8/2/9 & mux matrix summary', () => {
    const s = useTuiStore.getState();
    const items = buildPaletteItems(
      { ...s, preferences: { ...s.preferences, language: 'zh', asciiMode: true } },
      { refresh: async () => {}, switchCourse: async () => {}, loadSample: async () => {}, removeSample: async () => {}, quit: () => {} },
      [],
      undefined,
    );
    const termCmd = items.find((it) => it.id === 'cmd:terminal');
    assert.ok(termCmd, '/terminal command must be registered');
    assert.equal(termCmd.label, '/terminal');

    useTuiStore.setState({ toasts: [] });
    termCmd.action();
    const toast = useTuiStore.getState().toasts.at(-1);
    assert.ok(toast, '/terminal must emit diagnostic toast');
    assert.match(toast.text, /mux:.*OSC52:.*OSC8:.*OSC2:.*OSC9:/);
  });
});
