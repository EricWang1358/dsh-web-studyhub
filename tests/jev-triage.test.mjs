import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeck } from '../lib/generation.js';
import { generateBatched } from '../lib/batch.js';
import { saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { TRIAGE_CHECKS, buildTriageRequest, createPreReview, readTriage, rewriteFlagged, triageDeck } from '../lib/jev-triage.js';
import { authored, qualityPlan, qualityReview, withQualityStages } from './helpers/assessment.mjs';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 出题预审: a cheap Jev pass over each candidate card BEFORE the one independent review. A confident failure sends the card back for
   one rewrite; EVERY card still goes through the independent review, which stays the only gate. The signals are kept with the draft. */

const source = { id: 's', title: 'Course notes', text: 'Architecture includes the principles guiding a system\'s design and evolution. Transactions isolate concurrent changes.' };
const quote = 'Architecture includes the principles guiding a system';
const flash = (id, prompt, extra = {}) => ({ id, kind: 'flashcard', topic: `Topic ${id}`, objective: `Objective ${id}`, prompt, answer: `Answer ${id}`,
  hint: 'Compare a current-state description with a constraint on permitted changes.', explanation: 'The quoted definition explicitly includes principles governing design and evolution.',
  misconception: 'Confusing a description with a constraint.', citations: [{ sourceId: 's', quote }], ...extra });
const quiz = (id, prompt) => ({ ...flash(id, prompt, { kind: 'quiz' }), options: ['a', 'b', 'c'].map(key => ({ id: key, text: `Option ${key} of ${id}`, correct: key === 'a', explanation: `Why ${key}` })) });
const han = /[㐀-鿿]/;

/** A fake whose noul answers are chosen per question text and check: table[prompt][check] = probability of "yes". */
const byCard = table => (name, question, state) => ({ type: 'noul', noul: table[state.question]?.[name] ?? (TRIAGE_CHECKS[name].fail === 'yes' ? 0.05 : 0.95) });

async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-triage-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev(serverOptions);
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  t.after(async () => {
    await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  return { home, fake, runtime, open: () => saveJevSettings({ key: fake.key, confirm: true, enabled: true, features: { preReview: true } }) };
}

test('one request per card: the question, its options and answer, and the evidence; the checks that fit the kind', () => {
  const flashRequest = buildTriageRequest(flash('f', 'What guides design?'), [source]);
  assert.deepEqual(Object.keys(flashRequest.questions).sort(), ['answerInEvidence', 'needsSource', 'stemLeaksAnswer']);
  assert.equal(flashRequest.state.question, 'What guides design?');
  assert.equal(flashRequest.state.answer, 'Answer f');
  assert.deepEqual(flashRequest.state.evidence, [quote]);
  for (const question of Object.values(flashRequest.questions)) { assert.equal(question.type, 'noul'); assert.ok(question.instructions.length > 20); }
  const quizRequest = buildTriageRequest(quiz('q', 'Which is right?'), [source]);
  assert.deepEqual(Object.keys(quizRequest.questions).sort(), ['answerInEvidence', 'needsSource', 'oneDefensible', 'stemLeaksAnswer']);
  assert.deepEqual(quizRequest.state.options.map(option => option.correct), [true, false, false]);
  const cloze = buildTriageRequest(flash('c', 'The {{b1}} guides design.', { kind: 'cloze' }), [source]);
  assert.deepEqual(Object.keys(cloze.questions).sort(), ['answerInEvidence', 'needsSource'], 'a cloze prompt contains its blanks, so "does the stem give it away" does not apply');
  // No evidence quote -> nothing to check the answer against.
  const bare = buildTriageRequest(flash('b', 'What?', { citations: [] }), [source]);
  assert.ok(!('answerInEvidence' in bare.questions));
  // Evidence is a short quote, not the whole source, and bounded.
  const long = buildTriageRequest(flash('l', 'What?', { citations: [{ sourceId: 's', quote: 'x'.repeat(5000) }] }), [source]);
  assert.ok(long.state.evidence[0].length <= 600);
});

test('a confident failure needs the failing side to reach the threshold; "does it reveal" fails on yes, "is it supported" fails on no', () => {
  const card = quiz('q', 'Which?');
  const signal = readTriage(card, { stemLeaksAnswer: { type: 'noul', noul: 0.93 }, needsSource: { type: 'noul', noul: 0.1 }, answerInEvidence: { type: 'noul', noul: 0.15 }, oneDefensible: { type: 'noul', noul: 0.9 } }, { threshold: 0.8 });
  assert.deepEqual(signal.checks.stemLeaksAnswer, { p: 0.93, failure: 0.93, failed: true });
  assert.deepEqual(signal.checks.needsSource, { p: 0.1, failure: 0.1, failed: false });
  assert.deepEqual(signal.checks.answerInEvidence, { p: 0.15, failure: 0.85, failed: true });
  assert.deepEqual(signal.checks.oneDefensible, { p: 0.9, failure: 0.1, failed: false });
  assert.equal(signal.flagged, true);
  assert.deepEqual(signal.failures.sort(), ['answerInEvidence', 'stemLeaksAnswer']);
  const edge = readTriage(card, { stemLeaksAnswer: { type: 'noul', noul: 0.8 }, needsSource: { type: 'noul', noul: 0.79 }, answerInEvidence: { type: 'noul', noul: 0.9 }, oneDefensible: { type: 'noul', noul: 0.9 } }, { threshold: 0.8 });
  assert.deepEqual(edge.failures, ['stemLeaksAnswer'], 'exactly at the line counts, just under it does not');
  const calm = readTriage(card, { stemLeaksAnswer: { type: 'noul', noul: 0.4 }, needsSource: { type: 'noul', noul: 0.5 }, answerInEvidence: { type: 'noul', noul: 0.6 }, oneDefensible: { type: 'noul', noul: 0.6 } }, { threshold: 0.8 });
  assert.equal(calm.flagged, false, 'an unsure Jev is not a failure');
});

test('triageDeck: every card is asked, with bounded concurrency; the gate and the failures never throw', async t => {
  const cards = Array.from({ length: 9 }, (_, index) => flash(`c${index}`, `Question ${index}?`));
  let active = 0, peak = 0;
  const h = await harness(t, { delayMs: 15, onRequest: () => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; }, 15); },
    answer: byCard({ 'Question 3?': { stemLeaksAnswer: 0.97 } }) });
  // Closed gate: nothing is sent.
  let result = await triageDeck({ runtime: h.runtime, cards, sources: [source], threshold: 0.8, concurrency: 3 });
  assert.equal(result.unavailable.reason, 'off');
  assert.deepEqual(result.signals, {});
  assert.equal(h.fake.requests.length, 0);
  await h.open();
  result = await triageDeck({ runtime: h.runtime, cards, sources: [source], threshold: 0.8, concurrency: 3 });
  assert.equal(Object.keys(result.signals).length, 9);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  assert.deepEqual(Object.entries(result.signals).filter(([, signal]) => signal.flagged).map(([id]) => id), ['c3']);
  assert.ok(result.usage.inputTokens > 0 && result.usage.calls === 9);
  // A bad key stops the run after one request.
  h.fake.requests.length = 0; h.fake.fail(401);
  result = await triageDeck({ runtime: h.runtime, cards, sources: [source], threshold: 0.8, concurrency: 1 });
  assert.equal(result.unavailable.reason, 'invalid-key');
  assert.equal(h.fake.requests.length, 1);
});

test('rewriteFlagged: only the flagged cards go to the author model; a valid rewrite replaces the card, an invalid one is ignored', async () => {
  const draft = { title: 'D', cards: [flash('a', 'Fine question?'), flash('b', 'The principles guiding design and evolution are what?'), flash('c', 'According to the text above, what is it?')] };
  const signals = { a: { flagged: false, failures: [] }, b: { flagged: true, failures: ['stemLeaksAnswer'] }, c: { flagged: true, failures: ['needsSource'] } };
  const seen = [];
  const complete = async (system, prompt) => {
    seen.push({ system, prompt });
    return JSON.stringify({ cards: [
      flash('b', 'What does an architecture\'s guiding set shape over time?'),
      { ...flash('c', 'Rewritten but with another kind'), kind: 'quiz' },
    ] });
  };
  const result = await rewriteFlagged({ complete, draft, signals, sources: [source] });
  assert.equal(seen.length, 1, 'one call for all flagged cards');
  const sent = JSON.parse(seen[0].prompt);
  assert.deepEqual(sent.cards.map(card => card.id), ['b', 'c']);
  assert.ok(sent.cards[0].problems.some(text => /reveal|give/i.test(text)));
  assert.ok(sent.cards[1].problems.some(text => /text|source|context/i.test(text)));
  assert.deepEqual(result.rewritten, ['b']);
  assert.equal(result.draft.cards[1].prompt, 'What does an architecture\'s guiding set shape over time?');
  assert.equal(result.draft.cards[2].prompt, 'According to the text above, what is it?', 'a kind change is refused, the original stays');
  assert.equal(result.draft.cards[0].prompt, 'Fine question?');
  assert.equal(draft.cards[1].prompt, 'The principles guiding design and evolution are what?', 'the input draft is not modified');
  // A failing model leaves everything as it was.
  const same = await rewriteFlagged({ complete: async () => { throw new Error('model down'); }, draft, signals, sources: [source] });
  assert.deepEqual(same.rewritten, []);
  assert.deepEqual(same.draft.cards.map(card => card.prompt), draft.cards.map(card => card.prompt));
  // A rewrite that breaks the card's evidence (a quote that is not in the source) is refused too.
  const broken = await rewriteFlagged({ complete: async () => JSON.stringify({ cards: [flash('b', 'New wording?', { citations: [{ sourceId: 's', quote: 'a quote that the source never contains' }] })] }), draft, signals, sources: [source] });
  assert.deepEqual(broken.rewritten, []);
});

test('generateDeck: Jev flags a card, it is rewritten once BEFORE the review, and every card still goes through the independent review', async t => {
  const h = await harness(t, { answer: byCard({ 'Leaky question?': { stemLeaksAnswer: 0.96 }, 'Fine question?': {} }) });
  await h.open();
  const deck = { title: 'D', cards: [flash('ok', 'Fine question?'), flash('bad', 'Leaky question?', { objective: 'Another objective' })] };
  const req = { count: 2, kind: 'flashcard', sources: [source], preReview: createPreReview({ runtime: h.runtime, threshold: 0.8 }) };
  const calls = [];
  const rewritten = flash('bad', 'A question that does not give itself away?', { objective: 'Another objective' });
  const result = await generateDeck(withQualityStages(async (system, prompt) => {
    calls.push(system);
    if (system.startsWith('Plan a source-grounded assessment')) return JSON.stringify(qualityPlan(req));
    if (system.startsWith('Act as a strict assessment editor')) {
      const candidate = JSON.parse(prompt).candidate;
      assert.deepEqual(candidate.cards.map(card => card.prompt), ['Fine question?', 'A question that does not give itself away?'], 'the reviewer sees the rewritten card, and the unflagged one too');
      return JSON.stringify(qualityReview(candidate));
    }
    if (system.startsWith('Rewrite')) return JSON.stringify({ cards: [rewritten] });
    return JSON.stringify(authored(deck));
  }), req);
  assert.equal(calls.filter(system => system.startsWith('Act as a strict')).length, 1, 'the independent review ran once, over both cards');
  assert.equal(h.fake.requests.length, 2, 'one tiny Jev call per card');
  assert.equal(result.cards.length, 2);
  const jev = result.editorial.jev;
  assert.equal(jev.version, 1);
  assert.equal(jev.threshold, 0.8);
  const byPrompt = Object.fromEntries(result.cards.map(card => [card.prompt, card.id]));
  assert.equal(jev.signals[byPrompt['A question that does not give itself away?']].rewritten, true);
  assert.equal(jev.signals[byPrompt['A question that does not give itself away?']].checks.stemLeaksAnswer.p, 0.96, 'the signal shows what Jev saw in the ORIGINAL card');
  assert.equal(jev.signals[byPrompt['Fine question?']].flagged, false);
  assert.ok(Object.keys(jev.signals).every(id => result.cards.some(card => card.id === id)), 'signals are keyed by the final card ids');
  assert.ok(result.editorial.reviewedCards[byPrompt['A question that does not give itself away?']], 'the rewritten card passed the independent review');
});

test('a Jev that is off, failing or throwing changes nothing: the same calls, the same deck, no jev block', async t => {
  const deck = () => ({ title: 'D', cards: [flash('ok', 'Fine question?'), flash('two', 'Second question?', { objective: 'Objective two' })] });
  const run = async preReview => {
    const calls = [], d = deck();
    const req = { count: 2, kind: 'flashcard', sources: [source], ...(preReview ? { preReview } : {}) };
    const result = await generateDeck(withQualityStages(async (system, prompt) => {
      calls.push(system.slice(0, 24));
      if (system.startsWith('Plan a source-grounded assessment')) return JSON.stringify(qualityPlan(req));
      if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
      return JSON.stringify(authored(d));
    }), req);
    return { calls, result };
  };
  const plain = await run();
  const h = await harness(t);
  const closed = await run(createPreReview({ runtime: h.runtime, threshold: 0.8 }));
  assert.deepEqual(closed.calls, plain.calls);
  assert.equal(closed.result.editorial.jev, undefined, 'a closed gate leaves no trace in the draft');
  assert.equal(h.fake.requests.length, 0);
  await h.open(); h.fake.fail(500, 500, 500, 500, 500, 500);
  const failing = await run(createPreReview({ runtime: h.runtime, threshold: 0.8 }));
  assert.deepEqual(failing.calls, plain.calls);
  assert.deepEqual(failing.result.cards.map(card => card.prompt), plain.result.cards.map(card => card.prompt));
  const throwing = await run(async () => { throw new Error('bug in the pre-review'); });
  assert.deepEqual(throwing.calls, plain.calls);
  assert.equal(throwing.result.cards.length, 2);
});

test('batches: the signals of every part are collected into the one draft', async t => {
  const h = await harness(t, { answer: byCard({}) });
  await h.open();
  const plan = request => qualityPlan(request);
  let n = 0;
  const sources = Array.from({ length: 2 }, (_, index) => ({ id: `s${index}`, title: `Notes ${index}`, text: `Unique source number ${index}. ${'Architecture includes the principles guiding a system. '.repeat(2000)}` }));
  const result = await generateBatched(withQualityStages(async (system, prompt) => {
    if (system.startsWith('Plan a source-grounded assessment')) return JSON.stringify(plan(JSON.parse(prompt.split('REQUEST DATA:\n')[1])));
    if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]), id = ++n;
    return JSON.stringify(authored({ title: 'T', cards: Array.from({ length: request.count }, (_, k) => ({ ...flash(`x${id}-${k}`, `Distinct question ${id}-${k}?`, { objective: `Objective ${id}-${k}`, citations: [{ sourceId: request.sources[0].id, quote: request.sources[0].text.trim().slice(0, 40) }] }) })) }, [], request.assessmentPlan));
  }), { count: 4, kind: 'flashcard', sources, preReview: createPreReview({ runtime: h.runtime, threshold: 0.8 }) });
  const signals = result.editorial.jev?.signals ?? {};
  assert.equal(Object.keys(signals).length, result.cards.length);
  assert.ok(result.cards.every(card => signals[card.id]));
});

test('the signals hold ids and numbers only: nothing of the card text is stored a second time', async t => {
  const h = await harness(t, { answer: byCard({}) });
  await h.open();
  const deck = { title: 'D', cards: [flash('ok', 'Fine question?')] };
  const req = { count: 1, kind: 'flashcard', sources: [source], preReview: createPreReview({ runtime: h.runtime, threshold: 0.8 }) };
  const result = await generateDeck(withQualityStages(async (system, prompt) => {
    if (system.startsWith('Plan a source-grounded assessment')) return JSON.stringify(qualityPlan(req));
    if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    return JSON.stringify(authored(deck));
  }), req);
  const dump = JSON.stringify(result.editorial.jev);
  assert.ok(!dump.includes('Fine question'), 'no card text in the signals');
  assert.ok(!han.test(dump));
});
