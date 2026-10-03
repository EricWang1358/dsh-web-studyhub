/* Formulas in study cards (#49): the renderer handles $…$, $$…$$, \(…\) and \[…\], so a formula shows
   as raw text only when it never reached the renderer in that form: it was written without delimiters,
   or JSON ate its backslashes. These tests cover both, from the model's JSON to the learner's card. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairTexEscapes, restoreTexControlChars, bareMath, TEX_COMMANDS } from '../lib/tex-text.js';
import { parseJson } from '../lib/generation.js';
import { prepareJsonImport } from '../lib/json-import.js';
import { formulaIssues } from '../lib/assessment-quality.js';

/* ---------- JSON escapes ---------- */

test('invalid TeX escapes in model JSON are doubled so the formula survives; other invalid escapes still fail', () => {
  const json = String.raw`{"p":"\(z^l = \sigma(z)\) with \alpha and \mathbb{R}, \upsilon, \, \{x\}"}`;
  assert.equal(parseJson(json).p, String.raw`\(z^l = \sigma(z)\) with \alpha and \mathbb{R}, \upsilon, \, \{x\}`);
  assert.equal(repairTexEscapes(String.raw`{"a":"\\alpha"}`), String.raw`{"a":"\\alpha"}`, 'already doubled: unchanged');
  assert.equal(repairTexEscapes('{"a":"plain"}'), '{"a":"plain"}');
  assert.equal(repairTexEscapes(String.raw`\alpha outside a string`), String.raw`\alpha outside a string`, 'only inside JSON strings');
  for (const text of [String.raw`{"a":"A\qB"}`, String.raw`{"a":"C:\Users\x"}`, String.raw`{"a":"\é"}`])
    assert.throws(() => parseJson(text), SyntaxError, text);
  assert.equal(parseJson(String.raw`{"a":"é \u00e9 \n \" \\ \/"}`).a, 'é é \n " \\ /', 'valid escapes keep their meaning');
});

test('TeX commands that JSON escapes silently turned into control characters are restored inside math only', () => {
  const single = String.raw`{"p":"$\theta$ $\beta$ $\frac{a}{b}$ $\tau \times \text{x}$ $\nabla f \neq \nu$ $\rho \right) \rightarrow$ $\bar x \binom{n}{k}$"}`;
  const parsed = JSON.parse(single);
  assert.match(parsed.p, /[\b\f\t\r\n]/, 'JSON itself corrupted them');
  const expected = String.raw`$\theta$ $\beta$ $\frac{a}{b}$ $\tau \times \text{x}$ $\nabla f \neq \nu$ $\rho \right) \rightarrow$ $\bar x \binom{n}{k}$`;
  assert.equal(restoreTexControlChars(parsed).p, expected);
  assert.equal(parseJson(single).p, expected, 'parseJson restores them');
  assert.equal(restoreTexControlChars(JSON.parse(String.raw`{"p":"\\(\theta\\)"}`)).p, String.raw`\(\theta\)`, '\\( \\) spans');
  assert.equal(restoreTexControlChars(JSON.parse(String.raw`{"p":"\\[\beta\\]"}`)).p, String.raw`\[\beta\]`, '\\[ \\] spans');
});

test('restoring leaves text that is not TeX alone: tabs and breaks outside math, real display line breaks, unknown words', () => {
  assert.equal(restoreTexControlChars('a\theta b'), 'a\theta b', 'outside math: untouched');
  assert.equal(restoreTexControlChars('$a\tb$ and $x\ty$'), '$a\tb$ and $x\ty$', 'a tab not followed by a command stays');
  assert.equal(restoreTexControlChars('$$x = 1\nu = 2$$'), '$$x = 1\nu = 2$$', 'a line break in display math is a line break');
  assert.equal(restoreTexControlChars('$$\theta\n= 1$$'), '$$\\theta\n= 1$$', 'but a tab-made command is still restored there');
  assert.equal(restoreTexControlChars('$a\nu$'), '$a\\nu$', 'in an inline formula a line break never occurs');
  assert.equal(restoreTexControlChars('价格 $5\ntheta'), '价格 $5\ntheta', 'currency is not math');
  assert.deepEqual(restoreTexControlChars({ a: ['$\theta$', 3, null, { b: '$\beta$' }], c: 7, d: undefined }),
    { a: ['$\\theta$', 3, null, { b: '$\\beta$' }], c: 7, d: undefined }, 'deep, non-strings untouched');
});

test('every command that starts like a JSON escape letter can be restored', () => {
  const letters = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  for (const name of TEX_COMMANDS.filter(command => letters[command[0]])) {
    const damaged = `$${letters[name[0]]}${name.slice(1)}$`;
    assert.equal(restoreTexControlChars(damaged), `$\\${name}$`, name);
  }
});

test('JSON import repairs LaTeX the way a model writes it and still reports real JSON errors', () => {
  const body = prompt => `{"title":"t","cards":[{"kind":"flashcard","topic":"x","objective":"y","prompt":${prompt},"answer":"a","hint":"h","explanation":"e","misconception":"m"}]}`;
  const prompts = text => prepareJsonImport(text, []).deck.cards.map(card => card.prompt);
  assert.deepEqual(prompts(body(String.raw`"算 \(a^{l-1}\) 与 \alpha"`)), [String.raw`算 \(a^{l-1}\) 与 \alpha`], 'invalid escapes');
  assert.deepEqual(prompts(body(String.raw`"算 $\theta + \frac{a}{b}$"`)), [String.raw`算 $\theta + \frac{a}{b}$`], 'valid but wrong escapes');
  assert.deepEqual(prompts(body(String.raw`"算 $\\theta$"`)), [String.raw`算 $\theta$`], 'correct JSON is untouched');
  const imported = prepareJsonImport(body(String.raw`"算 $\theta$"`), []);
  assert.match(imported.source.text, /\\theta/, 'the provenance copy holds the repaired formula');
  assert.throws(() => prepareJsonImport(body(String.raw`"A\qB"`), []), /JSON 格式错误/);
  assert.throws(() => prepareJsonImport('{"title": ', []), /JSON 格式错误/);
});

/* ---------- formulas without delimiters ---------- */

test('bareMath finds unmistakable TeX outside delimiters and code, and nothing else', () => {
  assert.deepEqual(bareMath('先算 z^l = W^l a^{l-1} + b^l，再算 a^l = σ(z^l)'), ['a^{l-1}']);
  assert.deepEqual(bareMath('x_{i} 与 \\frac{a}{b} 与 2\\pi r 与 x\\leq y'), ['x_{i}', '\\frac', '\\pi', '\\leq']);
  assert.deepEqual(bareMath('10^{-3} 秒'), ['10^{-3}']);
  for (const fine of ['$a^{l-1}$', '$$a^{l-1}$$', String.raw`\(a^{l-1}\)`, String.raw`\[a^{l-1}\]`, '用 `a^{l-1}` 表示', '```\na^{l-1}\n```',
    '价格 $5 和 $10', '复杂度 O(n^2)', 'snake_case_name 与 my_var', 'C:\\Users\\log\\x', '\\\\server\\share\\sum', '普通文字，没有公式', ''])
    assert.deepEqual(bareMath(fine), [], JSON.stringify(fine));
  assert.deepEqual(bareMath(undefined), []);
});

test('formulaIssues flags a card with an undelimited formula in any text the learner reads', () => {
  const card = { id: 'q', kind: 'quiz', prompt: '前向传播两步顺序', answer: '先算 $z^l$', hint: '提示', explanation: '解析', misconception: '误解',
    options: [{ id: 'a', text: '先算 $z^l = W^l a^{l-1} + b^l$', correct: true, explanation: '对' }, { id: 'b', text: '先算 a^{l-1}', correct: false, explanation: '错' }] };
  const issues = formulaIssues({ cards: [card] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^Card 1: formula outside math delimiters \("a\^\{l-1\}"\)/);
  assert.match(issues[0], /\$…\$/, 'it says how to fix it');
  for (const field of ['prompt', 'hint', 'explanation', 'misconception', 'answer'])
    assert.equal(formulaIssues({ cards: [{ ...card, options: [], [field]: 'W^{l} 未定界' }] }).length, 1, field);
  assert.equal(formulaIssues({ cards: [{ id: 'c', kind: 'cloze', cloze: { text: '求 {{b1}} 的 a^{2}', answers: [] } }] }).length, 1, 'cloze text');
  assert.equal(formulaIssues({ cards: [{ ...card, options: [{ id: 'a', text: 'x', explanation: 'y_{k}' }] }] }).length, 1, 'option explanation');
  assert.deepEqual(formulaIssues({ cards: [{ ...card, options: [card.options[0]] }] }), [], 'fully delimited');
  assert.deepEqual(formulaIssues({ cards: [card, { ...card }] }).map(issue => issue.slice(0, 7)), ['Card 1:', 'Card 2:']);
  assert.deepEqual(formulaIssues(null), []);
  assert.deepEqual(formulaIssues({ cards: [null, {}] }), []);
});
