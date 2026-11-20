import test from 'node:test';
import assert from 'node:assert/strict';
import { act1Prompt, act2Prompt, repairLessonPrompt, sharedLessonSystem } from '../lib/contexts/generation/companion/prompts.js';
import { applyLessonRepairPatch } from '../lib/contexts/generation/companion/jobs/companion-lesson-build.js';
import { SECTION_SYSTEM, writePrompt as bookWritePrompt, reviewPrompt as bookReviewPrompt, repairPrompt as bookRepairPrompt, examPrompt } from '../lib/contexts/generation/book/prompts.js';
import { cardPassPrompt } from '../lib/contexts/generation/book/card-prompt.js';
import { confusablePrompt } from '../lib/contexts/generation/book/confusables/prompt.js';
import { kitPrompt } from '../lib/contexts/generation/book/kit/prompt.js';
import { inventoryPrompt } from '../lib/contexts/generation/inventory/prompt.js';
import { clusterPrompt } from '../lib/contexts/generation/outline/cluster.js';
import { ANSWER_CARD_SYSTEM, writePrompt as cardWritePrompt, reviewPrompt as cardReviewPrompt, repairPrompt as cardRepairPrompt } from '../lib/contexts/generation/answer-card/prompts.js';
import { applyAnswerCardPatch, readCardRepair } from '../lib/contexts/generation/answer-card/jobs/case-answer-card.js';
import { CASE_PAPER_SYSTEM, caseAuthorPrompt, caseReviewPrompt } from '../lib/case-study.js';
import { sectionWeights, weightsPrompts } from '../lib/section-weights.js';
import { recapGroups } from '../lib/daily-recap.js';
import { parseJson } from '../lib/generation.js';
import { stageRequest } from '../lib/prompt-order.js';
import { requestData } from './helpers/request-data.mjs';

const lcp = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
};

/* ---------- 1. Companion Lesson: byte-identical system + slide-patch repair ---------- */

test('companion act1, act2, and repair share byte-identical system (>=16k chars) and place stage rules after materials + blueprint', () => {
  const plan = {
    course: 'Control Systems',
    topic: 'Critical Damping',
    archetype: 'sandbox',
    language: 'en',
    grounded: true,
    excerpts: [{ id: 's1', title: 'Lecture 4', text: 'Critical damping occurs at zeta = 1. '.repeat(80) }],
  };
  const blueprint = {
    id: 'critical-damping',
    archetype: 'sandbox',
    title: 'Why does zeta = 1 collapse the naive solution?',
    act1Slides: [{ slide: 1, beat: 'open', title: 'Puzzle' }],
    act2Slides: [{ slide: 9, beat: 'fix', title: 'Secular term' }],
  };
  const act1Slides = [{ beat: 'predict', title: 'Predict', blocks: [{ t: 'predict', id: 'pred-1', q: 'What happens?' }] }];
  const lesson = { format: 'studyhub-lesson/1', id: 'critical-damping', language: 'en', slides: act1Slides };

  const a1 = act1Prompt(plan, blueprint);
  const a2 = act2Prompt(plan, blueprint, act1Slides);
  const rep = repairLessonPrompt(lesson, ['slide 1: invalid answerLines'], 'en');

  assert.equal(a1.system, sharedLessonSystem('en'));
  assert.equal(a1.system, a2.system, 'act1 and act2 must have byte-identical system for Anthropic caching');
  assert.equal(a2.system, rep.system, 'act2 and repair must have byte-identical system for Anthropic caching');
  assert.ok(a1.system.length >= 16000, `shared companion system clears Opus/Haiku 4,096-tok threshold (got ${a1.system.length} chars)`);
  assert.ok(!a1.system.includes('You are authoring Act I'), 'stage rules must live in prompt tail, not system');
  assert.ok(a1.prompt.includes('You are authoring Act I'));
  assert.ok(a2.prompt.includes('You are authoring Act II'));
  assert.ok(rep.prompt.includes('slidePatches'));

  // OpenAI/DeepSeek prefix: materials + blueprint stay at the front of prompt before stage instructions and act2 volatile fields.
  const a1Data = parseJson(a1.prompt);
  const a2Data = parseJson(a2.prompt);
  assert.deepEqual(Object.keys(a1Data), ['course', 'language', 'materials', 'blueprint']);
  assert.deepEqual(Object.keys(a2Data).slice(0, 4), ['course', 'language', 'materials', 'blueprint']);
  const sharedJsonPrefix = JSON.stringify(a1Data).slice(0, -1);
  assert.ok(lcp(a1.prompt, a2.prompt) >= sharedJsonPrefix.length, 'act1 and act2 share full course+language+materials+blueprint prefix');
  assert.ok(a1.prompt.indexOf('You are authoring Act I') > sharedJsonPrefix.length);
  assert.ok(a2.prompt.indexOf('You are authoring Act II') > sharedJsonPrefix.length);

  // Chinese language rule is also byte-identical across all 3 stages.
  const zhPlan = { ...plan, language: 'zh' };
  assert.equal(act1Prompt(zhPlan, blueprint).system, act2Prompt(zhPlan, blueprint, act1Slides).system);
  assert.equal(act2Prompt(zhPlan, blueprint, act1Slides).system, repairLessonPrompt(lesson, ['err'], 'zh').system);
});

test('companion applyLessonRepairPatch merges minimal slidePatches + metaPatch and falls back to full lesson JSON', () => {
  const assembled = {
    format: 'studyhub-lesson/1',
    id: 'demo',
    title: 'Old Title',
    lead: 'Old lead',
    slides: [
      { beat: 'open', title: 'Slide 0', blocks: [{ t: 'text', md: 'a', say: 's0' }] },
      { beat: 'why', title: 'Broken Slide 1', blocks: [{ t: 'spot', answerLines: [99], source: 'l1\nl2', say: 's1' }] },
      { beat: 'take', title: 'Slide 2', blocks: [{ t: 'cards', items: [], say: 's2' }] },
    ],
  };

  // Minimal slidePatches + metaPatch mode.
  const patched = applyLessonRepairPatch(assembled, {
    slidePatches: [{ index: 1, slide: { beat: 'why', title: 'Fixed Slide 1', blocks: [{ t: 'spot', answerLines: [2], source: 'l1\nl2', say: 'fixed' }] } }],
    metaPatch: { title: 'Updated Title', slides: 'ignored' },
  });
  assert.equal(patched.title, 'Updated Title');
  assert.equal(patched.lead, 'Old lead', 'untouched meta fields preserved');
  assert.equal(patched.slides.length, 3);
  assert.equal(patched.slides[0].title, 'Slide 0', 'untouched slides preserved');
  assert.equal(patched.slides[1].title, 'Fixed Slide 1');
  assert.deepEqual(patched.slides[1].blocks[0].answerLines, [2]);
  assert.equal(patched.slides[2].title, 'Slide 2');
  assert.equal(assembled.slides[1].title, 'Broken Slide 1', 'original assembled lesson is not mutated');

  // Full-object fallback mode.
  const fullFallback = applyLessonRepairPatch(assembled, {
    title: 'Full Replacement',
    slides: [{ beat: 'open', title: 'Only Slide', blocks: [] }],
  });
  assert.equal(fullFallback.title, 'Full Replacement');
  assert.equal(fullFallback.slides.length, 1);
  assert.equal(fullFallback.slides[0].title, 'Only Slide');

  // Unusable / empty objects return null so ask() retries cleanly.
  assert.equal(applyLessonRepairPatch(assembled, null), null);
  assert.equal(applyLessonRepairPatch(assembled, {}), null);
  assert.equal(applyLessonRepairPatch(assembled, { slidePatches: [] }), null);
});

/* ---------- 2. Review Book SECTION_SYSTEM & batch-index `part` ordering ---------- */

test('book SECTION_SYSTEM is >=4,000 chars, byte-identical across write/review/repair, and keeps untrusted anchor.exemplar out of system', () => {
  assert.ok(SECTION_SYSTEM.length >= 4000, `SECTION_SYSTEM must clear 4,000 chars for Anthropic caching (got ${SECTION_SYSTEM.length})`);
  const unit = {
    n: 1,
    of: 1,
    segments: [{ material: 'L1', page: 1, text: 'Architecture defines system structure and quality attributes.' }],
    checklist: [{ alias: 'c1', id: 'i1', kind: 'term', name: 'Architecture', gist: 'system structure', priority: 'must', page: 1 }],
  };
  const leaf = { title: 'Architecture Basics', path: ['Ch1'], before: 'Intro', after: 'Styles' };
  const anchor = { exemplar: 'UNTRUSTED_EXEMPLAR_TOKEN_710', band: { low: 150, high: 300 } };
  const plan = { language: 'zh', pitchLanguage: 'en', anchor };
  const draft = { text: 'Explained [1].', cites: [{ n: 1, quote: 'Architecture defines' }], cards: [] };
  const verdict = { round: 1, missing: [{ alias: 'c1' }], issues: [{ kind: 'missing', item: 'i1', alias: 'c1', note: 'missing' }] };

  const w = bookWritePrompt(unit, leaf, plan);
  const r = bookReviewPrompt(unit, leaf, draft, plan);
  const f = bookRepairPrompt(unit, leaf, draft, verdict, plan);

  assert.equal(w.system, SECTION_SYSTEM);
  assert.equal(r.system, SECTION_SYSTEM);
  assert.equal(f.system, SECTION_SYSTEM);
  assert.ok(!SECTION_SYSTEM.includes('UNTRUSTED_EXEMPLAR_TOKEN_710'), 'untrusted anchor exemplar must stay in user message');
  assert.ok(w.prompt.includes('UNTRUSTED_EXEMPLAR_TOKEN_710'));
  // Duplicate static definitions removed from stage tails (live in SECTION_SYSTEM instead).
  assert.ok(!w.prompt.includes('A quote that is not in the page is thrown away'));
  assert.ok(!r.prompt.includes('a term used before or without an explanation'));
  assert.ok(!f.prompt.includes('A quote that is not in the page is thrown away'));
});

test('batch-index `part` comes AFTER shared fields (language, papers) across book, inventory, and outline cluster prompts', () => {
  const keysOf = prompt => Object.keys(requestData(prompt));

  const examKeys = keysOf(examPrompt({ number: 2, items: [{ title: 'T', path: [], evidence: [{ quote: 'Q' }] }] }, { language: 'zh' }).prompt);
  assert.ok(examKeys.indexOf('language') < examKeys.indexOf('part'), `examPrompt: ${examKeys.join(',')}`);

  const cardKeys = keysOf(cardPassPrompt({ number: 2, entries: [{ alias: 'k1', title: 'T', path: [], text: 'x', checklist: [] }] }, { language: 'zh', pitchLanguage: 'en' }).prompt);
  assert.ok(cardKeys.indexOf('language') < cardKeys.indexOf('part'), `cardPassPrompt: ${cardKeys.join(',')}`);

  const confKeys = keysOf(confusablePrompt({ number: 2, pairs: [{ alias: 'p1', kind: 'opposite', a: { name: 'A' }, b: { name: 'B' } }] }, { language: 'zh' }).prompt);
  assert.ok(confKeys.indexOf('language') < confKeys.indexOf('part'), `confusablePrompt: ${confKeys.join(',')}`);

  const kitKeys = keysOf(kitPrompt(
    { number: 2, types: [{ family: 'compare', questions: [{ id: 'q1', title: 'P1', label: 'Q1', text: 'Compare A and B', leaves: ['n1'] }] }] },
    { language: 'zh' },
    { language: 'en', order: new Map([['n1', 0]]), titles: new Map([['n1', 'Point 1']]) },
  ).prompt);
  assert.ok(kitKeys.indexOf('language') < kitKeys.indexOf('part'), `kitPrompt language: ${kitKeys.join(',')}`);
  assert.ok(kitKeys.indexOf('papers') < kitKeys.indexOf('part'), `kitPrompt papers: ${kitKeys.join(',')}`);

  const invKeys = keysOf(inventoryPrompt({ number: 3, ranges: [{ material: 'L1', from: 1, to: 2, pieces: [{ text: 'hello' }] }] }, { language: 'en' }).prompt);
  assert.ok(invKeys.indexOf('language') < invKeys.indexOf('part'), `inventoryPrompt: ${invKeys.join(',')}`);

  const clusterKeys = keysOf(clusterPrompt({ number: 4, items: [{ alias: 'c1', kind: 'term', name: 'CIA', gist: 'triad', material: 'L1', page: 1 }] }, { language: 'zh' }).prompt);
  assert.ok(clusterKeys.indexOf('language') < clusterKeys.indexOf('part'), `clusterPrompt: ${clusterKeys.join(',')}`);
});

/* ---------- 3. Answer Card: shared system + question-first + `{ patch }` merge ---------- */

test('answer-card write, review, and repair share byte-identical system (>=4,000 chars), put question first in REQUEST DATA, and put stage rules at tail', () => {
  assert.ok(ANSWER_CARD_SYSTEM.length >= 4000, `ANSWER_CARD_SYSTEM must clear 4,000 chars (got ${ANSWER_CARD_SYSTEM.length})`);
  const plan = {
    language: 'zh',
    cardLanguage: 'en',
    prompt: 'Does the booking service meet its 99.9% target?',
    marks: 6,
    criteria: [{ id: 'c1', label: 'Calc', marks: 6, descriptor: 'Compute availability', keyPoints: ['one server', 'pair'] }],
    paragraphs: ['Two independent servers with MTBF 1000h and MTTR 2h. '.repeat(30)],
    types: [{ id: 'availability', label: 'Availability', signals: ['MTBF'], steps: ['Compute A'] }],
    guess: 'availability',
    bounded: [{ ref: 'M1', title: 'L4', text: 'Availability is uptime share.' }],
  };
  const card = {
    questionType: { id: 'availability', label: 'Availability' },
    signals: [{ word: 'MTBF', quote: 'MTBF 1000h' }],
    facts: [{ text: 'Two servers', quote: 'Two independent servers' }],
    concepts: [{ name: 'Availability', quote: 'Availability is uptime share.' }],
    assumptions: ['Independent failures'],
    steps: ['A = 1000/1002 = 0.998'],
    conclusion: 'Meets target.',
    justification: { goal: 'Meets 99.9%', cost: '2x servers', failure: 'Failover', verify: 'Measure uptime' },
    pitfalls: ['Series formula'],
    marksMap: [{ point: 'c1.k1', sentence: 'A = 1000/1002 = 0.998' }],
  };

  const w = cardWritePrompt(plan);
  const r = cardReviewPrompt(plan, card);
  const rep = cardRepairPrompt(plan, card, ['review missingCost at justification.cost: Be specific.']);

  assert.equal(w.system, ANSWER_CARD_SYSTEM);
  assert.equal(r.system, ANSWER_CARD_SYSTEM);
  assert.equal(rep.system, ANSWER_CARD_SYSTEM);
  assert.ok(w.prompt.startsWith('REQUEST DATA:\n{"question":'), 'write puts question first in REQUEST DATA');
  assert.ok(r.prompt.startsWith('REQUEST DATA:\n{"question":'), 'review puts question first in REQUEST DATA');
  assert.ok(rep.prompt.startsWith(w.prompt), 'repair preserves full write prompt as exact prefix');

  const questionEnd = w.prompt.indexOf(',"questionTypes":');
  assert.ok(lcp(w.prompt, r.prompt) >= questionEnd, 'write and review share identical REQUEST DATA question + case prefix');
  assert.ok(w.prompt.indexOf('STAGE: write') > questionEnd);
  assert.ok(r.prompt.indexOf('STAGE: review') > questionEnd);
});

test('answer-card applyAnswerCardPatch / readCardRepair merges minimal `{ patch }` (including partial justification) and supports full-card fallback', () => {
  const existing = {
    questionType: { id: 'availability', label: 'Availability' },
    signals: [{ word: 'MTBF', quote: 'MTBF 1000h' }],
    facts: [{ text: 'Bad fact', quote: 'Wrong quote' }],
    concepts: [{ name: 'Availability', quote: 'Availability is uptime share.' }],
    assumptions: ['Independent failures'],
    steps: ['Step 1: A = 0.998'],
    conclusion: 'Meets target.',
    justification: { goal: 'Keeps bookings running', cost: 'Vague', failure: 'Failover to peer', verify: 'Monthly SLA check' },
    pitfalls: ['Multiplying in series'],
    marksMap: [{ point: 'c1.k1', sentence: 'Step 1: A = 0.998' }],
  };

  const patched = readCardRepair(JSON.stringify({
    patch: {
      facts: [{ text: 'Two servers', quote: 'Two independent servers' }],
      justification: { cost: 'Two servers plus load balancer roughly double infrastructure spend.' },
    },
  }), existing);
  assert.ok(patched);
  assert.equal(patched.facts[0].quote, 'Two independent servers');
  assert.equal(patched.justification.cost, 'Two servers plus load balancer roughly double infrastructure spend.');
  assert.equal(patched.justification.goal, 'Keeps bookings running', 'untouched justification fields preserved');
  assert.equal(patched.justification.failure, 'Failover to peer');
  assert.equal(patched.conclusion, 'Meets target.');
  assert.deepEqual(patched.marks, [{ point: 'c1.k1', sentence: 'Step 1: A = 0.998' }]);

  const fullFallback = applyAnswerCardPatch(existing, {
    questionType: 'risk',
    steps: ['Full step 1'],
    conclusion: 'Full conclusion',
  });
  assert.equal(fullFallback.questionType, 'risk');
  assert.equal(fullFallback.conclusion, 'Full conclusion');

  assert.equal(applyAnswerCardPatch(existing, { patch: {} }), null);
  assert.equal(readCardRepair('not json', existing), null);
});

/* ---------- 4. Case Study: unified system + shared prefix before candidate ---------- */

test('caseAuthorPrompt and caseReviewPrompt share identical system and leading { language, referenceQuestions, styleTemplate } prefix', () => {
  const refs = [{ id: 'r1', title: 'Past Exam', text: 'Past exam case question style reference. '.repeat(40) }];
  const styleText = 'PAST STYLE TEMPLATE TEXT. '.repeat(40);
  const sources = [{ id: 's1', title: 'Notes', text: 'Microservices and event-driven architecture.' }];

  const author = caseAuthorPrompt({
    language: 'English',
    questions: 2,
    totalMarks: 20,
    sources,
    questionReferences: refs,
    referenceFormat: 'balanced',
    styleText,
  });
  const review = caseReviewPrompt(
    { title: 'Candidate', scenario: { paragraphs: ['P1'] }, questions: [] },
    { language: 'English', questionReferences: refs, referenceFormat: 'balanced', styleText },
  );

  assert.equal(author.system, review.system, 'author and review must share byte-identical system');
  assert.ok(author.system.startsWith(CASE_PAPER_SYSTEM));
  // stageRequest leaves case prompts untouched so unified CASE_PAPER_SYSTEM is preserved.
  assert.deepEqual(stageRequest(author.system, author.prompt), author);
  assert.deepEqual(stageRequest(review.system, review.prompt), review);

  const reviewData = parseJson(review.prompt.slice(review.prompt.indexOf('DATA:\n') + 6));
  const reviewKeys = Object.keys(reviewData);
  assert.ok(reviewKeys.indexOf('language') < reviewKeys.indexOf('candidate'), `language before candidate: ${reviewKeys.join(',')}`);
  assert.ok(reviewKeys.indexOf('referenceQuestions') < reviewKeys.indexOf('candidate'), `referenceQuestions before candidate: ${reviewKeys.join(',')}`);
  assert.ok(reviewKeys.indexOf('styleTemplate') < reviewKeys.indexOf('candidate'), `styleTemplate before candidate: ${reviewKeys.join(',')}`);

  const sharedEnd = review.prompt.indexOf(',"candidate":');
  assert.ok(sharedEnd > 2000, 'shared prefix covers language + references + styleTemplate');
  assert.ok(lcp(author.prompt, review.prompt) >= sharedEnd, 'author and review share exact prefix before candidate');
  assert.ok(author.prompt.indexOf('STAGE: case-author') > sharedEnd);
  assert.ok(review.prompt.indexOf('STAGE: case-review') > sharedEnd);

  // Repair keeps attempt 1 prompt as an exact prefix.
  const repair = caseAuthorPrompt({
    language: 'English',
    questions: 2,
    totalMarks: 20,
    sources,
    questionReferences: refs,
    referenceFormat: 'balanced',
    styleText,
    repair: { previous: { title: 'Draft' }, issues: ['q1: mismatch'] },
  });
  assert.equal(repair.system, author.system);
  assert.ok(repair.prompt.startsWith(author.prompt), 'caseAuthorPrompt repair keeps attempt 1 as exact prefix');
});

/* ---------- 5. Section Weights: shared SYSTEM + hedge: false ---------- */

test('section-weights puts instructions + focusNote in shared SYSTEM, keeps evidence first in prompt, and passes hedge: false', async () => {
  const p1 = weightsPrompts([{ id: 's1', title: 'Intro', position: '1/2', chars: 500, head: 'Intro text' }], { language: 'en', focusTopics: ['MVCC'] });
  const p2 = weightsPrompts([{ id: 's1', title: 'MVCC', position: '2/2', chars: 900, head: 'MVCC text' }], { language: 'en', focusTopics: ['MVCC'] });
  assert.equal(p1.system, p2.system, 'instructions and focusNote live in shared system across chunks');
  assert.match(p1.system, /Rate EVERY section/);
  assert.match(p1.system, /MVCC/);
  assert.ok(p1.prompt.startsWith('{"sections":['), 'evidence leads prompt');
  assert.ok(!p1.prompt.includes('MVCC') || p1.prompt.includes('Intro text'));
  assert.doesNotMatch(p1.prompt, /Course exam focus topics/);

  const seenOptions = [];
  const result = await sectionWeights({
    sections: [{ id: 'sec1', sourceId: 'src1', title: 'MVCC', start: 0, end: 20 }],
    sources: [{ id: 'src1', text: 'MVCC snapshot rules.' }],
    language: 'en',
    focusTopics: ['MVCC'],
    light: async (_system, _prompt, options) => {
      seenOptions.push(options);
      return JSON.stringify({ sections: [{ id: 's1', importance: 5, kind: 'definition', reason: 'Focus topic' }] });
    },
  });
  assert.equal(result.source, 'model');
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0].hedge, false, 'sectionWeights disables 15s light-lane hedging on batch calls');
});

/* ---------- 6. Daily Recap: strip unused UUIDs, timestamps, and solid options ---------- */

test('daily-recap strips deckId/cardId/attempt.id/at and solid-card options from JSON payload while keeping wrong-card options and JS deckId/cardId', () => {
  const opts = [
    { id: 'a', text: 'Right option', correct: true, explanation: 'Because condition holds.' },
    { id: 'b', text: 'Distractor option', correct: false, explanation: 'Common confusion.' },
  ];
  const state = {
    decks: [{
      id: 'deck-uuid-1234',
      title: 'Databases',
      course: 'Databases',
      cards: [
        { id: 'card-solid-uuid', kind: 'quiz', topic: 'Indexes', objective: 'Use B+ trees', prompt: 'Solid Q?', answer: 'A', explanation: 'Exp solid', misconception: 'Misc', options: opts },
        { id: 'card-wrong-uuid', kind: 'quiz', topic: 'Isolation', objective: 'Spot write skew', prompt: 'Wrong Q?', answer: 'A', explanation: 'Exp wrong', misconception: 'Misc', options: opts },
      ],
    }],
    sources: [],
    drafts: [],
    courses: [],
    notes: [],
    runs: [{
      id: 'run-1',
      deckId: 'deck-uuid-1234',
      entries: [
        { deckId: 'deck-uuid-1234', card: { id: 'card-solid-uuid', topic: 'Indexes', prompt: 'Solid Q?', answer: 'A', explanation: 'Exp solid', options: opts }, feedback: { selected: ['a'], grade: 5 } },
        { deckId: 'deck-uuid-1234', card: { id: 'card-wrong-uuid', topic: 'Isolation', prompt: 'Wrong Q?', answer: 'A', explanation: 'Exp wrong', options: opts }, feedback: { selected: ['b'], grade: 1 } },
      ],
    }],
    oralRuns: [],
    attempts: [
      { id: 'attempt-uuid-1', runId: 'run-1', deckId: 'deck-uuid-1234', quiz_id: 'card-solid-uuid', grade: 5, assessment: 'graded', timestamp: '2026-10-06T04:00:00Z' },
      { id: 'attempt-uuid-2', runId: 'run-1', deckId: 'deck-uuid-1234', quiz_id: 'card-wrong-uuid', grade: 1, assessment: 'graded', timestamp: '2026-10-06T04:05:00Z' },
    ],
  };

  const { groups } = recapGroups(state, { day: '2026-10-06', timeZone: 'Asia/Shanghai' });
  assert.equal(groups.length, 1);
  const questions = groups[0].questions;
  assert.equal(questions.length, 2);

  // Downstream JS access (`note.cards = current.questions.map(({ deckId, cardId }) => ...)`) still works!
  assert.deepEqual(
    questions.map(({ deckId, cardId }) => ({ deckId, cardId })),
    [{ deckId: 'deck-uuid-1234', cardId: 'card-solid-uuid' }, { deckId: 'deck-uuid-1234', cardId: 'card-wrong-uuid' }],
  );

  // Serialized JSON payload sent to the model omits deckId, cardId, attempt.id, attempt.at, and options on solid cards.
  const serialized = JSON.parse(JSON.stringify(questions));
  const rawJson = JSON.stringify(serialized);
  assert.ok(!rawJson.includes('deck-uuid-1234'), 'deckId stripped from JSON payload');
  assert.ok(!rawJson.includes('card-solid-uuid'), 'cardId stripped from JSON payload');
  assert.ok(!rawJson.includes('attempt-uuid-1'), 'attempt.id stripped from JSON payload');
  assert.ok(!rawJson.includes('2026-10-06T04:00:00Z'), 'attempt.at stripped from JSON payload');

  const solid = serialized.find(q => q.question === 'Solid Q?');
  const wrong = serialized.find(q => q.question === 'Wrong Q?');
  assert.equal(solid.wrong, false);
  assert.equal(solid.options, undefined, 'options omitted on solid (wrong === false) cards');
  assert.equal(solid.attempts[0].id, undefined);
  assert.equal(solid.attempts[0].at, undefined);
  assert.equal(solid.attempts[0].grade, 5);

  assert.equal(wrong.wrong, true);
  assert.deepEqual(wrong.options, opts, 'options preserved on wrong === true cards');
  assert.deepEqual(wrong.attempts[0].selected, ['b']);
});
