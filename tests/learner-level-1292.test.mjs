import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATION_LEARNER_LEVELS,
  GENERATION_SETTINGS_DEFAULTS,
  normalizeGenerationSettings,
  resolveGenerationRequest,
  validateGenerationPatch,
} from '../lib/generation-settings.js';
import { sharedBefore } from '../lib/prompt-order.js';
import { writePrompts } from '../lib/one-pass/prompts.js';
import { planPrompts } from '../lib/assessment-quality.js';
import { estimateRun } from '../lib/token-estimate.js';
import { latestOutcomes, planPath } from '../lib/mastery.js';
import { slayCard, restoreSlainCard } from '../lib/slay.js';
import {
  MAX_GAP_PREREQ_CARDS,
  runPrereqGapScan,
} from '../lib/contexts/generation/generate/prereq-gap-scan.js';
import { loadUi } from './helpers/ui-module.mjs';

const CJK_RE = /[\u4e00-\u9fff]/;

/** What a prerequisite card needs besides its prompt and answer (objective, hint, misconception, and a quote of the material): the cards of the scan are cards like any other (#1400). */
const gapFields = n => ({ objective: `Prerequisite objective ${n}`, hint: `Hint ${n}.`, misconception: `Misconception ${n}.`, sourceId: 'src-mvcc', quote: 'MVCC avoids read locks by keeping row versions' });

const SAMPLE_SOURCES = [
  {
    id: 'src-mvcc',
    title: 'PostgreSQL MVCC Notes',
    text: 'MVCC avoids read locks by keeping row versions tagged with xmin and xmax transaction IDs. Vacuum reclaims dead tuples once no active snapshot references their xid. Write skew can still happen under Snapshot Isolation without Serializable checks.',
  },
];

test('#1292-1: default (unset) learnerLevel leaves request, sharedBefore, prompts, and estimate identical; valid levels validate cleanly', () => {
  assert.deepEqual(GENERATION_LEARNER_LEVELS, ['', 'zero', 'rusty', 'sprint']);
  assert.equal(GENERATION_SETTINGS_DEFAULTS.learnerLevel, '');

  const defaultResolved = resolveGenerationRequest({}, { count: 4, kind: 'quiz' }, { language: 'zh' });
  assert.equal('learnerLevel' in defaultResolved, false);
  assert.equal('learnerLevel' in sharedBefore({ kind: 'quiz', difficulty: 'mixed', language: '中文', focus: '' }), false);

  const zeroResolved = resolveGenerationRequest({}, { count: 4, kind: 'quiz', learnerLevel: 'zero' }, { language: 'zh' });
  assert.equal(zeroResolved.learnerLevel, 'zero');
  assert.equal(sharedBefore({ kind: 'quiz', difficulty: 'mixed', language: '中文', focus: '', learnerLevel: 'zero' }).learnerLevel, 'zero');

  assert.equal(normalizeGenerationSettings({ learnerLevel: 'rusty' }).learnerLevel, 'rusty');
  assert.equal(normalizeGenerationSettings({ learnerLevel: 'bogus' }).learnerLevel, '');
  assert.throws(() => validateGenerationPatch({ learnerLevel: 'invalid' }), /Invalid generation setting: learnerLevel/);

  // Prompts: default has no learner-level clause; zero adds beginner-friendly guidance
  const pieces = [{ id: 'src-mvcc', title: 'PostgreSQL MVCC Notes', text: SAMPLE_SOURCES[0].text, section: 'S1' }];
  const sections = [{ label: 'S1', title: 'MVCC', quota: 2, pieces }];
  const onePassDefault = writePrompts({ language: '中文', difficulty: 'mixed', focus: '' }, sections);
  const onePassZero = writePrompts({ language: '中文', difficulty: 'mixed', focus: '', learnerLevel: 'zero' }, sections);
  assert.doesNotMatch(onePassDefault.prompt, /learnerLevel/);
  assert.match(onePassZero.prompt, /"learnerLevel":"zero"/);

  const stagedDefault = planPrompts({ sources: SAMPLE_SOURCES, count: 2, kind: 'quiz', difficulty: 'mixed', language: '中文', focus: '' });
  const stagedZero = planPrompts({ sources: SAMPLE_SOURCES, count: 2, kind: 'quiz', difficulty: 'mixed', language: '中文', focus: '', learnerLevel: 'zero' });
  assert.doesNotMatch(stagedDefault.prompt, /learnerLevel/);
  assert.match(stagedZero.prompt, /"learnerLevel":"zero"/);
});

test('#1292-2: estimateRun adds a bounded prereqGapScan stage only when learnerLevel === "zero"', () => {
  const baseEst = estimateRun('generate', { sources: SAMPLE_SOURCES, count: 4, kind: 'quiz', language: '中文' });
  const sprintEst = estimateRun('generate', { sources: SAMPLE_SOURCES, count: 4, kind: 'quiz', language: '中文', learnerLevel: 'sprint' });
  const zeroEst = estimateRun('generate', { sources: SAMPLE_SOURCES, count: 4, kind: 'quiz', language: '中文', learnerLevel: 'zero' });

  assert.equal(baseEst.stages.some(s => s.id === 'prereqGapScan'), false);
  assert.equal(sprintEst.stages.some(s => s.id === 'prereqGapScan'), false);
  assert.equal(baseEst.calls.low, sprintEst.calls.low);

  const gapStage = zeroEst.stages.find(s => s.id === 'prereqGapScan');
  assert.ok(gapStage, 'zero learnerLevel adds prereqGapScan stage to estimate');
  assert.equal(gapStage.calls, 1);
  assert.ok(zeroEst.calls.low === baseEst.calls.low + 1, 'adds exactly 1 call to low estimate');
  assert.ok(zeroEst.totalTokens.high > baseEst.totalTokens.high);
  assert.deepEqual(zeroEst.prereqGapScan, { calls: 1, maxCards: MAX_GAP_PREREQ_CARDS });
});

test('#1292-3: prereqGapScan skips known course terms, caps at 6 cards, links prerequisites acyclically (<=12), orders before dependents in planPath, and survives slay/unslay', async () => {
  const draft = {
    id: 'deck-mvcc',
    title: 'MVCC Basics',
    course: 'Databases',
    cards: [
      { id: 'c1', kind: 'flashcard', topic: 'MVCC', prompt: 'How do xmin and xmax govern visibility?', answer: 'They mark birth and deletion transaction IDs.', explanation: 'Snapshots compare xids.' },
      { id: 'c2', kind: 'flashcard', topic: 'Isolation', prompt: 'Why can Snapshot Isolation still allow write skew?', answer: 'Two transactions read overlapping state and update disjoint rows.', explanation: 'Requires SSI.' },
    ],
  };

  let capturedPrompt = '';
  const fakeModel = async (_system, prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      prerequisites: [
        {
          term: 'Transaction ID',
          topic: 'Transactions',
          prompt: 'What is a database transaction ID (xid)?',
          answer: 'A monotonically increasing identifier assigned to each write transaction.',
          explanation: 'MVCC tags row versions with xids so snapshots know which versions are visible.',
          ...gapFields(1),
          targetCardIds: ['c1', 'c2'],
        },
        {
          term: 'Snapshot',
          topic: 'Isolation',
          prompt: 'What does a database snapshot represent?',
          answer: 'The set of committed transaction IDs visible at a point in time.',
          explanation: 'Snapshots provide consistent reads without blocking writers.',
          ...gapFields(2),
          targetCardIds: ['c1'],
        },
        {
          // Already known by learner -> must be skipped
          term: 'Dead Tuple',
          topic: 'Storage',
          prompt: 'What is a dead tuple?',
          answer: 'An obsolete row version.',
          explanation: 'Vacuum cleans it.',
          ...gapFields(3),
          targetCardIds: ['c1'],
        },
        // Excess cards beyond cap (create 8 total to verify MAX_GAP_PREREQ_CARDS = 6)
        ...Array.from({ length: 6 }, (_, i) => ({
          term: `Concept ${i + 1}`,
          topic: 'Foundations',
          prompt: `Foundational prerequisite concept #${i + 1}?`,
          answer: `Answer ${i + 1}.`,
          explanation: `Explanation ${i + 1}.`,
          ...gapFields(i + 4),
          targetCardIds: ['c2'],
        })),
      ],
    });
  };

  const result = await runPrereqGapScan({
    deck: draft,
    sources: SAMPLE_SOURCES,
    knownTerms: [{ term: 'Dead Tuple', known: true }],
    language: 'English',
    ask: fakeModel,
  });

  assert.match(capturedPrompt, /Dead Tuple/, 'known terms are communicated to skip');
  assert.equal(result.added, MAX_GAP_PREREQ_CARDS, 'respects MAX_GAP_PREREQ_CARDS = 6 cap');
  assert.equal(result.skippedKnown, 1, 'records skipped known term');
  assert.ok(result.linked >= 2, 'links prerequisite cards onto dependent cards');

  const prereqCards = result.deck.cards.filter(c => c.prereqGap === true);
  assert.equal(prereqCards.length, MAX_GAP_PREREQ_CARDS);
  assert.equal(prereqCards.some(c => /dead tuple/i.test(c.prompt)), false, 'known term card is not added');

  const c1 = result.deck.cards.find(c => c.id === 'c1');
  const c2 = result.deck.cards.find(c => c.id === 'c2');
  assert.ok(c1.requires?.length >= 2 && c1.requires.length <= 12);
  assert.ok(c2.requires?.length >= 1 && c2.requires.length <= 12);
  assert.equal(c1.requires.every(r => r.deckId === 'deck-mvcc'), true);

  // Path planner places unmastered prerequisite cards BEFORE their dependent cards
  const state = { decks: [result.deck], drafts: [], attempts: [], runs: [], sources: SAMPLE_SOURCES, courses: [] };
  const outcome = latestOutcomes(state.attempts);
  const planned = planPath(state.decks, outcome, { scope: [{ deckId: 'deck-mvcc' }], limit: 20, newLimit: 20, sources: SAMPLE_SOURCES });
  const firstPrereqIdx = planned.entries.findIndex(item => item.card.id === c1.requires[0].cardId);
  const c1Idx = planned.entries.findIndex(item => item.card.id === 'c1');
  assert.ok(firstPrereqIdx >= 0 && firstPrereqIdx < c1Idx, 'prerequisite card appears before dependent card in learning path');

  // Slaying a prerequisite card skips it cleanly, and restoring it puts the link back intact
  const firstPrereqId = c1.requires[0].cardId;
  slayCard(state, { deckId: 'deck-mvcc', cardId: firstPrereqId });
  const afterSlay = planPath(state.decks, outcome, { scope: [{ deckId: 'deck-mvcc' }], limit: 20, newLimit: 20, sources: SAMPLE_SOURCES });
  assert.equal(afterSlay.entries.some(item => item.card.id === firstPrereqId), false, 'slain prerequisite is skipped');
  restoreSlainCard(state, { deckId: state.decks.find(d => d.systemKind === 'slain').id, cardId: firstPrereqId });
  const restoredC1 = state.decks.find(d => d.id === 'deck-mvcc').cards.find(c => c.id === 'c1');
  assert.ok(restoredC1.requires.some(r => r.deckId === 'deck-mvcc' && r.cardId === firstPrereqId), 'unslaying restores prerequisite link back to original deck');
});

test('#1292-4: Generate form helpers and Generate.jsx expose learnerLevel with Tooltip, zero-default parity, and English i18n', async () => {
  const ui = await loadUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { LEARNER_LEVELS, learnerLevelNote, chosenOptions, moreValuesOf, generationRequest, estimateRequestOf } from './ui/generate-form.js';
    export { default as Generate } from './ui/Generate.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);

  assert.deepEqual(ui.LEARNER_LEVELS.map(x => x.value), ['', 'zero', 'rusty', 'sprint']);

  // Default empty learnerLevel stays absent from requests & chosenOptions
  const defaultReq = ui.generationRequest({ kind: 'quiz', kinds: ['quiz'], difficulty: 'mixed', language: '中文', learnerLevel: '' }, { course: 'DB', sourceIds: ['s1'] });
  assert.equal('learnerLevel' in defaultReq, false);
  const zeroReq = ui.generationRequest({ kind: 'quiz', kinds: ['quiz'], difficulty: 'mixed', language: '中文', learnerLevel: 'zero' }, { course: 'DB', sourceIds: ['s1'] });
  assert.equal(zeroReq.learnerLevel, 'zero');

  const zeroEstReq = ui.estimateRequestOf({ kind: 'quiz', kinds: ['quiz'], difficulty: 'mixed', language: '中文', learnerLevel: 'zero' }, { course: 'DB', sourceIds: ['s1'] });
  assert.equal(zeroEstReq.learnerLevel, 'zero');
  const defaultEstReq = ui.estimateRequestOf({ kind: 'quiz', kinds: ['quiz'], difficulty: 'mixed', language: '中文', learnerLevel: '' }, { course: 'DB', sourceIds: ['s1'] });
  assert.equal('learnerLevel' in defaultEstReq, false);

  assert.equal(ui.moreValuesOf({ difficulty: 'mixed', language: '中文', learnerLevel: 'zero' }, { difficulty: 'mixed', language: '中文', learnerLevel: '' }), true);
  assert.equal(ui.chosenOptions({ difficulty: 'mixed', language: '中文', learnerLevel: 'zero' }, { difficulty: 'mixed', language: '中文', learnerLevel: '' }).length, 1);

  ui.setUiLanguage('en');
  try {
    assert.ok(!CJK_RE.test(ui.learnerLevelNote('zero')));
    assert.ok(!CJK_RE.test(ui.learnerLevelNote('rusty')));
    assert.ok(!CJK_RE.test(ui.learnerLevelNote('sprint')));
    for (const item of ui.LEARNER_LEVELS) assert.ok(!CJK_RE.test(item.label), `EN label leaked Han: ${item.label}`);
  } finally {
    ui.setUiLanguage('zh');
  }
});
