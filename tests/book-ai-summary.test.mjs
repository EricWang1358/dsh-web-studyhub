/* The row of a folded AI block of the review book (ui/book/ai-summary.js): its first real sentence, skipping the template a whole-point block is written in
   (这段在讲什么, headings, list numbers, 原文说, 意思就是, 资料原文, 补充（资料以外）, 关于：「…」), and its size. Pure; fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { wholeBody } from './helpers/book-fixtures.mjs';
import { POINTS } from './helpers/book-topics.mjs';

const ui = await loadUi(`
  export * from './ui/book/ai-summary.js';`);

test('the summary skips the template lines and gives the first real sentence', () => {
  const body = ['这段在讲什么', '', '本节讲熵：系统无序程度的度量。下面按资料的顺序逐条讲。', '', '### 1. 先要弄清的概念', '', '原文说：熵度量无序。', '', '意思就是：它只增不减。'].join('\n');
  assert.equal(ui.aiSummary(body), '本节讲熵：系统无序程度的度量。', 'one sentence, not the rest of the line');
  assert.equal(ui.aiSummary('这段在讲什么：本节讲熵。\n\n更多。'), '本节讲熵。', 'a label with words after it gives its words');
  assert.equal(ui.aiSummary('这段在讲什么\n\n### 1. 小标题\n\n1. 小标题\n\n原文说：熵度量无序。\n\n意思就是：它只增不减。'), '熵度量无序。', 'a heading, a numbered title and the bare label are skipped');
  assert.equal(ui.aiSummary('意思就是：它只增不减。'), '它只增不减。');
  assert.equal(ui.aiSummary('资料原文：「熵度量无序」\n\n补充（资料以外）：玻尔兹曼公式。'), '「熵度量无序」');
  assert.equal(ui.aiSummary('补充（资料以外）：\n\n- 玻尔兹曼公式。'), '玻尔兹曼公式。', 'a bullet says what it says');
  assert.equal(ui.aiSummary('关于：「熵」\n\n熵是无序度。'), '熵是无序度。', 'the 关于 line is not the answer');
  assert.equal(ui.aiSummary('1. 熵增是方向。\n2. 另一条。'), '熵增是方向。', 'a numbered sentence says what it says, without its number');
  assert.equal(ui.aiSummary('**小标题**\n\n---\n\n| a | b |\n\n熵是无序度。'), '熵是无序度。', 'a bold line alone, a rule and a table are structure');
  assert.equal(ui.aiSummary('这段在讲什么\n\n### 1. 小标题\n\n补充（资料以外）'), '', 'nothing real: no summary');
  assert.equal(ui.aiSummary(''), '');
  assert.equal(ui.aiSummary(undefined), '');
});

test('a bold label and the English template are labels too', () => {
  assert.equal(ui.aiSummary('**这段在讲什么**：本节讲熵。'), '本节讲熵。', 'a bold label with its colon outside');
  assert.equal(ui.aiSummary('**原文说：** 熵度量无序。'), '熵度量无序。', 'a bold label with its colon inside');
  assert.equal(ui.aiSummary('**这段在讲什么**\n\n**原文说**：熵度量无序。'), '熵度量无序。', 'a bold label alone is structure');
  assert.equal(ui.aiSummary('What this passage is about\n\nEntropy measures disorder. More follows.'), 'Entropy measures disorder.');
  assert.equal(ui.aiSummary('What this passage is about: Entropy rises.\n\n### 1. Entropy\n\nThe source says: it never falls.\n\nIn plain words: it only rises.'), 'Entropy rises.');
  assert.equal(ui.aiSummary('What this passage is about\n\n### 1. Entropy\n\n**The source says:** it never falls.\n\nIn plain words: it only rises.'), 'it never falls.');
  assert.equal(ui.aiSummary('The source says:\n\nIn plain words:\n\nExtra (beyond the materials)'), '', 'only labels: no summary');
});

test('the summary is plain words: marks, cites and links off; English too; a long line is cut', () => {
  assert.equal(ui.aiSummary('\n  **Bold** and `code` [^1] see [a link](studyhub://x) and [[term]]\nsecond line'), 'Bold and code see a link and term');
  assert.equal(ui.aiSummary('It means entropy rises, e.g. in a gas. More follows.'), 'It means entropy rises, e.g. in a gas.');
  const long = `${'长'.repeat(300)}`;
  assert.equal(ui.aiSummary(long).length, 120);
  assert.ok(ui.aiSummary(long).endsWith('…'));
});

test('the summary of every whole-point block of the fixture says what the point is, not its template', () => {
  POINTS.forEach((point, at) => {
    const summary = ui.aiSummary(wholeBody(point, at));
    assert.equal(summary, `本节讲${point.term}：${point.defines}。`, point.title);
    assert.doesNotMatch(summary, /这段在讲什么|原文说|意思就是|资料原文/);
  });
});

test('the size: the characters, rounded to 100 from a thousand and to 10 from a hundred', () => {
  const of = length => ui.aiSize('x'.repeat(length));
  assert.deepEqual([of(5187), of(5150), of(1449), of(1450), of(1000), of(999), of(104), of(87), of(4), of(0)], [5200, 5200, 1400, 1500, 1000, 1000, 100, 87, 4, 0]);
  assert.equal(ui.aiSize(undefined), 0);
});
