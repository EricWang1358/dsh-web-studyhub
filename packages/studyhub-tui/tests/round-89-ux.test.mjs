// Round 89 comprehensive behavior & layout tests:
// - Track A8: Borderless CJK-aware `renderStatTable` with exact column widths, right-aligned numbers,
//             pure ASCII & NO_COLOR safety across 80-col and 120-col viewports
// - Track B6: CommandPalette natural-language execution (`buildNaturalLanguagePaletteItem` sharing
//             `parseAssistantIntent` & `planAssistantWorkflow` with #1315, enforcing P2 confirmation)
// - Track D5: Proactive Round Completion Next-Step Suggestion (`round-next-step.ts` + `RoundSummary`
//             rendering with disable toggle `proactiveHints=false`, accuracy/weak/due branching)
// node --test tests/round-89-ux.test.mjs
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
  chartsMod,
  cjkMod,
  tokensMod,
  paletteMod,
  nextStepMod,
  { RoundSummary },
  storeMod,
] = await Promise.all([
  import('../src/render/charts.ts'),
  import('../src/render/cjk.ts'),
  import('../src/theme/tokens.ts'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/views/review/round-next-step.ts'),
  import('../src/views/review/RoundSummary.tsx'),
  import('../src/state/store.ts'),
]);

const { renderStatTable } = chartsMod;
const { displayWidth } = cjkMod;
const { getTheme, setColorLevel, getColorLevel } = tokensMod;
const { buildNaturalLanguagePaletteItem } = paletteMod;
const { buildRoundNextStepSuggestion } = nextStepMod;
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

describe('Round 89 Track A8 — Borderless CJK-aligned Stat Table typography', () => {
  test('maintains exact displayWidth across CJK + numeric columns in Unicode, ASCII, and NO_COLOR modes', () => {
    const theme = getTheme('soft-sage');
    const cols = [
      { key: 'course', label: '课程', align: 'left' },
      { key: 'due', label: '待复习', align: 'right' },
      { key: 'mastery', label: '掌握度', align: 'right' },
    ];
    const rows = [
      { course: '线性代数与矩阵分析', due: 12, mastery: '84%' },
      { course: 'Probability & Statistics', due: 3, mastery: '92%' },
    ];

    for (const width of [40, 76, 116]) {
      const uniLines = renderStatTable(cols, rows, width, theme, { ascii: false });
      assert.equal(uniLines.length, 4);
      for (const l of uniLines) {
        assert.equal(displayWidth(stripAnsi(l)), width, `Unicode table line width must equal ${width}`);
      }

      const asciiLines = renderStatTable(cols, rows, width, theme, { ascii: true });
      for (const l of asciiLines) {
        const plain = stripAnsi(l);
        assert.equal(displayWidth(plain), width, `ASCII table line width must equal ${width}`);
        assert.equal(/[─│╭╮╰╯…]/u.test(plain), false, 'ASCII table must emit zero Unicode box chrome');
      }
    }

    // NO_COLOR safety
    const prevLevel = getColorLevel();
    setColorLevel(0);
    try {
      const plainLines = renderStatTable(cols, rows, 50, theme, { ascii: true });
      assert.ok(plainLines.every((l) => !l.includes('\x1b')), 'NO_COLOR must emit zero ANSI escapes');
    } finally {
      setColorLevel(prevLevel);
    }
  });
});

describe('Round 89 Track B6 — CommandPalette Natural Language (shared #1315 parser)', () => {
  test('synthesizes NL action items for navigation, guided study, write-confirm, and multi-step workflows', () => {
    const snap = { sources: [{ id: 's1', title: 'LinearAlgebra.pdf' }] };
    const baseCtx = { snapshot: snap, lang: 'zh', asciiMode: true };

    // Slash commands & tiny queries return null (never hijack normal palette filtering)
    assert.equal(buildNaturalLanguagePaletteItem('/theme', baseCtx), null);
    assert.equal(buildNaturalLanguagePaletteItem('a', baseCtx), null);

    // Navigation NL -> executes direct navigation
    useTuiStore.setState({ page: 'library', navContext: null });
    const navItem = buildNaturalLanguagePaletteItem('跳到资料第 12 页', baseCtx);
    assert.ok(navItem);
    assert.match(navItem.label, /第 12 页|sources/i);
    navItem.action();
    assert.equal(useTuiStore.getState().page, 'sources');
    assert.equal(useTuiStore.getState().navContext?.pageNumber, 12);

    // Write NL -> routes to AssistantPanel (NEVER bypasses P2 confirmation)
    useTuiStore.setState({ assistantOpen: false });
    const writeItem = buildNaturalLanguagePaletteItem('导出错题本', baseCtx);
    assert.ok(writeItem);
    assert.match(writeItem.hint, /确认/);
    writeItem.action();
    assert.equal(useTuiStore.getState().assistantOpen, true);

    // Multi-step NL -> recognized as multi-step workflow item
    const wfItem = buildNaturalLanguagePaletteItem('先跳到错题本，再导出错题本', baseCtx);
    assert.ok(wfItem);
    assert.equal(wfItem.id, 'nl:workflow');
    assert.match(wfItem.label, /多步执行 \(2 步\)/);

    // #1340: search queries like "step 2", "app 3", "过去统计的方法" must NOT produce bogus NL navigation items
    assert.equal(buildNaturalLanguagePaletteItem('step 2', baseCtx), null);
    assert.equal(buildNaturalLanguagePaletteItem('app 3', baseCtx), null);
    assert.equal(buildNaturalLanguagePaletteItem('过去统计的方法', baseCtx), null);
  });
});

describe('Round 89 Track D5 — Proactive Round Completion Next-Step Suggestion', () => {
  test('selects contextual next step (weak > due > recap > all_clear), honors disable switch, and renders in RoundSummary', async () => {
    assert.equal(
      buildRoundNextStepSuggestion({
        answered: 5,
        correct: 2,
        weakCount: 3,
        weakTopics: ['Eigenvalues'],
        remainingDue: 4,
        lang: 'zh',
        asciiMode: true,
        proactiveHints: false,
      }),
      null,
      'Disable toggle must suppress suggestion',
    );

    const weakSug = buildRoundNextStepSuggestion({
      answered: 5,
      correct: 2,
      weakCount: 3,
      weakTopics: ['Eigenvalues'],
      remainingDue: 4,
      lang: 'zh',
      asciiMode: true,
      proactiveHints: true,
    });
    assert.equal(weakSug?.kind, 'retry_weak');
    assert.match(weakSug.text, /\[w\].*3 道错题.*Eigenvalues/);

    const dueSug = buildRoundNextStepSuggestion({
      answered: 5,
      correct: 5,
      weakCount: 0,
      weakTopics: [],
      remainingDue: 8,
      lang: 'zh',
      asciiMode: true,
      proactiveHints: true,
    });
    assert.equal(dueSug?.kind, 'continue_due');
    assert.match(dueSug.text, /\[R\].*8 道到期题/);

    // Live RoundSummary render at 120x36 & 80x24 ASCII
    const mockRun = {
      id: 'run-r89',
      title: 'Linear Algebra',
      mode: 'path',
      status: 'finished',
      total: 5,
      answered: 5,
      index: 4,
      summary: { answered: 5, correct: 2, accuracy: 40, weakTopics: ['Eigenvalues'] },
    };
    const host = {
      async call(action) {
        if (action === 'review.lookBack') {
          return {
            ok: true,
            value: {
              rows: [
                { number: 1, cardId: 'c1', status: 'wrong', prompt: 'Q1', card: { topic: 'Eigenvalues' } },
                { number: 2, cardId: 'c2', status: 'wrong', prompt: 'Q2', card: { topic: 'Eigenvalues' } },
              ],
            },
          };
        }
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true, proactiveHints: true },
      snapshot: { decks: [{ id: 'd1', due: 4 }] },
    });

    const wideTty = createTtyHarness(120, 36);
    const wide = render(
      React.createElement(RoundSummary, { host, run: mockRun, width: 116, height: 34, isActive: true, mathUnicode: false }),
      { stdout: wideTty.stdout, stdin: wideTty.stdin, exitOnCtrlC: false, interactive: true },
    );
    const wideOut = await wideTty.waitFor((s) => s.includes('下一步建议'));
    assert.match(wideOut, /下一步建议.*\[w\]/);
    wide.unmount();

    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(
      React.createElement(RoundSummary, { host, run: mockRun, width: 76, height: 22, isActive: true, mathUnicode: false }),
      { stdout: narrowTty.stdout, stdin: narrowTty.stdin, exitOnCtrlC: false, interactive: true },
    );
    const narrowOut = await narrowTty.waitFor((s) => s.includes('本轮练习总结'));
    assert.match(narrowOut, /下一步建议/);
    narrow.unmount();
  });
});
