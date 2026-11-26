import test from 'node:test';
import assert from 'node:assert/strict';
import { blueprintPrompt, act1Prompt, act2Prompt, repairLessonPrompt } from '../lib/contexts/generation/companion/prompts.js';
import { createDraftRepair } from '../lib/contexts/generation/draft-repair.js';
import { LEAD_SOURCE_CHARS, REQUEST_DATA, GENERATION_SYSTEM, QUALITY_CRITERIA, REVIEW_SEVERITY_CRITERIA, leadsWithSources, promptSources, stageRequest, stageSystem } from '../lib/prompt-order.js';
import { CODE_STYLE } from '../lib/notation.js';
import { planPrompts, blueprintPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { patchPrompts } from '../lib/generation-yield.js';
import { caseAuthorPrompt, caseCriteriaPrompt } from '../lib/case-study.js';
import { mapPrompt } from '../lib/contexts/generation/outline/prompts.js';
import { translationPrompt } from '../lib/passage-translation.js';
import { writeRewrite } from '../lib/coach.js';
import { createAssistService } from '../lib/assist.js';
import { createAssistChildren } from '../lib/assist-child.js';
import { qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';

const lcp = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
};

const fillText = (tag, size) =>
  Array.from({ length: Math.ceil(size / 40) }, (_, i) => `Sentence ${i} of ${tag}: mechanism ${i} holds under condition ${i % 5}.`).join(' ').slice(0, size);

/* ---------- 1. Companion Lesson ---------- */

test('companion prompts lead with shared static spec at byte 0 across blueprint, act1, act2, and repair; act2 places materials & blueprint before volatile fields', () => {
  const plan = {
    course: 'Control Systems',
    topic: 'Critical Damping',
    archetype: 'sandbox',
    language: 'en',
    grounded: true,
    excerpts: [{ id: 's1', title: 'Lecture 4', text: fillText('control', 3000) }],
  };
  const blueprint = {
    id: 'critical-damping',
    archetype: 'sandbox',
    title: 'Why does zeta = 1 collapse the naive solution?',
    act1Slides: [{ slide: 1, beat: 'open', title: 'Puzzle' }],
    act2Slides: [{ slide: 9, beat: 'fix', title: 'Secular term' }],
  };
  const act1Slides = [
    { beat: 'predict', title: 'Predict', blocks: [{ t: 'predict', id: 'pred-1', q: 'What happens at zeta=1?' }] },
  ];

  const bp = blueprintPrompt(plan);
  const a1 = act1Prompt(plan, blueprint);
  const a2 = act2Prompt(plan, blueprint, act1Slides);
  const rep = repairLessonPrompt({ id: 'critical-damping', slides: act1Slides }, ['slide 1: fix answerLines'], 'en');

  // Blueprint shares DISCIPLINE_MICRO_BLUEPRINTS + VOICE_MANDATES at byte 0 with Act I, Act II, and Repair.
  for (const [name, prompt] of [['act1', a1], ['act2', a2], ['repair', rep]]) {
    const sharedWithBp = lcp(bp.system, prompt.system);
    assert.ok(sharedWithBp >= 3000, `blueprint and ${name} must share leading static pedagogy spec (got ${sharedWithBp})`);
  }

  // Act I, Act II, and Repair share the full static spec including BLOCK_SPEC_REFERENCE (> 10k chars).
  assert.ok(lcp(a1.system, a2.system) > 10000, `act1 and act2 must share >10k leading system spec (got ${lcp(a1.system, a2.system)})`);
  assert.ok(lcp(a2.system, rep.system) > 10000, `act2 and repair must share >10k leading system spec (got ${lcp(a2.system, rep.system)})`);
  assert.ok(a1.system.startsWith('DISCIPLINE-SPECIFIC MICRO-BLUEPRINTS'));
  assert.ok(a2.system.startsWith('DISCIPLINE-SPECIFIC MICRO-BLUEPRINTS'));
  assert.ok(rep.system.startsWith('DISCIPLINE-SPECIFIC MICRO-BLUEPRINTS'));

  // Act II user prompt places stable materials & blueprint before volatile priorSlidesSummary & existingPredictIds (stage instructions follow JSON).
  const a1Json = a1.prompt.split('\n\n')[0];
  const a2Json = a2.prompt.split('\n\n')[0];
  const a2Keys = Object.keys(JSON.parse(a2Json));
  assert.ok(a2Keys.indexOf('materials') < a2Keys.indexOf('priorSlidesSummary'), `materials before priorSlidesSummary: ${a2Keys.join(',')}`);
  assert.ok(a2Keys.indexOf('blueprint') < a2Keys.indexOf('priorSlidesSummary'), `blueprint before priorSlidesSummary: ${a2Keys.join(',')}`);
  assert.ok(a2Keys.indexOf('blueprint') < a2Keys.indexOf('existingPredictIds'), `blueprint before existingPredictIds: ${a2Keys.join(',')}`);
  // Act I JSON payload (up to closing brace) is an exact prefix of Act II user prompt.
  assert.ok(a2.prompt.startsWith(a1Json.slice(0, -1)), 'act1 JSON payload must be a prefix of act2 user prompt');
});

/* ---------- 2 & 3 & 4. S1-S4 + patchPrompts + leadsWithSources ---------- */

test('S1-S4 and patchPrompts share canonical before key order, move review task/scope after before, and share sources+before+references prefix', () => {
  const bigSources = [{ id: 's1', title: 'Notes', text: fillText('db', LEAD_SOURCE_CHARS + 1500) }];
  const refs = [{ id: 'ref1', title: 'Past exam', text: fillText('exam', 2500) }];
  const request = {
    kind: 'quiz',
    difficulty: 'intermediate',
    language: 'English',
    focus: 'isolation levels',
    focusTopics: ['MVCC', 'Phantom reads'],
    constraints: { hintNoAnswer: true },
    role: 'backend engineer',
    sources: bigSources,
    questionReferences: refs,
    referenceFormat: 'balanced',
    count: 2,
    existing: ['Old target'],
  };
  const assessmentPlan = {
    targets: [{ targetId: 'target-1', objective: 'Explain MVCC', knowledge: 'MVCC uses snapshots', citations: [{ sourceId: 's1', quote: 'Sentence 0 of db: mechanism 0 holds under condition 0.' }] }],
  };
  const answerBlueprint = {
    items: [{ targetId: 'target-1', answer: 'Snapshot isolation', reasoning: 'Reads a consistent snapshot', comparisonAxis: 'isolation', scenario: { kind: 'none', facts: [], decisiveConditions: [] } }],
  };
  const deck = {
    title: 'DB',
    cards: [{ id: 'q1', targetId: 'target-1', kind: 'quiz', topic: 'MVCC', prompt: 'Which mechanism avoids read locks?', answer: 'Snapshot isolation', hint: 'Think versions.', explanation: 'Snapshots avoid blocking reads.', misconception: '2PL' }],
  };

  const s1 = planPrompts(request);
  const s2 = blueprintPrompts(request, assessmentPlan);
  const s3 = authorPrompts(request, assessmentPlan, answerBlueprint);
  const s4 = reviewPrompts({
    sources: bigSources,
    deck,
    kind: request.kind,
    count: 1,
    structuralErrors: [],
    role: request.role,
    difficulty: request.difficulty,
    focus: request.focus,
    focusTopics: request.focusTopics,
    constraints: request.constraints,
    language: request.language,
    questionReferences: request.questionReferences,
    referenceFormat: request.referenceFormat,
    assessmentPlan,
    answerBlueprint,
  });
  const patch = patchPrompts({
    entries: [{ card: deck.cards[0], issues: ['q1: explanationQuality failed'], item: answerBlueprint.items[0], fields: new Set(['explanation']) }],
    sources: bigSources,
    kind: request.kind,
    difficulty: request.difficulty,
    language: request.language,
    focus: request.focus,
    focusTopics: request.focusTopics,
    constraints: request.constraints,
    role: request.role,
    questionReferences: request.questionReferences,
    referenceFormat: request.referenceFormat,
  });

  // Verify exact canonical leading key order right after `sources`.
  const expectedShared = ['sources', 'kind', 'difficulty', 'language', 'focus', 'focusTopics', 'constraints', 'role'];
  for (const [name, text] of [['plan', s1.prompt], ['blueprint', s2.prompt], ['author', s3.prompt], ['review', s4.payload], ['patch', patch.prompt]]) {
    const keys = Object.keys(requestData(text));
    assert.deepEqual(keys.slice(0, expectedShared.length), expectedShared, `${name} must match canonical leading key order (got ${keys.join(',')})`);
  }

  // Review includes language in before, and moves task & scope AFTER referenceQuestions/referenceInstruction.
  const reviewKeys = Object.keys(requestData(s4.payload));
  assert.ok(reviewKeys.indexOf('referenceInstruction') < reviewKeys.indexOf('task'), `review task must follow referenceInstruction: ${reviewKeys.join(',')}`);
  assert.ok(reviewKeys.indexOf('task') < reviewKeys.indexOf('scope'), `review task before scope: ${reviewKeys.join(',')}`);
  assert.equal(reviewKeys.at(-1), 'count', 'review count stays last');

  // Sent via stageRequest: all five stages use GENERATION_SYSTEM (sources stay in prompt, not system).
  const sent = {
    plan: stageRequest(s1.system, s1.prompt),
    blueprint: stageRequest(s2.system, s2.prompt),
    author: stageRequest(s3.system, s3.prompt),
    review: stageRequest(s4.system, s4.payload),
    patch: stageRequest(patch.system, patch.prompt),
  };
  // Hoisted static rubric in GENERATION_SYSTEM clears Anthropic's 1,024-token (~4,096-char) system[0] auto-cache threshold
  // and is deduplicated out of leading-source stage prompt bodies.
  assert.ok(GENERATION_SYSTEM.length >= 4096, `GENERATION_SYSTEM must be >= 4,096 chars (got ${GENERATION_SYSTEM.length})`);
  assert.ok(GENERATION_SYSTEM.includes(QUALITY_CRITERIA), 'GENERATION_SYSTEM hoists QUALITY_CRITERIA');
  assert.ok(GENERATION_SYSTEM.includes(REVIEW_SEVERITY_CRITERIA), 'GENERATION_SYSTEM hoists REVIEW_SEVERITY_CRITERIA');
  assert.ok(GENERATION_SYSTEM.includes(CODE_STYLE), 'GENERATION_SYSTEM hoists CODE_STYLE');
  assert.equal(sent.author.prompt.includes(QUALITY_CRITERIA), false, 'S3 prompt omits duplicated QUALITY_CRITERIA when sources lead');
  assert.equal(sent.author.prompt.includes(CODE_STYLE), false, 'S3 prompt omits duplicated CODE_STYLE when sources lead');
  assert.equal(sent.review.prompt.includes(QUALITY_CRITERIA), false, 'S4 prompt omits duplicated QUALITY_CRITERIA when sources lead');
  assert.equal(sent.review.prompt.includes(REVIEW_SEVERITY_CRITERIA), false, 'S4 prompt omits duplicated REVIEW_SEVERITY_CRITERIA when sources lead');
  assert.equal(sent.patch.prompt.includes(CODE_STYLE), false, 'patch prompt omits duplicated CODE_STYLE when sources lead');
  for (const [name, req] of Object.entries(sent)) {
    const originalSystem = { plan: s1.system, blueprint: s2.system, author: s3.system, review: s4.system, patch: patch.system }[name];
    assert.equal(req.system, GENERATION_SYSTEM, `${name} uses shared GENERATION_SYSTEM`);
    assert.ok(!req.system.includes('Sentence 0 of db'), `${name} never moves untrusted sources into system`);
    const recovered = stageSystem(req.system, req.prompt);
    const expectedSystem = originalSystem.replace(REVIEW_SEVERITY_CRITERIA, 'Apply the shared severity rules from the system prompt.');
    if (expectedSystem.includes('\n\n')) assert.ok(expectedSystem.startsWith(recovered), `${name} stageSystem recovers leading paragraph of original system`);
    else assert.equal(recovered, expectedSystem, `${name} stageSystem recovers stage system`);
    assert.deepEqual(stageRequest(req.system, req.prompt), req, `${name} stageRequest is idempotent`);
    assert.deepEqual(requestData(req.prompt).sources, bigSources, `${name} requestData preserves sources`);
  }

  // S1 -> S2 -> S3 share sources + full shared before block.
  const sharedBeforeMarker = `${REQUEST_DATA}${JSON.stringify({
    sources: bigSources,
    kind: request.kind,
    difficulty: request.difficulty,
    language: request.language,
    focus: request.focus,
    focusTopics: request.focusTopics,
    constraints: request.constraints,
    role: request.role,
  }).slice(0, -1)}`;
  assert.ok(lcp(sent.plan.prompt, sent.blueprint.prompt) >= sharedBeforeMarker.length, 'S1 and S2 share sources + all shared before fields');
  assert.ok(lcp(sent.blueprint.prompt, sent.author.prompt) >= sharedBeforeMarker.length, 'S2 and S3 share sources + all shared before fields');

  // S3 -> S4 -> Patch share sources + before + full questionReferences block!
  const refEndIdx = sent.author.prompt.indexOf('"assessmentPlan"');
  assert.ok(refEndIdx > sharedBeforeMarker.length + 2000, 'author prompt includes large reference block before assessmentPlan');
  assert.ok(lcp(sent.author.prompt, sent.review.prompt) >= refEndIdx, `S3 and S4 share sources+before+references (${lcp(sent.author.prompt, sent.review.prompt)} >= ${refEndIdx})`);
  assert.ok(lcp(sent.author.prompt, sent.patch.prompt) >= refEndIdx, `S3 and patch share sources+before+references (${lcp(sent.author.prompt, sent.patch.prompt)} >= ${refEndIdx})`);
  assert.ok(lcp(sent.review.prompt, sent.patch.prompt) >= refEndIdx, `S4 and patch share sources+before+references (${lcp(sent.review.prompt, sent.patch.prompt)} >= ${refEndIdx})`);
});

test('leadsWithSources accounts for sources + shared before (including questionReferences) without breaking 1-arg backward compatibility', () => {
  const mediumSources = [{ id: 'm1', title: 'Short chapter', text: fillText('med', 2400) }];
  const bigRefs = [{ id: 'r1', title: 'Sample bank', text: fillText('sample', 2200) }];
  assert.ok(JSON.stringify(mediumSources).length < LEAD_SOURCE_CHARS, 'sources alone are below LEAD_SOURCE_CHARS');
  assert.equal(leadsWithSources(mediumSources), false, '1-arg leadsWithSources preserves backward-compatible sources-only check');
  assert.equal(leadsWithSources(mediumSources, { referenceQuestions: bigRefs }), true, '2-arg leadsWithSources enables sources-first when sources + before exceed threshold');
  assert.equal(leadsWithSources([], { referenceQuestions: bigRefs }), false, 'empty sources never lead');

  const request = {
    kind: 'quiz',
    difficulty: 'mixed',
    language: 'English',
    focus: 'caching',
    constraints: { hintNoAnswer: true },
    role: '',
    sources: mediumSources,
    questionReferences: bigRefs,
    referenceFormat: 'balanced',
    count: 1,
  };
  const plan = { targets: [{ targetId: 'target-1', objective: 'Obj', knowledge: 'Know', citations: [] }] };
  const bp = { items: [{ targetId: 'target-1', answer: 'Ans', reasoning: 'Why', comparisonAxis: 'axis', scenario: { kind: 'none', facts: [], decisiveConditions: [] } }] };
  const deck = { title: 'D', cards: [{ id: 'q1', targetId: 'target-1', kind: 'quiz', topic: 'T', prompt: 'P?', answer: 'Ans' }] };

  const a = authorPrompts(request, plan, bp);
  const r = reviewPrompts({ ...request, deck, structuralErrors: [], assessmentPlan: plan, answerBlueprint: bp });
  const p = patchPrompts({ entries: [{ card: deck.cards[0], issues: ['q1: explanationQuality failed'], item: bp.items[0], fields: new Set(['explanation']) }], ...request });

  assert.ok(a.prompt.startsWith(`${REQUEST_DATA}{"sources":`), 'author leads with sources when sources+references > 4000');
  assert.ok(r.payload.startsWith(`${REQUEST_DATA}{"sources":`), 'review leads with sources when sources+references > 4000');
  assert.ok(p.prompt.startsWith(`${REQUEST_DATA}{"sources":`), 'patch leads with sources when sources+references > 4000');
  assert.ok(lcp(a.prompt, r.payload) > LEAD_SOURCE_CHARS, 'author and review share > 4000 chars prefix');
  assert.ok(lcp(r.payload, p.prompt) > LEAD_SOURCE_CHARS, 'review and patch share > 4000 chars prefix');
});

test('promptSources strips raw storage/audio/PDF metadata without mutating callers, and leadsWithSources measures stripped payload', () => {
  const raw = [{
    id: 'a1',
    title: 'Lecture 1',
    text: 'Short transcript body.',
    section: 'sec-1',
    audio: { corrections: Array.from({ length: 80 }, (_, i) => ({ from: `typo${i}`, to: `fixed${i}`, at: i * 10 })) },
    createdAt: '2026-10-01T00:00:00Z',
    importedAt: '2026-10-01T00:00:00Z',
    courses: ['CS3211'],
    provenance: 'audio-import',
    document: { pages: 42, hash: 'deadbeef' },
  }];
  const snapshot = structuredClone(raw);
  const clean = promptSources(raw);
  assert.deepEqual(clean, [{ id: 'a1', title: 'Lecture 1', text: 'Short transcript body.', section: 'sec-1' }]);
  assert.deepEqual(raw, snapshot, 'caller source objects are never mutated');
  assert.equal(leadsWithSources(raw), false, 'bloated metadata does not falsely trigger leadsWithSources');

  const plan = planPrompts({ sources: raw, count: 1, kind: 'quiz' });
  assert.deepEqual(requestData(plan.prompt).sources, clean, 'stagePrompt serializes only promptSources fields');
  assert.equal(plan.prompt.includes('corrections'), false, 'audio.corrections never leaks into prompt');
  assert.equal(plan.prompt.includes('deadbeef'), false, 'PDF document metadata never leaks into prompt');

  const review = reviewPrompts({ sources: raw, deck: { title: 'D', cards: [] }, kind: 'quiz', count: 0 });
  assert.deepEqual(requestData(review.payload).sources, clean, 'dataPayload serializes only promptSources fields');
  assert.equal(review.payload.includes('audio-import'), false, 'provenance never leaks into review payload');
});

test('patchPrompts omits questionReferences when citedSources shrinks sources below sourcePoolSize and avoids duplicating identical options', () => {
  const s1 = { id: 's1', title: 'Part 1', text: fillText('p1', 2500) };
  const s2 = { id: 's2', title: 'Part 2', text: fillText('p2', 2500) };
  const refs = [{ id: 'ref1', title: 'Exam bank', text: fillText('refbank', 3000) }];
  const options = [
    { id: 'a', text: 'Correct choice', correct: true, explanation: 'Why a' },
    { id: 'b', text: 'Wrong choice', correct: false, explanation: 'Why b' },
    { id: 'c', text: 'Another wrong', correct: false, explanation: 'Why c' },
  ];
  const entry = {
    card: { id: 'q1', kind: 'quiz', topic: 'T', prompt: 'P?', hint: 'H', explanation: 'E', misconception: 'M', options },
    issues: ['q1: optionQuality failed'],
    item: { answer: 'Correct choice', options: structuredClone(options), reasoning: 'R', scenario: { kind: 'none', facts: [], decisiveConditions: [] } },
    fields: new Set(['options']),
  };

  const full = patchPrompts({ entries: [entry], sources: [s1, s2], sourcePoolSize: 2, kind: 'quiz', questionReferences: refs, referenceFormat: 'balanced' });
  const shrunk = patchPrompts({ entries: [entry], sources: [s1], sourcePoolSize: 2, kind: 'quiz', questionReferences: refs, referenceFormat: 'balanced' });
  const fullData = requestData(full.prompt);
  const shrunkData = requestData(shrunk.prompt);

  assert.ok(Array.isArray(fullData.referenceQuestions) && fullData.referenceQuestions.length === 1, 'full pool keeps questionReferences for shared cache prefix');
  assert.equal(shrunkData.referenceQuestions, undefined, 'shrunk citedSources omits questionReferences to avoid uncached token blowup');
  assert.equal(shrunk.prompt.includes('refbank'), false, 'omitted references text absent from shrunk patch prompt');
  assert.deepEqual(fullData.cards[0].options, options, 'card carries options when options is in allowed fields');
  assert.equal(fullData.cards[0].blueprint.options, undefined, 'identical options are not duplicated on blueprint');
});

/* ---------- 5a. Draft Repair ---------- */

test('draft-repair shares GENERATION_SYSTEM + sources + before + references with reviewDeck, scopes otherQuestions to top 25, strips source metadata, and merges { patch }', async () => {
  const source = {
    id: 's',
    title: 'Notes',
    text: fillText('arch', 3200),
    audio: { corrections: [{ from: 'archt', to: 'arch' }] },
    provenance: 'audio-import',
  };
  const ref = { id: 'r1', title: 'Sample exam', text: fillText('ref', 1200) };
  const makeCard = (id, n, objective = `Explain principle ${n} of arch mechanism`) => ({
    id,
    kind: 'flashcard',
    topic: `Principle ${n}`,
    objective,
    prompt: `What guides design choice ${n}?`,
    answer: `Principle ${n} guides system evolution.`,
    hint: `Focus on evolution rule ${n}.`,
    explanation: `Original explanation ${n}.`,
    misconception: `Confusing principle ${n} with layout.`,
    citations: [{ sourceId: 's', quote: source.text.slice(0, 60) }],
  });
  // Mix 15 unrelated siblings ahead of 25 relevant siblings to prove scopeExisting ranks relevant objectives into the 25-entry cap (not blind slicing).
  const unrelatedSiblings = Array.from({ length: 15 }, (_, i) => makeCard(`unrel-${i}`, i + 100, `Unrelated botany chlorophyll specimen ${i}`));
  const relevantSiblings = Array.from({ length: 25 }, (_, i) => makeCard(`sib-${i}`, i + 10, `Sibling objective ${i} mechanism arch condition`));
  const siblings = [...unrelatedSiblings, ...relevantSiblings];
  let state = {
    sources: [source, ref],
    decks: [],
    drafts: [{
      id: 'd',
      draftVersion: 1,
      title: 'Architecture',
      cards: [makeCard('a', 1), makeCard('b', 2), ...siblings],
      editorial: {
        generation: { sourceIds: ['s'], referenceSourceIds: ['r1'], kind: 'flashcard', constraints: { hintNoAnswer: true } },
        rejectedIssues: { a: ['explanationQuality failed'], b: ['explanationQuality failed'] },
        reviewedCards: {},
      },
    }],
    settings: {},
  };
  const repairCalls = [], reviewCalls = [];
  const ask = async (system, prompt) => {
    const ordered = stageRequest(system, prompt);
    const head = stageSystem(ordered.system, ordered.prompt);
    if (head.startsWith('Repair one draft card')) {
      const data = requestData(ordered.prompt);
      repairCalls.push({ system: ordered.system, prompt: ordered.prompt, data });
      // Return slim { patch } for card 'a' and legacy full { card } for card 'b' to prove both work seamlessly.
      if (data.card.id === 'a') return JSON.stringify({ patch: { explanation: `Patched: ${data.card.explanation}` } });
      return JSON.stringify({ card: { ...data.card, explanation: `Fixed: ${data.card.explanation}` } });
    }
    if (head.startsWith('Act as a strict')) {
      const data = requestData(ordered.prompt);
      reviewCalls.push({ system: ordered.system, prompt: ordered.prompt, data });
      return JSON.stringify(qualityReview(data.candidate));
    }
    throw new Error(`unexpected system: ${head.slice(0, 60)}`);
  };

  let donePromise;
  const work = {
    jobs: new Map(),
    generationControllers: new Map(),
    jobControls: new Map(),
    jobOutputs: { open() {}, close() {}, append() {}, appendReasoning() {}, endJob() {} },
    generationMessengers: new Map(),
  };
  const queue = { run: (_root, _id, fn) => { donePromise = Promise.resolve().then(fn); } };
  const repair = createDraftRepair({
    state: { root: 'mem', read: async () => structuredClone(state) },
    call: async (action, args) => {
      if (action === 'draft.save') {
        state = { ...state, drafts: [{ ...args.deck, draftVersion: state.drafts[0].draftVersion + 1 }] };
        return state.drafts[0];
      }
      throw new Error(`unexpected action: ${action}`);
    },
    announceJob: () => {},
    complete: ask,
    language: 'en',
    work,
    jobServices: { activeJob: () => false, pruneJobs: () => {} },
    offersModel: false,
  }, { env: { queue, work, workOwner: 'test', ask, askLight: ask, currentModel: () => null, feature: 'generate' }, managed: false });

  await repair.start({ id: 'd', draftVersion: 1 });
  await donePromise;

  assert.equal(repairCalls.length, 2);
  assert.equal(reviewCalls.length, 2);
  assert.ok(repairCalls[0].prompt.startsWith(`${REQUEST_DATA}{"sources":`), 'repair payload leads with REQUEST_DATA sources block (dataPayload)');
  const keys = Object.keys(repairCalls[0].data);
  const expectedShared = ['sources', 'kind', 'difficulty', 'language', 'focus', 'constraints', 'role', 'referenceQuestions'];
  assert.deepEqual(keys.slice(0, expectedShared.length), expectedShared, `repair payload follows canonical sharedBefore key order (got ${keys.join(',')})`);
  assert.ok(keys.indexOf('sources') < keys.indexOf('card'), `sources before card: ${keys.join(',')}`);
  assert.ok(keys.indexOf('referenceQuestions') < keys.indexOf('card'), `referenceQuestions before card: ${keys.join(',')}`);
  assert.ok(keys.indexOf('otherQuestions') < keys.indexOf('card'), `otherQuestions before card: ${keys.join(',')}`);
  assert.ok(keys.indexOf('card') < keys.indexOf('issues'), `card before issues: ${keys.join(',')}`);

  // Metadata stripped and otherQuestions capped at 25 relevant `{ objective }` objects (no `prompt`, unrelated excluded).
  assert.deepEqual(repairCalls[0].data.sources, [{ id: 's', title: 'Notes', text: source.text }]);
  assert.equal(repairCalls[0].prompt.includes('audio-import'), false, 'provenance metadata stripped from repair prompt');
  assert.equal(repairCalls[0].prompt.includes('corrections'), false, 'audio.corrections metadata stripped from repair prompt');
  assert.equal(repairCalls[0].data.otherQuestions.length, 25, 'otherQuestions capped at 25 relevant objectives');
  assert.ok(repairCalls[0].data.otherQuestions.every((item) => typeof item.objective === 'string' && !Object.hasOwn(item, 'prompt')), 'otherQuestions carries objective only');
  assert.ok(repairCalls[0].data.otherQuestions.every((item) => !item.objective.startsWith('Unrelated botany')), 'scopeExisting excludes unrelated siblings when 25 relevant objectives match sources');

  // Repair and reviewDeck share byte-identical GENERATION_SYSTEM AND sources + before + questionReferences prefix!
  assert.equal(repairCalls[0].system, GENERATION_SYSTEM, 'repair uses hoisted GENERATION_SYSTEM');
  assert.equal(reviewCalls[0].system, GENERATION_SYSTEM, 'reviewDeck uses hoisted GENERATION_SYSTEM');
  const sharedRefEnd = repairCalls[0].prompt.indexOf('"task":');
  assert.ok(sharedRefEnd > 4000, `repair prompt leads with >4000 chars of sources + before + references (${sharedRefEnd})`);
  assert.ok(lcp(repairCalls[0].prompt, reviewCalls[0].prompt) >= sharedRefEnd, `repair and reviewDeck share full sources + before + references prefix (${lcp(repairCalls[0].prompt, reviewCalls[0].prompt)} >= ${sharedRefEnd})`);
  assert.ok(lcp(repairCalls[0].prompt, repairCalls[1].prompt) >= sharedRefEnd, `two repaired cards share sources + before + references prefix`);

  // Both { patch } and { card } saved cleanly.
  const finalCards = state.drafts[0].cards;
  assert.match(finalCards.find((c) => c.id === 'a').explanation, /^Patched:/, '{ patch } merged onto current card');
  assert.match(finalCards.find((c) => c.id === 'b').explanation, /^Fixed:/, '{ card } fallback preserved');
});

/* ---------- 5b. Case Study Retry ---------- */

test('case-study repair appends repair rule after schema and data so attempt 1 prompt is a prefix of repair prompt', () => {
  const sources = [{ id: 's1', title: 'Course', text: fillText('case', 4500) }];
  const baseReq = { language: 'English', questions: 2, totalMarks: 20, focusTopics: ['Storage'], sources };
  const firstAuthor = caseAuthorPrompt(baseReq);
  const repairAuthor = caseAuthorPrompt({ ...baseReq, repair: { previous: { title: 'Draft' }, issues: ['q1: marks mismatch'] } });
  assert.equal(firstAuthor.system, repairAuthor.system);
  assert.ok(repairAuthor.prompt.startsWith(firstAuthor.prompt.slice(0, -1)), 'caseAuthorPrompt attempt 1 must be a prefix of repair attempt');
  assert.ok(repairAuthor.prompt.endsWith('Revise the previous paper to fix every issue in repair.issues; keep what was sound.'));

  const baseCriteria = { scenario: fillText('scenario', 2000), questions: [{ prompt: 'Design storage', marks: 10 }], sources, language: 'English' };
  const firstCriteria = caseCriteriaPrompt(baseCriteria);
  const repairCriteria = caseCriteriaPrompt({ ...baseCriteria, repair: { previous: {}, issues: ['q1: missing criteria'] } });
  assert.equal(firstCriteria.system, repairCriteria.system);
  assert.ok(repairCriteria.prompt.startsWith(firstCriteria.prompt.slice(0, -1)), 'caseCriteriaPrompt attempt 1 must be a prefix of repair attempt');
  assert.ok(repairCriteria.prompt.endsWith('Revise the previous reply to fix every issue in repair.issues.'));
});

/* ---------- 5c. Outline Map Prompts ---------- */

test('outline mapPrompt places shared language and syllabus before varying part number', () => {
  const plan = { language: 'zh', syllabus: { text: fillText('syllabus', 3500) }, described: { units: [] }, batches: [{ number: 1 }, { number: 2 }] };
  const p1 = mapPrompt({ number: 1, descriptors: [{ id: 'm1', title: 'Lecture 1' }] }, plan);
  const p2 = mapPrompt({ number: 2, descriptors: [{ id: 'm2', title: 'Lecture 2' }] }, plan);
  assert.equal(p1.system, p2.system);
  const keys = Object.keys(requestData(p1.prompt));
  assert.ok(keys.indexOf('language') < keys.indexOf('part'), `language before part: ${keys.join(',')}`);
  assert.ok(keys.indexOf('syllabus') < keys.indexOf('part'), `syllabus before part: ${keys.join(',')}`);
  assert.ok(lcp(p1.prompt, p2.prompt) > 3500, 'part 1 and part 2 share rules + language + syllabus prefix');
});

/* ---------- 5d. Assist / Passage Translation / Coach Retry ---------- */

test('passage-translation retry keeps system byte-identical and appends retryNote at the end of JSON prompt', () => {
  const args = { target: 'zh', title: 'Distributed Systems', passages: [{ id: 'p1', text: fillText('trans', 2500) }] };
  const first = translationPrompt(args);
  const retry = translationPrompt({ ...args, retry: 'refusal' });
  assert.equal(first.system, retry.system, 'translation retry must not mutate system');
  assert.ok(retry.prompt.startsWith(first.prompt.slice(0, -1)), 'translation attempt 1 prompt is a prefix of retry prompt');
  const parsed = JSON.parse(retry.prompt);
  assert.equal(Object.keys(parsed).at(-1), 'retryNote');
  assert.match(parsed.retryNote, /rejected \(refusal\)/);
});

test('coach writeRewrite keeps system byte-identical and places previousPatchRejected after evidence and learner', async () => {
  const calls = [];
  const complete = async (system, prompt) => {
    calls.push({ system, prompt, data: JSON.parse(prompt) });
    return JSON.stringify({ patch: { hint: 'Check ownership.' }, summary: 'Clarified hint.' });
  };
  const card = { id: 'c1', kind: 'flashcard', topic: 'Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Hint', explanation: 'Exp', misconception: 'Misc', citations: [] };
  const evidence = [{ sourceId: 's1', title: 'Notes', text: fillText('bridge', 3000) }];
  const commonArgs = { card, deck: { id: 'd1', title: 'Patterns' }, tags: ['stem-vague'], evidence, learner: { goal: 'exam', summary: 'Studying patterns' }, language: 'en' };
  await writeRewrite(complete, commonArgs);
  await writeRewrite(complete, { ...commonArgs, errors: 'Hint still mentions abstraction' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].system, calls[1].system, 'coach rewrite retry must not mutate system');
  const retryKeys = Object.keys(calls[1].data);
  assert.ok(retryKeys.indexOf('evidence') < retryKeys.indexOf('previousPatchRejected'), `evidence before previousPatchRejected: ${retryKeys.join(',')}`);
  assert.ok(retryKeys.indexOf('learner') < retryKeys.indexOf('previousPatchRejected'), `learner before previousPatchRejected: ${retryKeys.join(',')}`);
  assert.ok(calls[1].prompt.startsWith(calls[0].prompt.slice(0, -1)), 'coach rewrite attempt 1 prompt is an exact prefix of retry prompt');
});

test('assist retry keeps system byte-identical and appends refusal instructions after the original payload', async t => {
  const children = createAssistChildren();
  const assist = createAssistService({ children });
  t.after(() => assist.dispose());

  const evidenceText = fillText('bridge', 2500);
  const card = {
    id: 'c',
    kind: 'flashcard',
    topic: 'Bridge',
    objective: 'Explain Bridge',
    prompt: 'What does Bridge separate?',
    answer: 'Abstraction and implementation.',
    hint: 'Two dimensions.',
    explanation: 'Both vary independently.',
    misconception: 'Adapts interfaces.',
    citations: [{ sourceId: 's', quote: evidenceText.slice(0, 60) }],
  };
  const state = {
    sources: [{ id: 's', title: 'Lecture', text: evidenceText }],
    decks: [{ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(card)] }],
    runs: [],
    settings: {},
  };
  const seen = [];
  const service = {
    store: { read: async () => structuredClone(state) },
    complete: async (system, payload) => {
      seen.push({ system, payload });
      if (seen.length === 1) return JSON.stringify({ patch: { prompt: 'Bridge separates {{blank}}.' }, reason: 'Broken cloze' });
      return JSON.stringify({ patch: { prompt: 'Which two dimensions does Bridge separate?' }, reason: 'Fixed' });
    },
    saveAssistResult: async ({ result }) => {
      if (result?.patch?.prompt?.includes('{{')) throw new Error('Cannot put cloze blanks in a flashcard stem');
      return { message: 'Saved' };
    },
  };

  await assist.startAssist({}, {
    root: 'mem',
    service,
    sessionId: 'parent',
    mode: 'improve',
    ref: { deckId: 'd', cardId: 'c' },
    text: 'Clarify the stem',
    helpChoices: [],
    card,
    deckTitle: 'Patterns',
    route: { provider: 'p', model: 'm' },
  });
  for (let i = 0; i < 200; i++) {
    const task = assist.assistView('mem').tasks.at(-1);
    if (task?.status !== 'running') break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(assist.assistView('mem').tasks.at(-1).status, 'done');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].system, seen[1].system, 'assist retry must not mutate system');
  assert.ok(seen[1].payload.startsWith(seen[0].payload), 'assist retry payload must keep attempt 1 payload as an exact prefix');
  assert.match(seen[1].payload, /refused by the validator/);
  assert.match(seen[1].payload, /REFUSED_REPLY/);
});
