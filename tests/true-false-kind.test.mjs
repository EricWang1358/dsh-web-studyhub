import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { CARD_KIND_IDS, EXAM_KIND_IDS, GENERATE_KIND_IDS, INGEST_KIND_IDS, kindOf } from '../lib/card-kinds.js';
import { optionOrder, validateDeck } from '../lib/domain.js';
import { prepareJsonImport } from '../lib/json-import.js';
import { importExample } from '../lib/deck-format.js';
import { trueFalseOptions, unbalancedTrueFalse } from '../lib/true-false.js';
import { TRUE_FALSE_RULE, blueprintAssessment, blueprintPrompts, qualityCriteriaFor } from '../lib/assessment-quality.js';
import { optionCueIssues } from '../lib/option-cues.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { variantKind, writeVariants } from '../lib/coach.js';
import { reviewChoiceKind, shortcutAction } from '../ui/review/session-logic.js';

/* 判断题 (owner 2026-11-05): one statement, answered 对 / 错 and graded like a single choice. Stored as a choice question with the two fixed options
   "true" and "false" of the registry, so grading, exams, mistakes, insights, export and the validator read it as they read a single choice. */

const quote = 'The Caretaker manages snapshot history without inspecting snapshot contents.';
const source = { id: 's1', title: 'Memento notes', text: quote };
const statement = (id, truth, extra = {}) => ({
  id, kind: 'truefalse', topic: 'Memento', objective: `Judge the role of the Caretaker ${id}`,
  prompt: truth ? `The Caretaker keeps the snapshot history (${id}).` : `The Caretaker reads the contents of each snapshot (${id}).`,
  answer: truth ? 'True.' : 'False. The Caretaker keeps the history without inspecting the snapshots.',
  hint: 'Separate keeping a history from reading it.', explanation: `"${quote}" So the statement is ${truth ? 'true' : 'false'}.`,
  misconception: 'Thinking whoever stores a snapshot must read it.', citations: [{ sourceId: 's1', quote }],
  options: [{ id: 'true', text: 'True', correct: truth, explanation: truth ? 'The source says the Caretaker manages the history.' : 'The source says it never inspects them.' },
    { id: 'false', text: 'False', correct: !truth, explanation: truth ? 'Nothing in the source denies it.' : 'Inspecting the contents is what the source rules out.' }],
  ...extra,
});

test('the registry entry: two fixed options, one right, graded, in exams and generation, not in 整理成题', () => {
  const kind = kindOf('truefalse');
  assert.ok(CARD_KIND_IDS.includes('truefalse') && GENERATE_KIND_IDS.includes('truefalse') && EXAM_KIND_IDS.includes('truefalse'));
  assert.ok(!INGEST_KIND_IDS.includes('truefalse'));
  assert.deepEqual(kind.options, { min: 2, max: 2 });
  assert.equal(kind.answers, 'one');
  assert.equal(kind.graded, true);
  assert.deepEqual(kind.fixedOptions.map(({ id, label, en }) => [id, label, en]), [['true', '对', 'True'], ['false', '错', 'False']]);
  assert.deepEqual([kind.label, kind.short], ['判断题', '判断']);
});

test('the validator takes exactly the options true and false with one of them correct', () => {
  const check = card => validateDeck({ title: 'T', cards: [card] }, [source]).errors;
  assert.deepEqual(check(statement('q1', true)), []);
  assert.deepEqual(check(statement('q1', false)), []);
  assert.match(check(statement('q1', true, { options: statement('q1', true).options.map(option => ({ ...option, correct: true })) })).join(), /invalid correct option count/);
  const third = { id: 'maybe', text: 'Maybe', correct: false, explanation: 'x' };
  assert.match(check(statement('q1', true, { options: [...statement('q1', true).options, third] })).join(), /exactly 2 options/);
  assert.match(check(statement('q1', true, { options: statement('q1', true).options.map((option, at) => ({ ...option, id: 'ab'[at] })) })).join(), /options true and false/);
});

test('the deck format has a 判断题 example that imports as it is shown', () => {
  for (const language of ['zh', 'en']) {
    const deck = JSON.parse(importExample('truefalse', language));
    const card = deck.cards[0];
    assert.equal(card.kind, 'truefalse');
    assert.deepEqual(card.options.map(option => option.id), ['true', 'false']);
    assert.deepEqual(validateDeck({ ...deck, cards: [{ ...card, id: 'x', importedFromJson: true, citations: [] }] }, []).errors, []);
  }
  assert.ok(JSON.parse(importExample('mixed')).cards.some(card => card.kind === 'truefalse'), 'the mixed example has one of every kind');
});

test('options a model writes with other ids are put in the fixed order, in the language of the statement', () => {
  const given = [{ id: 'b', text: '错误', correct: false, explanation: '不是这样' }, { id: 'a', text: '正确', correct: true, explanation: '原文这样说' }];
  assert.deepEqual(trueFalseOptions(given, '看管者保存快照历史。'), [
    { id: 'true', text: '对', correct: true, explanation: '原文这样说' }, { id: 'false', text: '错', correct: false, explanation: '不是这样' }]);
  assert.deepEqual(trueFalseOptions([{ id: 'false', text: 'x', correct: true, explanation: 'e' }, { id: 'true', text: 'y', correct: false, explanation: 'e' }], 'A statement.')
    .map(option => [option.id, option.text, option.correct]), [['true', 'True', false], ['false', 'False', true]]);
  const odd = [{ id: 'a', text: 'Maybe', correct: true, explanation: 'e' }, { id: 'b', text: 'Perhaps', correct: false, explanation: 'e' }];
  assert.equal(trueFalseOptions(odd, 'A statement.'), odd, 'options that are not a true and a false one are left for the validator to refuse');
});

test('a batch of four or more statements of one verdict asks for the later half to be the other verdict', () => {
  const item = truth => ({ options: statement('x', truth).options });
  assert.deepEqual(unbalancedTrueFalse([item(true), item(true), item(true)]), [], 'three of a kind can be chance');
  assert.deepEqual(unbalancedTrueFalse([item(true), item(true), item(true), item(true)]), [2, 3]);
  assert.deepEqual(unbalancedTrueFalse([item(false), item(false), item(false), item(false), item(false)]), [3, 4]);
  assert.deepEqual(unbalancedTrueFalse([item(true), item(false), item(true), item(true)]), []);
});

test('the writer and the reviewer of a 判断题 get its rules; other kinds are asked exactly as before', () => {
  const request = { kind: 'truefalse', count: 1, sources: [source], language: 'English' };
  const plan = { targets: [{ targetId: 't1', objective: 'Judge the role of the Caretaker', citations: [{ sourceId: 's1', quote }] }] };
  for (const text of [JSON.stringify(blueprintPrompts(request, plan)), JSON.stringify(authorPrompts(request, plan)),
    JSON.stringify(reviewPrompts({ sources: [source], deck: { cards: [statement('q1', true)] }, kind: 'truefalse', count: 1 }))])
    assert.ok(text.includes(TRUE_FALSE_RULE.slice(TRUE_FALSE_RULE.indexOf('Test one idea'))), 'the rule is in every stage');
  for (const rule of [/不\/没有\/not/,/absolute/i, /double negative/i, /balanced/i, /true statement/i]) assert.match(TRUE_FALSE_RULE, rule);
  const quiz = { ...request, kind: 'quiz' };
  assert.ok(!JSON.stringify(blueprintPrompts(quiz, plan)).includes('True/false'));
  assert.ok(!JSON.stringify(authorPrompts(quiz, plan)).includes('True/false'));
  assert.ok(!JSON.stringify(reviewPrompts({ sources: [source], deck: { cards: [] }, kind: 'quiz', count: 1 })).includes('True/false'));
});

test('the prompts of a 判断题 batch do not contradict its rule; the other batches keep their words', () => {
  const plan = { targets: [{ targetId: 't1', objective: 'Judge the role of the Caretaker', citations: [{ sourceId: 's1', quote }] }] };
  const prompt = (stage, kind) => JSON.stringify(stage({ kind, count: 1, sources: [source], language: 'English' }, plan));
  const answer = prompt(blueprintPrompts, 'truefalse'), author = prompt(authorPrompts, 'truefalse');
  assert.doesNotMatch(answer, /Choice questions need 3–6/);
  assert.match(answer, /exactly the two fixed options true and false/);
  assert.doesNotMatch(author, /Only quiz\/multi use options/);
  assert.match(author, /Only quiz\/multi\/truefalse use options/);
  for (const kind of ['quiz', 'multi', 'cloze']) {
    assert.match(prompt(blueprintPrompts, kind), /Choice questions need 3–6 plausible options/);
    assert.match(prompt(authorPrompts, kind), /Only quiz\/multi use options/);
  }
});

test('the answer stage is asked once to balance a batch of one verdict, and never drops a statement for it', async () => {
  const targets = [1, 2, 3, 4].map(n => ({ targetId: 't' + n, objective: 'Judge the Caretaker role ' + n, citations: [{ sourceId: 's1', quote }] }));
  const item = (n, truth) => ({ targetId: 't' + n, statement: (truth ? 'The Caretaker keeps the history ' : 'The Caretaker reads every snapshot ') + n + '.',
    answer: truth ? 'True.' : 'False. It keeps the history without reading it.', reasoning: 'The source: ' + quote,
    scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'Keeping versus reading snapshots',
    options: [{ id: 'a', text: '正确', correct: truth, explanation: 'Because of the source.' },
      { id: 'b', text: '错误', correct: !truth, explanation: 'Because of the source.' }] });
  const asked = [];
  const reply = (all, balanced) => async (system, prompt) => { asked.push(prompt); return asked.length === 1 ? all : balanced; };
  const request = { kind: 'truefalse', count: 4, sources: [source], language: 'English' };
  const allTrue = { items: [1, 2, 3, 4].map(n => item(n, true)) };
  const fixed = await blueprintAssessment(reply(allTrue, { items: [item(3, false), item(4, false)] }), request, { targets });
  assert.equal(asked.length, 2);
  assert.match(asked[1], /every true\/false statement of this batch is true/);
  assert.deepEqual(fixed.items.map(one => one.options.find(option => option.correct).id), ['true', 'true', 'false', 'false']);
  assert.deepEqual(fixed.items[0].options.map(option => option.id), ['true', 'false'], 'the options are put in their fixed order');
  asked.length = 0;
  const stubborn = await blueprintAssessment(reply(allTrue, allTrue), request, { targets });
  assert.equal(stubborn.items.length, 4, 'a model that keeps them all true loses no statement');
});

test('a failed balance re-ask keeps the original valid statements instead of dropping them', async () => {
  const targets = [1, 2, 3, 4].map(n => ({ targetId: 't' + n, objective: 'Judge the Caretaker role ' + n, citations: [{ sourceId: 's1', quote }] }));
  const item = (n, truth) => ({ targetId: 't' + n, statement: 'The Caretaker keeps the history ' + n + '.',
    answer: truth ? 'True.' : 'False. It keeps the history without reading it.', reasoning: 'The source: ' + quote,
    scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'Keeping versus reading snapshots',
    options: [{ id: 'true', text: 'True', correct: truth, explanation: 'Because of the source.' }, { id: 'false', text: 'False', correct: !truth, explanation: 'Because of the source.' }] });
  const allTrue = { items: [1, 2, 3, 4].map(n => item(n, true)) };
  const request = { kind: 'truefalse', count: 4, sources: [source], language: 'English' };
  const second = (answer, options) => { let asks = 0; return blueprintAssessment(async () => (++asks === 1 ? allTrue : answer), request, { targets }, options); };
  const errored = await second({ error: 'max tokens' });
  assert.deepEqual(errored.items.map(one => one.targetId), ['t1', 't2', 't3', 't4'], 'a re-ask that errors loses nothing');
  assert.deepEqual(errored.omitted, []);
  const invalid = await second({ items: [{ ...item(3, false), options: [] }, { ...item(4, false), reasoning: '' }] });
  assert.deepEqual(invalid.items.map(one => one.targetId), ['t1', 't2', 't3', 't4'], 'rewrites that fail other checks fall back to the originals');
  assert.deepEqual(invalid.items.map(one => one.options.find(option => option.correct).id), ['true', 'true', 'true', 'true']);
  assert.deepEqual(invalid.omitted, []);
  const strict = await second({ items: [{ ...item(3, false), options: [] }] }, { salvage: false });
  assert.equal(strict.items.length, 4, 'also without salvage: the balance check alone never fails a batch');
  const partial = await second({ items: [item(3, false)] });
  assert.deepEqual(partial.items.map(one => one.options.find(option => option.correct).id), ['true', 'true', 'false', 'true'], 'a rewrite replaces only its own statement');
});

test('the variant of a wrong 判断题 is a 判断题 under its rule; the other kinds keep the kinds they were given', async () => {
  assert.deepEqual([['wrong', 'truefalse'], ['wrong', 'multi'], ['wrong', 'quiz'], ['wrong', 'cloze'], ['too-hard', 'truefalse']]
    .map(([reason, kind]) => variantKind(reason, { kind })), ['truefalse', 'multi', 'quiz', 'quiz', 'flashcard']);
  const prompts = [];
  const complete = async (_system, prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ cards: [{ target: 0, topic: 'Memento', objective: 'Judge the Caretaker', prompt: 'The Caretaker decides when a snapshot is taken.',
      answer: 'False. The Originator decides.', hint: 'Who owns the state?', explanation: `"${quote}" The history is all it manages.`, misconception: 'Thinking the keeper also decides.',
      citations: [{ sourceId: 's1', quote }],
      options: [{ id: 'a', text: '正确', correct: false, explanation: 'The Caretaker only keeps them.' }, { id: 'b', text: '错误', correct: true, explanation: 'The Originator decides.' }] }] });
  };
  const original = statement('q1', false);
  const [made] = await writeVariants(complete, { targets: [{ card: original, kind: 'truefalse', reason: 'wrong' }], sources: [source], learner: {} });
  assert.equal(made.card.kind, 'truefalse');
  assert.deepEqual(made.card.options.map(option => [option.id, option.correct]), [['true', false], ['false', true]]);
  assert.ok(prompts[0].includes(TRUE_FALSE_RULE.slice(TRUE_FALSE_RULE.indexOf('Test one idea'))), 'the writer is given the rule');
  prompts.length = 0;
  await writeVariants(complete, { targets: [{ card: { ...original, kind: 'quiz' }, kind: 'quiz', reason: 'wrong' }], sources: [source], learner: {} });
  assert.ok(!prompts[0].includes('True/false'), 'a batch without 判断题 is asked exactly as before');
});

test('a 判断题 whose option ids are not true and false is still shown in its own option order', () => {
  const option = id => ({ id, text: id, correct: false, explanation: 'e' });
  assert.deepEqual(optionOrder({ kind: 'truefalse', options: ['a', 'b'].map(option) }), ['a', 'b']);
  assert.deepEqual(optionOrder({ kind: 'truefalse', options: ['true', 'x'].map(option) }), ['true', 'x'], 'half the fixed ids is not the fixed order either');
  assert.deepEqual(optionOrder({ kind: 'truefalse', options: ['false', 'true'].map(option) }), ['true', 'false'], 'the fixed order is kept when the ids are the fixed ones');
  assert.equal(optionOrder({ kind: 'truefalse' }), undefined);
});

test('a JSON file may write the options of a 判断题 as 对/错, true/false in any case, or T/F; anything else is refused as before', () => {
  const file = options => JSON.stringify({ title: 'Patterns', cards: [{ kind: 'truefalse', topic: 'Memento', objective: 'Judge the Caretaker', prompt: 'The Caretaker keeps the history.',
    answer: 'True', hint: 'h', explanation: 'e', misconception: 'm', options }] });
  const two = (first, second) => [{ id: first[0], text: first[1], correct: true, explanation: 'e' }, { id: second[0], text: second[1], correct: false, explanation: 'e' }];
  const read = options => prepareJsonImport(file(options)).deck;
  for (const given of [two(['T', 'x'], ['F', 'y']), two(['a', 'TRUE'], ['b', 'False']), two(['对', '对'], ['错', '错']), two(['b', 'true'], ['a', 'false']), two(['x', 'F'], ['y', 'T'])]) {
    const deck = read(given);
    assert.deepEqual(deck.cards[0].options.map(option => option.id), ['true', 'false'], JSON.stringify(given));
    assert.deepEqual(deck.quality.errors, [], JSON.stringify(given));
    assert.equal(deck.cards[0].options.filter(option => option.correct).length, 1);
  }
  assert.equal(read(two(['x', 'F'], ['y', 'T'])).cards[0].options.find(option => option.correct).id, 'false', 'the correctness goes with the verdict, not with the position');
  assert.match(read(two(['a', 'Maybe'], ['b', 'Perhaps'])).quality.errors.join(), /options true and false/);
  assert.match(read([{ id: 'a', text: 'True', correct: true, explanation: 'e' }]).quality.errors.join(), /options true and false|exactly 2 options/);
});

async function library(cards) {
  const root = await mkdtemp(join(tmpdir(), 'study-truefalse-'));
  const service = new StudyService(root);
  await service.call('source.add', source);
  await service.call('draft.save', { deck: { id: 'd1', title: 'Patterns', cards } });
  await service.call('draft.publish', { id: 'd1' });
  return { root, service };
}

test('practice: the two options come in their fixed order, one choice grades it, and a false statement is answered 错', async (t) => {
  const { root, service } = await library([statement('q1', false)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let round = 0; round < 4; round++) {
    const run = await service.call('review.start', { deckId: 'd1', mode: 'due' });
    assert.deepEqual(run.card.options.map(option => option.id), ['true', 'false'], 'never shuffled');
    assert.equal(run.card.multiple, false);
    await service.call('review.end', { runId: run.id }).catch(() => {});
  }
  const run = await service.call('review.start', { deckId: 'd1', mode: 'due' });
  await assert.rejects(service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['true', 'false'] }), /valid options/);
  const answered = await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['false'] });
  assert.equal(answered.feedback.correct, true);
  assert.deepEqual(answered.solution.options.filter(option => option.correct).map(option => option.id), ['false']);
});

test('exams take 判断题, and the balanced paper counts it on the single-answer side', async (t) => {
  const quiz = (id) => ({ ...statement(id, true), kind: 'quiz', prompt: `Which component keeps the history (${id})?`, answer: 'Caretaker',
    options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It keeps the history.' }, { id: 'b', text: 'Memento', correct: false, explanation: 'It is one state.' },
      { id: 'c', text: 'Originator', correct: false, explanation: 'It makes snapshots.' }] });
  const multi = (id) => ({ ...quiz(id), kind: 'multi', prompt: `Which parts take part in undo (${id})?`, answer: 'Caretaker; Originator',
    options: quiz(id).options.map(option => ({ ...option, correct: option.id !== 'b' })) });
  const { root, service } = await library([statement('t1', true), statement('t2', false), statement('t3', true), multi('m1'), multi('m2'), multi('m3')]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const deck = (await service.call('snapshot')).decks.find(item => item.id === 'd1');
  assert.deepEqual([deck.examCount, deck.examQuizCount, deck.examMultiCount, deck.examTrueFalseCount], [6, 0, 3, 3]);
  const kindOfId = id => (id.startsWith('t') ? 'truefalse' : 'multi');
  for (let paper = 0; paper < 3; paper++) {
    const run = await service.call('review.start', { mode: 'exam', count: 4, examKinds: 'balanced', fresh: true });
    assert.deepEqual(run.picks.map(pick => kindOfId(pick.cardId)).sort(), ['multi', 'multi', 'truefalse', 'truefalse'], 'two of each side');
    await service.call('review.end', { runId: run.id });
  }
  const run = await service.call('review.start', { mode: 'exam', count: 6, fresh: true });
  for (let at = 0; at < 6; at++) {
    const now = await service.call('review.move', { runId: run.id, index: at });
    if (now.card.kind === 'truefalse') {
      assert.deepEqual(now.card.options.map(option => option.id), ['true', 'false']);
      await assert.rejects(service.call('review.answer', { runId: run.id, cardId: now.card.id, selected: ['true', 'false'] }), /valid options/);
      await service.call('review.answer', { runId: run.id, cardId: now.card.id, selected: [now.card.id === 't2' ? 'false' : 'true'] });
    }
  }
  const report = await service.call('exam.submit', { runId: run.id });
  const row = report.byKind.find(item => item.kind === 'truefalse');
  assert.ok(row, 'the report has a row for 判断题');
  assert.equal(report.wrong.filter(item => kindOfId(item.cardId ?? item.id ?? '') === 'truefalse').length, 0, 'every 判断题 was answered right');
});

test('the practice page treats a 判断题 as a choice and keys 1 and 2 choose 对 and 错', () => {
  const run = { id: 'r', index: 0, mode: 'due', card: { id: 'q', kind: 'truefalse', multiple: false, options: [{ id: 'true', text: '对' }, { id: 'false', text: '错' }] } };
  const kind = reviewChoiceKind(run);
  assert.equal(kind.choice, true);
  const ctx = { inside: true, page: 'review', run, busy: false, choice: true, isCloze: false, rubricCard: false, selected: [], clozeValues: {} };
  const press = key => shortcutAction({ key, code: key, shiftKey: false, repeat: false, defaultPrevented: false }, ctx)?.action;
  assert.deepEqual(press('1'), { type: 'choose', id: 'true' });
  assert.deepEqual(press('2'), { type: 'choose', id: 'false' });
  assert.equal(press('3'), null);
});

test('the choice-option cues of the distractor rule are not a 判断题\'s: its two fixed options are judged by its own rule', () => {
  // The correct option is far longer than the wrong one, and only the wrong one says "never": on a single choice both would be cues.
  const card = statement('q1', false, { options: [{ id: 'true', text: 'True', correct: false, explanation: 'Never.' },
    { id: 'false', text: 'False, because the Caretaker keeps the history without inspecting it', correct: true, explanation: 'The source says so.' }] });
  assert.deepEqual(optionCueIssues({ cards: [card] }), []);
  assert.match(qualityCriteriaFor(['truefalse']), /instead of the choice-option cues/);
  assert.doesNotMatch(qualityCriteriaFor(['quiz']), /truefalse/);
});
