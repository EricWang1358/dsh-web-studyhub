import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNER_ATOMIC_FACTS_PER_COURSE_MAX,
  cleanAtomicFact,
  cleanAtomicFacts,
  decayAtomicFacts,
  effectiveAtomicConfidence,
  emptyLearner,
  mergeAtomicFacts,
  normalizeLearner,
  selectAtomicFacts,
  summarizeAtomicFacts,
} from '../lib/learner.js';
import { learnerFacts } from '../lib/learner-facts.js';
import { consolidateDailyLearnerMemory, learnerMemoryConsolidationAllowed } from '../lib/coach-daily.js';

const NOW = '2026-11-20T10:00:00.000Z';
const daysAgo = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();

test('emptyLearner and normalizeLearner preserve backward compatibility and validate atomicFacts', () => {
  assert.deepEqual(emptyLearner().atomicFacts, []);
  const legacy = normalizeLearner({ goal: 'exam', summary: 'Legacy 300-char summary' });
  assert.deepEqual(legacy.atomicFacts, []);
  assert.equal(legacy.summary, 'Legacy 300-char summary');

  const fact = cleanAtomicFact({
    course: 'OS',
    topic: 'Deadlocks',
    kind: 'misconception',
    statement: '经常混淆死锁与饥饿的必要条件',
    confidence: 0.82,
    updatedAt: NOW,
    evidenceCount: 3,
  }, { strict: true });
  assert.equal(fact.course, 'OS');
  assert.equal(fact.topic, 'Deadlocks');
  assert.equal(fact.kind, 'misconception');
  assert.equal(fact.confidence, 0.82);
  assert.equal(fact.evidenceCount, 3);
  assert.ok(fact.id.startsWith('af-'));

  assert.throws(() => cleanAtomicFact({ statement: '' }, { strict: true }));
  assert.throws(() => cleanAtomicFact({ statement: 'valid', kind: 'bogus' }, { strict: true }));
  assert.throws(() => cleanAtomicFact({ statement: 'valid', confidence: 1.5 }, { strict: true }));
  assert.throws(() => cleanAtomicFact({ statement: 'valid', evidenceCount: 0 }, { strict: true }));
  assert.equal(cleanAtomicFacts(null).length, 0);
});

test('mergeAtomicFacts deduplicates near-duplicates, reinforces evidenceCount, attenuates contradictions, and isolates per-course caps', () => {
  const existing = [
    {
      id: 'af-1',
      course: 'OS',
      topic: '死锁',
      kind: 'misconception',
      statement: '容易把循环等待条件与资源饥饿现象混淆',
      confidence: 0.65,
      updatedAt: daysAgo(2),
      evidenceCount: 2,
    },
    {
      id: 'af-2',
      course: 'OS',
      topic: '页面置换',
      kind: 'weakness',
      statement: '页面置换算法题失误较多',
      confidence: 0.7,
      updatedAt: daysAgo(1),
      evidenceCount: 2,
    },
    {
      id: 'af-db',
      course: 'DB',
      topic: 'B+树',
      kind: 'strength',
      statement: 'B+树节点分裂与范围查询掌握牢固',
      confidence: 0.88,
      updatedAt: daysAgo(1),
      evidenceCount: 4,
    },
  ];

  const incoming = [
    // Near-duplicate of af-1 in same (course, topic, kind) -> should merge & increment evidenceCount
    {
      course: 'OS',
      topic: '死锁',
      kind: 'misconception',
      statement: '容易把循环等待条件和资源饥饿现象混淆',
      confidence: 0.75,
      updatedAt: NOW,
      evidenceCount: 1,
    },
    // Contradicting strength on OS/页面置换 -> should attenuate existing weakness
    {
      course: 'OS',
      topic: '页面置换',
      kind: 'strength',
      statement: '页面置换算法 LRU 与 Clock 已连续答对',
      confidence: 0.85,
      updatedAt: NOW,
      evidenceCount: 3,
    },
  ];

  const merged = mergeAtomicFacts(existing, incoming, { now: NOW });
  const deadlockFact = merged.find(f => f.id === 'af-1');
  assert.ok(deadlockFact, 'merged into existing atomic fact rather than duplicating');
  assert.equal(deadlockFact.evidenceCount, 3, 'evidenceCount incremented');
  assert.ok(deadlockFact.confidence > 0.75, `confidence reinforced: ${deadlockFact.confidence}`);
  assert.equal(merged.filter(f => f.course === 'OS' && f.topic === '死锁').length, 1);

  const pageWeakness = merged.find(f => f.id === 'af-2');
  assert.ok(!pageWeakness || pageWeakness.confidence < 0.4, 'contradicted weakness attenuated by new strength');
  assert.ok(merged.some(f => f.course === 'DB' && f.topic === 'B+树'), 'other course partition preserved untouched');

  // Per-course cap: flooding OS with 30 facts never evicts DB facts
  const flood = Array.from({ length: 30 }, (_, i) => ({
    course: 'OS',
    topic: `T${i}`,
    kind: 'weakness',
    statement: `操作系统知识点 ${i} 需要重点复习`,
    confidence: 0.8,
    updatedAt: NOW,
    evidenceCount: 1,
  }));
  const capped = mergeAtomicFacts(merged, flood, { now: NOW });
  assert.ok(capped.filter(f => f.course === 'OS').length <= LEARNER_ATOMIC_FACTS_PER_COURSE_MAX);
  assert.ok(capped.some(f => f.course === 'DB'), 'per-course partitioning protects DB memories from OS flood');
});

test('decayAtomicFacts decays stale memories and preserves high-evidence facts longer', () => {
  const lowEvidence = {
    id: 'af-low',
    course: 'OS',
    topic: 'A',
    kind: 'weakness',
    statement: '偶发失误',
    confidence: 0.5,
    updatedAt: daysAgo(90),
    evidenceCount: 1,
  };
  const highEvidence = {
    id: 'af-high',
    course: 'OS',
    topic: 'B',
    kind: 'misconception',
    statement: '长期反复混淆点',
    confidence: 0.8,
    updatedAt: daysAgo(90),
    evidenceCount: 8,
  };

  assert.ok(effectiveAtomicConfidence(highEvidence, { now: NOW }) > effectiveAtomicConfidence(lowEvidence, { now: NOW }));
  const survivors = decayAtomicFacts([lowEvidence, highEvidence], { now: NOW, minConfidence: 0.15 });
  assert.deepEqual(survivors.map(f => f.id), ['af-high'], 'expired low-evidence fact pruned while corroborated fact survives');
});

test('consolidateDailyLearnerMemory enforces consent.prep && debrief gate and merges attempts + bullets offline', () => {
  const baseState = () => ({
    settings: { practice: { debrief: true } },
    courses: [{ id: 'c-os', name: 'OS' }],
    decks: [{
      id: 'd-os',
      title: 'OS',
      course: 'OS',
      cards: [
        { id: 'q1', topic: '死锁' },
        { id: 'q2', topic: '虚拟内存' },
      ],
    }],
    attempts: [
      { deckId: 'd-os', quiz_id: 'q1', grade: 1, timestamp: daysAgo(2) },
      { deckId: 'd-os', quiz_id: 'q1', grade: 2, timestamp: daysAgo(1) },
      { deckId: 'd-os', quiz_id: 'q2', grade: 4, timestamp: daysAgo(3) },
      { deckId: 'd-os', quiz_id: 'q2', grade: 4, timestamp: daysAgo(2) },
      { deckId: 'd-os', quiz_id: 'q2', grade: 5, timestamp: daysAgo(1) },
    ],
    learner: {
      consent: { prep: false },
      summary: '既有手动摘要',
      bullets: [{ id: 'b1', text: '注意区分信号量初值含义', course: 'OS', source: 'user', refs: [], updatedAt: daysAgo(1) }],
      atomicFacts: [],
    },
  });

  // Gate 1: consent.prep === false -> blocked
  const gated1 = baseState();
  assert.equal(learnerMemoryConsolidationAllowed(gated1), false);
  const res1 = consolidateDailyLearnerMemory(gated1, { now: NOW });
  assert.equal(res1.consolidated, false);
  assert.equal(res1.reason, 'consent-gated');
  assert.equal(gated1.learner.atomicFacts.length, 0);

  // Gate 2: consent.prep === true but debrief === false -> blocked
  const gated2 = baseState();
  gated2.learner.consent.prep = true;
  gated2.settings.practice.debrief = false;
  assert.equal(learnerMemoryConsolidationAllowed(gated2), false);
  assert.equal(consolidateDailyLearnerMemory(gated2, { now: NOW }).consolidated, false);

  // Gate open: consolidates attempts + bullets into atomicFacts while preserving legacy summary
  const open = baseState();
  open.learner.consent.prep = true;
  const res = consolidateDailyLearnerMemory(open, { now: NOW });
  assert.equal(res.consolidated, true);
  assert.ok(res.added >= 3);
  assert.equal(open.learner.summary, '既有手动摘要', 'never overwrites existing summary unless syncSummary: true');
  assert.ok(open.learner.atomicFacts.some(f => f.course === 'OS' && f.topic === '死锁' && f.kind === 'weakness'));
  assert.ok(open.learner.atomicFacts.some(f => f.course === 'OS' && f.topic === '虚拟内存' && f.kind === 'strength'));
  assert.ok(open.learner.atomicFacts.some(f => f.statement.includes('信号量初值')));
});

test('learnerFacts partitions atomicFacts by course, respects consent.prep && debrief gate, and synthesizes summary fallback', () => {
  const state = {
    focus: { mode: 'class', course: 'OS' },
    courses: [{ id: 'c-os', name: 'OS' }, { id: 'c-db', name: 'DB' }],
    sources: [],
    decks: [],
    drafts: [],
    attempts: [],
    settings: { practice: { debrief: true } },
    learner: {
      consent: { prep: false },
      goal: '',
      preferences: [],
      summary: '',
      bullets: [],
      atomicFacts: [
        { id: 'af-coach-os', course: 'OS', topic: '死锁', kind: 'misconception', statement: '混淆银行家算法安全状态', confidence: 0.85, updatedAt: NOW, evidenceCount: 3 },
        { id: 'af-user-os', course: 'OS', topic: '调度', kind: 'strategy', statement: '画甘特图验证周转时间', confidence: 0.9, updatedAt: NOW, evidenceCount: 2, source: 'user' },
        { id: 'af-coach-db', course: 'DB', topic: '事务', kind: 'weakness', statement: '幻读与不可重复读边界不清', confidence: 0.8, updatedAt: NOW, evidenceCount: 2 },
      ],
    },
  };

  // Without consent: coach atomic facts & synthesized summary stay hidden; user-authored OS fact surfaces
  const noConsent = learnerFacts(state, 'OS', { now: Date.parse(NOW) });
  assert.equal(noConsent.summary, undefined);
  assert.deepEqual(noConsent.atomicFacts.map(f => f.id), ['af-user-os']);

  // With consent + debrief: OS partition surfaces both OS facts, excludes DB, and provides backward-compatible <=300 char summary
  const withConsent = learnerFacts({ ...state, learner: { ...state.learner, consent: { prep: true } } }, 'OS', { now: Date.parse(NOW) });
  assert.deepEqual(withConsent.atomicFacts.map(f => f.id).sort(), ['af-coach-os', 'af-user-os']);
  assert.ok(withConsent.summary && withConsent.summary.length <= 300);
  assert.match(withConsent.summary, /死锁|调度/);

  // Direct helper checks
  assert.equal(selectAtomicFacts(state.learner.atomicFacts, { course: 'DB', now: Date.parse(NOW) }).length, 1);
  assert.ok(summarizeAtomicFacts(state.learner.atomicFacts, { course: 'OS', maxChars: 120, now: Date.parse(NOW) }).length <= 120);
});
