import test from 'node:test';
import assert from 'node:assert/strict';
import { autofixDeck } from '../lib/card-autofix.js';
import { generateDeck, authorPrompts } from '../lib/generation.js';
import { blueprintPrompts, blueprintAssessment, formulaIssues, answerLeakIssues } from '../lib/assessment-quality.js';
import { validateDeck } from '../lib/domain.js';
import { qualityPlan, qualityReview } from './helpers/assessment.mjs';

const source = { id: 's', title: 'Course notes', text: 'Architecture includes the principles guiding a system design and evolution.' };
const ANSWER = 'Principles guide subsequent design choices and changes.';
const options = () => [
  { id: 'a', text: 'Principles govern later design choices.', correct: true, explanation: 'The definition includes principles governing design and evolution.' },
  { id: 'b', text: 'Architecture records only components.', correct: false, explanation: 'This omits the principles in the quoted definition.' },
  { id: 'c', text: 'Evolution is unconstrained.', correct: false, explanation: 'Principles also guide how the system evolves.' },
];
const plan = (kind = 'quiz') => ({ targets: [{ targetId: 'target-1', objective: 'Recognize the role of architectural principles',
  knowledge: 'k', citations: [{ sourceId: 's', quote: source.text }] }] , kind });
const blueprint = (kind = 'quiz') => ({ items: [{ targetId: 'target-1', answer: ANSWER, reasoning: 'The quoted definition lists principles guiding design and evolution.',
  scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'What governs the design decision',
  ...(kind === 'quiz' ? { options: options() } : {}) }] });
const goodCard = (extra = {}) => ({ id: 'q1', targetId: 'target-1', kind: 'quiz', topic: 'Architecture decisions', objective: 'Recognize the role of architectural principles',
  prompt: 'Which statement describes what governs later design choices?', answer: ANSWER, hint: 'Think about what constrains future change.',
  explanation: 'Because the definition includes principles.', misconception: 'Architecture only lists components.',
  citations: [{ sourceId: 's', quote: source.text }], options: options(), ...extra });
const run = (card, opts = {}, kind = 'quiz') => autofixDeck({ title: 't', cards: [card] },
  { assessmentPlan: plan(kind), answerBlueprint: blueprint(kind), expectedKind: kind, language: '中文', ...opts });

test('a clean card is returned unchanged with no fixes', () => {
  const input = { title: 't', cards: [goodCard()] }, before = structuredClone(input);
  const { deck, fixes } = autofixDeck(input, { assessmentPlan: plan(), answerBlueprint: blueprint(), expectedKind: 'quiz', language: 'English' });
  assert.deepEqual(fixes, []);
  assert.deepEqual(deck, before);
  assert.deepEqual(input, before, 'input is never mutated');
});

test('a wrong kind becomes the requested kind', () => {
  const { deck, fixes } = run(goodCard({ kind: 'flashcard' }));
  assert.equal(deck.cards[0].kind, 'quiz');
  assert.deepEqual(fixes, [{ cardId: 'q1', field: 'kind', rule: 'kind' }]);
});

test('blank topic falls back to the target objective; a leaking topic too', () => {
  for (const topic of ['', '   ', undefined]) {
    const { deck, fixes } = run(goodCard({ topic }));
    assert.equal(deck.cards[0].topic, 'Recognize the role of architectural principles');
    assert.equal(fixes[0].field, 'topic');
  }
  const leaking = run(goodCard({ topic: 'Principles govern later design choices.' }));
  assert.equal(leaking.deck.cards[0].topic, 'Recognize the role of architectural principles');
  // The objective itself leaks: the comparison axis is the next neutral choice.
  const bothLeak = autofixDeck({ title: 't', cards: [goodCard({ topic: 'Principles govern later design choices.' })] },
    { assessmentPlan: { targets: [{ ...plan().targets[0], objective: 'Principles govern later design choices.' }] }, answerBlueprint: blueprint(), expectedKind: 'quiz', language: 'English' });
  assert.equal(bothLeak.deck.cards[0].topic, 'What governs the design decision');
});

test('blank explanation takes the blueprint reasoning', () => {
  const { deck, fixes } = run(goodCard({ explanation: '' }));
  assert.equal(deck.cards[0].explanation, 'The quoted definition lists principles guiding design and evolution.');
  assert.equal(fixes[0].rule, 'explanation');
});

test('blank misconception uses the first incorrect option explanation, else the comparison axis', () => {
  const choice = run(goodCard({ misconception: undefined }));
  assert.equal(choice.deck.cards[0].misconception, 'This omits the principles in the quoted definition.');
  const open = run({ ...goodCard({ misconception: '', kind: 'open', rubric: 'r' }), options: undefined }, {}, 'open');
  assert.equal(open.deck.cards[0].misconception, 'What governs the design decision');
});

test('missing, answer-equal or leaking hints become a neutral method hint', () => {
  for (const hint of [undefined, '', ANSWER, 'It is that principles govern later design choices.']) {
    const { deck, fixes } = run(goodCard({ hint }));
    assert.equal(deck.cards[0].hint, '先想清楚：What governs the design decision', String(hint));
    assert.equal(fixes[0].field, 'hint');
  }
  assert.equal(run(goodCard({ hint: '' }), { language: 'English' }).deck.cards[0].hint, 'First think about: What governs the design decision');
});

test('a hint axis that still leaks falls back to the generic method hint', () => {
  const leakyBlueprint = { items: [{ ...blueprint().items[0], comparisonAxis: 'Principles govern later design choices.' }] };
  const zh = autofixDeck({ title: 't', cards: [goodCard({ hint: '' })] }, { assessmentPlan: plan(), answerBlueprint: leakyBlueprint, expectedKind: 'quiz', language: '中文' });
  assert.equal(zh.deck.cards[0].hint, '先找出题干里决定答案的条件，再逐一排除');
  const en = autofixDeck({ title: 't', cards: [goodCard({ hint: '' })] }, { assessmentPlan: plan(), answerBlueprint: leakyBlueprint, expectedKind: 'quiz', language: 'English' });
  assert.equal(en.deck.cards[0].hint, 'Find the condition in the stem that decides the answer, then rule out the others');
});

test('hintNoAnswer/topicNoAnswer false leaves leaks alone', () => {
  const card = goodCard({ hint: 'It is that principles govern later design choices.', topic: 'Principles govern later design choices.' });
  const { deck, fixes } = run(card, { constraints: { hintNoAnswer: false, topicNoAnswer: false } });
  assert.deepEqual(fixes, []);
  assert.equal(deck.cards[0].hint, card.hint);
  assert.equal(deck.cards[0].topic, card.topic);
});

test('bare TeX is wrapped in place in every learner text, never in cloze text', () => {
  const { deck, fixes } = run(goodCard({
    topic: 'Layer a^{l-1} activation',
    prompt: 'Compute \\frac{a}{b} for the layer.',
    hint: 'Use x_{i} and the chain rule.',
    explanation: 'Since a^{2}+b^{2}=c^{2} holds.',
    misconception: 'Treating \\alpha as constant.',
    options: options().map((option, index) => index === 1 ? { ...option, explanation: 'It drops the \\sum term.' } : option),
  }));
  const [card] = deck.cards;
  assert.equal(card.topic, 'Layer $a^{l-1}$ activation');
  assert.equal(card.prompt, 'Compute $\\frac{a}{b}$ for the layer.');
  assert.equal(card.hint, 'Use $x_{i}$ and the chain rule.');
  assert.equal(card.explanation, 'Since $a^{2}+b^{2}=c^{2}$ holds.');
  assert.equal(card.misconception, 'Treating $\\alpha$ as constant.');
  assert.equal(card.options[1].explanation, 'It drops the $\\sum$ term.');
  assert.equal(formulaIssues(deck).length, 0);
  assert.ok(fixes.every(fix => fix.rule === 'formula'));
  assert.equal(fixes.length, 6);
});

test('a formula is wrapped as one span, including its command arguments and trailing power', () => {
  const { deck } = run(goodCard({ prompt: '损失为 \\frac{1}{2}(y-\\hat{y})^2，其中 y 为真值。', hint: 'Use \\sqrt[3]{x}+1 and W^{(l)}.' }));
  assert.equal(deck.cards[0].prompt, '损失为 $\\frac{1}{2}(y-\\hat{y})^2$，其中 y 为真值。');
  assert.equal(deck.cards[0].hint, 'Use $\\sqrt[3]{x}+1$ and $W^{(l)}$.');
  assert.equal(run(goodCard({ explanation: 'The folder C:\\Users\\log holds it.' })).fixes.length, 0);
});

test('bare TeX skips text with a blank marker, already delimited math and the cloze stem', () => {
  const marker = run(goodCard({ prompt: 'Fill {{b1}} where a^{2} appears.' }));
  assert.equal(marker.deck.cards[0].prompt, 'Fill {{b1}} where a^{2} appears.');
  const delimited = run(goodCard({ explanation: 'Already $a^{2}$ fine and \\(x_{i}\\) too.' }));
  assert.deepEqual(delimited.fixes, []);
  const cloze = { ...goodCard({ kind: 'cloze', prompt: 'Value is {{b1}} for a^{2}.', cloze: { text: 'Value is {{b1}} for a^{2}.', answers: [{ id: 'b1', value: 'principles' }] } }), options: undefined };
  const out = autofixDeck({ title: 't', cards: [cloze] }, { assessmentPlan: plan('cloze'), answerBlueprint: { items: [{ ...blueprint('cloze').items[0], cloze: cloze.cloze }] }, expectedKind: 'cloze', language: '中文' });
  assert.equal(out.deck.cards[0].prompt, 'Value is {{b1}} for a^{2}.');
  assert.equal(out.deck.cards[0].cloze.text, 'Value is {{b1}} for a^{2}.');
});

test('a bare formula that cannot be wrapped cleanly is left unchanged', () => {
  const text = 'See `a^{2}` in code and `\\frac` too.';
  const { deck, fixes } = run(goodCard({ explanation: text }));
  assert.equal(deck.cards[0].explanation, text);
  assert.deepEqual(fixes, []);
});

test('answer, options, rubric, cloze, citations, objective and targetId are never touched', () => {
  const card = goodCard({ topic: '', hint: '', explanation: '', misconception: '', kind: 'flashcard', prompt: 'See \\frac{a}{b}.' });
  const before = structuredClone(card);
  const { deck } = run(card);
  const after = deck.cards[0];
  for (const key of ['answer', 'options', 'rubric', 'cloze', 'citations', 'objective', 'targetId', 'id'])
    assert.deepEqual(after[key], before[key], key);
  const valid = validateDeck(deck, [source]);
  assert.deepEqual(valid.errors.filter(error => /required|hint reveals|unsupported kind/.test(error)), []);
});

test('cards without a bound target and blueprint item are left alone', () => {
  const { deck, fixes } = run(goodCard({ targetId: 'target-9', topic: '', hint: '' }));
  assert.deepEqual(fixes, []);
  assert.equal(deck.cards[0].topic, '');
});

test('bound answer, option texts, option explanations and rubric get delimiters too, consistently and without changing what they say', () => {
  const formulaOptions = [
    { id: 'a', text: 'a_n=2·3^{n-1}', correct: true, explanation: 'Ratio q^{n-1} gives the term.' },
    { id: 'b', text: 'a_n=3^{n}', correct: false, explanation: 'It starts at 3^{1}.' },
    { id: 'c', text: 'a_n=q^{n-1}', correct: false, explanation: 'It drops the first term.' },
  ];
  const card = goodCard({ answer: 'a_n=2·3^{n-1}', options: formulaOptions });
  const { deck, fixes } = run(card);
  const [after] = deck.cards;
  assert.deepEqual(after.options.map(option => option.text), ['$a_n=2·3^{n-1}$', '$a_n=3^{n}$', '$a_n=q^{n-1}$']);
  assert.equal(after.answer, after.options[0].text, 'the answer stays equal to the correct option text');
  assert.deepEqual(after.options.map(option => [option.id, option.correct]), formulaOptions.map(option => [option.id, option.correct]));
  assert.equal(after.options[0].explanation, 'Ratio $q^{n-1}$ gives the term.');
  assert.equal(formulaIssues(deck).length, 0);
  assert.ok(fixes.some(fix => fix.field === 'answer') && fixes.some(fix => fix.field === 'options.2.text'));
  // The structural gates see the same card: no duplicate or missing correct option, no new leak.
  const wrapped = validateDeck(deck, [source]).errors, plain = validateDeck({ title: 't', cards: [card] }, [source]).errors;
  assert.deepEqual(wrapped, plain);
  assert.deepEqual(answerLeakIssues(deck), answerLeakIssues({ title: 't', cards: [card] }));
  assert.equal(after.options.filter(option => option.correct).length, 1);
  const rubric = run({ ...goodCard({ kind: 'open', rubric: 'Full credit for a_n=2·3^{n-1} and the ratio q^{n-1}.' }), options: undefined }, {}, 'open');
  assert.equal(rubric.deck.cards[0].rubric, 'Full credit for $a_n=2·3^{n-1}$ and the ratio $q^{n-1}$.');
});

test('two choices that would collapse into one after wrapping are left as authored', () => {
  const options = [{ id: 'a', text: '$x^{2}$', correct: true, explanation: 'e1' }, { id: 'b', text: 'x^{2}', correct: false, explanation: 'e2' }];
  const { deck } = run(goodCard({ options }));
  assert.equal(deck.cards[0].options[1].text, 'x^{2}');
});

test('blueprint items get deterministic delimiters, and only what cannot be wrapped asks the model again', async () => {
  const request = { count: 1, kind: 'quiz', sources: [source] };
  const item = (extra = {}) => ({ ...blueprint().items[0], answer: 'a_n=2·3^{n-1}', reasoning: 'Since q^{n-1} scales the first term.',
    options: [{ id: 'a', text: 'a_n=2·3^{n-1}', correct: true, explanation: 'Matches q^{n-1}.' }, { id: 'b', text: 'a_n=3^{n}', correct: false, explanation: 'Wrong start.' }, { id: 'c', text: 'a_n=q^{n-1}', correct: false, explanation: 'Drops the first term.' }], ...extra });
  let asked = 0;
  const fixed = await blueprintAssessment(async () => { asked++; return { items: [item()] }; }, request, plan());
  assert.equal(asked, 1, 'no correction round needed');
  assert.equal(fixed.items[0].answer, '$a_n=2·3^{n-1}$');
  assert.equal(fixed.items[0].options[0].text, fixed.items[0].answer);
  assert.equal(fixed.items[0].reasoning, 'Since $q^{n-1}$ scales the first term.');
  // A formula next to a link cannot be wrapped safely: the one correction round names it.
  const prompts = [];
  await assert.rejects(blueprintAssessment(async (system, prompt) => { prompts.push(prompt); return { items: [item({ reasoning: 'See https://example.com for \\frac{n}{b}.' })] }; }, request, plan()), /formula outside math delimiters/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /formula outside math delimiters/);
});

test('prompts: the author must always write text fields, quote no source voice, delimit formulas and keep topic/hint answer-free', () => {
  const { prompt } = authorPrompts({ count: 1, kind: 'quiz', sources: [source] }, plan(), blueprint());
  assert.doesNotMatch(prompt, /Omit fields that do not apply instead of returning null or placeholders/);
  assert.match(prompt, /topic, prompt, hint, explanation and misconception are ALWAYS non-empty text/);
  assert.match(prompt, /never phrase the stem as what the material, text, notes or slides say/i);
  assert.match(prompt, /every formula inside \$…\$/);
  assert.match(prompt, /hint and topic must not contain the answer or any option text/i);
  assert.match(blueprintPrompts({ count: 1, kind: 'quiz', sources: [source] }, plan()).prompt, /every formula inside \$…\$/);
});

test('generateDeck keeps a card with a missing hint and a bare formula without any extra model call', async () => {
  const req = { count: 1, kind: 'quiz', language: 'English', sources: [source] };
  const planned = qualityPlan(req), item = { ...blueprint().items[0], reasoning: 'The quoted definition lists principles guiding design and evolution.' };
  const authoredCard = { ...goodCard({ hint: undefined, explanation: 'Because a^{2}+b^{2}=c^{2} stays valid when the principles hold.' }) };
  delete authoredCard.citations; delete authoredCard.objective; delete authoredCard.answer; delete authoredCard.options;
  const calls = [];
  const result = await generateDeck(async (system, prompt) => {
    if (system.startsWith('Plan')) { calls.push('plan'); return JSON.stringify(planned); }
    if (system.startsWith('Prepare supported answers')) { calls.push('blueprint'); return JSON.stringify({ items: [{ ...item, targetId: planned.targets[0].targetId }] }); }
    if (system.startsWith('You author')) { calls.push('author'); return JSON.stringify({ deck: { title: 'Arch', cards: [{ ...authoredCard, targetId: planned.targets[0].targetId }] }, changes: [] }); }
    calls.push('review');
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  }, req);
  assert.deepEqual(calls, ['plan', 'blueprint', 'author', 'review'], 'no repair or extra call');
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].hint, 'First think about: What governs the design decision');
  assert.match(result.cards[0].explanation, /\$a\^\{2\}\+b\^\{2\}=c\^\{2\}\$/);
  assert.equal(result.editorial.autofixed, 2);
  assert.equal(result.editorial.dropped, undefined);
});
