import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDeck } from '../lib/generation.js';
import { stageSystem } from '../lib/prompt-order.js';
import { contentLanguage, languageRule, languageIssues, withContentLanguage, questionLanguage, LANGUAGE_ISSUE } from '../lib/contexts/generation/content-language.js';
import { patchCandidates, rejectionCode } from '../lib/generation-yield.js';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { resolveGenerationRequest, deckContentLanguage } from '../lib/generation-settings.js';
import { qualityPlan, qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';

// ui/quality-reasons.js reads the interface catalogue (JSON), so it is bundled the way the client is before it is imported.
const { outputFiles } = await build({ stdin: { contents: `export { issueCode, reasonLabel } from './ui/quality-reasons.js'; export { readableQualityIssue } from './ui/quality.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const { issueCode, reasonLabel, readableQualityIssue, setUiLanguage } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

/* #1002: the questions are written in the language the learner chose (出题语言), from Chinese sources too. The language is resolved once
   (resolveGenerationRequest), every stage is sent the same rule, and a deterministic check routes a card in the wrong language to the
   existing one repair; a card that is still wrong never reaches the deck. */

const ENGLISH = languageRule('English');
const source = { id: 's', title: '并发控制', text: '快照隔离在事务启动时读取一致快照，并在提交阶段执行首写者胜冲突检测，但仍可能出现写偏序异常。' };
const quote = source.text.slice(0, 30);

/* ---------- the rule and the check ---------- */

test('the requested language means one thing, and every language has one rule', () => {
  assert.equal(contentLanguage('English'), 'en');
  assert.equal(contentLanguage('en'), 'en');
  assert.equal(contentLanguage('中文'), 'zh');
  assert.equal(contentLanguage('中英双语'), 'both');
  assert.equal(contentLanguage('日本語'), 'other');
  assert.equal(contentLanguage(undefined), null);
  assert.match(ENGLISH, /^Content language: English\./);
  assert.match(ENGLISH, /every option/);
  assert.match(ENGLISH, /citation quotes stay verbatim/);
  assert.match(ENGLISH, /interface language preference/, 'it outranks the interface language preference every model call carries');
  assert.equal(languageRule('English'), languageRule('english'), 'the same words for the same language');
  assert.notEqual(languageRule('中文'), ENGLISH);
  assert.match(languageRule('中英双语'), /English translation/);
  assert.match(languageRule('日本語'), /in 日本語/);
  assert.equal(languageRule(undefined), '');
  assert.equal(withContentLanguage('Plan it.', undefined), 'Plan it.', 'nothing is added when no language was resolved');
  assert.ok(!withContentLanguage('Plan it.', 'English').includes('\n\n'), 'the system text stays one block (lib/prompt-order.js reads it up to its first blank line)');
});

test('English: a field with Chinese prose is flagged; quotations, glosses, formulas, code and a short name are not', () => {
  const card = { kind: 'quiz', topic: 'Snapshot isolation', prompt: 'When does snapshot isolation (快照隔离) detect a first-committer-wins conflict?',
    answer: 'At commit time.', hint: 'Think about when write sets are compared.', explanation: 'The notes say “在提交阶段执行首写者胜冲突检测”, so detection happens at commit; $x_{1}$ and `SELECT 1` stay as written.',
    misconception: 'Thinking the check runs when 北京 users start a transaction.',
    options: [{ id: 'a', text: 'At commit time', correct: true, explanation: 'The source says so.' },
      { id: 'b', text: '在事务启动时', correct: false, explanation: 'Too early.' },
      { id: 'c', text: 'Never', correct: false, explanation: 'The snapshot read at the start is not a check.' }] };
  assert.deepEqual(languageIssues({ cards: [card] }, 'English'), [`Card 1: option b ${LANGUAGE_ISSUE} (English)`]);
  const correct = { ...card, options: [{ ...card.options[0], text: '在提交阶段' }, { ...card.options[2], explanation: '启动时读取的是快照，不做检测。' }] };
  assert.deepEqual(languageIssues({ cards: [correct] }, 'English'), [`Card 1: correct option a ${LANGUAGE_ISSUE} (English)`, `Card 1: option c ${LANGUAGE_ISSUE} (English)`]);
  const cloze = { kind: 'cloze', prompt: 'Conflicts are checked at {{b1}} time.', cloze: { text: 'Conflicts are checked at {{b1}} time.', answers: [{ id: 'b1', value: '提交' }] } };
  assert.deepEqual(languageIssues({ cards: [cloze] }, 'English'), [`Card 1: cloze ${LANGUAGE_ISSUE} (English)`]);
});

test('Chinese is asked for, not checked; 中英双语 needs both in the stem; a free-form language is not checked', () => {
  const english = { kind: 'quiz', prompt: 'Which statement about snapshot isolation and write skew is correct in this case?' };
  const chinese = { kind: 'quiz', prompt: '关于快照隔离（MVCC），哪一项说法正确？', options: [{ id: 'a', text: 'MVCC', correct: true }] };
  assert.deepEqual(languageIssues({ cards: [english, chinese] }, '中文'), [], 'an English stem in a Chinese run is not held back (English material keeps its terms)');
  const both = { kind: 'quiz', prompt: '快照隔离何时检测冲突？\nWhen does snapshot isolation check for conflicts?', options: [{ id: 'a', text: '提交时（commit）', correct: true }] };
  assert.deepEqual(languageIssues({ cards: [both, chinese, english] }, '中英双语'),
    [`Card 2: prompt ${LANGUAGE_ISSUE} (Chinese with English)`, `Card 3: prompt ${LANGUAGE_ISSUE} (Chinese with English)`]);
  assert.deepEqual(languageIssues({ cards: [{ kind: 'cloze', prompt: '冲突在{{b1}}阶段检测。' }] }, '中英双语'), [], 'a cloze sentence stays one Chinese sentence');
  // The setting only says "Chinese & English" (ui/locales/en.json), so every common layout of the two passes: the English in brackets, a second
  // sentence, a short English stem; a flashcard front may be just the term in both languages. Code and formulas are not words of either.
  const layouts = ['什么是闭包？(What is a closure?)', '什么是闭包？（What is a closure?）', '定义熵。Define entropy.', '求极限 $\\lim_{x \\to 0} \\frac{\\sin x}{x}$。Find the limit.'];
  assert.deepEqual(languageIssues({ cards: layouts.map((prompt) => ({ kind: 'quiz', prompt })) }, '中英双语'), []);
  assert.deepEqual(languageIssues({ cards: [{ kind: 'flashcard', prompt: '熵 Entropy' }, { kind: 'flashcard', prompt: '熵' }] }, '中英双语'), [], 'a flashcard front is not checked');
  assert.deepEqual(languageIssues({ cards: [{ kind: 'quiz', prompt: '计算 `select count(*) from orders` 的结果。' }, { kind: 'quiz', prompt: '求 $\\int x \\, dx$ 的值。' }] }, '中英双语'),
    [`Card 1: prompt ${LANGUAGE_ISSUE} (Chinese with English)`, `Card 2: prompt ${LANGUAGE_ISSUE} (Chinese with English)`], 'code and a formula are not the English half');
  assert.deepEqual(languageIssues({ cards: [english, chinese] }, '日本語'), []);
  assert.deepEqual(languageIssues({ cards: [english, chinese] }, undefined), []);
});

test('a language finding is a wording defect where the repair may write, and says so in the learner\'s words', () => {
  const deck = { cards: [{ id: 'q1', kind: 'quiz', prompt: 'p' }, { id: 'q2', kind: 'quiz', prompt: 'p2' }] };
  const mentions = (issue, card, d) => new RegExp(`^Card ${d.cards.indexOf(card) + 1}:`).test(issue);
  const local = [`Card 1: option b ${LANGUAGE_ISSUE} (English)`, `Card 2: correct option a ${LANGUAGE_ISSUE} (English)`];
  const candidates = patchCandidates(deck, { local, binding: [], review: [] }, mentions);
  assert.deepEqual([...candidates.keys()], ['q1'], 'an incorrect option can be rewritten; the correct option and the answer cannot');
  assert.equal(rejectionCode(local[0]), 'language');
  assert.equal(issueCode(local[0]), 'language');
  assert.notEqual(reasonLabel('language'), 'language');
  // A held card's reason in the draft (ui/Draft.jsx) reads the same reason in Chinese, with the field it is about.
  setUiLanguage('zh');
  assert.equal(readableQualityIssue(local[0]), '第 1 题：有内容没有用设定的出题语言写（选项 b）');
  assert.equal(readableQualityIssue(local[1]), '第 2 题：有内容没有用设定的出题语言写（正确选项 a）');
  assert.equal(readableQualityIssue(`Card 3: prompt ${LANGUAGE_ISSUE} (Chinese with English)`), '第 3 题：有内容没有用设定的出题语言写（问题）');
  assert.equal(readableQualityIssue(`Card 4: cloze ${LANGUAGE_ISSUE} (English)`), '第 4 题：有内容没有用设定的出题语言写（填空）');
  setUiLanguage('en');
  assert.equal(readableQualityIssue(local[0]), local[0], 'the English interface shows the line as it is');
});

test('the language is resolved once: auto follows the interface, a deck keeps the language it was written in, an explicit choice wins', () => {
  assert.equal(resolveGenerationRequest({ language: 'auto' }, {}, { language: 'en' }).language, 'English');
  assert.equal(resolveGenerationRequest({ language: 'English' }, {}, { language: 'zh' }).language, 'English');
  assert.equal(deckContentLanguage({ language: 'English' }, { cards: [] }, { language: 'zh' }), 'English', 'a deck without a record takes today\'s setting');
  assert.equal(deckContentLanguage({ language: '中文' }, { editorial: { generation: { language: 'English' } } }, { language: 'zh' }), 'English', 'a deck written in English stays English');
  assert.equal(deckContentLanguage({ language: '中文' }, { editorial: { generation: { language: 'English' } } }, { language: 'zh', explicit: '中英双语' }), '中英双语');
});

test('one order decides the language of questions for an existing deck or card: asked, the deck\'s record, the card\'s own, the setting', () => {
  const recorded = { editorial: { generation: { language: 'English' } }, cards: [] }, imported = { cards: [] };
  const chinese = { prompt: '快照隔离什么时候检测冲突？' }, english = { prompt: 'When does snapshot isolation check for conflicts?' };
  assert.equal(questionLanguage({ asked: '中英双语', deck: recorded, card: chinese, fallback: '中文' }), '中英双语', 'what was asked');
  assert.equal(questionLanguage({ deck: recorded, card: chinese, fallback: '中文' }), 'English', 'then the language the deck was generated in');
  assert.equal(questionLanguage({ deck: imported, card: english, fallback: '中文' }), 'English', 'then the card\'s own');
  assert.equal(questionLanguage({ deck: imported, card: { prompt: '' }, fallback: '中文' }), '中文', 'then the setting');
  assert.equal(questionLanguage({ deck: imported, card: { prompt: '求 $\\int x \\, dx$' } }), '中文', 'a formula is no language: the stem around it is Chinese');
  assert.equal(questionLanguage({ deck: imported, card: { prompt: 'Evaluate $\\int x \\, dx$ for 熵.' } }), 'English');
  // The settings side resolves the setting (auto: the interface language) and the same order runs: a card of an imported deck keeps its own language.
  assert.equal(deckContentLanguage({ language: '中文' }, imported, { language: 'zh', card: english }), 'English');
  assert.equal(deckContentLanguage({ language: 'auto' }, imported, { language: 'en' }), 'English', 'no card: the setting, auto meaning the interface language');
});

/* ---------- every stage of a run ---------- */

const stageOf = (system) => system.startsWith('Plan ') ? 'plan' : system.startsWith('Prepare supported') ? 'blueprint' : system.startsWith('You author') ? 'author'
  : system.startsWith('Act as a strict assessment editor') ? 'review' : system.startsWith('Rewrite only the wording') ? 'patch' : 'other';
/** A sound English card for a target; its words carry the target's number, so a reserve target never repeats a first-pass card. */
const englishCard = (target, index, n = target.targetId.replace('target-', '')) => ({ id: `q${index + 1}`, targetId: target.targetId, kind: 'quiz', topic: `Snapshot isolation ${n}`,
  prompt: `Case ${n}: at which point does snapshot isolation run its first-committer-wins check?`, answer: `At commit time ${n}`,
  hint: 'Think about when the write sets of two transactions can be compared.', explanation: `The source places the check at commit, so case ${n} is decided there.`,
  misconception: 'Believing the check happens when the snapshot is read.', citations: [{ sourceId: 's', quote }],
  options: [{ id: 'a', text: `At commit time ${n}`, correct: true, explanation: 'The source puts the check at commit.' },
    { id: 'b', text: `When the transaction starts ${n}`, correct: false, explanation: 'That is when the snapshot is read.' },
    { id: 'c', text: `On every single read ${n}`, correct: false, explanation: 'Reads see the snapshot; nothing is compared.' }] });

/** A model that records every call and writes English unless a stage is told to slip (`authorSlip`, `blueprintSlip` on the first `blueprintSlipCalls` calls); `patch` is the reply to the repair. */
function recordingModel({ authorSlip = () => (card) => card, blueprintSlip = null, blueprintSlipCalls = 1, patch = null } = {}) {
  const calls = [];
  let authors = 0, blueprints = 0;
  const complete = async (rawSystem, prompt) => {
    const system = stageSystem(rawSystem, prompt), stage = stageOf(system);
    calls.push({ stage, text: `${rawSystem}\n${prompt}` });
    const data = requestData(prompt);
    if (stage === 'plan') return JSON.stringify({ targets: qualityPlan({ ...data, sources: [source] }).targets.map((target) => ({ ...target, citations: [{ sourceId: 's', quote }] })) });
    if (stage === 'blueprint') {
      blueprints++;
      const items = data.assessmentPlan.targets.map((target, index) => {
        const card = englishCard(target, index);
        const item = { targetId: target.targetId, answer: card.answer, reasoning: card.explanation, scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'When the check runs', options: card.options };
        return blueprintSlip && blueprints <= blueprintSlipCalls ? blueprintSlip(item, index) : item;
      });
      return JSON.stringify({ items });
    }
    if (stage === 'author') {
      authors++;
      const cards = data.assessmentPlan.targets.map((target, index) => authorSlip(authors)(englishCard(target, index), index));
      return JSON.stringify({ deck: { title: 'Snapshot isolation', cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    if (stage === 'review') return JSON.stringify(qualityReview(data.candidate));
    if (stage === 'patch') return JSON.stringify(patch(data));
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, calls };
}

test('every stage of a run from Chinese sources set to English carries the same language rule', async () => {
  const model = recordingModel();
  const deck = await generateDeck(model.complete, { count: 2, kind: 'quiz', sources: [source], language: 'English' });
  assert.deepEqual(model.calls.map((call) => call.stage), ['plan', 'blueprint', 'author', 'review']);
  for (const call of model.calls) assert.ok(call.text.includes(ENGLISH), `the ${call.stage} stage is sent the English rule`);
  assert.equal(deck.cards.length, 2);
  assert.deepEqual(languageIssues(deck, 'English'), []);
});

test('options the answer stage wrote in Chinese go back once through its own correction round, which fixes them before anything is written', async () => {
  const model = recordingModel({ blueprintSlip: (item) => ({ ...item, options: item.options.map((option) => option.correct ? option : { ...option, text: '在事务启动时读取快照' }) }) });
  const deck = await generateDeck(model.complete, { count: 2, kind: 'quiz', sources: [source], language: 'English' });
  assert.deepEqual(model.calls.map((call) => call.stage), ['plan', 'blueprint', 'blueprint', 'author', 'review'], 'the answer stage\'s existing correction, no new call kind');
  assert.match(model.calls[2].text, new RegExp(LANGUAGE_ISSUE), 'the correction names the language defect');
  assert.ok(model.calls.every((call) => call.text.includes(ENGLISH)));
  assert.deepEqual(languageIssues(deck, 'English'), []);
});

test('an answer stage still writing Chinese after its correction does not fail the part: the later checks drop that card with the reason and a fill round replaces it', async () => {
  // Both blueprint calls of the part bind Chinese wrong options; the fill round's blueprint is clean.
  const model = recordingModel({ blueprintSlipCalls: 2, patch: () => ({ cards: [] }),
    blueprintSlip: (item) => ({ ...item, options: item.options.map((option) => option.correct ? option : { ...option, text: `在事务启动时读取快照 ${option.id}` }) }) });
  const reserve = [{ targetId: 'target-9', objective: 'Reserve target', knowledge: quote, citations: [{ sourceId: 's', quote }] }];
  const deck = await generateDeck(model.complete, { count: 1, kind: 'quiz', sources: [source], language: 'English', fillRounds: 1,
    claimReserve: async (missing) => reserve.splice(0, missing) });
  assert.deepEqual(model.calls.slice(0, 4).map((call) => call.stage), ['plan', 'blueprint', 'blueprint', 'author'], 'the correction round, then the part goes on');
  assert.equal(deck.cards.length, 1, 'the fill round replaces the dropped card');
  assert.deepEqual(languageIssues(deck, 'English'), [], 'nothing in the wrong language reaches the deck');
  assert.ok(deck.editorial.omitted.some((item) => item.reasons.some((reason) => reason.includes(LANGUAGE_ISSUE))), 'the card in the wrong language is dropped with the reason');
});

test('a card written partly in Chinese gets the one wording repair with the rule; one still wrong after it is dropped with the reason, and a fill round replaces it', async () => {
  const model = recordingModel({
    // The first author call writes card 1 with a Chinese hint and card 2 with a Chinese explanation; the repair fixes the hint and writes the explanation in Chinese again.
    authorSlip: (round) => (card, index) => round > 1 ? card : index === 0 ? { ...card, hint: '想想两个事务的写集合什么时候比较。' }
      : index === 1 ? { ...card, explanation: '资料把检测放在提交阶段，所以答案是提交时。' } : card,
    patch: (data) => ({ cards: data.cards.map((card) => card.id === 'q1' ? { id: card.id, hint: 'Ask when the two write sets can first be compared.' }
      : { id: card.id, explanation: '检测发生在提交阶段，而不是读取快照的时候。' }) }),
  });
  const reserve = [{ targetId: 'target-9', objective: 'Reserve target', knowledge: quote, citations: [{ sourceId: 's', quote }] }];
  const deck = await generateDeck(model.complete, { count: 2, kind: 'quiz', sources: [source], language: 'English', fillRounds: 1,
    claimReserve: async (missing) => reserve.splice(0, missing) });
  assert.deepEqual(model.calls.map((call) => call.stage), ['plan', 'blueprint', 'author', 'review', 'patch', 'review', 'blueprint', 'author', 'review'],
    'one wording repair and one fill round: the budget a run already has, nothing more');
  for (const call of model.calls) assert.ok(call.text.includes(ENGLISH), `the ${call.stage} stage is sent the English rule`);
  const patchData = requestData(model.calls[4].text);
  assert.deepEqual(patchData.cards.map((card) => [card.id, card.allowed]), [['q1', ['hint']], ['q2', ['explanation']]], 'each card is repaired in the field that is in the wrong language');
  assert.equal(deck.cards.length, 2);
  assert.deepEqual(languageIssues(deck, 'English'), [], 'nothing in the wrong language reaches the deck');
  assert.ok(deck.editorial.omitted.some((item) => item.reasons.some((reason) => reason.includes(LANGUAGE_ISSUE))), 'the dropped card says why');
  assert.equal(deck.editorial.reserveUsed, 1);
});
