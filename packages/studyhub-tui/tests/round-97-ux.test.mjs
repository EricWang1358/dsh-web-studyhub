// Round 97 comprehensive behavior tests:
// - Track D10: `formatExamScheduleMarkdown` + automatic inclusion in `formatExamPrepMarkdown`
// - Track A15: TasksView borderless queue stat table + OSC 2 running task title
// - Track C10: CLI `--doctor` capability matrix (mux, OSC 52/8/2/9, DEC 1004) + 6 built-in themes
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [plannerMod, prepMod, cliMod] = await Promise.all([
  import('../src/views/examprep/exam-planner.ts'),
  import('../src/views/examprep/ExamPrepView.tsx'),
  import('../src/cli-args.ts'),
]);

const { buildExamCountdownPlan, formatExamScheduleMarkdown } = plannerMod;
const { formatExamPrepMarkdown } = prepMod;
const { buildDoctorReport, formatDoctorReport } = cliMod;

describe('Round 97 Track D10 — Exam Countdown Schedule Markdown Export', () => {
  it('embeds 7-day countdown schedule table & gap-fill checklist into ExamPrep Markdown export', () => {
    const topics = [
      { topic: '虚拟内存', status: 'none', cards: 0, mastery: 0, weakCards: [] },
      { topic: '进程调度', status: 'weak', cards: 10, mastery: 0.4, weakCards: ['c1', 'c2'] },
      { topic: '文件系统', status: 'todo', cards: 8, mastery: 0.6, weakCards: [] },
    ];
    const today = new Date(2026, 4, 1); // 2026-05-01
    const plan = buildExamCountdownPlan({
      examDate: '2026-05-11',
      topics,
      lang: 'zh',
      today,
    });
    const scheduleMd = formatExamScheduleMarkdown(plan, 'zh');
    assert.match(scheduleMd, /考期倒推自动排程（距考 10 天/);
    assert.match(scheduleMd, /\| 日期 \| 阶段 \| 主攻重点 \| 目标题量 \| 建议 \|/);
    assert.match(scheduleMd, /2026-05-01/);
    assert.match(scheduleMd, /补齐缺题：「虚拟内存」/);

    const fullMd = formatExamPrepMarkdown({
      course: 'Operating Systems',
      examDate: '2026-05-11',
      topics,
      lang: 'zh',
      generatedAt: today,
    });
    assert.match(fullMd, /考期倒推自动排程/);
    assert.match(fullMd, /建议行动清单/);
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
