import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeck } from '../lib/generation.js';
import { reviewIssues } from '../lib/assessment-quality.js';
import { REVIEW_CHECKS, buildReviewRequest, createReviewHook, readReview, critiqueFor, mergeJevDecided } from '../lib/jev-review.js';
import { jevReviewHook } from '../lib/jev-hooks.js';
import { saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { withQualityStages } from './helpers/assessment.mjs';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 独立复审 (the independent review of generated cards) with Jev as an optional replacement: per card, six typed yes/no checks. A card Jev
   settles with enough confidence is accepted or rejected exactly as the model's review would have been; every other card goes to the
   unchanged model review in ONE call. With the switch off the model call sequence is byte-identical to before. */

const source = { id: 's', title: 'Bridge', text: 'Bridge separates an abstraction from its implementation so the two can vary independently.' };
const card = (id, prompt, objective, extra = {}) => ({ id, kind: 'flashcard', topic: 'Bridge', objective, prompt, answer: 'Separate independent dimensions.',
  hint: 'Think about two independent reasons to change.', explanation: 'Report types and rendering backends vary independently, so a cross product of subclasses is avoided.',
  misconception: 'Adding a subclass for every combination causes a cross product.', citations: [{ sourceId: 's', quote: source.text }], ...extra });
const quiz = (id, prompt, objective) => card(id, prompt, objective, { kind: 'quiz', options: [
  { id: 'a', text: 'Separate abstraction and implementation', correct: true, explanation: 'That is the point of Bridge.' },
  { id: 'b', text: 'Copy objects', correct: false, explanation: 'That is Prototype.' }, { id: 'c', text: 'Wrap one interface', correct: false, explanation: 'That is Adapter.' }] });
const DECK = [card('c1', 'Why use Bridge for reports and renderers? [c1]', 'Objective one'), card('c2', 'What does Bridge let two dimensions do? [c2]', 'Objective two'), card('c3', 'When is Bridge better than subclassing? [c3]', 'Objective three')];

async function harness(t, { markers = {}, serverOptions = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-review-'));
  const before = Object.fromEntries(['DSH_HOME', 'JEV_API_KEY', 'JEV_BASE_URL'].map(name => [name, process.env[name]]));
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  // The fake reads the card text it is sent: "[fail dim]" makes that check fail (3% pass), "[unsure dim]" 50%, otherwise 95% pass.
  const fake = await startFakeJev({ answer: (name, question, state) => {
    const text = JSON.stringify(state);
    return { type: 'noul', noul: text.includes(`[fail ${name}]`) ? 0.03 : text.includes(`[unsure ${name}]`) ? 0.5 : text.includes('[down]') ? 0.5 : 0.95 };
  }, ...serverOptions });
  const calls = [];
  const complete = withQualityStages(async (system, prompt) => {
    calls.push({ system, prompt });
    if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify({ issues: markers.reviewIssues ?? [] });
    return JSON.stringify({ title: 'Bridge', cards: markers.cards ?? DECK });
  });
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  t.after(async () => {
    await fake.close();
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(home, { recursive: true, force: true });
  });
  const open = (extra = {}) => saveJevSettings({ key: fake.key, confirm: true, enabled: true, replace: { cardReview: true }, ...extra });
  const hook = (options = {}) => createReviewHook({ runtime, threshold: 0.8, language: 'en', ...options });
  const run = (extra = {}, count = 3) => generateDeck(complete, { sources: [source], count, kind: 'flashcard', ...extra });
  return { fake, calls, runtime, open, hook, run, reviews: () => calls.filter(call => call.system.startsWith('Act as a strict assessment editor')) };
}
const reviewedIds = call => JSON.parse(call.prompt).candidate.cards.map(item => item.id);

/* ---- the typed request ------------------------------------------------------------------------------------------------ */

test('the six checks of the model review each become one yes/no question; a card gets only the ones that fit it', () => {
  assert.deepEqual(REVIEW_CHECKS.map(item => item.id), ['selfContained', 'answerLeak', 'optionQuality', 'learningValue', 'sourceSupport', 'explanationQuality']);
  const flash = buildReviewRequest(DECK[0]);
  assert.deepEqual(Object.keys(flash.questions).sort(), ['answerLeak', 'explanationQuality', 'learningValue', 'selfContained', 'sourceSupport']);
  assert.ok(Object.values(flash.questions).every(question => question.type === 'noul' && question.instructions.length > 20));
  assert.equal(flash.state.question, DECK[0].prompt);
  assert.equal(flash.state.answer, DECK[0].answer);
  assert.ok(flash.state.evidence.length >= 1 && flash.state.explanation);
  const choice = buildReviewRequest(quiz('q', 'Which separates abstraction from implementation?', 'Pick Bridge'));
  assert.ok('optionQuality' in choice.questions);
  assert.equal(choice.state.options.length, 3);
  assert.equal(choice.state.options.filter(option => option.correct).length, 1);
});

test('what Jev cannot judge is not sent: multi-answer cards, a card without evidence or explanation', () => {
  assert.equal(buildReviewRequest({ ...DECK[0], kind: 'multi', options: [{ id: 'a', text: 'x', correct: true }, { id: 'b', text: 'y', correct: true }] }), null);
  assert.equal(buildReviewRequest({ ...DECK[0], citations: [] }), null);
  assert.equal(buildReviewRequest({ ...DECK[0], explanation: '' }), null);
  assert.equal(buildReviewRequest({ ...DECK[0], prompt: '' }), null);
});

test('reading the answers: all confident passes accept, one confident failure rejects, anything else is left to the model; the line is the learner’s', () => {
  const answers = (p, over = {}) => Object.fromEntries(Object.keys(buildReviewRequest(DECK[0]).questions).map(id => [id, { type: 'noul', noul: over[id] ?? p }]));
  const accept = readReview(DECK[0], answers(0.95), { threshold: 0.8 });
  assert.deepEqual([accept.value.verdict, accept.confidence], ['accept', 0.95]);
  const reject = readReview(DECK[0], answers(0.95, { answerLeak: 0.03 }), { threshold: 0.8 });
  assert.deepEqual([reject.value.verdict, reject.value.failed, reject.confidence], ['reject', ['answerLeak'], 0.97]);
  const mixed = readReview(DECK[0], answers(0.95, { sourceSupport: 0.5 }), { threshold: 0.8 });
  assert.deepEqual([mixed.value.verdict, mixed.confidence], ['unsure', 0]);
  assert.equal(readReview(DECK[0], answers(0.95, { sourceSupport: 0.5, answerLeak: 0.02 }), { threshold: 0.8 }).value.verdict, 'reject', 'one confident failure is enough');
  assert.equal(readReview(DECK[0], answers(0.85), { threshold: 0.9 }).value.verdict, 'unsure');
  assert.equal(readReview(DECK[0], answers(0.85), { threshold: 0.8 }).value.verdict, 'accept');
  assert.equal(readReview(DECK[0], answers(0.8), { threshold: 0.8 }).value.verdict, 'accept', 'the line itself counts');
  assert.equal(readReview(DECK[0], {}, { threshold: 0.8 }), null, 'a missing answer is not a verdict');
});

test('the critique entries read like the model’s: pass/fail per dimension, a concrete finding, issues that name the card; the numbers are Jev’s, the card text is not repeated', () => {
  const answers = over => Object.fromEntries(Object.keys(buildReviewRequest(DECK[0]).questions).map(id => [id, { type: 'noul', noul: over[id] ?? 0.95 }]));
  const accepted = critiqueFor(DECK[0], readReview(DECK[0], answers({}), { threshold: 0.8 }).value, 'en');
  assert.equal(accepted.check.cardId, 'c1');
  assert.deepEqual(accepted.issues, []);
  for (const id of ['selfContained', 'answerLeak', 'learningValue', 'sourceSupport', 'explanationQuality']) assert.equal(accepted.check[id], 'pass', id);
  assert.equal(accepted.check.optionQuality, 'na');
  assert.match(accepted.check.explanation, /Jev/);
  assert.ok(!accepted.check.explanation.includes(DECK[0].prompt));
  const rejected = critiqueFor(DECK[0], readReview(DECK[0], answers({ answerLeak: 0.03 }), { threshold: 0.8 }).value, 'en');
  assert.equal(rejected.check.answerLeak, 'fail');
  assert.ok(rejected.issues.some(issue => issue.startsWith('c1: answerLeak failed') && /Jev/.test(issue) && /97%/.test(issue)), rejected.issues.join('|'));
  assert.deepEqual(reviewIssues({ issues: accepted.issues, checks: [accepted.check] }, { cards: [DECK[0]] }), []);
  assert.ok(reviewIssues({ issues: rejected.issues, checks: [rejected.check] }, { cards: [DECK[0]] }).length >= 1);
});

/* ---- generateDeck: off, on, mixed, down ------------------------------------------------------------------------------- */

test('off: the call sequence is byte-identical to a run with no hook at all, whatever the hook does with the switch off', async t => {
  const plain = await harness(t);
  await plain.run();
  const baseline = plain.calls.map(call => [call.system, call.prompt]);
  assert.equal(plain.reviews().length, 1);
  for (const setup of [async () => {}, async () => saveJevSettings({ enabled: true }), async () => saveJevSettings({ key: plain.fake.key, confirm: true })]) {
    await setup();
    plain.calls.length = 0;
    // The hook factory of the pipeline: undefined unless the site is switched on.
    const hook = await jevReviewHook({ seam: { baseUrl: plain.fake.baseUrl, sleep: async () => {} }, language: 'en', experimental: true });
    assert.equal(hook, undefined);
    await plain.run({ jevReview: hook });
    assert.deepEqual(plain.calls.map(call => [call.system, call.prompt]), baseline);
  }
  assert.equal(plain.fake.requests.length, 0);
});

test('the pipeline hook is undefined unless the experimental features are shown AND the site is on, and then Jev is optional per call', async t => {
  const h = await harness(t);
  await h.open();
  const seam = { baseUrl: h.fake.baseUrl, sleep: async () => {}, random: () => 0 };
  assert.equal(await jevReviewHook({ seam, language: 'en', experimental: false }), undefined, 'hidden experimental features run nothing');
  assert.equal(typeof await jevReviewHook({ seam, language: 'en', experimental: true }), 'function');
  await saveJevSettings({ replace: { cardReview: false } });
  assert.equal(await jevReviewHook({ seam, language: 'en', experimental: true }), undefined);
});

test('on, every card confident: no model review call at all, the draft says Jev judged them, summary and provenance included', async t => {
  const h = await harness(t);
  await h.open();
  const draft = await h.run({ jevReview: h.hook() });
  assert.equal(h.reviews().length, 0, 'the independent model review was not needed');
  assert.equal(draft.cards.length, 3);
  const jev = draft.editorial.jevDecided;
  assert.deepEqual([jev.version, jev.site, jev.judged, jev.model, jev.accepted, jev.rejected, jev.fallback], [1, 'cardReview', 3, 0, 3, 0, null]);
  assert.deepEqual(Object.keys(jev.cards).sort(), draft.cards.map(item => item.id).sort());
  assert.ok(Object.values(jev.cards).every(entry => entry.verdict === 'accept'));
  assert.match(draft.editorial.summary, /Jev/);
  assert.match(draft.editorial.summary, /3/);
  assert.doesNotMatch(draft.editorial.summary, /^Independently approved/, 'the provenance is not rewritten as the model’s review');
  assert.equal(Object.keys(draft.editorial.reviewedCards).length, 3);
  assert.equal(h.fake.requests.length, 3, 'one tiny request per card');
});

test('on, one card rejected with confidence: it is dropped like a model-rejected card, with Jev named in the reason; the others are kept', async t => {
  const h = await harness(t, { markers: { cards: [DECK[0], card('c2', 'What does Bridge let two dimensions do? [c2] [fail answerLeak]', 'Objective two'), DECK[2]] } });
  await h.open();
  const draft = await h.run({ jevReview: h.hook() });
  assert.equal(h.reviews().length, 0);
  assert.equal(draft.cards.length, 2);
  assert.ok(!draft.cards.some(item => item.prompt.includes('[c2]')));
  assert.equal(draft.editorial.dropped, 1);
  assert.match(draft.editorial.omitted[0].reasons.join(' '), /Jev/);
  const jev = draft.editorial.jevDecided;
  assert.deepEqual([jev.judged, jev.accepted, jev.rejected, jev.model], [3, 2, 1, 0]);
  assert.equal(Object.keys(jev.cards).length, 2, 'provenance is kept for the cards that are in the draft');
});

test('on, one card unsure: ONE model review runs over just that card, the others are Jev’s; both appear in the draft with their own provenance', async t => {
  const h = await harness(t, { markers: { cards: [DECK[0], card('c2', 'What does Bridge let two dimensions do? [c2] [unsure sourceSupport]', 'Objective two'), DECK[2]] } });
  await h.open();
  const draft = await h.run({ jevReview: h.hook() });
  const reviews = h.reviews();
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviewedIds(reviews[0]), ['c2']);
  assert.equal(JSON.parse(reviews[0].prompt).count, 1);
  assert.equal(draft.cards.length, 3);
  const jev = draft.editorial.jevDecided;
  assert.deepEqual([jev.judged, jev.model, jev.accepted], [2, 1, 2]);
  assert.deepEqual(jev.fallback && [jev.fallback.reason, jev.fallback.count], ['low-confidence', 1]);
  assert.match(jev.fallback.message, /Jev/);
  assert.equal(Object.keys(jev.cards).length, 2, 'the model-reviewed card is not marked as Jev’s');
  assert.match(draft.editorial.summary, /Jev/);
});

test('on, the model’s verdict still counts for the cards it reviews: a card it rejects is dropped', async t => {
  const h = await harness(t, { markers: { cards: [DECK[0], card('c2', 'What does Bridge let two dimensions do? [c2] [unsure sourceSupport]', 'Objective two'), DECK[2]], reviewIssues: ['c2: answerLeak failed: the stem names the answer'] } });
  await h.open();
  const draft = await h.run({ jevReview: h.hook() });
  assert.equal(draft.cards.length, 2);
  assert.equal(draft.editorial.dropped, 1);
  assert.match(draft.editorial.omitted[0].reasons.join(' '), /names the answer/);
});

test('on, Jev unreachable or rejected: the model review is exactly the one a run without Jev makes (same prompt, same card set), and the draft says so once', async t => {
  const plain = await harness(t);
  await plain.run();
  const baseline = plain.reviews().map(call => [call.system, call.prompt]);
  for (const status of [401, 503]) {
    const h = await harness(t);
    await h.open();
    h.fake.fail(...Array(40).fill(status));
    const draft = await h.run({ jevReview: h.hook() });
    assert.deepEqual(h.reviews().map(call => [call.system, call.prompt]), baseline, `${status}: the same single review over the whole deck`);
    const jev = draft.editorial.jevDecided;
    assert.deepEqual([jev.judged, jev.model, jev.fallback.count], [0, 3, 3]);
    assert.equal(jev.fallback.reason, status === 401 ? 'invalid-key' : 'unavailable');
    assert.match(draft.editorial.summary, /Independently approved 3 questions/, 'with no Jev decision the usual wording stays');
  }
});

test('the line is the learner’s: at 90% a 85%-sure card goes to the model, at 80% Jev keeps it', async t => {
  const h = await harness(t, { markers: { cards: DECK.map((item, index) => index === 0 ? { ...item, prompt: `${item.prompt} [mid]` } : item) },
    serverOptions: { answer: (name, question, state) => ({ type: 'noul', noul: JSON.stringify(state).includes('[mid]') ? 0.85 : 0.97 }) } });
  await h.open();
  await h.run({ jevReview: h.hook({ threshold: 0.8 }) });
  assert.equal(h.reviews().length, 0);
  await h.run({ jevReview: h.hook({ threshold: 0.9 }) });
  assert.deepEqual(reviewedIds(h.reviews()[0]), ['c1']);
});

test('a failing model review keeps failing as before: the protocol error is not swallowed by the Jev layer', async t => {
  const h = await harness(t, { markers: { cards: [DECK[0], card('c2', 'Unsure one [c2] [unsure answerLeak]', 'Objective two'), DECK[2]] } });
  await h.open();
  const broken = async (system, prompt) => {
    if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify({ issues: [], summary: 'x', checks: [] });
    return withQualityStages(async () => JSON.stringify({ title: 'Bridge', cards: [DECK[0], card('c2', 'Unsure one [c2] [unsure answerLeak]', 'Objective two'), DECK[2]] }))(system, prompt);
  };
  await assert.rejects(generateDeck(broken, { sources: [source], count: 3, kind: 'flashcard', jevReview: h.hook() }), /Review protocol failed/);
});

test('the parts of a run merge into one record: counts add up, only the cards that stay are listed, ONE fallback notice for the whole run', () => {
  const part = (judged, model, cards, fallback) => ({ version: 1, site: 'cardReview', threshold: 0.8, language: 'en', provider: 'opencode-zen', judged, model, accepted: judged, rejected: 0,
    cards: Object.fromEntries(cards.map(id => [id, { verdict: 'accept', confidence: 0.9 }])), fallback });
  const merged = mergeJevDecided([part(4, 1, ['a', 'b', 'c', 'd'], { reason: 'low-confidence', count: 1, message: 'x' }), undefined, part(3, 2, ['e', 'f', 'g'], { reason: 'unavailable', count: 2, message: 'y' })], id => id !== 'b');
  assert.deepEqual([merged.judged, merged.model, merged.accepted], [7, 3, 7]);
  assert.deepEqual(Object.keys(merged.cards), ['a', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual([merged.fallback.reason, merged.fallback.count], ['low-confidence', 3]);
  assert.match(merged.fallback.message, /3 item\(s\)/);
  assert.equal(mergeJevDecided([part(1, 0, ['a'], null)]).fallback, null);
  assert.equal(mergeJevDecided([]), undefined);
});

test('tokens go to the card-review row of the Jev meter, apart from the study model', async t => {
  const h = await harness(t);
  await h.open();
  const meter = createJevUsage();
  await h.run({ jevReview: createReviewHook({ runtime: createJevRuntime({ baseUrl: h.fake.baseUrl, sleep: async () => {}, random: () => 0, usage: meter }), threshold: 0.8, language: 'en' }) });
  const summary = await meter.summary();
  assert.equal(summary.byFeature.cardReview.calls, 3);
  assert.equal(summary.byFeature.preReview, undefined);
});
