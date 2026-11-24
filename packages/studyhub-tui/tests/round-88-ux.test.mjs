// Round 88 comprehensive behavior & layout tests:
// - Track A7: Long-form reading typography (`longform.ts` reading time, heading breathing, relaxed/compact rhythm)
// - Track D4: Multi-step Assistant Workflow skeleton (`assistant-workflow.ts` "先 X 再 Y" parsing, zero invented
//             backend actions, step-by-step confirmation pausing on write steps, checklist formatting)
// - Track C5: tmux / screen / Windows Terminal / iTerm2 / WezTerm / dumb / NO_COLOR / ascii compatibility matrix
//             (`terminal-compat.ts` + OSC 52/8/2/9 passthrough verification)
// node --test tests/round-88-ux.test.mjs
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  longformMod,
  workflowMod,
  compatMod,
  clipMod,
] = await Promise.all([
  import('../src/render/longform.ts'),
  import('../src/shell/assistant-workflow.ts'),
  import('../src/render/terminal-compat.ts'),
  import('../src/render/clipboard.ts'),
]);

const { estimateReadingMinutes, formatReadingTimeLabel, formatLongformProse } = longformMod;
const {
  splitCompoundInstruction,
  planAssistantWorkflow,
  currentWorkflowStep,
  markWorkflowStepResult,
  cancelWorkflowPlan,
  formatWorkflowChecklist,
} = workflowMod;
const { detectMultiplexer, wrapMultiplexerPassthrough, probeTerminalCompatMatrix } = compatMod;
const { buildOsc52Sequence } = clipMod;

describe('Round 88 Track A7 — Long-form reading typography & rhythm', () => {
  test('estimates reading minutes for CJK/Latin and formats paragraphs with relaxed vs compact rhythm', () => {
    assert.equal(estimateReadingMinutes(''), 0);
    assert.equal(estimateReadingMinutes('短段落测试'), 1);
    assert.equal(estimateReadingMinutes('字'.repeat(1050)), 3);
    assert.equal(formatReadingTimeLabel('word '.repeat(440), 'en'), '~2 min read');
    assert.equal(formatReadingTimeLabel('字'.repeat(700), 'zh'), '约 2 分钟');

    const sample = '第 1 章 线性空间\n\n第一段介绍向量加法与数乘公理。\n\n\n\n第二段讨论线性无关与基的概念。';
    const relaxed = formatLongformProse(sample, 40, { relaxed: true });
    const compact = formatLongformProse(sample, 40, { relaxed: false });
    assert.ok(relaxed.includes(''), 'Relaxed long-form prose inserts 1-line breathing between paragraphs');
    assert.ok(relaxed.length > compact.length, 'Relaxed layout has more vertical breathing than compact layout');
    assert.ok(relaxed.every((line) => line.length <= 40), 'Every wrapped line stays within column width');
  });
});

describe('Round 88 Track D4 — Multi-step Assistant workflow skeleton (#1315 Phase 3)', () => {
  test('parses compound "先 X 再 Y" instructions via existing intents and enforces step-by-step confirmation', () => {
    // Single-step returns null (does not hijack ordinary commands)
    assert.equal(splitCompoundInstruction('跳到错题本'), null);

    // Chinese & English multi-step parsing
    assert.deepEqual(splitCompoundInstruction('先跳到资料第 12 页，再导出错题本'), ['跳到资料第 12 页', '导出错题本']);
    assert.deepEqual(splitCompoundInstruction('go to stats then open mistakes'), ['go to stats', 'open mistakes']);

    const plan = planAssistantWorkflow('先跳到资料第 12 页，再导出错题本', {
      snapshot: { sources: [{ id: 's1', title: 'Notes.pdf' }] },
      lang: 'zh',
    });
    assert.ok(plan);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].intent.kind, 'navigate');
    assert.equal(plan.steps[0].intent.requiresConfirm, false);
    assert.equal(plan.steps[1].intent.kind, 'write_confirm');
    assert.equal(plan.steps[1].intent.requiresConfirm, true);

    // Step 1 executes -> Step 2 automatically transitions to awaiting_confirm (P2 gate!)
    const afterStep1 = markWorkflowStepResult(plan, 'done', '已跳转');
    const step2 = currentWorkflowStep(afterStep1);
    assert.ok(step2);
    assert.equal(step2.index, 1);
    assert.equal(step2.status, 'awaiting_confirm');

    // Checklist renders cleanly in both Unicode & ASCII
    const asciiChecklist = formatWorkflowChecklist(afterStep1, 'zh', true);
    assert.match(asciiChecklist, /\[\+\] 1\./);
    assert.match(asciiChecklist, /\[\?\] 2\..*需确认/);

    // Cancellation terminates workflow cleanly
    const cancelled = cancelWorkflowPlan(afterStep1);
    assert.equal(currentWorkflowStep(cancelled), null);

    // #1339: ordinary questions containing semicolons or "然后"/"再" must NOT become multi-step workflows
    assert.equal(
      planAssistantWorkflow('讲讲 Memento；再讲讲 Bridge', { currentCardId: 'card-secret-id', lang: 'zh' }),
      null,
      'Plain questions separated by semicolon must return null so the full prompt goes to the model',
    );
    assert.equal(
      planAssistantWorkflow('先解释一下分页，然后说说分段的区别', { currentCardId: 'card-secret-id', lang: 'zh' }),
      null,
      'Plain questions using 先...然后 must return null when no executable action is present',
    );
  });
});

describe('Round 88 Track C5 — tmux / screen / terminal compatibility matrix', () => {
  test('detects tmux & screen, wraps DCS passthrough accurately, and verifies full environment matrix', () => {
    assert.equal(detectMultiplexer({ TMUX: '/tmp/tmux-1000/default,1,0' }), 'tmux');
    assert.equal(detectMultiplexer({ TERM: 'tmux-256color' }), 'tmux');
    assert.equal(detectMultiplexer({ STY: '4321.pts-0.host' }), 'screen');
    assert.equal(detectMultiplexer({ TERM: 'screen-256color' }), 'screen');
    assert.equal(detectMultiplexer({ TERM: 'xterm-256color' }), 'none');

    // tmux doubles ESC inside DCS Ptmux;...ST; screen wraps DCS P...ST
    const osc52Plain = buildOsc52Sequence('hi', { mux: 'none' });
    const osc52Tmux = buildOsc52Sequence('hi', { mux: 'tmux' });
    const osc52Screen = buildOsc52Sequence('hi', { mux: 'screen' });
    assert.equal(osc52Plain, '\x1b]52;c;aGk=\x07');
    assert.equal(osc52Tmux, '\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\');
    assert.equal(osc52Screen, '\x1bP\x1b]52;c;aGk=\x07\x1b\\');
    assert.equal(wrapMultiplexerPassthrough('\x1b]2;Title\x07', 'none'), '\x1b]2;Title\x07');

    // Full terminal compatibility matrix
    const wt = probeTerminalCompatMatrix({ env: { WT_SESSION: '1', TERM: 'xterm-256color' }, isTTY: true, platform: 'win32' });
    assert.deepEqual(wt, { mux: 'none', colorLevel: 3, osc52Copy: true, osc8Hyperlink: true, osc2Title: true, osc9Notify: true, sgrAltClick: true, focusReporting: true });

    const tmux = probeTerminalCompatMatrix({ env: { TMUX: '/tmp/t,1,0', TERM: 'tmux-256color', COLORTERM: 'truecolor' }, isTTY: true });
    assert.equal(tmux.mux, 'tmux');
    assert.equal(tmux.osc52Copy, true);
    assert.equal(tmux.osc8Hyperlink, true);
    assert.equal(tmux.osc2Title, true);

    const screen = probeTerminalCompatMatrix({ env: { STY: '123.pts', TERM: 'screen-256color' }, isTTY: true });
    assert.equal(screen.mux, 'screen');
    assert.equal(screen.colorLevel, 2);
    assert.equal(screen.osc52Copy, true);

    const dumb = probeTerminalCompatMatrix({ env: { TERM: 'dumb' }, isTTY: true });
    assert.deepEqual(dumb, { mux: 'none', colorLevel: 0, osc52Copy: false, osc8Hyperlink: false, osc2Title: false, osc9Notify: false, sgrAltClick: false, focusReporting: false });

    const noColor = probeTerminalCompatMatrix({ env: { WT_SESSION: '1', NO_COLOR: '1' }, isTTY: true });
    assert.equal(noColor.colorLevel, 0);
    assert.equal(noColor.osc8Hyperlink, false);
    assert.equal(noColor.osc2Title, false);
    assert.equal(noColor.osc9Notify, false);

    const ascii = probeTerminalCompatMatrix({ env: { WT_SESSION: '1' }, isTTY: true, asciiMode: true });
    assert.equal(ascii.osc8Hyperlink, false);
    assert.equal(ascii.osc2Title, false);
    assert.equal(ascii.osc9Notify, false);

    const nonTty = probeTerminalCompatMatrix({ env: { WT_SESSION: '1' }, isTTY: false });
    assert.equal(nonTty.osc52Copy, false);
    assert.equal(nonTty.osc8Hyperlink, false);
    assert.equal(nonTty.sgrAltClick, false);
  });
});
