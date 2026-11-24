// Round 96 comprehensive behavior & layout tests:
// - Track C9: OSC 2 exam & background task window titles (`terminal-title.ts` + `ExamRunner.tsx`)
// - Track A14: ExamReportView borderless `renderStatTable` breakdown at 120x36 & 80x24 ASCII
// - Track B10: Natural-language routing for exam planning, eye-care themes, and density
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [titleMod, intentMod, paletteMod, reportMod, storeMod] = await Promise.all([
  import('../src/render/terminal-title.ts'),
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/views/exam/ExamReportView.tsx'),
  import('../src/state/store.ts'),
]);

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const { buildExamWindowTitle, buildTaskProgressTitle, formatOsc2Title } = titleMod;
const { parseAssistantIntent } = intentMod;
const { buildNaturalLanguagePaletteItem } = paletteMod;
const { ExamReportView } = reportMod;
const { useTuiStore } = storeMod;

function makeStream(columns, rows) {
  const s = new PassThrough();
  s.columns = columns;
  s.rows = rows;
  s.isTTY = true;
  let buf = '';
  s.on('data', (chunk) => {
    buf += chunk.toString('utf8');
  });
  return { stream: s, getOutput: () => stripAnsi(buf) };
}

describe('Round 96 Track C9 — OSC 2 Exam & Task Window Title Helpers', () => {
  it('builds sanitized OSC 2 titles for written/case/oral exams and background tasks', () => {
    const zh = buildExamWindowTitle({ kind: 'written', at: 3, total: 20, timerText: '14:32', lang: 'zh' });
    assert.equal(zh, 'StudyHub · 模考 3/20 · 14:32');

    const en = buildExamWindowTitle({ kind: 'oral', at: 2, total: 5, timerText: '02:10', lang: 'en' });
    assert.equal(en, 'StudyHub · Oral 2/5 · 02:10');

    const taskTitle = buildTaskProgressTitle({ runningCount: 2, label: '生成题组\x1b[31m', lang: 'zh' });
    assert.equal(taskTitle, 'StudyHub · 2 项任务运行中 · 生成题组 [31m');
    assert.equal(buildTaskProgressTitle({ runningCount: 0, lang: 'en' }), 'StudyHub');

    const osc = formatOsc2Title(zh);
    assert.ok(osc.startsWith('\x1b]2;') && osc.endsWith('\x07'));
  });
});

describe('Round 96 Track A14 — ExamReportView Borderless Stat Table (120x36 & 80x24 ASCII)', () => {
  it('renders aligned borderless byKind breakdown table cleanly in both 120x36 and 80x24 ASCII', async () => {
    const reportState = {
      kind: 'written',
      report: {
        scorePct: 75,
        correct: 15,
        total: 20,
        durationMs: 420_000,
        byKind: [
          { kind: 'single', correct: 10, total: 12 },
          { kind: 'multi', correct: 3, total: 5 },
          { kind: 'truefalse', correct: 2, total: 3 },
        ],
        byTopic: [{ topic: 'OS', correct: 15, total: 20 }],
        wrong: [{ deckId: 'd1', cardId: 'c1', topic: 'OS', prompt: 'Paging vs segmentation?' }],
        skipped: [],
        weakScope: [{ deckId: 'd1', cardId: 'c1' }],
      },
    };

    for (const [cols, rows, asciiMode] of [
      [120, 36, false],
      [80, 24, true],
    ]) {
      useTuiStore.getState().setPreferences({ language: 'zh', asciiMode });
      const { stream, getOutput } = makeStream(cols, rows);
      const inst = render(
        React.createElement(ExamReportView, {
          state: reportState,
          width: cols,
          height: rows,
          lang: 'zh',
          isActive: false,
          busy: false,
          onPracticeWeak: () => {},
          onBack: () => {},
        }),
        { stdout: stream, interactive: true },
      );
      await new Promise((r) => setTimeout(r, 30));
      const out = getOutput();
      inst.unmount();

      assert.match(out, /题型/);
      assert.match(out, /正确率/);
      assert.match(out, /单选/);
      assert.match(out, /10\/12/);
      assert.match(out, /83%/);
      if (asciiMode) {
        assert.doesNotMatch(out, /[─═┌┐└┘│]/);
      }
    }
    useTuiStore.getState().setPreferences({ asciiMode: false });
  });
});

describe('Round 96 Track B10 — Natural Language Exam Planning, Eye-Care Theme & Density', () => {
  it('parses exam countdown plan, warm-amber/soft-sage eye-care themes, and compact/relaxed density', () => {
    const planIntent = parseAssistantIntent('帮我按考期倒推排备考计划', { lang: 'zh' });
    assert.equal(planIntent.kind, 'navigate');
    assert.equal(planIntent.page, 'examprep');

    const amberIntent = parseAssistantIntent('切换夜间护眼主题', { lang: 'zh' });
    assert.equal(amberIntent.kind, 'set_preference');
    assert.equal(amberIntent.patch.theme, 'warm-amber');

    const sageIntent = parseAssistantIntent('切换低对比度护眼浅绿', { lang: 'zh' });
    assert.equal(sageIntent.kind, 'set_preference');
    assert.equal(sageIntent.patch.theme, 'soft-sage');

    const compactIntent = parseAssistantIntent('开启紧凑模式', { lang: 'zh' });
    assert.equal(compactIntent.kind, 'set_preference');
    assert.equal(compactIntent.patch.compactMode, true);

    const relaxedIntent = parseAssistantIntent('switch to relaxed mode', { lang: 'en' });
    assert.equal(relaxedIntent.kind, 'set_preference');
    assert.equal(relaxedIntent.patch.compactMode, false);

    // CommandPalette NL execution applies set_preference directly
    const prevTheme = useTuiStore.getState().preferences.theme;
    const item = buildNaturalLanguagePaletteItem('切换夜间护眼主题', { snapshot: null, lang: 'zh', asciiMode: false });
    assert.ok(item);
    assert.equal(item.id, 'nl:preferences.set');
    item.action();
    assert.equal(useTuiStore.getState().preferences.theme, 'warm-amber');
    useTuiStore.getState().setPreferences({ theme: prevTheme });
  });
});
