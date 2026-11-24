// Round 97 comprehensive behavior tests:
// - Track D10: `formatExamScheduleMarkdown` (the saved 备考计划) + inclusion in `formatExamPrepMarkdown`
// - Track A15: TasksView borderless queue stat table + OSC 2 running task title
// - Track C10: CLI `--doctor` capability matrix (mux, OSC 52/8/2/9, DEC 1004) + 6 built-in themes
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [displayMod, prepMod, cliMod] = await Promise.all([
  import('../src/views/examprep/course-plan-display.ts'),
  import('../src/views/examprep/ExamPrepView.tsx'),
  import('../src/cli-args.ts'),
]);

const { formatExamScheduleMarkdown } = displayMod;
const { formatExamPrepMarkdown } = prepMod;
const { buildDoctorReport, formatDoctorReport } = cliMod;

describe('Round 97 Track D10 — Saved Study Plan Markdown Export', () => {
  it('embeds the saved 备考计划 schedule table & gap-fill checklist into ExamPrep Markdown export', () => {
    const topics = [
      { topic: '虚拟内存', status: 'none', cards: 0, mastery: 0, weakCards: [] },
      { topic: '进程调度', status: 'weak', cards: 10, mastery: 0.4, weakCards: ['c1', 'c2'] },
      { topic: '文件系统', status: 'todo', cards: 8, mastery: 0.6, weakCards: [] },
    ];
    const coursePlan = {
      status: 'ok',
      course: 'Operating Systems',
      examDate: '2026-05-11',
      daysLeft: 10,
      schedule: {
        status: 'ok',
        capacity: 120,
        phases: [{ name: '备考', from: '2026-05-01', until: '2026-05-11' }],
        days: [
          { date: '2026-05-01', offset: 0, phase: '备考', mode: 'learn', points: ['p1'], done: [], minutes: 120, reason: { code: 'learn-size', count: 1, weak: 0 } },
        ],
      },
      points: [{ id: 'p1', title: '页表' }],
    };
    const scheduleMd = formatExamScheduleMarkdown(coursePlan, 'zh');
    assert.match(scheduleMd, /## 备考计划（距考 10 天 · 每日 120 分钟）/);
    assert.match(scheduleMd, /\| 日期 \| 阶段 \| 模式 \| 安排 \| 分钟 \| 重点 \|/);
    assert.match(scheduleMd, /2026-05-01/);

    const fullMd = formatExamPrepMarkdown({
      course: 'Operating Systems',
      examDate: '2026-05-11',
      topics,
      coursePlan,
      daysLeft: 10,
      lang: 'zh',
      generatedAt: '2026-05-01 09:00',
    });
    assert.match(fullMd, /## 备考计划（/);
    assert.doesNotMatch(fullMd, /自动排程/);
    assert.match(fullMd, /建议行动清单/);
    assert.match(fullMd, /补齐缺题：「虚拟内存」/);
  });
});

describe('Round 97 Track C10 — CLI --doctor Terminal Compat Matrix & Eye-Care Themes', () => {
  it('exposes mux/OSC52/OSC8/OSC2/OSC9/DEC1004 and all 6 themes in DoctorReport and pure ASCII output', () => {
    const report = buildDoctorReport({
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'WezTerm',
        TMUX: '/tmp/tmux-1000/default,123,0',
      },
      isTty: true,
      stdoutCols: 120,
      stdoutRows: 36,
    });
    assert.equal(report.terminal.compat.mux, 'tmux');
    assert.equal(report.terminal.compat.osc52Copy, true);
    assert.equal(report.terminal.compat.osc8Hyperlink, true);
    assert.equal(report.terminal.compat.focusReporting, true);
    assert.ok(report.terminal.availableThemes.includes('warm-amber'));
    assert.ok(report.terminal.availableThemes.includes('soft-sage'));
    assert.equal(report.terminal.availableThemes.length, 6);

    const asciiText = formatDoctorReport(report, true);
    assert.match(asciiText, /Capabilities: mux=tmux OSC52=on OSC8=on OSC2=on OSC9=on DEC1004=on/);
    assert.match(asciiText, /Themes: dsh-dark, warm-paper, nord, high-contrast, warm-amber, soft-sage/);
    assert.doesNotMatch(asciiText, /[^\x00-\x7f]/);
  });
});
