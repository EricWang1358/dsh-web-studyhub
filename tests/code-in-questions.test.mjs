/* Generated questions mark code as code (Markdown backticks), and nothing that compares or matches question text trips over that markup.
   The rule (lib/notation.js CODE_STYLE) sits wherever the formula rule sits in a prompt that writes learner-facing question text; the checks that
   compare meaning ignore the backticks (lib/notation.js stripCodeMarkup). Fake models only: no real model's output was used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CODE_STYLE, stripCodeMarkup } from '../lib/notation.js';
import { authorPrompts } from '../lib/generation.js';
import { blueprintPrompts, answerLeakIssues, formulaIssues, clozeIssues, CLOZE_RULE, cardLocalIssues } from '../lib/assessment-quality.js';
import { patchPrompts } from '../lib/generation-yield.js';
import { validateDeck, gradeCloze, norm, quoteFound } from '../lib/domain.js';
import { autofixDeck, wrapBareMath, wrapChoiceOptions } from '../lib/card-autofix.js';
import { clozeRuns, blanksInFormula } from '../lib/cloze-text.js';
import { prepareJsonImport } from '../lib/json-import.js';
import { locateQuote } from '../lib/quote-locate.js';
import { writeVariants, writeRewrite } from '../lib/coach.js';
import { assistInstruction } from '../lib/assist-content.js';
import { caseAuthorPrompt, caseCriteriaPrompt } from '../lib/case-study.js';
import { writePrompt, repairPrompt } from '../lib/contexts/generation/answer-card/prompts.js';
import { settleJob } from './helpers/wait.mjs';
import { card as baseCard } from './helpers/supplement-fixtures.mjs';
import { openLibrary, stagedModel } from './helpers/generation-baseline.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';
import { reviewParts } from './helpers/review-render.mjs';

/* ---------- the rule ---------- */

test('CODE_STYLE is one short English rule that says what to wrap, how, and what never to wrap', () => {
  assert.equal(typeof CODE_STYLE, 'string');
  assert.ok(CODE_STYLE.length > 120 && CODE_STYLE.length < 900, 'short');
  for (const piece of ['`x = 1`', '`#`', '`/* */`', '`.py`', '`print()`']) assert.ok(CODE_STYLE.includes(piece), piece);
  assert.match(CODE_STYLE, /backticks/i);
  assert.match(CODE_STYLE, /fenced/i);
  assert.match(CODE_STYLE, /language tag/i);
  assert.match(CODE_STYLE, /formula/i);
  assert.match(CODE_STYLE, /cloze/i);
  assert.match(CODE_STYLE, /newline/i);
  assert.match(CODE_STYLE, /quote/i);
  assert.doesNotMatch(CODE_STYLE, /[㐀-鿿]/, 'English, like the formula rules');
});

test('stripCodeMarkup keeps the code and drops its markup', () => {
  assert.equal(stripCodeMarkup('use `x = 1` and `#`'), 'use x = 1 and #');
  assert.equal(stripCodeMarkup('a ``b`c`` d'), 'a b`c d');
  assert.equal(stripCodeMarkup('see\n```python\nx = 1\nprint(x)\n```\nnow'), 'see\nx = 1\nprint(x)\nnow');
  assert.equal(stripCodeMarkup('a lone ` stays'), 'a lone ` stays');
  assert.equal(stripCodeMarkup('`'), '`');
  assert.equal(stripCodeMarkup(undefined), '');
});

/* ---------- every prompt that writes question text carries the rule ---------- */

const plan = { targets: [{ targetId: 't1', objective: 'o', knowledge: 'k', citations: [] }] };
const blueprint = { items: [{ targetId: 't1', answer: 'a', reasoning: 'r', comparisonAxis: 'c', scenario: { kind: 'none', facts: [], decisiveConditions: [] } }] };
const request = notation => ({ count: 1, kind: 'quiz', sources: [], notation });

test('the blueprint, author and wording-repair prompts carry CODE_STYLE in both notations, after the formula rule', () => {
  for (const notation of ['text', 'latex']) {
    const author = authorPrompts(request(notation), plan, blueprint).prompt, drafted = blueprintPrompts(request(notation), plan).prompt;
    for (const prompt of [author, drafted]) {
      assert.ok(prompt.includes(CODE_STYLE), `${notation} prompt carries the rule`);
      assert.equal(prompt.split(CODE_STYLE).length, 2, 'once');
    }
    assert.ok(author.indexOf(CODE_STYLE) > author.indexOf('formula'), 'the code rule follows the formula rule');
    assert.ok(drafted.indexOf(CODE_STYLE) > drafted.indexOf('formula'));
  }
  const entries = [{ card: { id: 'q1', kind: 'quiz', prompt: 'p' }, issues: ['q1: explanationQuality failed'] }];
  assert.ok(patchPrompts({ entries, sources: [], notation: 'text' }).prompt.includes(CODE_STYLE));
  assert.ok(patchPrompts({ entries, sources: [] }).prompt.includes(CODE_STYLE));
});

test('adding the rule moves no other text: the prompts differ from the bare ones only by the rule', () => {
  const author = authorPrompts(request('text'), plan, blueprint).prompt;
  const without = author.replace(` ${CODE_STYLE}`, '');
  assert.ok(without.startsWith('STAGE 3') || without.startsWith('REQUEST DATA:'), 'the prompt still begins where it did');
  assert.notEqual(without, author);
});

test('the repair of one draft card carries CODE_STYLE next to its notation rule', async t => {
  const seen = [], staged = stagedModel();
  const model = async (system, prompt, context = {}) => {
    if (system.startsWith('Repair one draft card')) {
      const input = JSON.parse(prompt);
      seen.push(input);
      return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } });
    }
    if (system.startsWith('Act as a strict')) return JSON.stringify(qualityReview(requestData(prompt).candidate));
    return staged.complete(system, prompt, context);
  };
  const { service } = await openLibrary(t, { prefix: 'study-code-', model });
  const source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
  await service.call('source.add', source);
  const card = { ...baseCard('a', 's', source.text), objective: 'Explain principle 1', prompt: 'What guides design question 1?' };
  const saved = await service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [card],
    editorial: { generation: { sourceIds: ['s'], kind: 'flashcard', notationResolved: 'text' }, rejectedIssues: { a: ['explanationQuality failed'] } } } });
  const done = await settleJob(service, (await service.call('draft.repair', { id: 'd', draftVersion: saved.draftVersion })).jobId);
  assert.ok(seen.length >= 1, `a repair call was made (${done.status})`);
  assert.equal(seen[0].code, CODE_STYLE);
  assert.match(seen[0].notation, /plain Unicode/, 'the notation rule is still there');
});

test('the coach variant and feedback-rewrite prompts carry CODE_STYLE', async () => {
  const prompts = [];
  const complete = async (system, prompt) => { prompts.push(String(prompt)); return JSON.stringify({ cards: [], patch: {}, summary: 's' }); };
  const card = { id: 'c', kind: 'quiz', topic: 't', prompt: 'p', answer: 'a', options: [] };
  await writeVariants(complete, { targets: [{ card, kind: 'quiz', reason: 'wrong' }], sources: [], learner: {} });
  await writeRewrite(complete, { card, tags: ['stem-vague'], evidence: [], learner: {} });
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.ok(JSON.parse(prompt).task.includes(CODE_STYLE));
});

test('the background assistant writes new and improved questions under the rule', () => {
  assert.ok(assistInstruction('derive').includes(CODE_STYLE));
  assert.ok(assistInstruction('improve').includes(CODE_STYLE));
  assert.ok(assistInstruction('explain', true).includes(CODE_STYLE), 'a prerequisite card it may add');
});

test('case questions, their criteria and answer cards carry the rule', () => {
  assert.ok(caseAuthorPrompt({ language: 'English', questions: 2, totalMarks: 20, sources: [] }).prompt.includes(CODE_STYLE));
  assert.ok(caseCriteriaPrompt({ scenario: 'a', questions: [{ prompt: 'q', marks: 5 }], language: 'English' }).prompt.includes(CODE_STYLE));
  const cardPlan = { prompt: 'q', marks: 5, criteria: [], paragraphs: [], types: [], guess: null, bounded: [], cardLanguage: 'en', language: 'en' };
  assert.ok(writePrompt(cardPlan).prompt.includes(CODE_STYLE));
  const finished = { questionType: { id: 'general' }, signals: [], facts: [], concepts: [], assumptions: [], steps: [], conclusion: 'c', justification: {}, pitfalls: [], marksMap: [] };
  assert.ok(repairPrompt(cardPlan, finished, ['x']).prompt.includes(CODE_STYLE));
});

test('CLOZE_RULE says a blank value is written without backticks too', () => {
  assert.match(CLOZE_RULE, /backtick/i);
});

/* ---------- checks compare meaning, not markup ---------- */

const source = { id: 's', title: 'Notes', text: 'In Python a comment starts with the hash sign and runs to the end of the line.' };
const choice = (options, extra = {}) => ({ id: 'q', kind: 'quiz', topic: 'Comments', objective: 'Comment sign', prompt: 'Which sign starts a comment?', answer: options.find(o => o.correct).text,
  hint: 'Think of the sign.', explanation: 'The hash sign starts it.', misconception: 'C style.', citations: [{ sourceId: 's', quote: source.text }], options, ...extra });
const option = (id, text, correct = false) => ({ id, text, correct, explanation: `why ${id}` });
const errors = cards => validateDeck({ title: 'D', cards }, [source]).errors;

test('option uniqueness: `#` and # are the same option, `#` and `//` are not', () => {
  assert.ok(errors([choice([option('a', '`#`', true), option('b', '#'), option('c', '`//`')])]).some(e => /duplicate option text/.test(e)));
  assert.ok(errors([choice([option('a', '#', true), option('b', '`#`'), option('c', '`//`')])]).some(e => /duplicate option text/.test(e)));
  assert.deepEqual(errors([choice([option('a', '`#`', true), option('b', '`//`'), option('c', '`--`')])]), []);
  assert.ok(errors([choice([option('a', '#', true), option('b', '#'), option('c', '//')])]).some(e => /duplicate option text/.test(e)), 'plain duplicates are still caught');
  assert.ok(errors([choice([option('a', '```\nx = 1\n```', true), option('b', 'x = 1'), option('c', 'x = 2')])]).some(e => /duplicate option text/.test(e)), 'a fenced block too');
});

test('near-identical stems and a hint equal to the answer are caught through the markup', () => {
  const a = choice([option('a', '`#`', true), option('b', '`//`'), option('c', '`--`')]);
  const b = { ...a, id: 'r', objective: 'Another', prompt: 'Which sign starts a `comment`?' }, c = { ...a, id: 's', objective: 'Third', prompt: 'Which sign starts a comment?' };
  assert.ok(errors([{ ...a, prompt: 'Which sign starts a comment?' }, { ...b, prompt: 'Which sign starts a comment?' }].map((x, i) => ({ ...x, id: `i${i}` }))).some(e => /duplicate prompt/.test(e)));
  assert.ok(errors([{ ...c, prompt: 'Which sign starts a `comment`?' }, { ...a, id: 'z', objective: 'Z', prompt: 'Which sign starts a comment?' }]).some(e => /duplicate prompt/.test(e)));
  assert.ok(errors([{ ...a, hint: '`#`', answer: '#', options: a.options.map(o => ({ ...o, text: o.text.replaceAll('`', '') })) }]).some(e => /hint reveals the answer/.test(e)));
  assert.equal(norm('`x = 1`'), norm('x = 1'));
  assert.notEqual(norm('`x = 1`'), norm('x = 2'));
});

test('an answer leaked into the hint or topic is still caught when either side is in backticks', () => {
  const flashcard = (answer, hint, topic = 'Printing') => ({ cards: [{ id: 'f', kind: 'flashcard', topic, prompt: 'How do you show the total?', answer, hint, explanation: 'e', misconception: 'm' }] });
  assert.equal(answerLeakIssues(flashcard('`print(total_value)`', 'Call print(total_value) here')).length, 1);
  assert.equal(answerLeakIssues(flashcard('print(total_value)', 'Call `print(total_value)` here')).length, 1);
  assert.equal(answerLeakIssues(flashcard('`print(total_value)`', 'Call `print(total_value)` here')).length, 1);
  assert.equal(answerLeakIssues(flashcard('`print(total_value)`', 'Use the built-in output function')).length, 0);
  const choiceCard = { cards: [{ id: 'c', kind: 'quiz', topic: 'Uses `total_amount = 1`', prompt: 'p', hint: 'h', options: [{ id: 'a', text: '`total_amount = 1`', correct: true }, { id: 'b', text: 'x', correct: false }] }] };
  assert.equal(answerLeakIssues(choiceCard).length, 1, 'a correct option in the topic');
});

test('cloze grading compares plain answers: a learner and an accept list may carry backticks', () => {
  const cloze = { kind: 'cloze', cloze: { text: 'print({{b1}}) and {{b2}}', answers: [{ id: 'b1', value: 'x' }, { id: 'b2', value: '#', accept: ['`comment`'] }] } };
  assert.equal(gradeCloze(cloze, { b1: 'x', b2: '#' }).correct, true);
  assert.equal(gradeCloze(cloze, { b1: '`x`', b2: 'comment' }).correct, true, 'a typed `x` is x; the accept entry in backticks still matches');
  assert.equal(gradeCloze(cloze, { b1: 'y', b2: '#' }).correct, false);
  const stored = { kind: 'cloze', cloze: { text: '{{b1}}', answers: [{ id: 'b1', value: '`x`' }] } };
  assert.equal(gradeCloze(stored, { b1: 'x' }).correct, true, 'a stored value written in backticks still grades on the plain text');
});

test('the autofix writes cloze blanks as plain answers and leaves everything else of a cloze alone', () => {
  const target = { targetId: 't1', objective: 'o' }, item = { targetId: 't1', answer: 'x', reasoning: 'r', comparisonAxis: 'c' };
  const cloze = { id: 'k', targetId: 't1', kind: 'cloze', topic: 'Printing', prompt: 'Call `print({{b1}})`.', answer: 'x', hint: 'Name the variable.', explanation: 'e', misconception: 'm',
    cloze: { text: 'Call `print({{b1}})`.', answers: [{ id: 'b1', value: '`x`', accept: ['`y`', 'z'] }] } };
  const { deck, fixes } = autofixDeck({ cards: [cloze] }, { assessmentPlan: { targets: [target] }, answerBlueprint: { items: [item] }, expectedKind: 'cloze' });
  assert.deepEqual(deck.cards[0].cloze.answers, [{ id: 'b1', value: 'x', accept: ['y', 'z'] }]);
  assert.equal(deck.cards[0].cloze.text, 'Call `print({{b1}})`.', 'the sentence keeps its code markup');
  assert.ok(fixes.some(fix => fix.cardId === 'k' && fix.rule === 'code'));
});

test('the autofix lets a choice card keep following its correct option when the answer and the option differ only by backticks', () => {
  const target = { targetId: 't1', objective: 'o' }, item = { targetId: 't1', answer: '#', reasoning: 'r', comparisonAxis: 'c' };
  const quiz = choice([option('a', '`#`', true), option('b', '`//`'), option('c', '`--`')], { targetId: 't1', answer: '#' });
  const { deck } = autofixDeck({ cards: [quiz] }, { assessmentPlan: { targets: [target] }, answerBlueprint: { items: [item] }, expectedKind: 'quiz' });
  assert.equal(deck.cards[0].answer, '`#`', 'the answer follows the correct option, as for any other markup');
});

test('the math scan and notation autofix leave code spans and fences alone', () => {
  const codeCard = (prompt, option2 = 'plain') => ({ cards: [{ id: 'c', kind: 'quiz', topic: 'Code', prompt, answer: option2, hint: 'h', explanation: 'e', misconception: 'm' }] });
  for (const notation of ['text', 'latex', undefined]) {
    assert.deepEqual(formulaIssues(codeCard('Run `H2SO4 = x^2` and `a_{i}` then `\\frac{1}{2}` in `$HOME/$PATH`'), { notation }), [], `inline code, ${notation}`);
    assert.deepEqual(formulaIssues(codeCard('Look:\n```python\ny = x^2 + H2SO4\nz = a_{i}\n```\ndone'), { notation }), [], `fenced block, ${notation}`);
  }
  for (const notation of ['text', 'latex']) {
    for (const text of ['Run `H2SO4 = x^2` now', 'Look:\n```c\nint a = b^2;  /* x_{i} */\n```\nok', '`$HOME` and `$PATH`', 'a `x^2` b and `SO42-`'])
      assert.equal(wrapBareMath(text, notation), text, `${notation}: ${text}`);
  }
  const options = [option('a', '`x^2 + 1`', true), option('b', '`x^2`'), option('c', '`a_{i}`')];
  assert.deepEqual(wrapChoiceOptions(options, 'latex').map(o => o.text), ['`x^2 + 1`', '`x^2`', '`a_{i}`'], 'an option that is code is not wrapped as a formula');
  assert.deepEqual(wrapChoiceOptions(options, 'text').map(o => o.text), ['`x^2 + 1`', '`x^2`', '`a_{i}`']);
  assert.deepEqual(cardLocalIssues(codeCard('Does `x = 1` hold?'), { notation: 'latex' }).filter(issue => /formula|cloze/.test(issue)), []);
});

test('a quote with backticks is found in a source without them, and the other way round', () => {
  const plain = 'In Python the line x = 1 sets x, and the hash sign # starts a comment.', marked = 'In Python the line `x = 1` sets x, and the hash sign `#` starts a comment.';
  assert.ok(quoteFound(plain, marked));
  assert.ok(quoteFound(marked, plain));
  assert.ok(locateQuote(plain, marked), 'located');
  assert.ok(locateQuote(marked, plain), 'located');
});

test('CODE_STYLE sits in a cloze rule that keeps blanks and code apart; clozeRuns draws a blank inside a code span', () => {
  const runs = clozeRuns('Call `print({{b1}})` for `x`.');
  assert.deepEqual(runs, [{ t: 'text', v: 'Call ' }, { t: 'code', v: 'print(' }, { t: 'blank', id: 'b1' }, { t: 'code', v: ')' }, { t: 'text', v: ' for ' }, { t: 'code', v: 'x' }, { t: 'text', v: '.' }]);
  assert.deepEqual(clozeRuns('A {{b1}} and B'), [{ t: 'text', v: 'A ' }, { t: 'blank', id: 'b1' }, { t: 'text', v: ' and B' }], 'a text without code is as it was');
  assert.deepEqual(clozeRuns('Use `$HOME` and {{b1}}'), [{ t: 'text', v: 'Use ' }, { t: 'code', v: '$HOME' }, { t: 'text', v: ' and ' }, { t: 'blank', id: 'b1' }], 'a dollar in code is no formula');
  assert.deepEqual(blanksInFormula('Call `print({{b1}})` and $x + {{b2}}$'), ['b2'], 'a blank in code is no blank in a formula');
  assert.deepEqual(clozeIssues({ cards: [{ id: 'k', kind: 'cloze', cloze: { text: 'Call `print({{b1}})`.', answers: [{ id: 'b1', value: 'x' }] } }] }), []);
});

test('the JSON import keeps backticks and fenced blocks as written and passes the deck gate', () => {
  const text = readFileSync(new URL('./fixtures/code-question-deck.json', import.meta.url), 'utf8');
  const { deck } = prepareJsonImport(text, []);
  assert.equal(deck.cards.length, 2);
  assert.match(deck.cards[0].prompt, /`\.py`/);
  assert.match(deck.cards[0].prompt, /```python\nx = 1 {2}# 设置 x/);
  assert.equal(deck.cards[0].options[0].text, '`#`');
  assert.deepEqual(deck.quality.errors.filter(e => !/citations/.test(e)), []);
  assert.deepEqual(clozeIssues(deck), []);
});

/* ---------- the question card draws code as code ---------- */

const compiled = await build({ stdin: { contents: `export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';`, resolveDir: process.cwd() }, bundle: true,
write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { QuestionRun, StudyServicesContext } = mod.exports;
const render = old => {
  const { services, props } = reviewParts({ data: { sources: [] }, ...old });
  return renderToStaticMarkup(React.createElement(StudyServicesContext.Provider, { value: services },
    React.createElement(QuestionRun, { session: props.session, data: props.data, links: props.links, context: props.context, feedback: props.feedback })));
};
const deckOf = () => prepareJsonImport(readFileSync(new URL('./fixtures/code-question-deck.json', import.meta.url), 'utf8'), []).deck;

test('a question with inline code and a fenced block draws <code> in the stem and <pre class="md-code"> for the block', () => {
  const quiz = { ...deckOf().cards[0], id: 'q' };
  const html = render({ run: { id: 'r', index: 0, total: 1, mode: 'path', card: quiz } });
  assert.match(html, /<code>\.py<\/code>/);
  assert.match(html, /<code>x = 1<\/code>/);
  assert.match(html, /<pre class="md-code"><code>x = 1 {2}# 设置 x\nprint\(x\)<\/code><\/pre>/);
  assert.doesNotMatch(html, /`/, 'no backtick is left over on screen');
  for (const code of ['#', '/* */', '//', '--']) assert.ok(html.includes(`<code>${code}</code>`), `option ${code} is code`);
});

test('the options and their explanations draw code after the answer too (right and wrong)', () => {
  const quiz = { ...deckOf().cards[0], id: 'q' };
  const html = render({ run: { id: 'r', index: 0, total: 1, mode: 'path', card: quiz, revealed: true, answered: true, selected: ['b'] }, selected: ['b'],
    feedback: { correct: false, selected: ['b'], answer: 'a' } });
  assert.match(html, /<code>SyntaxError<\/code>/, 'the explanation of the wrong option');
  assert.doesNotMatch(html, /`/);
});

test('a cloze question draws its code spans as code and keeps the blank as an input', () => {
  const cloze = { ...deckOf().cards[1], id: 'k' };
  const html = render({ run: { id: 'r', index: 0, total: 1, mode: 'path', card: cloze } });
  assert.match(html, /<code[^>]*>print\(<\/code>/);
  assert.match(html, /<code[^>]*>\)<\/code>/);
  assert.match(html, /<input[^>]*cloze-blank/);
  assert.doesNotMatch(html, /`/);
});
