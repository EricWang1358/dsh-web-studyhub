/* StudyHub 5.0.0 Evolution 1 — Unified `hid` Evidence Spine tests (§3.1.5):
   - Assisted/exposed attempts cannot make retention solid or transfer verified; cardLevel() self-rating 5 stays mastered.
   - Non-compensatory overall rule (§6.3).
   - book.retell / teach.retell / C001 / linked companion interactive checks verify comprehension; consistent across
     course.evidence.summary, book.crunch, course.custom.readiness, course.outline, and learnerFacts.
   - Outline prereqIds: order/read/inventory-tree cycle + out-of-bounds + >3 stripping, propagation via manifest,
     prereqGaps accurate, and book.crunch sorting 100% invariant to prereqIds in 5.0.0.
   - Graceful fallback without review book/outline; DAG boundary (`courses` does not read `study`); conditional UI hints en/zh. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { cardLevel } from '../lib/mastery.js';
import { reads, writesFor } from '../lib/runtime/domain-contracts.js';
import {
  computeOverall,
  derivePointGapHint,
  evaluatePointEvidence,
  questionSolidity,
  resolvePrereqGaps,
} from '../lib/evidence/point-evidence.js';
import { courseEvidenceSummary } from '../lib/evidence/course-evidence.js';
import { learnerFacts } from '../lib/learner-facts.js';
import { buildCompactScene } from '../lib/study-scene.js';
import { courseOutlineMaterial, materialsFingerprint, normalizeCourseOutline } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { expandOrder, orderPrompt } from '../lib/contexts/generation/outline/order.js';
import { readReduce } from '../lib/contexts/generation/outline/read.js';
import { sanitizePrereqIds } from '../lib/contexts/generation/outline/inventory-tree.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const TODAY = localDate();

const uiHelpers = await loadUi(`
  export { gapHintLabel } from './ui/evidence-hint.js';
  export { isWeakOrDueNode, gapHintOfNode } from './ui/outline/gap-lens.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('assisted (hintUsed) and exposed (unseenStatus: exposed) right answers cannot make retention solid or transfer verified; self-rating 5 cardLevel stays mastered', () => {
  // Existing behavior untouched: self-rating 5 immediately yields mastered in cardLevel().
  const selfCard = { id: 'c-self', kind: 'flashcard', review: { repetitions: 1, interval_days: 4 } };
  assert.equal(cardLevel(selfCard, 5), 'mastered');

  // Hint-assisted right answers on two different days still cannot make retention solid or transfer verified.
  const hintAttempts = Object.freeze([
    Object.freeze({ deckId: 'd1', quiz_id: 'q1', grade: 3, timestamp: '2026-11-10T10:00:00Z', assistance: { used: true, hintUsed: true } }),
    Object.freeze({ deckId: 'd1', quiz_id: 'q1', grade: 3, timestamp: '2026-11-12T10:00:00Z', assistance: { used: true, hintUsed: true, unseenStatus: 'unseen' } }),
  ]);
  const hintSol = questionSolidity(hintAttempts);
  const q1Card = { id: 'q1', kind: 'open', rubricCriteria: [{ id: 'r1' }] };
  const q1State = hintSol({ deckId: 'd1', cardId: 'q1', level: 'mastered', card: q1Card });
  assert.equal(q1State.solid, false, 'hintUsed right answers cannot make card solid');
  assert.equal(q1State.assistedOnly, true);
  assert.equal(q1State.unseenTransferPassed, false, 'hintUsed right answer cannot verify transfer');

  const evHint = evaluatePointEvidence({
    hid: 'h1',
    cards: [{ ...q1State, deckId: 'd1', cardId: 'q1', level: 'learning', card: q1Card }],
  });
  assert.equal(evHint.facets.retention, 'assisted');
  assert.notEqual(evHint.facets.retention, 'solid');
  assert.notEqual(evHint.facets.transfer, 'verified');
  assert.ok(evHint.unverifiedReasons.includes('hint_assisted'));

  // Exposed solution right answers on two different days cannot make retention solid or transfer verified.
  const exposedAttempts = Object.freeze([
    Object.freeze({ deckId: 'd1', quiz_id: 'q2', grade: 4, timestamp: '2026-11-10T10:00:00Z', assistance: { used: true, unseenStatus: 'exposed' } }),
    Object.freeze({ deckId: 'd1', quiz_id: 'q2', grade: 4, timestamp: '2026-11-12T10:00:00Z', assistance: { used: true, unseenStatus: 'exposed' } }),
  ]);
  const expSol = questionSolidity(exposedAttempts);
  const q2State = expSol({ deckId: 'd1', cardId: 'q2', level: 'mastered', card: { id: 'q2', kind: 'open', isVariant: true } });
  assert.equal(q2State.solid, false);
  assert.equal(q2State.exposedSolution, true);
  assert.equal(q2State.unseenTransferPassed, false);
  assert.equal(q2State.partialTransfer, false);

  const evExposed = evaluatePointEvidence({
    hid: 'h2',
    cards: [{ ...q2State, deckId: 'd1', cardId: 'q2', level: 'familiar', card: { id: 'q2', kind: 'open', isVariant: true } }],
  });
  assert.equal(evExposed.facets.retention, 'assisted');
  assert.equal(evExposed.facets.transfer, 'unverified');
  assert.ok(evExposed.unverifiedReasons.includes('exposed_solution'));

  // Independent right answers on two different days + unseen transfer card -> solid retention & verified transfer.
  const cleanAttempts = Object.freeze([
    Object.freeze({ deckId: 'd1', quiz_id: 'q3', grade: 4, timestamp: '2026-11-10T10:00:00Z', assistance: { used: false, unseenStatus: 'unseen' } }),
    Object.freeze({ deckId: 'd1', quiz_id: 'q3', grade: 4, timestamp: '2026-11-12T10:00:00Z', assistance: { used: false } }),
  ]);
  const cleanSol = questionSolidity(cleanAttempts);
  const q3State = cleanSol({ deckId: 'd1', cardId: 'q3', level: 'learning', card: { id: 'q3', kind: 'quiz' } });
  assert.equal(q3State.solid, true);
  assert.equal(q3State.unseenTransferPassed, true);
});

test('non-compensatory overall rule (§6.3) matches exact truth table', () => {
  assert.equal(computeOverall({ retention: 'unstarted', comprehension: 'unverified', transfer: 'unverified' }), 'unstarted');
  assert.equal(computeOverall({ retention: 'weak', comprehension: 'verified', transfer: 'verified' }), 'shaky');
  assert.equal(computeOverall({ retention: 'slip', comprehension: 'verified', transfer: 'verified' }), 'shaky');
  assert.equal(computeOverall({ retention: 'solid', comprehension: 'gap', transfer: 'verified' }), 'shaky');
  assert.equal(computeOverall({ retention: 'solid', comprehension: 'verified', transfer: 'verified' }), 'solid');
  assert.equal(computeOverall({ retention: 'solid', comprehension: 'unverified', transfer: 'verified' }), 'in_progress');
  assert.equal(computeOverall({ retention: 'solid', comprehension: 'verified', transfer: 'partial' }), 'in_progress');
  assert.equal(computeOverall({ retention: 'holding', comprehension: 'verified', transfer: 'verified' }), 'in_progress');
  assert.equal(computeOverall({ retention: 'assisted', comprehension: 'verified', transfer: 'unverified' }), 'in_progress');
  assert.equal(computeOverall({ retention: 'unstarted', comprehension: 'verified', transfer: 'unverified' }), 'in_progress');
});

test('comprehension verifies on book.retell, teach.retell, C001 confusable check, or linked companion interactive checks (spot/say/quiz)', () => {
  const baseCard = { deckId: 'd1', cardId: 'c1', level: 'new', solid: false, weak: false, answered: false, assistedOnly: false, slowCorrect: 0, unseenTransferPassed: false };
  assert.equal(evaluatePointEvidence({ hid: 'h1', cards: [baseCard] }).facets.comprehension, 'unverified');

  // book.retell passed
  const byBookRetell = evaluatePointEvidence({
    hid: 'h1',
    cards: [baseCard],
    bookRetell: { tries: 1, passes: 1, gap: 'none', at: '2026-11-19T10:00:00Z' },
  });
  assert.equal(byBookRetell.facets.comprehension, 'verified');
  assert.equal(byBookRetell.signals.retellPasses, 1);

  // book.retell gap -> shaky
  const byRetellGap = evaluatePointEvidence({
    hid: 'h1',
    cards: [baseCard],
    bookRetell: { tries: 1, passes: 0, gap: 'missed', at: '2026-11-19T10:00:00Z' },
  });
  assert.equal(byRetellGap.facets.comprehension, 'gap');
  assert.equal(byRetellGap.overall, 'shaky');
  assert.ok(byRetellGap.unverifiedReasons.includes('retell_gap'));

  // teach.retell passed on card
  const byTeachRetell = evaluatePointEvidence({
    hid: 'h1',
    cards: [{ ...baseCard, card: { id: 'c1', retell: { tries: 1, passes: 1, gap: 'none', at: '2026-11-19T11:00:00Z' } } }],
  });
  assert.equal(byTeachRetell.facets.comprehension, 'verified');

  // C001 confusable check passed
  const byConfusable = evaluatePointEvidence({ hid: 'h1', cards: [baseCard], confusableMark: { passed: true } });
  assert.equal(byConfusable.facets.comprehension, 'verified');

  // Linked rescue companion: failed predict on Slide 1, passed spot & quiz on later slides -> verified!
  const byRescueCompanion = evaluatePointEvidence({
    hid: 'h1',
    cards: [baseCard],
    companions: [{
      id: 'comp-1',
      hid: 'h1',
      lessonMode: 'rescue',
      slideCount: 4,
      progress: { slide: 4, slideTotal: 4, completed: true, checkResults: { 'predict:1': false, 'spot:1': true, 'check:0': true }, checksPassed: 2, checksTotal: 3 },
    }],
  });
  assert.equal(byRescueCompanion.facets.comprehension, 'verified');
  assert.equal(byRescueCompanion.signals.companionChecksPassed, 2);
  assert.equal(byRescueCompanion.signals.companionSlidesDone, 4);

  // Linked companion completed with failed quiz check and 0 passed checks -> NOT verified
  const failedQuizComp = evaluatePointEvidence({
    hid: 'h1',
    cards: [baseCard],
    companions: [{
      id: 'comp-2',
      hid: 'h1',
      lessonMode: 'rescue',
      slideCount: 3,
      progress: { slide: 3, slideTotal: 3, completed: true, checkResults: { 'check:0': false }, checksPassed: 0, checksTotal: 1 },
    }],
  });
  assert.equal(failedQuizComp.facets.comprehension, 'unverified');
});

test('outline prereqIds: orderPrompt/readReduce/expandOrder preserve prereqIds; sanitizePrereqIds & normalizeCourseOutline strip cycles, out-of-bounds, self-loops, and >3', () => {
  const prompt = orderPrompt([{ id: 'p1', title: 'A', items: 2, materials: ['L1'], names: ['a'] }], { language: 'en' });
  assert.match(prompt.prompt, /prereqIds/);

  const parsed = readReduce(JSON.stringify({
    basis: ['logic'],
    chapters: [{
      title: 'Ch 1',
      intro: 'Intro',
      points: [
        'p1',
        { points: 'p2', prereqIds: ['p1'] },
        { points: ['p3', 'p4'], prereqIds: ['p1', 'p2', 'p99', 'p3'] },
      ],
    }],
  }));
  assert.deepEqual(parsed.chapters[0].leaves[1].prereqIds, ['p1']);
  const expanded = expandOrder(parsed, new Map([['p1', ['p1']], ['p2', ['p2']], ['p3', ['p3']], ['p4', ['p4']]]));
  assert.deepEqual(expanded.chapters[0].leaves[1].prereqIds, ['p1']);

  // Direct cycle, 3-cycle, self-loop, out-of-bounds, duplicates, and >3 cap stripping.
  const tree = [
    {
      id: 'ch1',
      title: 'Ch 1',
      children: [
        { id: 'a', title: 'A', anchors: ['doc#0'], prereqIds: ['a', 'missing', 'b'] },
        { id: 'b', title: 'B', anchors: ['doc#1'], prereqIds: ['a', 'c'] },
        { id: 'c', title: 'C', anchors: ['doc#2'], prereqIds: ['b', 'a', 'd', 'e', 'f', 'g'] },
        { id: 'd', title: 'D', anchors: ['doc#3'] },
        { id: 'e', title: 'E', anchors: ['doc#4'] },
        { id: 'f', title: 'F', anchors: ['doc#5'] },
        { id: 'g', title: 'G', anchors: ['doc#6'] },
      ],
    },
  ];
  sanitizePrereqIds(tree);
  const [a, b, c] = tree[0].children;
  // a keeps b (self & missing dropped); b drops a (would cycle with a->b) and keeps c; c drops b & a (would cycle with b->c and a->b->c) and keeps at most 3 valid leaves (d, e, f), dropping excess g.
  assert.deepEqual(a.prereqIds, ['b']);
  assert.deepEqual(b.prereqIds, ['c']);
  assert.deepEqual(c.prereqIds, ['d', 'e', 'f']);

  // normalizeCourseOutline enforces the same deterministic sanitization.
  const norm = normalizeCourseOutline({
    course: 'CS101',
    orderBasis: { codes: ['logic'] },
    fingerprint: 'abcd1234',
    nodes: [
      {
        id: 'ch1',
        title: 'Ch 1',
        children: [
          { id: 'leaf-a', title: 'Leaf A', anchors: ['doc#0'], prereqIds: ['leaf-b', 'ghost'] },
          { id: 'leaf-b', title: 'Leaf B', anchors: ['doc#1'], prereqIds: ['leaf-a'] },
        ],
      },
    ],
  });
  assert.deepEqual(norm.nodes[0].children[0].prereqIds, ['leaf-b']);
  assert.equal(norm.nodes[0].children[1].prereqIds, undefined, 'back-edge stripped to prevent cycle');
});

test('cross-surface consistency + prereqGaps + book.crunch sorting invariant to prereqIds + DAG boundary', async t => {
  // DAG boundary: courses context NEVER reads study; course.evidence.summary writes nothing.
  assert.equal(reads.courses.includes('study'), false, 'courses.reads must not include study');
  assert.deepEqual(writesFor('library', 'course.evidence.summary'), []);

  const setup = async (withPrereqs) => {
    const root = await mkdtemp(join(tmpdir(), 'study-evidence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const study = new StudyService(root);
    await study.call('snapshot');
    const { sources, decks } = outlineLibrary();
    const state = { sources, decks, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
    const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
    const outline = {
      ...courseOutlineMaterial({
        title: '总纲 · SA',
        course: COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex({ ...state, documents: [], drafts: [], attempts: [] }, { course: COURSE }).allDocuments),
        nodes: [{
          id: 'c1',
          title: 'Introduction',
          children: [
            { id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
            { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`], ...(withPrereqs ? { prereqIds: ['what'] } : {}) },
          ],
        }],
        other: { anchors: [] },
        counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    sources.push(outline);
    const page = sources.find(source => source.id === 'document-l1-p1');
    const leaves = outline.courseOutline.nodes[0].children;
    sources.push({
      ...courseNotesMaterial({
        title: '复习全书 · SA',
        course: COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: leaves.map(leaf => ({
          id: leaf.id,
          title: leaf.title,
          anchors: leaf.anchors,
          body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    await study.store.update(own => { own.sources.push(...sources); own.decks.push(...decks); own.focus = state.focus; });
    await study.call('course.save', { name: COURSE, exam: { date: addDays(TODAY, 10) } });
    const opened = await study.call('course.book.open');
    const [what, who] = opened.nodes[0].children;
    return { study, what, who };
  };

  const a = await setup(true);
  const b = await setup(false);

  // prereqHids propagated to review book leaf.
  assert.deepEqual(a.who.prereqHids, [a.what.hid]);

  // book.crunch sorting MUST be identical with or without prereqIds in 5.0.0.
  const crunchWith = await a.study.call('book.crunch', { date: TODAY });
  const crunchWithout = await b.study.call('book.crunch', { date: TODAY });
  assert.deepEqual(crunchWith.plan.order.learn, crunchWithout.plan.order.learn, '5.0.0 book.crunch learn order must not depend on prereqIds');
  assert.deepEqual(crunchWith.plan.order.flip, crunchWithout.plan.order.flip, '5.0.0 book.crunch flip order must not depend on prereqIds');

  // Leaf B ('who') depends on unsolid leaf A ('what') -> prereqGaps contains A's hid.
  const evBefore = await a.study.call('course.evidence.summary', { course: COURSE, date: TODAY });
  const whoEvBefore = evBefore.points.find(p => p.hid === a.who.hid);
  assert.deepEqual(whoEvBefore.prereqGaps, [a.what.hid]);
  assert.equal(whoEvBefore.gapHint.kind, 'prereq');
  assert.equal(whoEvBefore.gapHint.targetHid, a.what.hid);

  // Mark book.retell passed on 'what' and verify comprehension flips to 'verified' consistently across ALL surfaces!
  await a.study.store.update(own => {
    const bookRec = own.sources.find(s => s.provenance === 'course-book-doc');
    bookRec.bookDoc.marks = { ...(bookRec.bookDoc.marks || {}), retell: { [a.what.hid]: { tries: 1, passes: 1, gap: 'none', at: new Date().toISOString() } } };
  });

  const summaryAfter = await a.study.call('course.evidence.summary', { course: COURSE, date: TODAY });
  const crunchAfter = await a.study.call('book.crunch', { date: TODAY });
  const readinessAfter = await a.study.call('course.custom.readiness', { course: COURSE });
  const outlineAfter = await a.study.call('course.outline', { course: COURSE });
  const viewState = await a.study.store.read();
  const factsAfter = learnerFacts(viewState, COURSE, { today: TODAY });

  const evSummaryWhat = summaryAfter.points.find(p => p.hid === a.what.hid);
  const evCrunchWhat = crunchAfter.points.find(p => p.id === a.what.hid)?.evidence;
  const evReadinessWhat = readinessAfter.chapters[0].pointEvidence.find(p => p.hid === a.what.hid);
  const evOutlineWhat = outlineAfter.book.nodes[0].children.find(n => n.id === 'what')?.evidence;
  const evFactsWhat = factsAfter.evidence.points.find(p => p.hid === a.what.hid);

  assert.equal(evSummaryWhat.facets.comprehension, 'verified');
  assert.deepEqual(evCrunchWhat.facets, evSummaryWhat.facets);
  assert.equal(evCrunchWhat.overall, evSummaryWhat.overall);
  assert.deepEqual(evReadinessWhat.facets, evSummaryWhat.facets);
  assert.equal(evReadinessWhat.overall, evSummaryWhat.overall);
  assert.deepEqual(evOutlineWhat.facets, evSummaryWhat.facets);
  assert.equal(evOutlineWhat.overall, evSummaryWhat.overall);
  assert.deepEqual(evFactsWhat.facets, evSummaryWhat.facets);
  assert.equal(evFactsWhat.overall, evSummaryWhat.overall);

  // study.scene.get / buildCompactScene carries compact pointEvidence and stays well under 4 KB.
  const firstCard = a.what.questions[0];
  const scene = buildCompactScene({
    ...viewState,
    runs: [{ id: 'run-1', index: 0, entries: [{ deckId: firstCard.deckId, card: { id: firstCard.cardId, prompt: 'Q?', kind: 'quiz' }, revealed: false }] }],
  });
  assert.equal(scene.focusObject.pointEvidence.hid, a.what.hid);
  assert.equal(scene.focusObject.pointEvidence.facets.comprehension, 'verified');
  assert.ok(Buffer.byteLength(JSON.stringify(scene), 'utf8') <= 4096);
});

test('graceful fallback without review book or outline + prereqGaps clears when prereq becomes solid', () => {
  // Fallback course with only decks (no outline, no book).
  const state = {
    courses: [{ id: 'c-plain', name: 'Plain' }],
    sources: [],
    documents: [],
    decks: [{
      id: 'd-plain',
      title: 'Plain Deck',
      course: 'Plain',
      cards: [{ id: 'card-1', kind: 'quiz', topic: 'Basics', prompt: '1+1?', review: { repetitions: 0, interval_days: 0 } }],
    }],
    attempts: [{ deckId: 'd-plain', quiz_id: 'card-1', grade: 1, timestamp: '2026-11-18T10:00:00Z' }],
  };
  const ev = courseEvidenceSummary(state, { course: 'Plain', date: '2026-11-19' });
  assert.equal(ev.status, 'ok');
  assert.equal(ev.basis, 'fallback');
  assert.equal(ev.points.length, 1);
  assert.equal(ev.points[0].facets.retention, 'weak');
  assert.equal(ev.points[0].overall, 'shaky');
  assert.equal(ev.points[0].gapHint.kind, 'weak_cards');

  // resolvePrereqGaps clears once prerequisite retention is solid (with no comprehension gap).
  const pts = [
    { hid: 'h1', facets: { retention: 'solid', comprehension: 'unverified', transfer: 'unverified' }, overall: 'in_progress', prereqGaps: [] },
    { hid: 'h2', prereqIds: ['h1'], facets: { retention: 'unstarted', comprehension: 'unverified', transfer: 'unverified' }, overall: 'unstarted', prereqGaps: [] },
  ];
  resolvePrereqGaps(pts);
  assert.deepEqual(pts[1].prereqGaps, []);
});

test('conditional UI gap hint appears ONLY on weak or exam-near points, localized cleanly in zh and en without percentages or facet names', () => {
  const solidPoint = { hid: 'h1', facets: { retention: 'solid', comprehension: 'verified', transfer: 'verified' }, overall: 'solid', prereqGaps: [] };
  const calmPoint = { hid: 'h2', facets: { retention: 'holding', comprehension: 'unverified', transfer: 'unverified' }, overall: 'in_progress', prereqGaps: [] };
  const shakyPoint = { hid: 'h3', facets: { retention: 'weak', comprehension: 'unverified', transfer: 'unverified' }, overall: 'shaky', prereqGaps: [] };
  const prereqPoint = { hid: 'h4', facets: { retention: 'weak', comprehension: 'unverified', transfer: 'unverified' }, overall: 'shaky', prereqGaps: ['h1'] };
  const titles = new Map([['h1', 'Foundations']]);

  assert.equal(derivePointGapHint(solidPoint, { examNear: true }), null, 'solid point never gets a gap hint');
  assert.equal(derivePointGapHint(calmPoint, { examNear: false }), null, 'non-weak point far from exam gets no hint');
  assert.equal(derivePointGapHint(calmPoint, { examNear: true }).kind, 'retell', 'exam-near non-solid point gets single actionable hint');
  assert.equal(derivePointGapHint(shakyPoint, { examNear: false }).kind, 'weak_cards');
  assert.deepEqual(derivePointGapHint(prereqPoint, { titleByHid: titles, examNear: false }), { kind: 'prereq', hid: 'h4', targetHid: 'h1', targetTitle: 'Foundations' });

  // Outline gap lens agrees with PointEvidence shaky status.
  assert.equal(uiHelpers.isWeakOrDueNode({ summary: { weak: 0, due: 0 }, evidence: { overall: 'shaky' } }), true);
  assert.equal(uiHelpers.isWeakOrDueNode({ summary: { weak: 0, due: 0 }, evidence: { overall: 'solid' } }), false);

  const hints = [
    { kind: 'prereq', hid: 'h4', targetHid: 'h1', targetTitle: 'Foundations' },
    { kind: 'prereq', hid: 'h4', targetHid: 'h1', targetTitle: '' },
    { kind: 'weak_cards', hid: 'h3' },
    { kind: 'exam_slip', hid: 'h3' },
    { kind: 'retell_gap', hid: 'h3' },
    { kind: 'assisted_only', hid: 'h3' },
    { kind: 'retell', hid: 'h2' },
    { kind: 'transfer', hid: 'h2' },
    { kind: 'practice', hid: 'h2' },
  ];

  const han = /[\u3400-\u9fff]/;
  try {
    uiHelpers.setUiLanguage('zh');
    for (const hint of hints) {
      const zh = uiHelpers.gapHintLabel(hint);
      assert.ok(zh.startsWith('还差：'), `zh hint starts with 还差： (${zh})`);
      assert.doesNotMatch(zh, /%|保持度|理解度|迁移度|未掌握/);
    }
    uiHelpers.setUiLanguage('en');
    for (const hint of hints) {
      const en = uiHelpers.gapHintLabel(hint);
      assert.ok(en.startsWith('Still needed: '), `en hint starts with Still needed: (${en})`);
      assert.doesNotMatch(en, han, `en hint must contain zero Chinese (${en})`);
      assert.doesNotMatch(en, /%|retention|comprehension|transfer|not mastered/i);
    }
  } finally {
    uiHelpers.setUiLanguage('zh');
  }
});
