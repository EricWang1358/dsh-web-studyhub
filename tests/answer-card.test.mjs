/* 复习全书 M5 · 分析题答案卡, the pure part (lib/answer-card.js, lib/case-types.js): quotes located word for word or 未核实 (an elided quote, one under
   MIN_KEY letters and digits, one in an HTML text, one found nowhere), a found quote stored as the text's own slice, invented numbers, rubric coverage
   computed by the program, the three states (已核对 / 部分未核对 / 被改过), deterministic Markdown, the question-type catalogue as data, the fingerprint of
   the review and the reveal. Old cards without an answer card are unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerCardBasis, answerCardShapeErrors, answerCardState, checkAnswerCard, cardProblems, cardStatus, finishAnswerCard, holdsHtml, inventedNumbers, locateIn,
  normalizeAnswerCard, normalizeCardReview, renderAnswerCard, rubricCoverage, rubricPoints, textDigest,
} from '../lib/answer-card.js';
import { CASE_TYPES, caseTypesFor, checkedCaseTypes, guessCaseType, typeLabel } from '../lib/case-types.js';
import { cardMatchesReview, reviewedCardFingerprint } from '../lib/review-integrity.js';
import { solution } from '../lib/study-state.js';
import { draftShapeErrors, publicCard } from '../lib/domain.js';
import { EDITABLE } from '../lib/card-content.js';
import { MATERIAL, SCENARIO, caseCard, criteria, goodCard } from './helpers/answer-card-library.mjs';

const stem = (card = caseCard()) => [{ id: 'prompt', text: card.prompt }, { id: 'case', text: SCENARIO }];
const materials = [{ id: 'mat1', ref: 'M1', title: 'Lecture 4 · Availability', text: MATERIAL }];
const context = { stem: stem(), materials, criteria: criteria(), numbers: ['yearly downtime = (1 - A) x 8760 h'] };
const checked = (raw = goodCard()) => checkAnswerCard(normalizeAnswerCard(raw, { types: CASE_TYPES, language: 'en' }), context);
const clean = { ran: true, issues: [], repaired: false };

test('a quote is found word for word, or it is 未核实 with the reason: elided, too short, in an HTML text, nowhere', () => {
  const texts = [{ id: 'case', text: 'The booking service runs on two independent\nservers behind a load balancer.' }];
  const exact = locateIn(texts, 'runs on two independent');
  assert.deepEqual([exact.verified, exact.in, exact.quote], [true, 'case', 'runs on two independent']);
  // Whitespace and case never decide: the stored quote is the text's own slice, with its own line break.
  const spaced = locateIn(texts, 'TWO   independent servers behind');
  assert.equal(spaced.verified, true);
  assert.equal(spaced.quote, 'two independent\nservers behind');
  assert.deepEqual(texts[0].text.slice(spaced.at.start, spaced.at.end), spaced.quote);
  assert.deepEqual(locateIn(texts, 'The booking service … a load balancer'), { verified: false, reason: 'ellipsis', quote: 'The booking service … a load balancer' }, 'both parts exist, still refused');
  assert.equal(locateIn(texts, 'The booking service ... load balancer').reason, 'ellipsis');
  assert.equal(locateIn(texts, 'runs').reason, 'short', 'under MIN_KEY letters and digits, even when it is there');
  assert.equal(locateIn([{ id: 'm', text: 'a 可用性 b' }], '可用性').reason, 'short');
  assert.equal(locateIn(texts, 'runs on three dependent servers').reason, 'missing');
  const html = [{ id: 'm', text: '<table><tr><td>Availability is the proportion of time</td></tr></table>' }];
  assert.equal(holdsHtml(html[0].text), true);
  assert.equal(locateIn(html, 'Availability is the proportion of time').reason, 'html', 'an HTML text is never read through');
  assert.equal(locateIn([{ id: 'm', text: 'A &amp; B are the proportion of time' }], 'are the proportion of time').reason, 'html');
});

test('the checked card: signals and facts in the stem, the concept stored as the material\'s own slice with where it is, nothing invented, every point covered', () => {
  const card = checked();
  assert.deepEqual(card.signals.map(item => [item.verified, item.in]), [[true, 'case']]);
  assert.deepEqual(card.facts.map(item => item.verified), [true, true]);
  const [concept] = card.concepts;
  assert.equal(concept.verified, true);
  assert.equal(concept.quote, 'Availability is the proportion of time a system is able to perform its required function', 'the material\'s words, not the model\'s echo');
  assert.deepEqual(concept.where, { sourceId: 'mat1', title: 'Lecture 4 · Availability' });
  assert.equal(MATERIAL.slice(concept.at.start, concept.at.end), concept.quote);
  assert.equal('ref' in concept, false);
  assert.deepEqual(card.checks.quotes, { total: 4, verified: 4 });
  assert.deepEqual(card.checks.inventedNumbers, []);
  assert.deepEqual(card.checks.coverage, { total: 3, covered: 3, missing: [] });
  assert.deepEqual(card.checks.missing, []);
  assert.deepEqual(cardProblems({ ...card, checks: { ...card.checks, review: clean } }), []);
  assert.equal(cardStatus({ ...card.checks, review: clean }), 'verified');
  // A signal's word must stand inside its quote.
  const raw = goodCard();
  raw.signals = [{ word: 'latency', quote: 'The business requires 99.9% availability for bookings during the season.' }];
  assert.equal(checked(raw).signals[0].verified, false);
});

test('numbers from nowhere are flagged; stem numbers, stated assumptions, formulas, percentages and computed results are not', () => {
  const card = normalizeAnswerCard(goodCard(), { types: CASE_TYPES, language: 'en' });
  const allowed = [card.prompt, SCENARIO, ...card.assumptions, '8760'];
  assert.deepEqual(inventedNumbers(card, allowed), []);
  assert.deepEqual(inventedNumbers({ ...card, steps: [...card.steps, 'Each server costs 5000 dollars a year', 'MTBF = 3000 h for a new server'] }, allowed), ['5000', '3000'],
    'an input after = is no result');
  assert.deepEqual(inventedNumbers({ ...card, steps: [...card.steps, 'Each server costs 5000 dollars a year'] }, [...allowed, 'Assume a server costs 5000 dollars a year']), []);
  assert.deepEqual(inventedNumbers({ ...card, conclusion: 'It reaches 0.999, above the target.' }, allowed), [], '99.9% in the stem matches 0.999');
  assert.deepEqual(inventedNumbers({ ...card, steps: ['$A = 0.97 \\times 0.98 = 0.9506$'] }, allowed), ['0.97', '0.98']);
  const flagged = checked({ ...goodCard(), steps: [...goodCard().steps, 'A third server would cost 4200 a year'] });
  assert.deepEqual(flagged.checks.inventedNumbers, ['4200']);
  assert.match(cardProblems({ ...flagged, checks: { ...flagged.checks, review: clean } }).join('\n'), /4200 \(state them as assumptions/);
});

test('rubric coverage is the program\'s: one row per key point, a sentence counts only when it is in the card; a criterion without points is one point', () => {
  assert.deepEqual(rubricPoints(criteria()).map(point => [point.point, point.marks]), [['c1.k1', 2], ['c1.k2', 2], ['c2.k1', 2]]);
  assert.deepEqual(rubricPoints([{ id: 'x', label: 'Clarity', marks: 1, descriptor: 'Clear' }]).map(point => point.point), ['x']);
  const raw = goodCard();
  raw.marks = [{ point: 'c1.k1', sentence: 'One server: $A = 1000 / (1000 + 2) = 0.998$' }, { point: 'c1.k2', sentence: 'A sentence that the card never says at all.' },
    { point: 'c9.k1', sentence: 'The pair of servers meets the 99.9% availability target.' }];
  const card = normalizeAnswerCard(raw, { types: CASE_TYPES, language: 'en' });
  const { marksMap, coverage } = rubricCoverage(card, criteria());
  assert.deepEqual(marksMap.map(item => [item.point, item.found]), [['c1.k1', true], ['c1.k2', false], ['c2.k1', false]], 'unknown points are dropped, missing ones listed');
  assert.deepEqual(coverage, { total: 3, covered: 1, missing: ['c1.k2', 'c2.k1'] });
  assert.equal(marksMap[0].label, 'Calculation');
});

test('three states: 已核对, 部分未核对, 被改过 (the question changed, or the card itself); an old card without one is unchanged', () => {
  const card = caseCard();
  const verified = finishAnswerCard(checked(), { review: clean, basis: answerCardBasis(card) });
  assert.equal(verified.status, 'verified');
  assert.equal(answerCardState({ ...card, answerCard: verified }), 'verified');
  const unverified = checked({ ...goodCard(), facts: [{ text: 'A fact', quote: 'A sentence that is in neither the question nor the case.' }] });
  assert.equal(finishAnswerCard(unverified, { review: clean, basis: answerCardBasis(card) }).status, 'partial');
  assert.equal(finishAnswerCard(checked(), { review: { ran: false, issues: [], repaired: false }, basis: answerCardBasis(card) }).status, 'partial', 'no review, no 已核对');
  const flagged = { ran: true, issues: [{ kind: 'unsupported', where: 'conclusion', text: 'x' }], repaired: false };
  assert.equal(finishAnswerCard(checked(), { review: flagged, basis: answerCardBasis(card) }).status, 'partial');
  assert.equal(finishAnswerCard(checked(), { review: { ...flagged, repaired: true }, basis: answerCardBasis(card) }).status, 'verified', 'repaired once');
  for (const change of [{ prompt: `${card.prompt} Explain.` }, { marks: 8 }, { answer: 'Another answer.' }, { rubricCriteria: criteria().slice(0, 1) }])
    assert.equal(answerCardState({ ...card, ...change, answerCard: verified }), 'edited', JSON.stringify(Object.keys(change)));
  assert.equal(answerCardState({ ...card, answerCard: { ...verified, conclusion: 'Edited by hand.' } }), 'edited', 'the card no longer renders to what was checked');
  assert.equal(answerCardState({ ...card, hint: 'A new hint.', answerCard: verified }), 'verified', 'a hint is not what the card was made for');
  assert.equal(answerCardState(card), null);
  const old = solution(card);
  assert.equal('answerCard' in old, false, 'an old card reveals exactly what it did');
  assert.deepEqual(Object.keys(old), Object.keys(solution({ ...card })));
  assert.equal(solution({ ...card, answerCard: verified }).answerCard.state, 'verified');
  assert.equal('answerCard' in publicCard({ ...card, answerCard: verified }), false, 'never before the reveal');
  assert.equal(EDITABLE.includes('answerCard'), false, 'not editable through card.update');
});

test('the Markdown is deterministic, bold labels and no headings, every part with 未核实 where a quote was not found; English labels for an English card', () => {
  const card = finishAnswerCard(checked({ ...goodCard(), facts: [...goodCard().facts, { text: 'Bookings', quote: 'A quote of nowhere at all in this case.' }] }),
    { review: clean, basis: 'b' });
  const zh = renderAnswerCard(card, 'zh');
  assert.equal(zh, renderAnswerCard(structuredClone(card), 'zh'), 'same card, same bytes');
  assert.doesNotMatch(zh, /^#/m, 'no heading: a book file holding it gets no new heading');
  for (const label of ['题型', '识别信号', '题干事实', '概念', '假设', '推理链', '结论', '为什么满足目标', '代价', '失败处理', '如何验证', '易错检查', '评分点对照'])
    assert.match(zh, new RegExp(`\\*\\*${label}`), label);
  assert.match(zh, /A quote of nowhere at all in this case\.」（未核实）/);
  assert.match(zh, /\*\*Availability\*\*（资料：Lecture 4 · Availability）：「Availability is the proportion/);
  assert.match(zh, /\| Calculation · c1\.k1 \| 2 \| One server: \$A = 1000/);
  assert.match(zh, /已核对 ≠ 答案正确/);
  assert.doesNotMatch(zh, /\d{4}-\d{2}-\d{2}T|model|gpt|claude/i, 'no time, no model name');
  const en = renderAnswerCard(card);
  assert.match(en, /\*\*Question type: \*\*Availability/);
  assert.match(en, /not verified/);
  assert.equal(card.renderedDigest, textDigest(renderAnswerCard(card)));
});

test('the reviewer is trusted only in its shape; the model\'s card is cut to size; the shape check of card.answerCard', () => {
  assert.deepEqual(normalizeCardReview({ issues: [{ kind: 'unsupported', where: 'steps[1]', text: 'Not in the case.' }, { kind: 'style', text: 'x' }, { kind: 'missingCost' }, 'junk'] }),
    [{ kind: 'unsupported', where: 'steps[1]', text: 'Not in the case.' }]);
  const big = normalizeAnswerCard({ ...goodCard(), steps: Array.from({ length: 30 }, (_, at) => `${at + 1}. step ${'x'.repeat(2000)}`), questionType: 'no-such-type' }, { types: CASE_TYPES });
  assert.equal(big.steps.length, 10);
  assert.ok(big.steps.every(step => step.length <= 700 && !/^\d+\./.test(step)), 'numbering taken off, length capped');
  assert.deepEqual(big.questionType, { id: 'general', label: '一般分析题' });
  assert.deepEqual(answerCardShapeErrors(undefined), []);
  assert.deepEqual(answerCardShapeErrors(finishAnswerCard(checked(), { review: clean, basis: 'b' })), []);
  assert.equal(answerCardShapeErrors({ v: 2 }).length, 1);
  assert.equal(answerCardShapeErrors({ v: 1, steps: 'x' }).length, 1);
  assert.match(draftShapeErrors({ title: 'T', cards: [{ ...caseCard(), answerCard: { v: 1 } }] }).join('\n'), /Card 1: answerCard has an invalid shape/);
});

test('the review fingerprint keeps the answer card but not where its quotes stand; a card reviewed before its answer card was added still matches', () => {
  const card = caseCard(), mark = reviewedCardFingerprint(card);
  const answerCard = finishAnswerCard(checked(), { review: clean, basis: answerCardBasis(card) });
  const added = { ...card, answerCard };
  assert.equal(cardMatchesReview(mark, added), true, 'added on request with its own checks: not an edit of what the review saw');
  assert.equal(cardMatchesReview(mark, { ...added, prompt: 'Changed.' }), false);
  const reviewedWith = reviewedCardFingerprint(added);
  assert.notEqual(reviewedWith, mark);
  const moved = structuredClone(added);
  moved.answerCard.concepts[0].at = { start: 1, end: 2 };
  assert.equal(reviewedCardFingerprint(moved), reviewedWith, 'positions are derived');
  const edited = structuredClone(added);
  edited.answerCard.concepts[0].quote = 'Another definition.';
  assert.notEqual(reviewedCardFingerprint(edited), reviewedWith, 'content is not');
});

test('the question types are data: the SWE5001 entries, a course\'s own types checked and merged, a guess from the stem', () => {
  assert.deepEqual(CASE_TYPES.map(type => type.id), ['risk', 'availability', 'performance', 'capacity', 'domain', 'cloud', 'general']);
  const availability = CASE_TYPES.find(type => type.id === 'availability');
  assert.ok(availability.formulas.some(formula => /MTBF \/ \(MTBF \+ MTTR\)/.test(formula)) && availability.formulas.some(formula => /8760/.test(formula)));
  assert.match(CASE_TYPES.find(type => type.id === 'risk').steps.join(' '), /STRIDE.*exploits a vulnerability, harms an asset/);
  assert.equal(typeLabel(availability, 'zh'), '可用性');
  assert.equal(typeLabel(availability, 'en'), 'Availability');
  assert.throws(() => checkedCaseTypes([{ id: 'Bad id', label: 'x', steps: ['y'] }]), /unique id/);
  assert.throws(() => checkedCaseTypes([{ id: 'a', label: '', steps: ['y'] }]), /a label and at least one step/);
  assert.throws(() => checkedCaseTypes('x'), /a list/);
  const own = checkedCaseTypes([{ id: 'queueing', label: '排队论', signals: ['排队', '到达率'], steps: ['写出到达率和服务率', '算利用率'] }, { id: 'availability', label: '可用性（本课）', steps: ['本课的步骤'] }]);
  const merged = caseTypesFor(own);
  assert.deepEqual(merged.map(type => type.id), ['risk', 'availability', 'performance', 'capacity', 'domain', 'cloud', 'queueing', 'general']);
  assert.equal(merged.find(type => type.id === 'availability').label, '可用性（本课）', 'a course replaces a type by its id');
  assert.deepEqual(caseTypesFor('junk').map(type => type.id), CASE_TYPES.map(type => type.id), 'a bad list is ignored');
  assert.equal(guessCaseType('系统可用性要达到 99.9%，MTBF 为 1000 小时').id, 'availability');
  assert.equal(guessCaseType('到达率是每秒 5 个请求，求排队', merged).id, 'queueing');
  assert.equal(guessCaseType('Describe the organisation').id, 'general');
});
