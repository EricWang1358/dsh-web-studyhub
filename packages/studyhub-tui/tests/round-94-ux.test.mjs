// Round 94 comprehensive behavior & layout tests:
// - Track D8: Exam Gap-Fill Remediation Workflow (`buildGapFillWorkflowSteps` with P2 confirm on generate steps)
// - Track A12: Borderless exam schedule table of the saved 备考计划 (`renderExamScheduleTable` + `ExamPrepView` `[T]` toggle
//              at 120x36 & 80x24 ASCII)
// - Track C8: DEC 1004 terminal focus/blur reporting (`parseTerminalFocusEvent`, `supportsFocusReporting`,
//             `resolveAdaptiveTickMs` 4x low-power blur throttling)
// node --test tests/round-94-ux.test.mjs
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { createVirtualTty, disposeTerminalPool } from './helpers/virtual-tty.mjs';

const { Terminal } = xtermPkg;

const unregisterTsx = register();
after(() => {
  disposeTerminalPool();
  unregisterTsx?.();
});

const [
  displayMod,
  coverageMod,
  compatMod,
  tokensMod,
  cjkMod,
  { ExamPrepView },
  storeMod,
] = await Promise.all([
  import('../src/views/examprep/course-plan-display.ts'),
  import('../src/views/examprep/exam-coverage.ts'),
  import('../src/render/terminal-compat.ts'),
  import('../src/theme/tokens.ts'),
  import('../src/render/cjk.ts'),
  import('../src/views/examprep/ExamPrepView.tsx'),
  import('../src/state/store.ts'),
]);

const { renderExamScheduleTable } = displayMod;
const { buildExamCoverage, buildGapFillWorkflowSteps } = coverageMod;
const {
  DEC_FOCUS_ENABLE,
  DEC_FOCUS_DISABLE,
  parseTerminalFocusEvent,
  supportsFocusReporting,
  resolveAdaptiveTickMs,
} = compatMod;
const { getTheme } = tokensMod;
const { displayWidth } = cjkMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('Round 94 Track D8 & A12 — Gap-Fill Workflow & Saved-Plan Schedule Table [T]', () => {
  test('generates P2-guarded gap-fill workflow steps and exact-width saved-plan schedule table in ExamPrepView', async () => {
    const topics = [
      { topic: 'Vector Spaces', status: 'none', cards: 0, mastery: 0, weakCards: [], counts: {} },
      { topic: 'Eigenvalues', status: 'weak', cards: 8, mastery: 0.25, weakCards: [{ deckId: 'd1', cardId: 'c1' }], counts: { weak: 4 } },
    ];
    const steps = buildGapFillWorkflowSteps(buildExamCoverage(topics, 8), 'zh');
    assert.equal(steps.length, 2, 'generate_gap + drill_weak; mock exams are the saved plan\'s mockDates');
    assert.equal(steps[0].kind, 'generate_gap');
    assert.equal(steps[0].requiresConfirm, true, 'AI generation step MUST enforce P2 confirmation');
    assert.equal(steps[1].kind, 'drill_weak');
    assert.equal(steps[1].requiresConfirm, false);

    const futureDate = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
    const savedDay = (n, mode, minutes, reason) => ({
      date: new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10),
      offset: n,
      phase: '备考',
      mode,
      points: [],
      done: [],
      minutes,
      reason,
    });
    const savedPlan = {
      status: 'ok',
      course: 'Linear Algebra',
      examDate: futureDate,
      daysLeft: 8,
      schedule: {
        status: 'ok',
        capacity: 180,
        phases: [{ name: '备考', from: savedDay(0).date, until: futureDate }],
        days: [
          savedDay(0, 'learn', 180, { code: 'learn-size', count: 3, weak: 1 }),
          savedDay(1, 'off', 0, { code: 'weekday' }),
          savedDay(2, 'mock', 0, { code: 'mock' }),
        ],
      },
      points: [],
    };

    const theme = getTheme('warm-amber');
    const lines = renderExamScheduleTable(savedPlan, 56, theme, { lang: 'zh', ascii: true });
    assert.equal(lines.length, 5, 'Header + rule + the 3 saved days');
    for (const l of lines) {
      assert.equal(displayWidth(stripAnsi(l)), 56);
    }

    // Live ExamPrepView [T] toggle at 120x36 & 80x24 ASCII
    const host = {
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp',
      async call(action) {
        if (action === 'course.focusProgress') {
          return { ok: true, value: { course: 'Linear Algebra', topics, total: 2, done: 0, weak: 1, none: 1, weakScope: [] } };
        }
        if (action === 'book.crunch') {
          return { ok: true, value: { status: 'ok', course: 'Linear Algebra', examDate: futureDate, daysLeft: 8, points: [] } };
        }
        if (action === 'course.get') {
          return { ok: true, value: { name: 'Linear Algebra', exam: { date: futureDate } } };
        }
        if (action === 'course.plan') return { ok: true, value: savedPlan };
        return { ok: true, value: {} };
      },
    };
    useTuiStore.setState({
      page: 'examprep',
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true, proactiveHints: true },
      snapshot: { focus: { course: 'Linear Algebra' }, courses: [{ name: 'Linear Algebra' }] },
    });

    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      inst = render(React.createElement(ExamPrepView, { host, width: 116, height: 34, isActive: true }), {
        stdout: tty.stdout,
        stdin: tty.stdin,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        interactive: true,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Vector Spaces'), { label: 'ExamPrepView initial render' });
      await tty.flush();
      tty.send('T');
      const tblOut = await tty.waitFor(
        (s) => s.includes('排程与重点矩阵') && s.includes('缺口自动补齐步骤'),
        { label: 'ExamPrepView [T] schedule table and gap-fill steps' },
      );
      assert.match(tblOut, /日期.*阶段.*安排.*分钟/);
      assert.match(tblOut, /补齐缺题.*Vector Spaces/);
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount errors during teardown
      }
      tty.dispose();
    }
  });
});

describe('Round 94 Track C8 — DEC 1004 Focus Reporting & Low-Power Blur Throttle', () => {
  test('parses focus/blur CSI sequences, detects capability safely, and throttles background ticks 4x when blurred', async () => {
    // Verify DEC_FOCUS_ENABLE / DEC_FOCUS_DISABLE toggle DEC 1004 mode in a real terminal emulator
    const term = new Terminal({ allowProposedApi: true });
    const writeToTerm = (seq) => new Promise((resolve) => term.write(seq, resolve));
    try {
      assert.equal(term.modes.sendFocusMode, false);
      await writeToTerm(DEC_FOCUS_ENABLE);
      assert.equal(term.modes.sendFocusMode, true, 'DEC_FOCUS_ENABLE toggles terminal sendFocusMode on');
      await writeToTerm(DEC_FOCUS_DISABLE);
      assert.equal(term.modes.sendFocusMode, false, 'DEC_FOCUS_DISABLE toggles terminal sendFocusMode off');
    } finally {
      term.dispose();
    }
    assert.equal(parseTerminalFocusEvent('\x1b[I'), 'focus');
    assert.equal(parseTerminalFocusEvent('\x1b[O'), 'blur');
    assert.equal(parseTerminalFocusEvent('hello'), null);

    assert.equal(supportsFocusReporting({ env: { TERM: 'xterm-256color' }, isTTY: true }), true);
    assert.equal(supportsFocusReporting({ env: { TERM: 'dumb' }, isTTY: true }), false);
    assert.equal(supportsFocusReporting({ env: { TERM: 'xterm-256color' }, isTTY: false }), false);
    assert.equal(supportsFocusReporting({ env: { TERM: 'xterm-256color' }, isTTY: true, asciiMode: true }), false);

    assert.equal(resolveAdaptiveTickMs(true, 80), 80);
    assert.equal(resolveAdaptiveTickMs(false, 80), 320);
  });
});
