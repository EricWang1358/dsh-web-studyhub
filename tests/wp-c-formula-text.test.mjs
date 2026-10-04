import test from 'node:test';
import assert from 'node:assert/strict';
import { autofixDeck, wrapBareMath } from '../lib/card-autofix.js';
import { generateDeck, authorPrompts } from '../lib/generation.js';
import { blueprintPrompts, blueprintAssessment, formulaIssues } from '../lib/assessment-quality.js';
import { validateDeck } from '../lib/domain.js';
import { qualityPlan, qualityReview } from './helpers/assessment.mjs';

const source = { id: 's', title: 'Course notes', text: 'Sulfuric acid is a strong acid that ionises completely in water to give hydrogen ions.' };
const ANSWER = 'Sulfuric acid ionises completely.';
const opt = (id, text, correct, explanation = `Why ${id} is ${correct ? 'right' : 'wrong'}.`) => ({ id, text, correct, explanation });
const plan = () => ({ targets: [{ targetId: 'target-1', objective: 'Recognise the strong acid', knowledge: 'k', citations: [{ sourceId: 's', quote: source.text }] }] });
const blueprint = (options, answer = ANSWER, extra = {}) => ({ items: [{ targetId: 'target-1', answer, reasoning: 'The notes state sulfuric acid ionises completely in water.',
  scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'Which species is produced', options, ...extra }] });
const goodCard = (extra = {}) => ({ id: 'q1', targetId: 'target-1', kind: 'quiz', topic: 'Strong acids', objective: 'Recognise the strong acid',
  prompt: 'Which species is produced when the acid dissolves?', answer: ANSWER, hint: 'Think about complete ionisation.',
  explanation: 'Because the notes say it ionises completely.', misconception: 'Treating it as a weak acid.',
  citations: [{ sourceId: 's', quote: source.text }], options: [opt('a', 'one', true), opt('b', 'two', false), opt('c', 'three', false)], ...extra });
const run = (card, options = card.options) => autofixDeck({ title: 't', cards: [card] },
  { assessmentPlan: plan(), answerBlueprint: blueprint(options, card.answer), expectedKind: 'quiz', language: 'English' });

test('chemistry: neutral formulas in stem, answer, options and explanations are wrapped consistently, answer stays equal to the correct option', () => {
  const options = [opt('a', 'H2SO4', true, 'H2SO4 ionises fully into H+ and HSO4-.'), opt('b', 'H2SO3', false, 'H2SO3 is a weak acid.'), opt('c', 'NaOH', false, 'NaOH is a base.')];
  const { deck, fixes } = run(goodCard({ answer: 'H2SO4', options, prompt: '浓 H2SO4 溶于水后，下列哪一项是强酸？2个H+ 来自它。',
    explanation: 'H2SO4 的第一步电离几乎完全，产生 H+。', misconception: '把 H2SO4 当成弱酸 H2SO3。' }));
  const [card] = deck.cards;
  assert.equal(card.prompt, '浓 $\\ce{H2SO4}$ 溶于水后，下列哪一项是强酸？2个$\\ce{H+}$ 来自它。');
  assert.deepEqual(card.options.map(option => option.text), ['$\\ce{H2SO4}$', '$\\ce{H2SO3}$', '$\\ce{NaOH}$']);
  assert.equal(card.answer, card.options[0].text);
  assert.equal(card.options[0].explanation, '$\\ce{H2SO4}$ ionises fully into $\\ce{H+}$ and $\\ce{HSO4-}$.');
  assert.equal(card.explanation, '$\\ce{H2SO4}$ 的第一步电离几乎完全，产生 $\\ce{H+}$。');
  assert.equal(card.misconception, '把 $\\ce{H2SO4}$ 当成弱酸 $\\ce{H2SO3}$。');
  assert.equal(formulaIssues(deck).length, 0);
  assert.ok(fixes.length >= 6);
  assert.deepEqual(validateDeck(deck, [source]).errors, validateDeck({ title: 't', cards: [goodCard({ answer: 'H2SO4', options })] }, [source]).errors);
});

test('chemistry: an ambiguous ion such as SO42− is never rewritten and stays reported', () => {
  const options = [opt('a', 'SO42−', true), opt('b', 'HSO4-', false), opt('c', 'H2SO4', false)];
  const { deck } = run(goodCard({ answer: 'SO42−', options, prompt: '硫酸根 SO42− 的检验。' }));
  const [card] = deck.cards;
  assert.equal(card.options[0].text, 'SO42−');
  assert.equal(card.answer, 'SO42−');
  assert.equal(card.options[1].text, '$\\ce{HSO4-}$');
  assert.equal(card.prompt, '硫酸根 SO42− 的检验。');
  const issues = formulaIssues(deck);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^Card 1: formula outside math delimiters/);
  assert.match(issues[0], /SO42−/);
  assert.match(issues[0], /\\\\ce\{/, 'the message tells the model how to write it');
  // ui/draft-shortfall.js issueCode() maps exactly this phrase to the formula label.
});

test('formulaIssues reports bare chemistry and plain-text math with the instruction to use $…$ and \\ce', () => {
  const chem = formulaIssues({ cards: [goodCard({ prompt: '浓 H2SO4 的性质' })] });
  assert.equal(chem.length, 1);
  assert.match(chem[0], /^Card 1: formula outside math delimiters \("H2SO4"\)/);
  assert.match(chem[0], /\$\\\\ce\{H2SO4\}\$/);
  assert.match(chem[0], /\$\\\\ce\{SO4\^2-\}\$/);
  const math = formulaIssues({ cards: [goodCard({ prompt: '化简 √8+√18', explanation: '得到 x≠1 且 x^2+1' })] });
  assert.equal(math.length, 1);
  assert.match(math[0], /^Card 1: formula outside math delimiters/);
  assert.equal(formulaIssues({ cards: [goodCard({ prompt: 'A4 paper, C++ and 1+1 的口算, 2026-10-04, A/B 测试', hint: '$\\ce{H2SO4}$ 和 $x+1$' })] }).length, 0);
});

test('radical and expression options become one parallel set of $…$ options and the answer follows the correct option', () => {
  const options = [opt('a', '5√4', false), opt('b', '√26', false), opt('c', '10√2', false), opt('d', '5√2', true)];
  const { deck } = run(goodCard({ answer: '5√2', options }));
  assert.deepEqual(deck.cards[0].options.map(option => option.text), ['$5\\sqrt{4}$', '$\\sqrt{26}$', '$10\\sqrt{2}$', '$5\\sqrt{2}$']);
  assert.equal(deck.cards[0].answer, '$5\\sqrt{2}$');
  assert.deepEqual(deck.cards[0].options.map(option => option.correct), [false, false, false, true]);
  assert.equal(formulaIssues(deck).length, 0);
});

test('a plain number next to an expression option is wrapped too, so the set stays visually parallel', () => {
  const options = [opt('a', '1', false), opt('b', 'x+1', true), opt('c', 'x−1', false), opt('d', 'x^2+1', false)];
  const { deck } = run(goodCard({ answer: 'x+1', options }));
  assert.deepEqual(deck.cards[0].options.map(option => option.text), ['$1$', '$x+1$', '$x-1$', '$x^{2}+1$']);
  assert.equal(deck.cards[0].answer, '$x+1$');
  // The same answer when the correct option is the plain number.
  const number = run(goodCard({ answer: '1', options: [opt('a', '1', true), opt('b', 'x+1', false), opt('c', 'x−1', false)] }));
  assert.equal(number.deck.cards[0].answer, '$1$');
  assert.equal(number.deck.cards[0].options[0].text, '$1$');
});

test('option sets without any math are untouched, and prose options only get their math spans wrapped', () => {
  const numbers = run(goodCard({ answer: '1', options: [opt('a', '1', true), opt('b', '2', false), opt('c', '3', false)] }));
  assert.deepEqual(numbers.deck.cards[0].options.map(option => option.text), ['1', '2', '3']);
  const prose = run(goodCard({ answer: 'Use x+1 as the divisor', options: [opt('a', 'Use x+1 as the divisor', true), opt('b', 'Use 2 as the divisor', false), opt('c', '两边同时约去(x−1)', false)] }));
  assert.deepEqual(prose.deck.cards[0].options.map(option => option.text), ['Use $x+1$ as the divisor', 'Use 2 as the divisor', '两边同时约去$(x-1)$']);
  assert.equal(prose.deck.cards[0].answer, 'Use $x+1$ as the divisor');
});

test('two options that would collapse into one are left as authored', () => {
  const options = [opt('a', 'x+1', true), opt('b', '$x+1$', false), opt('c', 'x−1', false)];
  const { deck } = run(goodCard({ answer: 'x+1', options }));
  assert.equal(deck.cards[0].options[0].text, 'x+1');
  assert.equal(deck.cards[0].options[1].text, '$x+1$');
  assert.equal(deck.cards[0].answer, 'x+1', 'the answer keeps following the correct option');
});

test('stem, hint and explanation: only the math spans are wrapped, the Chinese is untouched', () => {
  const { deck } = run(goodCard({ prompt: '化简 (x^2-1)/(x-1) 时，当 x≠1 可约去因子。', explanation: '约去非零因子(x−1)后得到x+1', hint: '先因式分解 x^2-1' }));
  const [card] = deck.cards;
  assert.equal(card.explanation, '约去非零因子$(x-1)$后得到$x+1$');
  assert.equal(card.hint, '先因式分解 $x^{2}-1$');
  assert.match(card.prompt, /当 \$x\\neq 1\$ 可约去因子/);
  assert.equal(wrapBareMath('速度 5 m/s 的 A/B 测试 1+1 的口算'), '速度 5 m/s 的 A/B 测试 1+1 的口算');
});

test('blueprint items get their options and formulas wrapped deterministically, with no correction round', async () => {
  const request = { count: 1, kind: 'quiz', sources: [source] };
  const item = { ...blueprint([opt('a', '5√4', false), opt('b', '√26', false), opt('c', '10√2', false), opt('d', '5√2', true)], '5√2').items[0],
    reasoning: '化简 √8+√18 得 5√2；约去非零因子(x−1)。' };
  let asked = 0;
  const fixed = await blueprintAssessment(async () => { asked++; return { items: [item] }; }, request, plan());
  assert.equal(asked, 1);
  assert.deepEqual(fixed.items[0].options.map(option => option.text), ['$5\\sqrt{4}$', '$\\sqrt{26}$', '$10\\sqrt{2}$', '$5\\sqrt{2}$']);
  assert.equal(fixed.items[0].answer, '$5\\sqrt{2}$');
  assert.equal(fixed.items[0].reasoning, '化简 $\\sqrt{8}+\\sqrt{18}$ 得 $5\\sqrt{2}$；约去非零因子$(x-1)$。');
  // An ambiguous ion cannot be fixed by the program: the one correction round names it.
  const prompts = [];
  await assert.rejects(blueprintAssessment(async (system, prompt) => { prompts.push(prompt); return { items: [{ ...item, options: [opt('a', 'SO42−', true), opt('b', 'HSO4-', false), opt('c', 'OH-', false)], answer: 'SO42−' }] }; }, request, plan()), /formula outside math delimiters/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /SO42−/);
});

test('prompts: chemistry in \\ce, ions with a caret, equations in one \\ce, and options that are expressions in $…$', () => {
  const author = authorPrompts({ count: 1, kind: 'quiz', sources: [source] }, plan(), blueprint([opt('a', 'one', true), opt('b', 'two', false)])).prompt;
  const bp = blueprintPrompts({ count: 1, kind: 'quiz', sources: [source] }, plan()).prompt;
  for (const prompt of [author, bp]) {
    assert.match(prompt, /\$\\\\ce\{SO4\^2-\}\$/);
    assert.match(prompt, /\$\\\\ce\{N2 \+ 3H2 <=> 2NH3\}\$/);
    assert.match(prompt, /every option that is a number, expression or formula is written in \$…\$/i);
    assert.match(prompt, /\$5\\\\sqrt\{2\}\$/);
    assert.match(prompt, /never with Unicode √ or a bare \^/);
  }
});

test('the plain-text notation (公式写法 text) keeps Unicode math as written and turns chemistry and TeX into Unicode: nothing is wrapped, flagged or prompted for \ce', async () => {
  const options = [opt('a', '5√4', false), opt('b', '√26', false), opt('c', '5√2', true)];
  const card = goodCard({ answer: '5√2', options, prompt: '化简 √8+√18，当 x≠1 时，H2SO4 的 a/b。', explanation: '得到 x^2 与 TeX a^{2}。' });
  const { deck } = autofixDeck({ title: 't', cards: [card] }, { assessmentPlan: plan(), answerBlueprint: blueprint(options, '5√2'), expectedKind: 'quiz', language: 'English', notation: 'text' });
  assert.deepEqual(deck.cards[0].options.map(option => option.text), ['5√4', '√26', '5√2']);
  assert.equal(deck.cards[0].prompt, '化简 √8+√18，当 x≠1 时，H₂SO₄ 的 a/b。');
  assert.equal(deck.cards[0].explanation, '得到 x² 与 TeX a²。', 'TeX and caret powers become Unicode in the text notation');
  assert.equal(formulaIssues({ cards: [goodCard({ prompt: '化简 √8+√18，当 x≠1 时，H2SO4 的 a/b。' })] }, { notation: 'text' }).length, 0);
  assert.equal(formulaIssues({ cards: [goodCard({ prompt: '化简 √8+√18' })] }).length, 1);
  assert.equal(formulaIssues({ cards: [goodCard({ prompt: 'bare a^{2} here' })] }, { notation: 'text' }).length, 1);
  const request = { count: 1, kind: 'quiz', sources: [source], notation: 'text' };
  assert.doesNotMatch(authorPrompts(request, plan(), blueprint([opt('a', 'one', true), opt('b', 'two', false)])).prompt, /Chemical formulas, ions and equations always go in/);
  assert.doesNotMatch(blueprintPrompts(request, plan()).prompt, /Chemical formulas, ions and equations always go in/);
  assert.match(blueprintPrompts({ ...request, notation: 'latex' }, plan()).prompt, /Chemical formulas, ions and equations always go in/);
  const asked = await blueprintAssessment(async () => ({ items: [blueprint(options, '5√2').items[0]] }), request, plan());
  assert.deepEqual(asked.items[0].options.map(option => option.text), ['5√4', '√26', '5√2']);
});

test('generateDeck keeps a chemistry card with bare neutral formulas without any extra model call', async () => {
  const req = { count: 1, kind: 'quiz', language: 'English', sources: [source] };
  const planned = qualityPlan(req);
  const options = [opt('a', 'H2SO4', true, 'H2SO4 ionises fully into H+ and HSO4-.'), opt('b', 'H2SO3', false, 'H2SO3 is a weak acid.'), opt('c', 'NH3', false, 'NH3 is a weak base.')];
  const item = { ...blueprint(options, 'H2SO4').items[0], targetId: planned.targets[0].targetId };
  const authoredCard = { ...goodCard({ targetId: planned.targets[0].targetId, prompt: 'Which of these, such as H2SO4 or CaCO3 in the lab, ionises completely in water?',
    explanation: 'H2SO4 gives 2个H+ per unit in the first step; H2SO3 does not.' }) };
  delete authoredCard.citations; delete authoredCard.objective; delete authoredCard.answer; delete authoredCard.options;
  const calls = [];
  const result = await generateDeck(async (system, prompt) => {
    if (system.startsWith('Plan')) { calls.push('plan'); return JSON.stringify(planned); }
    if (system.startsWith('Prepare supported answers')) { calls.push('blueprint'); return JSON.stringify({ items: [item] }); }
    if (system.startsWith('You author')) { calls.push('author'); return JSON.stringify({ deck: { title: 'Acids', cards: [authoredCard] }, changes: [] }); }
    calls.push('review');
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  }, req);
  assert.deepEqual(calls, ['plan', 'blueprint', 'author', 'review']);
  assert.equal(result.cards.length, 1);
  const [card] = result.cards;
  assert.deepEqual(card.options.map(option => option.text), ['$\\ce{H2SO4}$', '$\\ce{H2SO3}$', '$\\ce{NH3}$']);
  assert.equal(card.answer, card.options[0].text);
  assert.equal(card.prompt, 'Which of these, such as $\\ce{H2SO4}$ or $\\ce{CaCO3}$ in the lab, ionises completely in water?');
  assert.equal(card.explanation, '$\\ce{H2SO4}$ gives 2个$\\ce{H+}$ per unit in the first step; $\\ce{H2SO3}$ does not.');
  assert.equal(result.editorial.dropped, undefined);
});
