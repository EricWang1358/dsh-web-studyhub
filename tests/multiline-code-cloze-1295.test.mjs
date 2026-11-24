import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clozeRuns,
  clozeHasCodeBlock,
  blanksInFormula,
  codeBlockBlankLangs,
} from '../lib/cloze-text.js';
import { validateDeck, gradeCloze, normCodeBlank } from '../lib/domain.js';
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
