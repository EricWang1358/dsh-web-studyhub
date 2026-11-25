import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clozeRuns,
  clozeHasCodeBlock,
  blanksInFormula,
  codeBlockBlankLangs,
  clozeBlankIds,
} from '../lib/cloze-text.js';
import { validateDeck, gradeCloze, normCodeBlank } from '../lib/domain.js';
import { clozeBlankKeyAction } from '../ui/review/session-logic.js';
import { clozeBlankIds as voiceClozeBlankIds, splitSpokenBlanks } from '../ui/voice/cloze-split.js';
import { exportBook } from '../lib/course-book-export.js';
import { exportBook as fixtureBook } from './helpers/course-book-export-book.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const PYTHON_SOURCE = {
  id: 'src-py',
  title: 'Python Dicts',
  text: 'In Python, dict.items() returns a view of (key, value) pairs that can be inverted in a dictionary comprehension.',
};

const PYTHON_CLOZE_CARD = {
  id: 'cloze-py-1',
  kind: 'cloze',
  topic: 'Python Dict',
  objective: 'Invert a Python dictionary with items()',
  prompt: 'Complete the dictionary comprehension:',
  hint: 'Use the dictionary view method that yields key-value tuples.',
  answer: 'k; items',
  misconception: 'Iterating over d directly yields only keys.',
  citations: [{ sourceId: 'src-py', quote: 'dict.items() returns a view of (key, value) pairs' }],
  cloze: {
    text: 'Fill in the key method and loop variable:\n```python\n$price = 10\ndef invert(d):\n    return {v: {{b1}} for k, v in d.{{b2}}()}\n```',
    answers: [
      { id: 'b1', value: 'k' },
      { id: 'b2', value: 'items' },
    ],
  },
  explanation: 'dict.items() yields (key, value) pairs.',
};

test('#1295-1: cloze with fenced multi-line code passes validateDeck, splits into code-block runs, and ignores $ inside fences as LaTeX', () => {
  const { errors } = validateDeck({ title: 'Python Cloze', cards: [PYTHON_CLOZE_CARD] }, [PYTHON_SOURCE]);
  assert.deepEqual(errors, []);
  assert.equal(clozeHasCodeBlock(PYTHON_CLOZE_CARD.cloze.text), true);

  // `$price = 10` and another `$` inside the fenced code block MUST NOT trigger blanksInFormula
  const withTwoDollars = '```bash\necho "$HOME" && echo "$PATH {{b1}}"\n```';
  assert.deepEqual(blanksInFormula(withTwoDollars), []);

  const runs = clozeRuns(PYTHON_CLOZE_CARD.cloze.text);
  const block = runs.find(r => r.t === 'code-block');
  assert.ok(block, 'emits structured code-block run');
  assert.equal(block.lang, 'python');
  assert.equal(block.runs.some(r => r.t === 'blank' && r.id === 'b1'), true);
  assert.equal(block.runs.some(r => r.t === 'blank' && r.id === 'b2'), true);

  const langs = codeBlockBlankLangs(PYTHON_CLOZE_CARD.cloze.text);
  assert.equal(langs.get('b1'), 'python');
  assert.equal(langs.get('b2'), 'python');
});

test('#1295-2: gradeCloze enforces case sensitivity for code languages, case-insensitivity for SQL, and preserves newlines/relative indentation for multi-line code blanks', () => {
  // Python: case-sensitive
  assert.equal(gradeCloze(PYTHON_CLOZE_CARD, { b1: 'k', b2: 'items' }).correct, true);
  assert.equal(gradeCloze(PYTHON_CLOZE_CARD, { b1: 'K', b2: 'items' }).correct, false, 'Python code blank is case-sensitive');

  // SQL: case-insensitive
  const sqlCard = {
    id: 'cloze-sql-1',
    kind: 'cloze',
    cloze: {
      text: '```sql\nSELECT name FROM users\n{{b1}} active = 1;\n```',
      answers: [{ id: 'b1', value: 'WHERE' }],
    },
  };
  assert.equal(gradeCloze(sqlCard, { b1: 'where' }).correct, true);
  assert.equal(gradeCloze(sqlCard, { b1: 'WHERE' }).correct, true);

  // Multi-line blank preserves relative indentation and newlines (dedents common outer indent)
  const multiLineCard = {
    id: 'cloze-py-ml',
    kind: 'cloze',
    cloze: {
      text: '```python\ndef check(x):\n{{b1}}\n```',
      answers: [{ id: 'b1', value: '    if x > 0:\n        return True' }],
    },
  };
  assert.equal(gradeCloze(multiLineCard, { b1: 'if x > 0:\n    return True' }).correct, true, 'dedented relative indent matches');
  assert.equal(gradeCloze(multiLineCard, { b1: 'if x > 0:\nreturn True' }).correct, false, 'lost inner indentation fails');
  assert.equal(gradeCloze(multiLineCard, { b1: 'if x > 0: return True' }).correct, false, 'collapsed newline fails');
  assert.equal(normCodeBlank('  a\n    b  \n'), 'a\n  b');

  // Ordinary prose cloze stays 100% case-insensitive and whitespace-collapsed
  const proseCard = {
    id: 'cloze-prose-1',
    kind: 'cloze',
    cloze: {
      text: 'The capital of France is {{b1}}.',
      answers: [{ id: 'b1', value: 'Paris' }],
    },
  };
  assert.equal(gradeCloze(proseCard, { b1: '  paris ' }).correct, true);
});

test('#1295-3: Cloze.jsx renders fenced code blocks in monospace <pre><code> without raw backticks, renders blanks in place, and shows expected code answer on miss', async () => {
  const ui = await loadUi(`
    export { default as Cloze } from './ui/Cloze.jsx';
  `);

  const html = renderToStaticMarkup(
    React.createElement(ui.Cloze, {
      card: {
        ...PYTHON_CLOZE_CARD,
        cloze: { text: PYTHON_CLOZE_CARD.cloze.text, blanks: [{ id: 'b1' }, { id: 'b2' }] },
      },
      values: { b1: 'k', b2: '' },
      onChange: () => {},
    }),
  );

  assert.match(html, /class="cloze-code-block"/);
  assert.match(html, /class="cloze-code-block__lang">python</);
  assert.match(html, /class="cloze-code-block__pre"/);
  assert.doesNotMatch(html, /```python/, 'raw markdown fence does not leak into rendered HTML');
  assert.match(html, /cloze-blank--code/, 'blank inside fenced block carries code styling');

  // Graded miss state shows expected code value
  const gradedHtml = renderToStaticMarkup(
    React.createElement(ui.Cloze, {
      card: {
        ...PYTHON_CLOZE_CARD,
        cloze: { text: PYTHON_CLOZE_CARD.cloze.text, blanks: [{ id: 'b1' }, { id: 'b2' }] },
      },
      values: { b1: 'k', b2: 'keys' },
      details: [
        { id: 'b1', correct: true },
        { id: 'b2', correct: false, expected: 'items' },
      ],
      solution: PYTHON_CLOZE_CARD,
    }),
  );
  assert.match(gradedHtml, /cloze-expected[^>]*>items</);
});

test('#1295-4: course-book-export preserves multi-line code newlines and indentation in both questions and answer key', () => {
  const mlCard = {
    id: 'c-ml',
    kind: 'cloze',
    topic: 'Python Loop',
    prompt: 'Fill in the block:',
    cloze: {
      text: '```python\nfor x in xs:\n    {{b1}}\n```',
      answers: [{ id: 'b1', value: 'if x:\n    print(x)' }],
    },
    explanation: 'Prints truthy items.',
  };
  const book = fixtureBook();
  const exported = exportBook(book, {
    cardOf: () => mlCard,
    form: 'single',
    answerKey: true,
    questions: 'all',
  });
  assert.match(exported.text, /```python\nfor x in xs:\n {4}＿＿\n```/, 'question preserves fenced code newlines and 4-space indent');
  assert.match(exported.text, /```\nif x:\n {4}print\(x\)\n```/, 'answer key preserves multi-line code blank indentation');
});

/* ── #1403 review: a code-block answer spans lines, so it needs a multi-line field; the blank ids of a code block must be counted
   everywhere they are shown (progress count, voice answering); and one Tab/space rule for code comparison. ── */

const MULTILINE_CARD = {
  id: 'cloze-ml-io',
  kind: 'cloze',
  cloze: {
    text: '```python\n{{b1}}\n```',
    answers: [{ id: 'b1', value: 'for x in xs:\n    print(x)' }],
  },
};

test('#1403-1: a blank inside a fenced code block is a multi-line textarea, so a newline in the answer can be typed', async () => {
  // The grader (lib/domain.js gradeCloze) already compares real newlines: only a value that kept them can pass, which is
  // exactly what a single-line <input> could not send.
  assert.equal(gradeCloze(MULTILINE_CARD, { b1: 'for x in xs:\n    print(x)' }).correct, true);
  assert.equal(gradeCloze(MULTILINE_CARD, { b1: 'for x in xs:    print(x)' }).correct, false, 'a newline swallowed by a single-line field fails');
  assert.equal(gradeCloze(MULTILINE_CARD, { b1: 'for x in xs: print(x)' }).correct, false, 'a collapsed line fails');

  const ui = await loadUi(`
    export { default as Cloze } from './ui/Cloze.jsx';
  `);
  const html = renderToStaticMarkup(
    React.createElement(ui.Cloze, {
      card: { ...MULTILINE_CARD, cloze: { text: MULTILINE_CARD.cloze.text, blanks: [{ id: 'b1' }] } },
      values: { b1: 'for x in xs:\n    print(x)' },
      onChange: () => {},
    }),
  );
  assert.match(html, /<textarea/, 'the code-block blank is a textarea, not a single-line input');
  assert.match(html, /cloze-blank--multiline/, 'it carries the multi-line class');
  assert.doesNotMatch(html, /<input[^>]*cloze-blank--input[^>]*cloze-blank--code/, 'no single-line input swallows the newline');
});

test('#1403-2: in a multi-line blank Enter and Shift+Enter insert a newline, Ctrl/Cmd+Enter submits, and Esc leaves the field', () => {
  const key = (k, extra = {}) => ({ key: k, repeat: false, isComposing: false, keyCode: k === 'Enter' ? 13 : 27, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  const base = { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: 'for x in xs:' }, multiline: true };
  assert.equal(clozeBlankKeyAction(key('Enter'), base), null, 'Enter is a newline in a multi-line blank');
  assert.equal(clozeBlankKeyAction(key('Enter', { shiftKey: true }), base), null, 'Shift+Enter is a newline too');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { ctrlKey: true }), base), { type: 'submit' }, 'Ctrl+Enter submits');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { metaKey: true }), base), { type: 'submit' }, 'Cmd+Enter submits on macOS');
  assert.deepEqual(clozeBlankKeyAction(key('Escape'), base), { type: 'blur' }, 'Esc still returns focus to the card');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { ...base, multiline: false }), { type: 'focus', id: 'b2' }, 'single-line blanks keep moving on Enter');
});

test('#1403-3: a blank inside a fenced code block is counted by the shared extractor, the 已填 x/N count, and voice answering', async () => {
  const text = '```python\ndef f(x):\n    {{b1}}\n```\n然后把结果交给 {{b2}}。';
  assert.deepEqual(clozeBlankIds(text), ['b1', 'b2'], 'shared extractor walks into code blocks');
  assert.deepEqual(clozeBlankIds('```sql\nSELECT {{a}} FROM t;\n```'), ['a'], 'a code-block-only card still lists its blanks');

  const card = { cloze: { text, blanks: [{ id: 'b1' }, { id: 'b2' }] } };
  assert.deepEqual(voiceClozeBlankIds(card), ['b1', 'b2'], 'voice answering knows the code-block blank');
  assert.deepEqual(
    splitSpokenBlanks('第一空 把结果打印出来 第二空 缓存', voiceClozeBlankIds(card)),
    { values: { b1: '把结果打印出来', b2: '缓存' } },
    'a spoken answer fills a card whose blanks stand in a code block',
  );

  const ui = await loadUi(`
    export { ClozeQuestion } from './ui/review/QuestionParts.jsx';
  `);
  const run = {
    id: 'r1',
    index: 0,
    mode: 'path',
    card: { id: 'c1', kind: 'cloze', cloze: { text, blanks: [{ id: 'b1' }, { id: 'b2' }] } },
    feedback: null,
    solution: null,
  };
  const html = renderToStaticMarkup(
    React.createElement(ui.ClozeQuestion, {
      run,
      clozeValues: { b1: 'def f(x):\n    return x' },
      clozeFocusTick: 0,
      enOn: false,
      enStem: null,
      enAnswer: null,
      voiceAnswer: null,
      pendingCloze: false,
      actions: { reviewAct: () => {}, setClozeValue: () => {} },
    }),
  );
  assert.match(html, /已填 1\/2 空/, 'the progress count sees the code-block blank');
});

test('#1403-4: one Tab/space rule for code (a Tab is two columns, the width the block draws), relative indentation stays significant, and runs of blank lines are one blank line', () => {
  assert.equal(normCodeBlank('if x:\n\treturn 1'), normCodeBlank('if x:\n  return 1'), 'a Tab is the two columns the code block renders (tab-size: 2)');
  assert.notEqual(normCodeBlank('if x:\n\treturn 1'), normCodeBlank('if x:\n    return 1'), 'four spaces are not one Tab');

  const tabCard = { id: 'tab', kind: 'cloze', cloze: { text: '```python\n{{b1}}\n```', answers: [{ id: 'b1', value: 'if y:\n\treturn 1' }] } };
  assert.equal(gradeCloze(tabCard, { b1: 'if y:\n  return 1' }).correct, true, 'two spaces match a Tab answer');
  assert.equal(gradeCloze(tabCard, { b1: 'if y:\n    return 1' }).correct, false, 'four spaces do not');
  assert.equal(gradeCloze(tabCard, { b1: 'if y:\n\treturn 1' }).correct, true, 'the Tab itself still matches');
  assert.equal(normCodeBlank('\tif x:\n\t\treturn 1'), 'if x:\n  return 1', 'two levels of Tab indent become two-space steps');
  assert.equal(normCodeBlank('a\tb'), 'a b', 'a Tab inside a line is whitespace, not a character');

  const relCard = { id: 'rel', kind: 'cloze', cloze: { text: '```python\n{{b1}}\n```', answers: [{ id: 'b1', value: 'if x:\n  return 1' }] } };
  assert.equal(gradeCloze(relCard, { b1: 'if x:\n  return 1' }).correct, true);
  assert.equal(gradeCloze(relCard, { b1: 'if x:\n    return 1' }).correct, false, 'relative 4-space indentation differs from 2');

  assert.equal(normCodeBlank('a\n\n\nb'), normCodeBlank('a\n\nb'), 'a run of blank lines counts as one');
  assert.notEqual(normCodeBlank('a\n\nb'), normCodeBlank('a\nb'), 'a blank line between lines still counts');
});
