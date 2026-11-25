import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeCommentLeakIssues,
  cardLocalIssues,
  extractFencedCodeComments,
  stripLeakingCodeComments,
} from '../lib/assessment-quality.js';
import { autofixDeck } from '../lib/card-autofix.js';
import { isCodeOrientedMaterial } from '../lib/notation.js';

/* PR #1402 review: a card flagged "answerLeak in code comment" must not simply be dropped. The deterministic autofix deletes the
   answer-bearing comment lines instead, keeps the code, and the leak gate still drops whatever cannot be cleaned. */

const ANSWER = '[[1, 2, 3]] because the inner list is shared';

const leakingCard = (prompt, extra = {}) => ({
  id: 'q1',
  targetId: 't1',
  kind: 'flashcard',
  topic: 'Shallow copy',
  prompt,
  answer: ANSWER,
  explanation: 'list.copy() shares the inner list, so appending through b changes a.',
  misconception: 'Assuming copy() deep-copies nested lists.',
  ...extra,
});

const leakingPrompt = 'What does this print?\n```python\na = [[1, 2]]\nb = a.copy()\nb[0].append(3)\n# prints [[1, 2, 3]] because the inner list is shared\nprint(a)\n```';
const plan = { targets: [{ targetId: 't1', objective: 'Shallow copy', knowledge: 'copy()', citations: [] }] };
const blueprint = { items: [{ targetId: 't1', answer: ANSWER, reasoning: 'Shared inner list.' }] };

test('#1402-1: autofix deletes an answer-bearing whole-line comment and keeps the card instead of dropping it', () => {
  const deck = { title: 'Deck', cards: [leakingCard(leakingPrompt)] };
  assert.equal(codeCommentLeakIssues(deck).length, 1, 'the fixture must really leak first');

  const fixed = autofixDeck(deck, { assessmentPlan: plan, answerBlueprint: blueprint, constraints: {}, language: 'English', notation: 'text' });
  const card = fixed.deck.cards[0];
  assert.notEqual(card.prompt, leakingPrompt, 'the prompt should be rewritten');
  assert.equal(codeCommentLeakIssues({ cards: [card] }).length, 0, 'the repaired card no longer leaks');
  assert.equal(cardLocalIssues({ cards: [card] }).some((issue) => /answerLeak in code comment/.test(issue)), false);
  // The code itself survives untouched.
  for (const line of ['b = a.copy()', 'b[0].append(3)', 'print(a)']) assert.ok(card.prompt.includes(line), `missing code line: ${line}`);
  assert.ok(fixed.fixes.some((fix) => fix.field === 'prompt' && fix.rule === 'codeComment'), 'the fix is reported');
});

test('#1402-2: autofix cuts only the trailing comment, leaving the code statement on that line', () => {
  const prompt = 'What does this print?\n```js\nconst b = a.slice(); // [[1, 2, 3]] because the inner list is shared\n```';
  const deck = { title: 'Deck', cards: [leakingCard(prompt)] };
  assert.equal(codeCommentLeakIssues(deck).length, 1);

  const fixed = autofixDeck(deck, { assessmentPlan: plan, answerBlueprint: blueprint, constraints: {}, language: 'English', notation: 'text' });
  const card = fixed.deck.cards[0];
  assert.ok(card.prompt.includes('const b = a.slice();'), 'code stays');
  assert.equal(/inner list is shared/.test(card.prompt), false, 'the leaking comment is gone');
  assert.equal(codeCommentLeakIssues({ cards: [card] }).length, 0);
});

test('#1402-3: a card whose comments only leak jointly cannot be cleaned, so autofix leaves it and the gate still drops it', () => {
  const prompt = 'What does this print?\n```python\n# prints [[1, 2, 3]]\n# because the inner list is shared\nprint(a)\n```';
  const deck = { title: 'Deck', cards: [leakingCard(prompt)] };
  const issues = codeCommentLeakIssues(deck);
  assert.equal(issues.length, 1, 'joined comments leak');

  const fixed = autofixDeck(deck, { assessmentPlan: plan, answerBlueprint: blueprint, constraints: {}, language: 'English', notation: 'text' });
  assert.equal(fixed.deck.cards[0].prompt, prompt, 'nothing is deleted that would not fix it');
  assert.ok(cardLocalIssues({ cards: [fixed.deck.cards[0]] }).some((issue) => /answerLeak in code comment/.test(issue)), 'the backstop gate still reports the leak');
});

test('#1402-4: kit-style helpers stay pure: stripLeakingCodeComments never mutates the input card', () => {
  const card = leakingCard(leakingPrompt);
  const before = JSON.stringify(card);
  const stripped = stripLeakingCodeComments(card);
  assert.equal(typeof stripped, 'string');
  assert.equal(JSON.stringify(card), before);
  assert.equal(stripLeakingCodeComments(leakingCard('No code here, [[1, 2, 3]] because the inner list is shared.')), null);
});

test('#1402-5: an untagged block keeps `#` inside a string literal as data, but a line-leading `#` is still a comment', () => {
  // A JS/JSON snippet without a language tag: '#ff8800cc' is a value, not a comment.
  const jsStringCard = {
    id: 'c1', kind: 'flashcard', prompt: "Which colour is assigned?\n```\nconst accent = '#ff8800cc';\n```", answer: '#ff8800cc', explanation: 'The literal is assigned as is.',
  };
  assert.deepEqual(extractFencedCodeComments(jsStringCard.prompt), []);
  assert.deepEqual(codeCommentLeakIssues({ cards: [jsStringCard] }), []);

  // The same block with a real line-leading comment is still read.
  const commented = '```\n# the accent is #ff8800cc\nconst accent = x;\n```';
  assert.deepEqual(extractFencedCodeComments(commented), ['the accent is #ff8800cc']);

  // Tagged hash languages keep mid-line comments.
  assert.deepEqual(extractFencedCodeComments('```py\nx = 1  # the accent is #ff8800cc\n```'), ['the accent is #ff8800cc']);
});

test('#1402-6: a `#` inside a tagged-language string literal is data, and the repair never cuts a string in half', () => {
  const card = {
    id: 'c9', kind: 'flashcard', topic: 'Colour',
    prompt: "What colour is set?\n```py\nACCENT = '#ff8800cc'  # brand accent from the style guide\n```",
    answer: '#ff8800cc', explanation: 'The literal is assigned as is.',
  };
  // The marker inside the literal is not a comment, so the answer is not read out of a comment.
  assert.deepEqual(extractFencedCodeComments(card.prompt), ['brand accent from the style guide']);
  assert.deepEqual(codeCommentLeakIssues({ cards: [card] }), []);
  assert.equal(stripLeakingCodeComments(card), null, 'nothing to strip, nothing broken');
});

test('#1402-7: `C++` in the course name is recognised, and a single fenced block in maths prose does not make a code course', () => {
  const history = [{ id: 'h', title: 'Modern European History', text: 'The Treaty of Westphalia in 1648 established sovereignty.' }];
  assert.equal(isCodeOrientedMaterial(history, { course: 'C++ Programming' }), true);
  assert.equal(isCodeOrientedMaterial(history, { course: 'C++' }), true);
  assert.equal(isCodeOrientedMaterial(history, { course: 'C# fundamentals' }), true);

  const mathHandout = [{
    id: 'm', title: 'Linear Algebra', text: 'Eigenvalues decide diagonalizability: a matrix with n independent eigenvectors is diagonalizable.\n```\nA = P D P^{-1}\n```\nThe determinant is the product of the eigenvalues.',
  }];
  assert.equal(isCodeOrientedMaterial(mathHandout, { course: 'Linear Algebra' }), false);

  // A code-dense body with one snippet is still a code course.
  const codeNotes = [{
    id: 'c', title: 'SQL Notes', text: '```sql\nBEGIN;\nSELECT * FROM t FOR UPDATE;\nUPDATE t SET v = 1;\nCOMMIT;\n```\nBEGIN; ...' + 'const rows = db.query(sql);\nif (!rows.length) { return null; }\nfor (const row of rows) { total += row.v; }\n',
  }];
  assert.equal(isCodeOrientedMaterial(codeNotes, { course: 'Databases' }), true);
});
