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
import { gradeCloze, publicCard } from '../../../lib/domain.js';

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

  /** Mount ReviewAnswerInput with sensible defaults; `debug` renders every frame separately so the last frame is exact. */
  function mountAnswerInput({ clozeData, activeIdx = 0, innerW = 80, lang = 'zh', asciiMode = false, columns = 100, rows = 28, onSubmit = () => {} }) {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(stdout, { isTTY: true, columns, rows });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
    const frames = [];
    stdout.on('data', (chunk) => {
      const plain = stripAnsi(chunk.toString('utf8'));
      if (plain.trim()) frames.push(plain);
    });
    function Harness() {
      const [clozeInputs, setClozeInputs] = useState({});
      const [activeBlankIdx, setActiveBlankIdx] = useState(activeIdx);
      const [clozeEditing, setClozeEditing] = useState(true);
      return React.createElement(ReviewAnswerInput, {
        kind: 'fill_blank', isRubricEligibleKind: false, options: [], clozeData, feedback: null, solution: null,
        revealed: false, activeTranslation: null, cursorOpt: 0, selectedIds: [], clozeInputs, activeBlankIdx, clozeEditing,
        openDraft: '', openEditing: false, innerW, isActive: true, cardScopeActive: true, lang, asciiMode,
        setCursorOpt: () => {}, setSelectedIds: () => {}, setClozeInputs, setActiveBlankIdx, setClozeEditing,
        setOpenDraft: () => {}, setOpenEditing: () => {}, onSubmitChoice: () => {}, onSubmitCloze: onSubmit,
        onReveal: () => {}, onScheduleDraftSave: () => {},
      });
    }
    const inst = render(React.createElement(Harness), { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
    return {
      send: (s) => stdin.write(s),
      lastFrame: () => frames.at(-1) ?? '',
      cleanup: () => {
        inst.unmount();
        stdin.destroy();
        stdout.destroy();
      },
    };
  }

  test('5. A card with a single code blank still shows the hint bar (badge + editing hint with Esc), and no hint promises Ctrl+Enter (#1736)', async () => {
    const clozeData = resolveClozeBlanks({ cloze: { text: '补全：\n```python\n{{b1}}\n```', blanks: [{ id: 'b1' }] } });
    for (const lang of ['zh', 'en']) {
      const h = mountAnswerInput({ clozeData, lang });
      try {
        await wait(40);
        const frame = h.lastFrame();
        // The box header says "Enter 换行 · Ctrl+S 提交" and has no Esc: only the hint bar carries Esc and the code badge.
        assert.match(frame, /code:python/, `${lang}: hint bar badge missing:\n${frame}`);
        assert.match(frame, lang === 'zh' ? /Esc 退出/ : /Esc blur/, `${lang}: hint bar text missing:\n${frame}`);
        assert.doesNotMatch(frame, /Ctrl\+Enter/, `${lang}: Ctrl+Enter only works on kitty-style terminals and must not be advertised`);
      } finally {
        h.cleanup();
      }
    }
  });

  test('6. Code blanks: Ctrl+S says 下一空 until the last blank and 提交 on it, and does exactly that', async () => {
    const clozeData = resolveClozeBlanks({
      cloze: { text: '```python\n{{b1}}\n```\n```python\n{{b2}}\n```', blanks: [{ id: 'b1' }, { id: 'b2' }] },
    });
    assert.equal(clozeData.blanks.length, 2);

    // Hint on the first (not last) blank promises "next blank", never "submit"; en too.
    const first = mountAnswerInput({ clozeData, activeIdx: 0 });
    const firstEn = mountAnswerInput({ clozeData, activeIdx: 0, lang: 'en' });
    const last = mountAnswerInput({ clozeData, activeIdx: 1 });
    const lastEn = mountAnswerInput({ clozeData, activeIdx: 1, lang: 'en' });
    // The hint bar is the one line with Esc; each box header is the line with its "#n [python]" label.
    const hintLine = (h) => h.lastFrame().split('\n').find((l) => /Esc (退出|blur)/.test(l)) ?? '';
    const boxLine = (h, n) => h.lastFrame().split('\n').find((l) => l.includes(`#${n} [python]`)) ?? '';
    try {
      await wait(60);
      assert.match(hintLine(first), /Ctrl\+S 下一空/);
      assert.doesNotMatch(hintLine(first), /提交/);
      assert.match(hintLine(firstEn), /Ctrl\+S next blank/);
      assert.doesNotMatch(hintLine(firstEn), /submit/);
      assert.match(hintLine(last), /Ctrl\+S 提交/);
      assert.match(hintLine(lastEn), /Ctrl\+S submit/);
      assert.match(boxLine(first, 1), /Ctrl\+S 下一空/);
      assert.match(boxLine(first, 2), /Ctrl\+S 提交/);
      assert.match(boxLine(firstEn, 1), /Ctrl\+S next blank/);
      assert.match(boxLine(firstEn, 2), /Ctrl\+S submit/);
      for (const h of [first, firstEn, last, lastEn]) assert.doesNotMatch(h.lastFrame(), /Ctrl\+Enter/);
    } finally {
      for (const h of [first, firstEn, last, lastEn]) h.cleanup();
    }

    // Behaviour matches the words: Ctrl+S on blank 1 only moves on, on the last blank it submits the whole card.
    let submitted = null;
    const h = mountAnswerInput({ clozeData, onSubmit: (vals) => { submitted = vals; } });
    try {
      await wait(40);
      h.send('a = 1');
      await wait(25);
      h.send('\x13');
      await wait(40);
      assert.equal(submitted, null, 'Ctrl+S on a non-last blank must not submit the card');
      assert.match(hintLine(h), /Ctrl\+S 提交/, 'focus moved to the last blank');
      h.send('b = 2');
      await wait(25);
      h.send('\x13');
      await wait(40);
      assert.deepEqual(submitted, { b1: 'a = 1', b2: 'b = 2' });
    } finally {
      h.cleanup();
    }
  });

  test('7. A long language tag keeps the code-box header on one line at a narrow width', async () => {
    const clozeData = resolveClozeBlanks({
      cloze: { text: '```typescriptreact-long-label\n{{b1}}\n```', blanks: [{ id: 'b1' }] },
    });
    assert.equal(clozeData.blanks[0].codeLang, 'typescriptreact-long-label');
    for (const lang of ['zh', 'en']) {
      const h = mountAnswerInput({ clozeData, innerW: 44, columns: 50, lang });
      try {
        await wait(40);
        const lines = h.lastFrame().split('\n');
        const headerAt = lines.findIndex((l) => /#1 \[/.test(l));
        assert.ok(headerAt >= 0, `no header line:\n${h.lastFrame()}`);
        assert.match(lines[headerAt + 1], /输入多行代码|Type multi-line/, `${lang}: header wrapped onto a second line:\n${h.lastFrame()}`);
      } finally {
        h.cleanup();
      }
    }
  });

  test('8. A single-line revealed answer inside a code fence has no literal ** (prose blanks keep theirs)', () => {
    const clozeText = '```js\nconst total = {{b1}};\n```\n结论 {{b2}}';
    const { blanks } = resolveClozeBlanks({ cloze: { text: clozeText, blanks: [{ id: 'b1' }, { id: 'b2' }] } });
    const solution = { cloze: { answers: [{ id: 'b1', value: 'a + b' }, { id: 'b2', value: 'O(n)' }] } };
    const empty = formatClozeDisplay(clozeText, blanks, {}, true, solution, true);
    assert.ok(empty.includes('const total = [#1: a + b];'), `code blank, nothing typed:\n${empty}`);
    const wrong = formatClozeDisplay(clozeText, blanks, { b1: 'a - b' }, true, solution, true);
    assert.ok(wrong.includes('const total = [#1: a - b -> a + b];'), `code blank, wrong answer:\n${wrong}`);
    assert.ok(!/\*\*(a|a \+ b)\*\*/.test(empty + wrong), 'no literal ** around a code answer');
    assert.ok(empty.includes('[#2: **O(n)**]'), 'prose blank keeps its bold answer');
  });

  test('9. A reveal shows "yours -> expected" only when the grader would mark the answer wrong', () => {
    const cases = [
      { text: '```python\n{{b1}}\n```', expected: 'for x in xs:\n    print(x)', user: 'for x in xs:\n    print(x)' },
      { text: '```python\n{{b1}}\n```', expected: 'for x in xs:\n    print(x)', user: '  for x in xs:   \r\n      print(x)  \r\n' },
      { text: '```python\n{{b1}}\n```', expected: 'for x in xs:\n  print(x)', user: 'for x in xs:\n\tprint(x)' },
      { text: '```python\n{{b1}}\n```', expected: 'for x in xs:\n    print(x)', user: 'for x in xs:\n    pass' },
      { text: '```python\n{{b1}}\n```', expected: 'return Total', user: 'return total' },
      { text: '```sql\n{{b1}}\n```', expected: 'SELECT 1', user: 'select 1' },
      { text: '结论 {{b1}}', expected: 'O(n)', user: 'o(n)' },
      { text: '结论 {{b1}}', expected: 'O(n)', user: ' O(n)  ' },
      { text: '结论 {{b1}}', expected: 'O(n)', user: 'O(1)' },
    ];
    for (const c of cases) {
      const card = { kind: 'cloze', cloze: { text: c.text, answers: [{ id: 'b1', value: c.expected }] } };
      const graded = gradeCloze(card, { b1: c.user });
      const { blanks } = resolveClozeBlanks({ cloze: { text: c.text, blanks: [{ id: 'b1' }] } });
      const solution = { cloze: { answers: card.cloze.answers } };
      const out = formatClozeDisplay(c.text, blanks, { b1: c.user }, true, solution, true);
      assert.equal(out.includes('->'), !graded.correct, `grader=${graded.correct} but display disagrees for ${JSON.stringify(c.user)}:\n${out}`);
      const diffs = buildClozeBlankDiffs(blanks, { b1: c.user }, null, solution);
      assert.equal(diffs[0].matched, graded.correct, `diff verdict disagrees with the grader for ${JSON.stringify(c.user)}`);
    }
  });

  test('10. Real host data shape: publicCard sends blanks as {id} only and the fence in cloze.text alone puts the blank in multi-line mode', () => {
    const stored = {
      id: 'c1', kind: 'cloze', topic: 't', prompt: 'p', hint: 'h',
      cloze: {
        text: '补全：\n```python\nfor x in xs:\n    {{b1}}\n```\n复杂度 {{b2}}',
        answers: [{ id: 'b1', value: 'print(x)' }, { id: 'b2', value: 'O(n)' }],
      },
    };
    const pub = publicCard(stored);
    assert.deepEqual(pub.cloze.blanks, [{ id: 'b1' }, { id: 'b2' }], 'host strips everything but the id; the TUI must not rely on a code flag');
    const { blanks } = resolveClozeBlanks(pub);
    assert.equal(blanks[0].inCodeBlock, true);
    assert.equal(blanks[0].codeLang, 'python');
    assert.equal(blanks[1].inCodeBlock, undefined);
    // Same ids the host's own fence scan finds, so TUI and grader agree on which blanks are code.
    assert.deepEqual([...libCodeBlockBlankLangs(pub.cloze.text).keys()], blanks.filter((b) => b.inCodeBlock).map((b) => b.id));
  });

  test('11. Wrapped multi-line diff lines keep their indentation', async () => {
    const clozeData = resolveClozeBlanks({ cloze: { text: '```python\n{{b1}}\n```', blanks: [{ id: 'b1' }] } });
    const long = 'if ok:\n        very_long_function_name(argument_one, argument_two, argument_three)';
    const diffs = buildClozeBlankDiffs(
      clozeData.blanks,
      { b1: long },
      { correct: false, details: [{ id: 'b1', correct: false, expected: 'pass' }] },
      null,
    );
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(stdout, { isTTY: true, columns: 44, rows: 24 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
    const frames = [];
    stdout.on('data', (chunk) => {
      const plain = stripAnsi(chunk.toString('utf8'));
      if (plain.trim()) frames.push(plain);
    });
    const inst = render(
      React.createElement(ReviewFeedbackHeader, {
        innerW: 40, lang: 'en', asciiMode: true, isActive: false, gradingBusy: false, gradeError: null,
        feedback: { correct: false }, userAnswerText: '', canUndo: false, clozeBlankDiffs: diffs, activeRubric: null,
        gradeResult: null, canAckCorrection: false, revealed: true, referenceAnswer: '', activeTranslation: null,
      }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    try {
      await wait(40);
      const lines = (frames.at(-1) ?? '').split('\n');
      const from = lines.findIndex((l) => l.includes('very_long'));
      assert.ok(from >= 0, `long line missing:\n${frames.at(-1)}`);
      const stop = lines.findIndex((l, i) => i > from && /->/.test(l));
      const pieces = lines.slice(from, stop > from ? stop : undefined).filter((l) => l.trim());
      assert.ok(pieces.length >= 2, `expected the long line to wrap:\n${frames.at(-1)}`);
      for (const piece of pieces) {
        assert.ok(/^ {12}\S/.test(piece), `wrapped piece lost its 4+8 space indentation: ${JSON.stringify(piece)}`);
      }
    } finally {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
