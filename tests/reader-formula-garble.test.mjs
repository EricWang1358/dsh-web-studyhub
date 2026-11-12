/* #1001: the converted text of a formula-heavy PDF often stacks a formula's pieces on lines of their own (a variable, its subscript, =, ∑, an exponent).
   formula-garble.js guesses that from the text of one chapter so the reader can suggest 原始 PDF. Positive: text like the issue's screenshot. Negative:
   prose (English and Chinese), code, numeric and Markdown tables, formulas written as LaTeX, a page of one short formula. And it is cheap. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaGarble, isFragment, looksGarbled } from '../ui/document-preview/reader/formula-garble.js';

const prose = n => Array.from({ length: n }, (_, index) => `Sentence ${index + 1} explains how output relates to demand through spending, saving and the multiplier.`).join('\n');
// What a converter without formula support makes of E[X] = Σ_{i=1}^{n} x_i p_i and Var(X) = E[X^2] − (E[X])^2: one piece per line.
const expectation = ['The expected value of a discrete random variable is', 'E', '[', 'X', ']', '=', '∑', 'i', '=', '1', 'n', 'x', 'i', 'p', 'i', 'and its variance is',
  'Var', '(', 'X', ')', '=', 'E', '[', 'X', '2', ']', '−', '(', 'E', '[', 'X', ']', ')', '2', 'where each term is weighted by its probability.'].join('\n');
const garbledChapter = Array.from({ length: 6 }, () => `${prose(12)}\n${expectation}`).join('\n');

test('a fragment is a short piece of a formula, not a page number, a brace, a word or a sentence', () => {
  for (const line of ['x', 'ij', '=', '∑', '(', 'p', 'i', 'n+1', 'σ²', 'x′', '−']) assert.equal(isFragment(line), true, line);
  for (const line of ['12', '3.5', '}', '};', '{', 'end', 'sin', 'The', '解', '一', '', 'abcd', '|']) assert.equal(isFragment(line), false, line);
});

test('the text of a chapter whose formulas fell apart is flagged (#1001)', () => {
  assert.equal(looksGarbled(garbledChapter), true);
  const measured = formulaGarble(garbledChapter);
  assert.ok(measured.share > 0.3, `most lines are stacked fragments: ${measured.share}`);
});

test('prose, code, tables and LaTeX are not flagged', () => {
  const chinese = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段：需求通过消费、储蓄和乘数影响产出，读的时候要慢一点。`).join('\n');
  const headings = Array.from({ length: 30 }, (_, index) => `解\n第 ${index + 1} 题的解答写在这一行，说明为什么答案是对的。`).join('\n');
  const javascript = Array.from({ length: 40 }, (_, index) => `function step${index}(x) {\n  if (x > ${index}) {\n    return x * 2;\n  }\n  return x;\n}\n`).join('\n');
  const ruby = Array.from({ length: 30 }, (_, index) => `class Item${index}\n  def total\n    items.each do |item|\n      sum += item.price\n    end\n  end\nend`).join('\n');
  const numbers = `Year\nRevenue\nCost\n${Array.from({ length: 60 }, (_, index) => `${2000 + index}\n${index * 3}\n${(index * 1.5).toFixed(1)}`).join('\n')}`;
  const markdownTable = `| Year | Revenue | Cost |\n| --- | --- | --- |\n${Array.from({ length: 60 }, (_, index) => `| ${2000 + index} | ${index * 3} | ${index} |`).join('\n')}`;
  const latex = Array.from({ length: 40 }, () => 'The expected value is $E[X] = \\sum_{i=1}^{n} x_i p_i$ and the variance is $E[X^2] - (E[X])^2$.').join('\n');
  const options = Array.from({ length: 30 }, (_, index) => `(a)\nOption one of question ${index}.\n(b)\nOption two of question ${index}.`).join('\n');
  const oneFormula = `${prose(200)}\n${expectation}\n${prose(200)}`;
  for (const [name, text] of Object.entries({ prose: prose(300), chinese, headings, javascript, ruby, numbers, markdownTable, latex, options, oneFormula, empty: '' })) {
    assert.equal(looksGarbled(text), false, `${name}: ${JSON.stringify(formulaGarble(text))}`);
  }
});

test('a long chapter is read in well under 5 ms', () => {
  // About 60 pages of converted text, a third of it fallen-apart formulas.
  const big = Array.from({ length: 60 }, () => garbledChapter.slice(0, 5000)).join('\n');
  assert.ok(big.length > 250_000);
  looksGarbled(big); // warm up
  let best = Infinity;
  for (let round = 0; round < 5; round += 1) {
    const started = performance.now();
    looksGarbled(big);
    best = Math.min(best, performance.now() - started);
  }
  assert.ok(best < 5, `best of five: ${best.toFixed(2)} ms`);
});
