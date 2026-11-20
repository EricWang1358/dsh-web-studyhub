import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StudyService } from '../lib/service.js';
import { buildCompactScene, MAX_SCENE_BYTES } from '../lib/study-scene.js';
import { projectTrapLedger } from '../lib/contexts/study/trap-projection.js';
import { pointEvidenceForCard } from '../lib/evidence/course-evidence.js';
import {
  COURSE_NOTES_PROVENANCE,
  COURSE_BOOK_DOC_PROVENANCE,
} from '../lib/exam-point-list.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { qaBlock } from '../lib/course-book-qa-text.js';

const CANARIES = {
  refAnswer: 'SECRET_REF_ANSWER_CANARY_991',
  explanation: 'SECRET_EXPLANATION_CANARY_992',
  followupAnswer: 'SECRET_FOLLOWUP_ANS_CANARY_993',
  bookQaAnswer: 'SECRET_BOOK_QA_ANS_CANARY_994',
  answerCardConclusion: 'SECRET_ANSWERCARD_CONCLUSION_CANARY_995',
  catchupAnswer: 'SECRET_CATCHUP_ANS_CANARY_996',
  doubtAnswer: 'SECRET_DOUBT_ANS_CANARY_997',
  confusableDiff: 'SECRET_CONFUSABLE_DIFF_CANARY_998',
};

function buildRichFixture() {
  const course = 'Probability';
  const sourceText = '# Conditional & Bayes\nConditional probability P(A|B) = P(A and B)/P(B) requires P(B) > 0. Bayes theorem partitions the sample space.';
  const source = {
    id: 'src-prob-1',
    title: 'Lecture 1',
    courses: [course],
    text: sourceText,
    annotations: {
      items: [
        {
          id: 'ann-1',
          sourceId: 'src-prob-1',
          start: 0,
          end: 40,
          label: 'Why must denominator P(B) be strictly positive?',
          question: 'Why must denominator P(B) be strictly positive?',
          answer: CANARIES.doubtAnswer,
          status: 'active',
        },
      ],
    },
  };

  const card = {
    id: 'card-bayes-1',
    kind: 'quiz',
    topic: 'Bayes Theorem',
    prompt: 'When applying Bayes theorem with partition B1, B2, what is the denominator?',
    options: [
      { id: 'opt-a', text: 'Sum of P(A|Bi)P(Bi) over the full partition', correct: true },
      { id: 'opt-b', text: 'Only P(A|B1) without weighting by P(B1)', correct: false },
      { id: 'opt-c', text: 'Unconditional P(B1) alone', correct: false },
    ],
    answer: CANARIES.refAnswer,
    hint: 'Check the law of total probability over all disjoint cases.',
    explanation: CANARIES.explanation,
    citations: [{ sourceId: source.id, quote: 'Bayes theorem partitions the sample space.' }],
    companionRef: { companionId: 'comp-bayes', anchor: '#2', slide: 2 },
    followups: [
      {
        id: 'fu-1',
        question: 'When can we skip the normalizing denominator?',
        answer: CANARIES.followupAnswer,
        at: '2026-11-18T10:00:00.000Z',
        source: 'user',
      },
    ],
    answerCard: {
      v: 1,
      language: 'en',
      questionType: { id: 'calc', label: 'Calculation' },
      signals: [],
      facts: [],
      concepts: [],
      assumptions: [],
      steps: ['Step 1: write partition'],
      conclusion: CANARIES.answerCardConclusion,
      justification: { goal: '', cost: '', failure: '', verify: '' },
      pitfalls: ['Forgetting to weight each branch by its prior P(Bi)'],
      marksMap: [],
      status: 'verified',
    },
  };

  const deck = { id: 'deck-prob', title: 'Prob Quiz', course, folder: course, cards: [card] };
  const catchupDeck = {
    id: 'deck-catchup-prob',
    title: 'Companion Catch-ups',
    course,
    folder: course,
    companionCatchup: true,
    cards: [
      {
        id: 'card-catchup-1',
        kind: 'flashcard',
        topic: 'Bayes Theorem',
        prompt: 'Distinguish P(A|B) from P(B|A) under rare priors',
        answer: CANARIES.catchupAnswer,
        citations: [{ sourceId: source.id, quote: 'Conditional probability P(A|B)' }],
        companionRef: { companionId: 'comp-bayes', anchor: '#3', slide: 3 },
      },
    ],
  };

  const idx = buildOutlineIndex({ sources: [source], documents: [], decks: [deck], attempts: [] }, { course });
  const docKey = idx.allDocuments[0]?.key || `source:${source.id}`;
  const anchor = idx.allDocuments[0]?.chapters?.[0] ? `${docKey}#0` : docKey;
  const outlineNodes = [
    {
      id: 'ch1',
      title: 'Chapter 1',
      children: [{ id: 'h1', hid: 'h1', title: 'Conditional & Bayes', leaf: true, anchors: [anchor] }],
    },
  ];
  const outline = courseOutlineMaterial({
    title: 'Outline · Probability',
    course,
    orderBasis: { codes: ['numbering'] },
    fingerprint: materialsFingerprint(idx.allDocuments),
    nodes: outlineNodes,
    other: { anchors: [] },
    counts: {},
  });

  const notes = {
    id: 'notes-prob',
    title: 'Notes · Probability',
    courses: [course],
    provenance: COURSE_NOTES_PROVENANCE,
    text: '',
    courseNotes: {
      v: 1,
      course,
      outlineId: outline.id,
      leaves: [
        {
          id: 'h1',
          title: 'Conditional & Bayes',
          anchors: [`${source.id}#0`],
          body: {
            fingerprint: 'f'.repeat(16),
            units: [
              {
                cards: [
                  { item: 'it-cond', name: 'P(A|B)', relations: [{ kind: 'opposite', target: 'it-rev', code: 'K002' }] },
                  { item: 'it-rev', name: 'P(B|A)', relations: [{ kind: 'opposite', target: 'it-cond', code: 'K001' }] },
                ],
              },
            ],
          },
        },
      ],
      confusables: [
        {
          items: ['it-cond', 'it-rev'],
          print: '1234567890abcdef',
          rows: [
            { aspect: 'difference', cells: [CANARIES.confusableDiff, 'Conditioned on A instead of B'] },
            { aspect: 'mistake', cells: ['Swapping conditioning event and target event', 'Ignoring base-rate prior'] },
          ],
        },
      ],
    },
  };

  const bookQaText = qaBlock(
    { cardId: card.id, followupId: 'fu-book-1', question: 'Does partition need pairwise disjointness?', answer: CANARIES.bookQaAnswer },
    'en',
  );
  const bookDoc = {
    id: 'book-prob',
    title: 'Book · Probability',
    courses: [course],
    provenance: COURSE_BOOK_DOC_PROVENANCE,
    text: '',
    bookDoc: {
      course,
      outlineId: outline.id,
      revision: 1,
      manifest: { nodes: outline.courseOutline.nodes },
      files: { 'h1.qa.md': { text: bookQaText, version: 1, by: 'learner' } },
    },
  };

  const attempts = [
    {
      id: 'att-1',
      quiz_id: card.id,
      deckId: deck.id,
      timestamp: '2026-11-18T08:00:00.000Z',
      grade: 1,
      correct: false,
      feedback: { selected: ['opt-b'] },
      errorReason: 'condition',
      thinkingNote: 'I forgot to multiply by P(Bi) in the denominator',
      assistance: { used: false },
    },
    {
      id: 'att-2',
      quiz_id: card.id,
      deckId: deck.id,
      timestamp: '2026-11-18T09:00:00.000Z',
      grade: 1,
      correct: false,
      // Even if a multi-select attempt included the correct option plus a wrong option, wrongChoices must exclude opt-a.
      feedback: { selected: ['opt-a', 'opt-c'] },
      errorReason: 'condition',
      thinkingNote: 'Mixed up P(A|B) with P(B|A)',
      assistance: { used: false },
    },
    {
      id: 'att-3',
      quiz_id: card.id,
      deckId: deck.id,
      timestamp: '2026-11-19T09:00:00.000Z',
      grade: 4,
      correct: true,
      feedback: { selected: ['opt-a'] },
      elapsed_ms: 75_000,
      assistance: { used: false },
    },
  ];

  const run = {
    id: 'run-1',
    deckId: deck.id,
    mode: 'path',
    index: 0,
    queueVersion: 1,
    entries: [{ deckId: deck.id, card, revealed: false, feedback: null, selected: null, startedAt: Date.now() }],
  };

  const session = {
    id: 'sess-prob',
    courseId: course,
    version: 1,
    status: 'active',
    focus: { kind: 'card', id: card.id, deckId: deck.id, runId: run.id },
  };

  return {
    course,
    source,
    card,
    deck,
    catchupDeck,
    outline,
    notes,
    bookDoc,
    attempts,
    run,
    session,
    state: {
      sources: [source, outline, notes, bookDoc],
      documents: [],
      decks: [deck, catchupDeck],
      runs: [run],
      attempts,
      studySessions: [session],
      learner: {},
    },
  };
}

test('projectTrapLedger aggregates all 6 existing sources with strict cue/hint/full separation', () => {
  const f = buildRichFixture();
  const projected = projectTrapLedger(f.state, { card: f.card, cardId: f.card.id, hid: 'h1', course: f.course });

  assert.equal(projected.hasTraps, true);
  assert.equal(projected.cue.failedCount, 2);
  assert.deepEqual(projected.cue.errorReasons, { condition: 2 });
  assert.equal(projected.cue.latestErrorReason, 'condition');
  assert.equal(projected.cue.slowCorrectCount, 1);
  assert.equal(projected.cue.thinkingNotes.length, 2);
  // Correct option opt-a must NEVER appear in wrongChoices.
  assert.ok(!projected.cue.wrongChoices.some(w => w.includes('Sum of P(A|Bi)P(Bi)')));
  assert.equal(projected.cue.wrongChoices.length, 2);
  assert.deepEqual(projected.cue.confusableIds, ['C001']);
  assert.equal(projected.cue.pitfallCount, 1);
  assert.equal(projected.cue.doubtCount, 1);
  assert.equal(projected.cue.catchupCount, 1);
  assert.equal(projected.cue.qaQuestions.length, 2);
  assert.match(projected.cue.trapCue, /h1:.*failed 2x \(conditionx2\).*slow-correct 1x.*confusable C001/);

  // Cue JSON must NEVER leak any canary answer or conclusion.
  const cueJson = JSON.stringify(projected.cue);
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!cueJson.includes(canary), `cue leaked ${name}`);
  }

  // Hint holds pitfalls + card hint + confusable mistake, still zero answer canaries.
  assert.equal(projected.hint.pitfalls.length, 1);
  assert.equal(projected.hint.confusableMistakes.length, 1);
  const hintJson = JSON.stringify(projected.hint);
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!hintJson.includes(canary), `hint leaked ${name}`);
  }

  // Full holds the gated answers & conclusion.
  assert.equal(projected.full.answerCardConclusion, CANARIES.answerCardConclusion);
  assert.equal(projected.full.qaAnswers.length, 2);
  assert.equal(projected.full.doubtAnswers[0].answer, CANARIES.doubtAnswer);
  assert.equal(projected.full.catchupAnswers[0].answer, CANARIES.catchupAnswer);
  assert.equal(projected.full.confusableComparisons[0].difference[0], CANARIES.confusableDiff);
});

test('anti-spoiling security gate: revealed === false strips all answers, correct markers, book.qa answers, and AnswerCard conclusions', () => {
  const f = buildRichFixture();
  const trapData = projectTrapLedger(f.state, { card: f.card, cardId: f.card.id, hid: 'h1', course: f.course });
  const scene = buildCompactScene(f.state, { sessionId: f.session.id, trapData });

  assert.equal(scene.focusObject.revealed, false);
  assert.equal(scene.focusObject.disclosureTier, 'cue_only');
  assert.equal(scene.trapLedger.disclosureTier, 'cue_only');
  assert.equal(scene.trapLedger.cueOnly, true);
  assert.equal(scene.trapLedger.latestErrorReason, 'condition');
  assert.deepEqual(scene.trapLedger.confusableIds, ['C001']);
  assert.ok(scene.trapLedger.trapCue.includes('conditionx2'));
  assert.equal(scene.trapLedger.hint, undefined);
  assert.equal(scene.trapLedger.full, undefined);
  assert.equal(scene.focusObject.answer, undefined);
  assert.equal(scene.focusObject.explanation, undefined);
  for (const opt of scene.focusObject.options) assert.equal(opt.correct, undefined);

  const serialized = JSON.stringify(scene);
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!serialized.includes(canary), `unrevealed scene leaked ${name}`);
  }
  assert.ok(!JSON.stringify(scene.focusObject.options).includes('"correct"'), 'unrevealed options leaked correct marker');
  // Prior correct attempt & partial-right multi-select attempt must NEVER leak correct option id 'opt-a' via recentAttempts.selected before reveal.
  const att2 = scene.recentAttempts.find(a => a.id === 'att-2');
  const att3 = scene.recentAttempts.find(a => a.id === 'att-3');
  assert.deepEqual(att2?.selected, ['opt-c'], 'partial-right wrong attempt keeps only wrong option IDs');
  assert.equal(att3?.selected, null, 'prior correct attempt strips selected before reveal');
  for (const att of scene.recentAttempts) {
    assert.ok(!(Array.isArray(att.selected) && att.selected.includes('opt-a')), `recentAttempts[${att.id}] leaked correct option id opt-a`);
  }
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_SCENE_BYTES, `scene exceeded 4KB: ${Buffer.byteLength(serialized, 'utf8')} bytes`);
});

test('solutionExposures surfaces solutionExposed flag while remaining cue_only before reveal', () => {
  const f = buildRichFixture();
  f.state.learner = {
    solutionExposures: [{ cardIds: [f.card.id], deckId: f.deck.id, source: 'request-trace', at: '2026-11-19T10:00:00.000Z' }],
  };
  const scene = buildCompactScene(f.state, { sessionId: f.session.id });
  assert.equal(scene.trapLedger.disclosureTier, 'cue_only');
  assert.equal(scene.trapLedger.solutionExposed, true);
  assert.equal(scene.focusObject.answer, undefined);
});

test('exam runs NEVER disclose hints or answers even when releaseAnswer: true is requested', () => {
  const f = buildRichFixture();
  f.run.mode = 'exam';
  const trapData = projectTrapLedger(f.state, { card: f.card, cardId: f.card.id, hid: 'h1', course: f.course });
  const scene = buildCompactScene(f.state, { sessionId: f.session.id, trapData, releaseAnswer: true, disclosureTier: 'full' });

  assert.equal(scene.focusObject.disclosureTier, 'cue_only');
  assert.equal(scene.trapLedger.disclosureTier, 'cue_only');
  assert.equal(scene.trapLedger.full, undefined);
  assert.equal(scene.trapLedger.hint, undefined);
  assert.equal(scene.assistanceReceipt, undefined);
  const serialized = JSON.stringify(scene);
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!serialized.includes(canary), `exam scene leaked ${name}`);
  }
});

test('size gate: maximal CJK + ASCII scene with rich trapLedger stays <= 4096 UTF-8 bytes in both cue_only and full tiers', () => {
  const f = buildRichFixture();
  f.card.prompt = '条件概率与全概率公式边界推导题干说明 '.repeat(45);
  f.card.options = Array.from({ length: 6 }, (_, i) => ({
    id: `opt-${i}`,
    text: `选项 ${i} 详细推导陈述与边界条件检验 `.repeat(4),
    correct: i === 0,
  }));
  f.card.answer = '完整标准解析与推导结论说明 '.repeat(25);
  f.card.explanation = '详细逐步骤说明与易错点对比解析 '.repeat(30);
  f.card.followups = Array.from({ length: 10 }, (_, i) => ({
    id: `fu-stress-${i}`,
    question: `关于全概率划分条件的第 ${i} 个追问？`.repeat(3),
    answer: `这是第 ${i} 个追问的完整解答内容与推导过程。`.repeat(5),
    at: '2026-11-19T00:00:00.000Z',
  }));
  f.state.attempts = Array.from({ length: 30 }, (_, i) => ({
    id: `att-stress-${i}`,
    quiz_id: f.card.id,
    deckId: f.deck.id,
    timestamp: `2026-11-19T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
    grade: i % 3 === 0 ? 4 : 1,
    correct: i % 3 === 0,
    elapsed_ms: i % 3 === 0 ? 80_000 : 12_000,
    feedback: { selected: ['opt-1'] },
    errorReason: 'condition',
    thinkingNote: '我把条件概率的分母漏掉了全概率求和项并且混淆了先验与后验边界条件'.repeat(2),
    assistance: { used: false },
  }));

  const trapData = projectTrapLedger(f.state, { card: f.card, cardId: f.card.id, hid: 'h1', course: f.course });
  for (const opts of [{ sessionId: f.session.id, trapData }, { sessionId: f.session.id, trapData, releaseAnswer: true }]) {
    const scene = buildCompactScene(f.state, opts);
    const bytes = Buffer.byteLength(JSON.stringify(scene), 'utf8');
    assert.ok(bytes <= MAX_SCENE_BYTES, `scene exceeded 4096 UTF-8 bytes (${bytes}) for tier=${scene.trapLedger.disclosureTier}`);
    assert.ok(scene.trapLedger.trapCue.length > 0, 'core trapCue preserved under budget trimming');
    assert.deepEqual(scene.trapLedger.confusableIds, ['C001'], 'C001 id preserved under budget trimming');
  }
});

test('study.scene.get runtime end-to-end: anti-spoiling -> hint -> explicit release records askedTutorBeforeAnswer -> PointEvidence treats pass as assisted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-trap-scene-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const f = buildRichFixture();

  await service.store.update((s) => {
    s.sources.push(f.source, f.outline, f.notes, f.bookDoc);
    s.decks.push(f.deck, f.catchupDeck);
    s.attempts.push(...f.attempts);
  });

  const session = await service.call('study.session.start', {
    courseId: f.course,
    scope: [{ kind: 'deck', id: f.deck.id }],
  });
  const started = await service.call('review.start', {
    mode: 'path',
    scope: [{ deckId: f.deck.id, cardId: f.card.id }],
  });
  const runId = started.id || started.runId;
  await service.call('study.session.update', {
    sessionId: session.id,
    focus: { kind: 'card', id: f.card.id, deckId: f.deck.id, runId },
  });

  // 1. Default study.scene.get: cue_only, zero answer leakage, trapLedger populated from all sources.
  const cueScene = await service.call('study.scene.get', { sessionId: session.id });
  assert.equal(cueScene.unchanged, false);
  assert.equal(cueScene.focusObject.disclosureTier, 'cue_only');
  assert.equal(cueScene.trapLedger.disclosureTier, 'cue_only');
  assert.equal(cueScene.trapLedger.latestErrorReason, 'condition');
  assert.deepEqual(cueScene.trapLedger.confusableIds, ['C001']);
  assert.equal(cueScene.trapLedger.doubtCount, 1);
  assert.equal(cueScene.trapLedger.catchupCount, 1);
  assert.equal(cueScene.trapLedger.pitfallCount, 1);
  assert.equal(cueScene.assistanceReceipt, undefined);
  const cueSerialized = JSON.stringify(cueScene);
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!cueSerialized.includes(canary), `runtime cue_only leaked ${name}`);
  }
  assert.ok(!JSON.stringify(cueScene.focusObject.options).includes('"correct"'));

  // 2. Hint escalation (hintTier: 1): unlocks pitfalls/hint, still no answer canaries, records receipt.
  const hintScene = await service.call('study.scene.get', {
    sessionId: session.id,
    sinceFingerprint: cueScene.fingerprint,
    hintTier: 1,
  });
  assert.equal(hintScene.unchanged, false, 'escalating disclosure tier must invalidate sinceFingerprint');
  assert.equal(hintScene.focusObject.disclosureTier, 'hint');
  assert.equal(hintScene.trapLedger.hint.pitfalls.length, 1);
  assert.equal(hintScene.trapLedger.full, undefined);
  assert.equal(hintScene.assistanceReceipt?.recorded, true);
  assert.equal(hintScene.assistanceReceipt?.assistance?.askedTutorBeforeAnswer, true);
  assert.equal(hintScene.assistanceReceipt?.assistance?.hintUsed, true);
  const hintSerialized = JSON.stringify(hintScene);
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!hintSerialized.includes(canary), `runtime hint leaked ${name}`);
  }

  // 3. Explicit full answer release in the same turn: unlocks full context + persists askedTutorBeforeAnswer.
  const fullScene = await service.call('study.scene.get', {
    sessionId: session.id,
    sinceFingerprint: hintScene.fingerprint,
    releaseAnswer: true,
  });
  assert.equal(fullScene.unchanged, false);
  assert.equal(fullScene.focusObject.disclosureTier, 'full');
  assert.equal(fullScene.focusObject.askedTutorBeforeAnswer, true);
  assert.equal(fullScene.focusObject.answer, CANARIES.refAnswer);
  assert.equal(fullScene.focusObject.explanation, CANARIES.explanation);
  assert.equal(fullScene.focusObject.options.find(o => o.id === 'opt-a')?.correct, true);
  assert.deepEqual(fullScene.recentAttempts.find(a => a.id === 'att-3')?.selected, ['opt-a'], 'prior correct selection unlocked once disclosureTier is full');
  assert.equal(fullScene.trapLedger.full.answerCardConclusion, CANARIES.answerCardConclusion);
  assert.equal(fullScene.trapLedger.full.qaAnswers.length, 2);
  assert.equal(fullScene.assistanceReceipt?.recorded, true);
  assert.equal(fullScene.assistanceReceipt?.assistance?.askedTutorBeforeAnswer, true);
  assert.ok(Buffer.byteLength(JSON.stringify(fullScene), 'utf8') <= MAX_SCENE_BYTES);

  // 4. Learner answers correctly after explicit release -> attempt carries askedTutorBeforeAnswer & PointEvidence stays non-solid (assisted).
  await service.call('review.answer', {
    runId,
    cardId: f.card.id,
    selected: ['opt-a'],
  });
  const afterState = await service.store.read();
  const latestAttempt = afterState.attempts.at(-1);
  assert.equal(latestAttempt.quiz_id, f.card.id);
  assert.equal(latestAttempt.assistance?.askedTutorBeforeAnswer, true);
  assert.equal(latestAttempt.assistance?.used, true);

  const ev = pointEvidenceForCard(afterState, { deckId: f.deck.id, cardId: f.card.id });
  assert.ok(ev, 'PointEvidence computed for card');
  assert.notEqual(ev.facets.retention, 'solid', 'assisted pass after explicit tutor release cannot make retention solid');
});
