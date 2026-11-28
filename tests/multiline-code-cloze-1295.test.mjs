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
  stripOuterCodeFence,
} from '../lib/cloze-text.js';
import { validateDeck, gradeCloze, normCodeBlank } from '../lib/domain.js';
import { clozeIssues, blueprintAssessment, CLOZE_RULE, CLOZE_SENTENCE } from '../lib/assessment-quality.js';
import { autofixDeck } from '../lib/card-autofix.js';
import { CODE_STYLE } from '../lib/notation.js';
import { qualityPlan, qualityBlueprint } from './helpers/assessment.mjs';
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

/* ── #1496-3: CRLF fenced code clozes, $ / backslash escapes in code blanks, and syntax backticks preserved end-to-end ── */

test('#1496-3a: CRLF fenced code cloze parses as code-block across all extractors and enforces strict code grading', () => {
  // Trailing CRLF + prose after closing fence reproduces the (?=\n|$) CRLF mismatch in FENCED_CLOZE_RE.
  const crlfText = 'Complete the function:\r\n```python\r\ndef greet(name):\r\n    {{b1}}\r\n```\r\nExplain why.';
  assert.equal(clozeHasCodeBlock(crlfText), true, 'CRLF fenced block detected by clozeHasCodeBlock');
  assert.equal(codeBlockBlankLangs(crlfText).get('b1'), 'python', 'CRLF fenced block language extracted');
  assert.deepEqual(clozeBlankIds(crlfText), ['b1'], 'CRLF fenced block blank id extracted');
  const runs = clozeRuns(crlfText);
  const block = runs.find((r) => r.t === 'code-block');
  assert.ok(block, 'CRLF fenced block emits structured code-block run');
  assert.equal(block.lang, 'python');
  assert.equal(block.runs.some((r) => r.t === 'blank' && r.id === 'b1'), true);
  assert.equal(block.runs.some((r) => r.t === 'code' && r.v.includes('\r')), false, 'code-block runs normalize CRLF to LF');

  const crlfCard = {
    id: 'cloze-crlf-1',
    kind: 'cloze',
    cloze: {
      text: crlfText,
      answers: [{ id: 'b1', value: 'if name:\r\n    return name' }],
    },
  };
  assert.equal(gradeCloze(crlfCard, { b1: 'if name:\n    return name' }).correct, true, 'LF matches CRLF expected code blank');
  assert.equal(gradeCloze(crlfCard, { b1: 'if name:\r\n    return name' }).correct, true, 'CRLF matches CRLF expected code blank');
  assert.equal(gradeCloze(crlfCard, { b1: 'IF NAME:\n    RETURN NAME' }).correct, false, 'CRLF python code blank stays case-sensitive (not prose fallback)');
  assert.equal(gradeCloze(crlfCard, { b1: 'if name: return name' }).correct, false, 'CRLF python code blank preserves newlines (not collapsed prose)');
});

test('#1496-3b: code-block blanks containing $ and backslash escapes pass clozeIssues while prose blanks with LaTeX still fail', () => {
  const codeCard = {
    id: 'cloze-escapes-1',
    kind: 'cloze',
    cloze: {
      text: 'Complete the expressions:\n```js\nconst msg = {{b1}};\nconst env = {{b2}};\nconst digits = {{b3}};\nconst nl = {{b4}};\n```',
      answers: [
        { id: 'b1', value: '`${user.name}`', accept: ['`Hello ${user.name}`'] },
        { id: 'b2', value: '$HOME', accept: ['${HOME}'] },
        { id: 'b3', value: '/\\d+/' },
        { id: 'b4', value: '"\\n"' },
      ],
    },
  };
  assert.deepEqual(clozeIssues({ cards: [codeCard] }), [], 'code-block blanks with $, ${...}, /\\d+/, and "\\n" pass clozeIssues');

  // Explicit answer.code === true also exempts code answers even without a fenced block.
  const explicitCodeCard = {
    id: 'cloze-explicit-code',
    kind: 'cloze',
    cloze: {
      text: 'Use {{b1}} to print the user home directory in bash.',
      answers: [{ id: 'b1', value: 'echo $HOME', accept: ['printf "%s\\n" "$HOME"'], code: true }],
    },
  };
  assert.deepEqual(clozeIssues({ cards: [explicitCodeCard] }), [], 'explicit answer.code === true passes clozeIssues');

  // Non-code prose blanks with LaTeX / TeX MUST still be rejected by clozeIssues.
  const proseLatex = {
    id: 'cloze-prose-latex',
    kind: 'cloze',
    cloze: {
      text: 'The learning rate parameter is {{b1}} and the slope is {{b2}}.',
      answers: [
        { id: 'b1', value: '$\\alpha$' },
        { id: 'b2', value: '\\frac{1}{2}' },
      ],
    },
  };
  const proseIssues = clozeIssues({ cards: [proseLatex] });
  assert.equal(proseIssues.length, 1);
  assert.match(proseIssues[0], /cloze answer b1, b2 is written as a formula/);
});

test('#1496-3c: syntax backticks in JS/SQL/Go/Bash code blanks survive wrapItemMath, autofixDeck, and gradeCloze while prose blanks still strip backticks', async () => {
  const cases = [
    { lang: 'js', value: 'return `Hello ${name}`;', wrong: 'return Hello ${name};' },
    { lang: 'sql', value: 'SELECT `order` FROM `users`;', wrong: 'SELECT order FROM users;' },
    { lang: 'go', value: 'ID int `json:"id"`', wrong: 'ID int json:"id"' },
    { lang: 'bash', value: 'now=`date`', wrong: 'now=date' },
  ];

  // 1. gradeCloze preserves syntax backticks and rejects answers missing them; outer code fences unwrap cleanly.
  for (const { lang, value, wrong } of cases) {
    const card = {
      id: `cloze-bt-${lang}`,
      kind: 'cloze',
      cloze: {
        text: `\`\`\`${lang}\n{{b1}}\n\`\`\``,
        answers: [{ id: 'b1', value }],
      },
    };
    assert.equal(gradeCloze(card, { b1: value }).correct, true, `${lang}: exact syntax backticks accepted`);
    assert.equal(gradeCloze(card, { b1: wrong }).correct, false, `${lang}: missing required syntax backticks rejected`);
    assert.equal(gradeCloze(card, { b1: `\`\`\`${lang}\r\n${value}\r\n\`\`\`` }).correct, true, `${lang}: outer fenced wrapper unwraps without losing inner backticks`);
  }

  // 2. autofixDeck preserves syntax backticks in code-block blanks, strips only an outer fence, and still strips backticks in prose blanks.
  const src = { id: 's-code', title: 'Syntax', text: 'Template literals use backticks in JavaScript, MySQL quotes reserved identifiers like order with backticks, Go uses struct tags, and prose answers are plain words.' };
  const req = { count: 2, kind: 'cloze', sources: [src] };
  const plan = qualityPlan(req);
  const codeFixCard = {
    id: 'c-fix-code',
    targetId: plan.targets[0].targetId,
    kind: 'cloze',
    topic: 'Template literals',
    objective: 'Write syntax with backticks',
    prompt: '```js\n{{b1}}\n{{b2}}\n```\n```sql\n{{b3}}\n```',
    answer: 'return `Hello ${name}`;',
    hint: 'Use a template literal and SQL backtick quotes.',
    explanation: 'Backticks are real syntax in JS templates and MySQL identifiers.',
    misconception: 'Single quotes interpolate ${name}.',
    citations: [{ sourceId: 's-code', quote: 'Template literals use backticks in JavaScript' }],
    cloze: {
      text: '```js\n{{b1}}\n{{b2}}\n```\n```sql\n{{b3}}\n```',
      answers: [
        { id: 'b1', value: 'return `Hello ${name}`;', accept: ['```js\nreturn `Hi ${name}`;\n```'] },
        { id: 'b2', value: '```js\r\nreturn `Bye ${name}`;\r\n```' },
        { id: 'b3', value: 'SELECT `order` FROM `users`;' },
      ],
    },
  };
  const proseFixCard = {
    id: 'c-fix-prose',
    targetId: plan.targets[1].targetId,
    kind: 'cloze',
    topic: 'Prose blank',
    objective: 'Strip markdown backticks on prose blanks',
    prompt: 'The keyword used for constants is {{b1}}.',
    answer: 'const',
    hint: 'Think of immutable bindings.',
    explanation: 'const declares a non-reassignable binding.',
    misconception: 'var is block-scoped.',
    citations: [{ sourceId: 's-code', quote: 'prose answers are plain words' }],
    cloze: {
      text: 'The keyword used for constants is {{b1}}.',
      answers: [{ id: 'b1', value: '`const`', accept: ['`readonly`'] }],
    },
  };
  const blueprint = qualityBlueprint(req, plan, { cards: [codeFixCard, proseFixCard] });
  const { deck: fixed } = autofixDeck({ title: 'T', cards: [codeFixCard, proseFixCard] }, { assessmentPlan: plan, answerBlueprint: blueprint, expectedKind: 'cloze' });
  assert.equal(fixed.cards[0].cloze.answers[0].value, 'return `Hello ${name}`;', 'autofixDeck keeps JS template literal backticks');
  assert.deepEqual(fixed.cards[0].cloze.answers[0].accept, ['return `Hi ${name}`;'], 'autofixDeck strips outer fence only on accept');
  assert.equal(fixed.cards[0].cloze.answers[1].value, 'return `Bye ${name}`;', 'autofixDeck strips CRLF outer fence and keeps inner backticks');
  assert.equal(fixed.cards[0].cloze.answers[2].value, 'SELECT `order` FROM `users`;', 'autofixDeck keeps SQL backticks');
  assert.equal(fixed.cards[1].cloze.answers[0].value, 'const', 'autofixDeck still strips markdown backticks on prose blanks');
  assert.deepEqual(fixed.cards[1].cloze.answers[0].accept, ['readonly'], 'autofixDeck still strips markdown backticks on prose accepts');

  // 3. blueprintAssessment (wrapItemMath) preserves code-block backticks/$ and strips only outer fences, while cleaning prose blanks.
  let calls = 0;
  const built = await blueprintAssessment(async () => { calls += 1; return structuredClone(blueprint); }, req, plan);
  assert.equal(calls, 1, 'code-block cloze with $ and backticks passes blueprintAssessment on first attempt');
  assert.equal(built.items[0].cloze.answers[0].value, 'return `Hello ${name}`;');
  assert.deepEqual(built.items[0].cloze.answers[0].accept, ['return `Hi ${name}`;']);
  assert.equal(built.items[0].cloze.answers[1].value, 'return `Bye ${name}`;');
  assert.equal(built.items[0].cloze.answers[2].value, 'SELECT `order` FROM `users`;');
  assert.equal(built.items[1].cloze.answers[0].value, 'const', 'wrapItemMath still strips markdown backticks on prose blanks');
  assert.deepEqual(built.items[1].cloze.answers[0].accept, ['readonly']);

  // 4. Prompt rules stay consistent and within budget.
  assert.ok(CODE_STYLE.length < 900, `CODE_STYLE must stay < 900 chars, got ${CODE_STYLE.length}`);
  assert.doesNotMatch(CODE_STYLE, /in a cloze sentence use only inline backticks/i);
  assert.ok(CLOZE_RULE.includes(CLOZE_SENTENCE), 'CLOZE_RULE preserves CLOZE_SENTENCE');
});

test('#1496-3d: stripOuterCodeFence unwraps a single outer fence without touching inner backticks or bridging two separate fenced blocks', () => {
  assert.equal(stripOuterCodeFence(null), null);
  assert.equal(stripOuterCodeFence(42), 42);
  assert.equal(stripOuterCodeFence('return `Hello ${name}`;'), 'return `Hello ${name}`;', 'non-fenced backticks untouched');
  assert.equal(stripOuterCodeFence('  ```js\r\nreturn `Hi ${x}`;\r\n  ```  '), 'return `Hi ${x}`;', 'strips outer CRLF fence + surrounding whitespace');
  assert.equal(stripOuterCodeFence('~~~sql\nSELECT `id` FROM `t`;\n~~~'), 'SELECT `id` FROM `t`;', 'strips tilde fence and preserves SQL backticks');
  assert.equal(stripOuterCodeFence('````md\n```js\nx = 1\n```\n````'), '```js\nx = 1\n```', '4-backtick outer fence unwraps cleanly around inner 3-backtick block');
  const twoBlocks = '```js\na()\n```\n```js\nb()\n```';
  assert.equal(stripOuterCodeFence(twoBlocks), twoBlocks, 'two separate fenced blocks are never bridged as one');
  const inlineTriple = '```js\nconst s = "a";\n```\nextra trailing line';
  assert.equal(stripOuterCodeFence(inlineTriple), inlineTriple, 'fenced block with trailing prose is not stripped');
});
