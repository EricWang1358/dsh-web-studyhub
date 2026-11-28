// Regression & behavior tests for #1460:
// Multi-line code-block cloze input, display indentation, diff rendering,
// cross-parity with `lib/cloze-text.js`, and real `lib/domain.js` grading round-trip.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import React, { useState } from 'react';
import { render } from 'ink';
import { register } from 'tsx/esm/api';
import { codeBlockBlankLangs as libCodeBlockBlankLangs } from '../../../lib/cloze-text.js';
import { gradeCloze } from '../../../lib/domain.js';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [helpersMod, answerMod, feedbackMod, storeMod] = await Promise.all([
  import('../src/views/review/review-helpers.ts'),
  import('../src/views/review/ReviewAnswerInput.tsx'),
  import('../src/views/review/ReviewFeedbackSections.tsx'),
  import('../src/state/store.ts'),
]);

const { codeBlockBlankLangs, resolveClozeBlanks, formatClozeDisplay, buildClozeBlankDiffs } = helpersMod;
const { ReviewAnswerInput } = answerMod;
const { ReviewFeedbackHeader } = feedbackMod;
const { useTuiStore } = storeMod;

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createInkHarness(element, { columns = 100, rows = 28 } = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns, rows });
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  return {
    send: (s) => stdin.write(s),
    getOutput: () => stripAnsi(output),
    cleanup: () => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe('#1460 — Multi-line code-block cloze detection, display, input & grading', () => {
  test('1. TUI codeBlockBlankLangs matches lib/cloze-text.js across backticks, tildes, untagged fences & inline code', () => {
    const samples = [
      '补全循环：\n```python\n{{b1}}\n```',
      '混合：\n~~~js\nfunction f() {\n  {{c1}}\n}\n~~~\n文内 `{{inline1}}` 与 {{prose1}}',
      '无语言标签：\n```\n{{u1}}\n{{ u2 }}\n```',
      '只有行内代码 `{{b1}}` 和普通填空 {{b2}}',
    ];
    for (const sample of samples) {
      const expected = [...libCodeBlockBlankLangs(sample).entries()];
      const actual = [...codeBlockBlankLangs(sample).entries()];
      assert.deepEqual(actual, expected, `mismatch on sample:\n${sample}`);
    }

    // Explicit `code: true` blank flag (matching lib/domain.js gradeCloze) also enables code mode
    const flagged = resolveClozeBlanks({
      cloze: {
        text: '填写代码：{{b1}} 和术语 {{b2}}',
        blanks: [{ id: 'b1', code: true }, { id: 'b2' }],
      },
    });
    assert.equal(flagged.blanks[0].inCodeBlock, true);
    assert.equal(flagged.blanks[1].inCodeBlock, undefined);
  });

  test('2. formatClozeDisplay preserves indentation, omits ** inside fenced code blocks, and keeps prose single-line format', () => {
    const clozeText = '补全函数体：\n```python\ndef show(xs):\n    {{b1}}\n```\n复杂度是 {{b2}}。';
    const clozeData = resolveClozeBlanks({
      cloze: { text: clozeText, blanks: [{ id: 'b1' }, { id: 'b2' }] },
    });
    assert.equal(clozeData.blanks[0].inCodeBlock, true);
    assert.equal(clozeData.blanks[0].codeLang, 'python');
    assert.equal(clozeData.blanks[1].inCodeBlock, undefined);

    const expectedCode = 'for x in xs:\n    print(x)';
    const solution = {
      cloze: {
        answers: [
          { id: 'b1', value: expectedCode },
          { id: 'b2', value: 'O(n)' },
        ],
      },
    };

    // Revealed with multi-line expected inside indented code block: aligned to 4-space base indent, zero literal **
    const revealedOut = formatClozeDisplay(clozeText, clozeData.blanks, {}, true, solution, true);
    assert.ok(!revealedOut.includes('**for x in xs:'), 'must never emit literal ** inside fenced code block');
    assert.ok(revealedOut.includes('    [#1]\n    for x in xs:\n        print(x)'), `unexpected code block reveal:\n${revealedOut}`);
    // Prose blank still uses bold expected
    assert.ok(revealedOut.includes('[#2: **O(n)**]'), `prose blank should keep bold formatting:\n${revealedOut}`);

    // Revealed with different multi-line user answer shows aligned user -> expected lines
    const wrongUser = 'for x in xs:\n    pass';
    const diffOut = formatClozeDisplay(clozeText, clozeData.blanks, { b1: wrongUser, b2: 'O(1)' }, true, solution, true);
    assert.ok(
      diffOut.includes('    [#1]\n    for x in xs:\n        pass\n    ->\n    for x in xs:\n        print(x)'),
      `unexpected multiline diff display:\n${diffOut}`,
    );
  });

  test('3. Interactive ReviewAnswerInput: Enter inserts newline in code blank, Ctrl+S submits exact multi-line answer that passes gradeCloze', async () => {
    useTuiStore.getState().setPreferences({ language: 'zh', asciiMode: false });
    const clozeText = '补全循环：\n```python\n{{b1}}\n```';
    const card = {
      id: 'card-py-1460',
      kind: 'fill_blank',
      cloze: {
        text: clozeText,
        blanks: [{ id: 'b1' }],
        answers: [{ id: 'b1', value: 'for x in xs:\n    print(x)' }],
      },
    };
    const clozeData = resolveClozeBlanks(card);
    let submitted = null;

    function Harness() {
      const [clozeInputs, setClozeInputs] = useState({});
      const [activeBlankIdx, setActiveBlankIdx] = useState(0);
      const [clozeEditing, setClozeEditing] = useState(true);
      return React.createElement(ReviewAnswerInput, {
        kind: 'fill_blank',
        isRubricEligibleKind: false,
        options: [],
        clozeData,
        feedback: null,
        solution: null,
        revealed: false,
        activeTranslation: null,
        cursorOpt: 0,
        selectedIds: [],
        clozeInputs,
        activeBlankIdx,
        clozeEditing,
        openDraft: '',
        openEditing: false,
        innerW: 80,
        isActive: true,
        cardScopeActive: true,
        lang: 'zh',
        asciiMode: false,
        setCursorOpt: () => {},
        setSelectedIds: () => {},
        setClozeInputs,
        setActiveBlankIdx,
        setClozeEditing,
        setOpenDraft: () => {},
        setOpenEditing: () => {},
        onSubmitChoice: () => {},
        onSubmitCloze: (vals) => {
          submitted = vals;
        },
        onReveal: () => {},
        onScheduleDraftSave: () => {},
      });
    }

    const h = createInkHarness(React.createElement(Harness));
    try {
      await wait(40);
      assert.match(h.getOutput(), /Enter 换行/);
      assert.match(h.getOutput(), /\[python\]/);

      // Type line 1, press Enter (MUST insert newline, NOT submit!), then line 2
      h.send('for x in xs:');
      await wait(25);
      h.send('\r');
      await wait(25);
      assert.equal(submitted, null, 'Enter inside code-block cloze must insert newline, not submit');

      h.send('    print(x)');
      await wait(25);

      // Submit via Ctrl+S (\x13)
      h.send('\x13');
      await wait(40);

      assert.ok(submitted, 'Ctrl+S must submit multi-line code cloze');
      assert.equal(submitted.b1, 'for x in xs:\n    print(x)');

      // Real backend grading round-trip proves TUI answer is graded correct
      const graded = gradeCloze(card, submitted);
      assert.equal(graded.correct, true, `gradeCloze rejected TUI multi-line answer: ${JSON.stringify(graded)}`);
    } finally {
      h.cleanup();
    }
  });

  test('4. Mixed card (code blank + prose blank) keeps Enter=submit on prose blank and renders multi-line feedback diffs cleanly in ASCII 80x24', async () => {
    const clozeText = '代码：\n```python\n{{b1}}\n```\n结论：{{b2}}';
    const clozeData = resolveClozeBlanks({ cloze: { text: clozeText, blanks: [{ id: 'b1' }, { id: 'b2' }] } });
    let submitted = null;

    function MixedHarness() {
      const [clozeInputs, setClozeInputs] = useState({ b1: 'for x in xs:\n    print(x)' });
      const [activeBlankIdx, setActiveBlankIdx] = useState(1); // focused on prose blank b2
      const [clozeEditing, setClozeEditing] = useState(true);
      return React.createElement(ReviewAnswerInput, {
        kind: 'fill_blank',
        isRubricEligibleKind: false,
        options: [],
        clozeData,
        feedback: null,
        solution: null,
        revealed: false,
        activeTranslation: null,
        cursorOpt: 0,
        selectedIds: [],
        clozeInputs,
        activeBlankIdx,
        clozeEditing,
        openDraft: '',
        openEditing: false,
        innerW: 72,
        isActive: true,
        cardScopeActive: true,
        lang: 'zh',
        asciiMode: true,
        setCursorOpt: () => {},
        setSelectedIds: () => {},
        setClozeInputs,
        setActiveBlankIdx,
        setClozeEditing,
        setOpenDraft: () => {},
        setOpenEditing: () => {},
        onSubmitChoice: () => {},
        onSubmitCloze: (vals) => {
          submitted = vals;
        },
        onReveal: () => {},
        onScheduleDraftSave: () => {},
      });
    }

    const h = createInkHarness(React.createElement(MixedHarness), { columns: 80, rows: 24 });
    try {
      await wait(40);
      h.send('O(n)');
      await wait(25);
      h.send('\r'); // Enter on single-line prose blank submits immediately
      await wait(40);
      assert.deepEqual(submitted, { b1: 'for x in xs:\n    print(x)', b2: 'O(n)' });
    } finally {
      h.cleanup();
    }

    // Verify ReviewFeedbackHeader multi-line diff rendering in pure ASCII 80x24
    const diffs = buildClozeBlankDiffs(
      clozeData.blanks,
      { b1: 'for x in xs:\n    pass', b2: 'O(n)' },
      {
        correct: false,
        details: [
          { id: 'b1', correct: false, expected: 'for x in xs:\n    print(x)' },
          { id: 'b2', correct: true },
        ],
      },
      null,
    );
    const fbHarness = createInkHarness(
      React.createElement(ReviewFeedbackHeader, {
        innerW: 72,
        lang: 'zh',
        asciiMode: true,
        isActive: false,
        gradingBusy: false,
        gradeError: null,
        feedback: { correct: false },
        userAnswerText: '#1(b1): for x in xs: /     pass',
        canUndo: false,
        clozeBlankDiffs: diffs,
        activeRubric: null,
        gradeResult: null,
        canAckCorrection: false,
        revealed: true,
        referenceAnswer: '',
        activeTranslation: null,
      }),
      { columns: 80, rows: 24 },
    );
    try {
      await wait(40);
      const out = fbHarness.getOutput();
      assert.match(out, /#1 x 你的作答:/);
      assert.match(out, /    for x in xs:/);
      assert.match(out, /        pass/);
      assert.match(out, /-> 参考答案:/);
      assert.match(out, /        print\(x\)/);
      assert.doesNotMatch(out, /[✓✕→·]/);
    } finally {
      fbHarness.cleanup();
    }
  });
});
