// PR #1327 design fix: the exam-prep countdown bar, the [T] table and the Markdown export show the saved 备考计划
// (the backend `course.plan` response), never a schedule computed inside the TUI.
// node --test tests/exam-plan-from-backend.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [displayMod, coverageMod, alertMod, tokensMod, cjkMod, { ExamPrepView, formatExamPrepMarkdown }, storeMod] =
  await Promise.all([
    import('../src/views/examprep/course-plan-display.ts'),
    import('../src/views/examprep/exam-coverage.ts'),
    import('../src/views/examprep/exam-gap-alert.ts'),
    import('../src/theme/tokens.ts'),
    import('../src/render/cjk.ts'),
    import('../src/views/examprep/ExamPrepView.tsx'),
    import('../src/state/store.ts'),
  ]);

const { formatExamCountdownSummary, renderExamScheduleTable, formatExamScheduleMarkdown } = displayMod;
const { buildExamCoverage, buildGapFillWorkflowSteps } = coverageMod;
const { buildExamGapAlert } = alertMod;
const { getTheme } = tokensMod;
const { displayWidth } = cjkMod;
const { useTuiStore } = storeMod;

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
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
    async waitFor(pred, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const plain = stripAnsi(output);
        if (pred(plain)) return plain;
        await wait(20);
      }
      throw new Error(`waitFor timed out. Last output:\n${stripAnsi(output).slice(-1200)}`);
    },
  };
}

// A saved plan as `course.plan` answers it: 180 min/day, weekends off, one mock day (lib/plan-schedule.js shape).
const day = (date, offset, fields) => ({ date, offset, phase: '夯实基础', mock: false, points: [], done: [], minutes: 0, ...fields });
const learnToday = day('2026-12-01', 0, {
  mode: 'learn',
  points: ['p1', 'p2', 'p3'],
  minutes: 180,
  reason: { code: 'learn-size', count: 3, weak: 1, minutes: 180 },
});
const PLAN_OK = {
  status: 'ok',
  course: 'Operating Systems',
  examDate: '2026-12-20',
  daysLeft: 19,
  today: '2026-12-01',
  plan: { version: 1, minutesPerDay: 180, studyWeekdays: [1, 2, 3, 4, 5], mockDates: ['2026-12-07'] },
  schedule: {
    status: 'ok',
    examDate: '2026-12-20',
    today: '2026-12-01',
    daysLeft: 19,
    capacity: 180,
    phases: [
      { name: '夯实基础', from: '2026-12-01', until: '2026-12-06' },
      { name: '冲刺模考', from: '2026-12-07', until: '2026-12-20', goal: '全真模拟' },
    ],
    days: [
      day('2026-11-30', -1, { mode: 'learn', points: ['p0'], done: ['p0'], minutes: 40, reason: { code: 'done', count: 1 } }),
      learnToday,
      day('2026-12-02', 1, { mode: 'learn', points: ['p4'], minutes: 150, reason: { code: 'learn-size', count: 1, weak: 0, minutes: 150 } }),
      day('2026-12-05', 4, { mode: 'off', reason: { code: 'weekday' } }),
      day('2026-12-06', 5, { mode: 'off', reason: { code: 'weekday' } }),
      day('2026-12-07', 6, { mode: 'mock', phase: '冲刺模考', mock: true, reason: { code: 'mock' } }),
    ],
  },
  points: [
    { id: 'p1', title: '死锁' },
    { id: 'p2', title: '虚拟内存' },
    { id: 'p3', title: '进程调度' },
    { id: 'p4', title: '文件系统' },
  ],
};
PLAN_OK.schedule.today = learnToday;

const PLAN_NONE = { status: 'no-plan', course: 'Operating Systems', examDate: '2026-12-20', today: '2026-12-01', plan: null };

describe('course.plan display formatter (no schedule arithmetic in the TUI)', () => {
  test('countdown line states the saved plan: exam date, days left, phase, today minutes', () => {
    const line = formatExamCountdownSummary(PLAN_OK, 'zh', true);
    assert.match(line, /备考计划/);
    assert.match(line, /2026-12-20/);
    assert.match(line, /19/);
    assert.match(line, /夯实基础/);
    assert.match(line, /180/);
    assert.doesNotMatch(line, /自动|倒推|日均/, 'the saved plan is not an automatic schedule');
    assert.match(formatExamCountdownSummary(PLAN_OK, 'en', true), /Study plan.*2026-12-20.*180/);
  });

  test('no plan: one line that says so and names the key that opens the plan modal; nothing is invented', () => {
    const zh = formatExamCountdownSummary(PLAN_NONE, 'zh', true);
    assert.match(zh, /还没有备考计划/);
    assert.match(zh, /\[P\]/);
    assert.match(formatExamCountdownSummary(PLAN_NONE, 'en', true), /No study plan yet.*\[P\]/);
    const theme = getTheme('warm-amber');
    assert.deepEqual(renderExamScheduleTable(PLAN_NONE, 60, theme, { lang: 'zh', ascii: true }), []);
    const md = formatExamScheduleMarkdown(PLAN_NONE, 'zh');
    assert.match(md, /还没有备考计划/);
    assert.doesNotMatch(md, /\|/, 'no table without a plan');
  });

  test('unknown or failed answers and past exams render nothing (no placeholder schedule)', () => {
    for (const resp of [null, undefined, {}, { status: 'no-course', course: null }, { status: 'past', examDate: '2020-01-01' }]) {
      assert.equal(formatExamCountdownSummary(resp, 'zh', true), '');
    }
  });

  test('plan saved but not schedulable (no exam date / no book) says why instead of faking days', () => {
    assert.match(formatExamCountdownSummary({ status: 'no-exam', plan: {} }, 'zh', true), /考试日期/);
    assert.match(formatExamCountdownSummary({ status: 'no-book', plan: {} }, 'zh', true), /复习全书/);
  });

  test('table lists the backend days from today on (past days dropped) at exact width', () => {
    const theme = getTheme('warm-amber');
    const lines = renderExamScheduleTable(PLAN_OK, 64, theme, { lang: 'zh', ascii: true });
    assert.equal(lines.length, 2 + 5, 'header + rule + the 5 days from today on');
    for (const l of lines) assert.equal(displayWidth(stripAnsi(l)), 64);
    const text = stripAnsi(lines.join('\n'));
    assert.match(text, /日期.*阶段.*安排.*分钟/);
    assert.match(text, /2026-12-01.*夯实基础.*精学.*180/);
    assert.match(text, /2026-12-05.*休息/);
    assert.match(text, /2026-12-07.*冲刺模考.*模考/);
    assert.doesNotMatch(text, /2026-11-30/);
  });

  test('Markdown section is the saved plan, never labelled as an automatic schedule', () => {
    const md = formatExamScheduleMarkdown(PLAN_OK, 'zh');
    assert.match(md, /^## 备考计划/);
    assert.doesNotMatch(md, /自动排程|倒推/);
    assert.match(md, /180/);
    assert.match(md, /\| 2026-12-01 \| 夯实基础 \| 精学 \|/);
    assert.match(md, /死锁、虚拟内存、进程调度/);
    assert.match(md, /\| 2026-12-07 \| 冲刺模考 \| 模考 \|/);
    assert.match(formatExamScheduleMarkdown(PLAN_OK, 'en'), /^## Study Plan/);
  });
});

describe('coverage gaps are not a schedule', () => {
  const topics = [
    { topic: 'Integrals', status: 'none', cards: 0, mastery: 0, weakCards: [] },
    { topic: 'Series', status: 'weak', cards: 6, mastery: 0.2, weakCards: [{ deckId: 'd1', cardId: 'c9' }] },
    { topic: 'Limits', status: 'done', cards: 6, mastery: 0.9, weakCards: [] },
  ];

  test('buildExamCoverage classifies topics and takes days-left from the backend', () => {
    const cov = buildExamCoverage(topics, 6);
    assert.deepEqual(cov, { daysLeft: 6, status: 'ok', gapTopics: ['Integrals'], weakTopics: ['Series'] });
    assert.equal(buildExamCoverage(topics, 0).status, 'today');
    assert.equal(buildExamCoverage(topics, -2).status, 'past');
    assert.equal(buildExamCoverage(topics, null), null);
    assert.equal(buildExamCoverage(topics, undefined), null);
  });

  test('gap alert still fires inside 14 days from that coverage and honors the three guardrails', () => {
    const near = buildExamCoverage(topics, 6);
    const alert = buildExamGapAlert({ plan: near, proactiveHints: true, dismissed: false, lang: 'zh', asciiMode: true });
    assert.ok(alert && alert.urgent);
    assert.match(alert.message, /考期预警（剩 6 天）.*缺题 1 项/);
    assert.equal(buildExamGapAlert({ plan: near, proactiveHints: false, dismissed: false, lang: 'zh', asciiMode: true }), null);
    assert.equal(buildExamGapAlert({ plan: near, proactiveHints: true, dismissed: true, lang: 'zh', asciiMode: true }), null);
    assert.equal(
      buildExamGapAlert({ plan: buildExamCoverage(topics, 30), proactiveHints: true, dismissed: false, lang: 'zh', asciiMode: true }),
      null,
    );
  });

  test('gap-fill steps: AI generation needs confirmation, weak drills do not, and no mock date is invented', () => {
    const steps = buildGapFillWorkflowSteps(buildExamCoverage(topics, 6), 'zh');
    assert.deepEqual(steps.map((s) => s.kind), ['generate_gap', 'drill_weak']);
    assert.equal(steps[0].requiresConfirm, true);
    assert.equal(steps[1].requiresConfirm, false);
    assert.deepEqual(buildGapFillWorkflowSteps(null, 'zh'), []);
  });
});

describe('Markdown export carries the saved plan', () => {
  const topics = [{ topic: '死锁', status: 'weak', cards: 6, mastery: 0.3, weakCards: [{ deckId: 'd', cardId: 'c' }] }];

  test('plan section comes from coursePlan; the exam date comes from the backend result passed in', () => {
    const md = formatExamPrepMarkdown({
      course: 'Operating Systems',
      examDate: PLAN_OK.examDate,
      topics,
      coursePlan: PLAN_OK,
      daysLeft: PLAN_OK.daysLeft,
      lang: 'zh',
      generatedAt: '2026-12-01 09:00',
    });
    assert.match(md, /考试日期\*\*: 2026-12-20/);
    assert.match(md, /## 备考计划（/);
    assert.doesNotMatch(md, /自动排程/);
    assert.match(md, /建议行动清单/);
  });

  test('no saved plan: one line, no schedule table; gap actions still listed', () => {
    const md = formatExamPrepMarkdown({
      course: 'Operating Systems',
      examDate: PLAN_NONE.examDate,
      topics: [...topics, { topic: '虚拟内存', status: 'none', cards: 0, mastery: 0, weakCards: [] }],
      coursePlan: PLAN_NONE,
      daysLeft: 19,
      lang: 'zh',
      generatedAt: '2026-12-01 09:00',
    });
    assert.match(md, /还没有备考计划/);
    assert.doesNotMatch(md, /\| 日期 \|/);
    assert.match(md, /补齐缺题：「虚拟内存」/);
  });

  test('plan not fetched (null): no plan section at all', () => {
    const md = formatExamPrepMarkdown({ course: 'OS', topics, coursePlan: null, lang: 'zh', generatedAt: '2026-12-01 09:00' });
    assert.doesNotMatch(md, /备考计划（|还没有备考计划/);
  });
});

describe('ExamPrepView reads course.plan with its other loads', () => {
  const topics = [
    { topic: '死锁', status: 'done', cards: 6, mastery: 0.95, weakCards: [], counts: {} },
    { topic: '虚拟内存', status: 'done', cards: 6, mastery: 0.9, weakCards: [], counts: {} },
  ];

  function makeHost(planValue, calls) {
    return {
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp',
      async call(action, payload) {
        calls.push({ action, payload });
        if (action === 'course.focusProgress') {
          return { ok: true, value: { course: 'Operating Systems', topics, total: 2, done: 2, weak: 0, none: 0, weakScope: [] } };
        }
        if (action === 'book.crunch') {
          return { ok: true, value: { status: 'ok', course: 'Operating Systems', examDate: '2026-12-20', daysLeft: 19, points: [] } };
        }
        // A child course: its own record carries a different (stale) date; the backend resolves inheritance.
        if (action === 'course.get') return { ok: true, value: { name: 'Operating Systems', exam: { date: '2099-01-01' } } };
        if (action === 'course.plan') return { ok: true, value: planValue };
        return { ok: true, value: {} };
      },
    };
  }

  function mount(host) {
    useTuiStore.setState({
      page: 'examprep',
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true, proactiveHints: true },
      snapshot: { focus: { course: 'Operating Systems' }, courses: [{ name: 'Operating Systems' }] },
    });
    const tty = createTtyHarness(120, 36);
    const inst = render(React.createElement(ExamPrepView, { host, width: 116, height: 34, isActive: true }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    return { tty, inst };
  }

  test('bar and [T] table show the saved plan; the date is the backend one, not courseRecord.exam.date', async () => {
    const calls = [];
    const { tty, inst } = mount(makeHost(PLAN_OK, calls));
    const bar = await tty.waitFor((s) => s.includes('2026-12-20') && s.includes('夯实基础'));
    assert.doesNotMatch(bar, /2099-01-01/);
    assert.ok(calls.some((c) => c.action === 'course.plan' && c.payload?.course === 'Operating Systems'));
    tty.stdin.write('T');
    const tbl = await tty.waitFor((s) => s.includes('排程与重点矩阵') && /日期.*阶段.*安排.*分钟/.test(s));
    assert.match(tbl, /2026-12-05.*休息/);
    assert.match(tbl, /2026-12-07.*模考/);
    assert.doesNotMatch(tbl, /主攻重点|题量/, 'no card-per-day quota columns any more');
    inst.unmount();
  });

  test('no plan: the bar says there is no 备考计划 and that [P] opens it', async () => {
    const calls = [];
    const { tty, inst } = mount(makeHost(PLAN_NONE, calls));
    const bar = await tty.waitFor((s) => s.includes('还没有备考计划'));
    assert.match(bar, /\[P\]/);
    inst.unmount();
  });
});

describe('the TUI no longer owns a second scheduler', () => {
  test('exam-planner.ts is gone and nothing under src imports it', () => {
    assert.equal(fs.existsSync(path.join(pkgRoot, 'src/views/examprep/exam-planner.ts')), false);
    const stack = [path.join(pkgRoot, 'src')];
    const offenders = [];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && /exam-planner/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
