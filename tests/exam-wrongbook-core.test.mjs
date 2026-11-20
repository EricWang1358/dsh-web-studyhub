import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { examReport, projection } from '../lib/study-state.js';
import { wrongDetail } from '../lib/wrong-detail.js';
import { createExamRun, examTiming } from '../ui/exam/exam-run.js';

const readText = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('examReport exposes full Q&A review fields on wrong and skipped questions in entry.order', () => {
  const wrongCard = {
    id: 'c-wrong',
    kind: 'multi',
    multiple: true,
    topic: 'Concurrency',
    prompt: 'Which statements about mutexes hold?',
    options: [
      { id: 'a', text: 'Only owner unlocks', correct: true, explanation: 'Ownership prevents accidental unlock.' },
      { id: 'b', text: 'Busy-waits forever', correct: false, explanation: 'Mutexes sleep instead of spinning.' },
      { id: 'c', text: 'Protects critical section', correct: true },
    ],
    explanation: 'Mutexes enforce mutual exclusion with ownership.',
    misconception: 'Do not confuse mutexes with spinlocks.',
    citations: [{ sourceId: 'src-1', quote: 'Mutexes block waiting threads.' }],
  };
  const skippedCard = {
    id: 'c-skip',
    kind: 'quiz',
    topic: 'Memory',
    prompt: 'What causes thrashing?',
    options: [
      { id: 'x', text: 'Working set exceeds frames', correct: true },
      { id: 'y', text: 'Too many registers', correct: false },
    ],
    explanation: 'Excessive paging starves CPU work.',
  };
  const okCard = {
    id: 'c-ok',
    kind: 'quiz',
    topic: 'CPU',
    prompt: 'Round-robin uses time quanta.',
    options: [{ id: 't', text: 'Yes', correct: true }],
  };
  const run = {
    id: 'exam-qa-1',
    mode: 'exam',
    deckId: 'd1',
    startedAt: '2026-11-20T00:00:00Z',
    submittedAt: '2026-11-20T00:10:00Z',
    closedAt: '2026-11-20T00:10:00Z',
    entries: [
      { deckId: 'd1', card: wrongCard, order: ['b', 'c', 'a'], selected: ['b'], feedback: { correct: false, selected: ['b'] } },
      { deckId: 'd1', card: skippedCard, order: ['y', 'x'] },
      { deckId: 'd1', card: okCard, feedback: { correct: true, selected: ['t'] } },
    ],
  };
  const report = examReport({ decks: [{ id: 'd1', title: 'OS', cards: [wrongCard, skippedCard, okCard] }], runs: [run] }, run);

  assert.equal(report.correct, 1);
  assert.equal(report.wrong.length, 1);
  assert.equal(report.skipped.length, 1);

  const w = report.wrong[0];
  assert.equal(w.multiple, true);
  assert.deepEqual(w.selected, ['b']);
  assert.deepEqual(w.options.map((o) => o.id), ['b', 'c', 'a'], 'preserves the exact option order shown in the exam');
  assert.equal(w.options[0].correct, false);
  assert.equal(w.options[0].explanation, 'Mutexes sleep instead of spinning.');
  assert.equal(w.options[2].correct, true);
  assert.equal(w.explanation, 'Mutexes enforce mutual exclusion with ownership.');
  assert.equal(w.misconception, 'Do not confuse mutexes with spinlocks.');
  assert.deepEqual(w.citations, [{ sourceId: 'src-1', quote: 'Mutexes block waiting threads.' }]);

  const s = report.skipped[0];
  assert.equal(s.selected, undefined);
  assert.deepEqual(s.options.map((o) => o.id), ['y', 'x']);
  assert.equal(s.options[1].correct, true);
  assert.equal(s.explanation, 'Excessive paging starves CPU work.');
});

test('projection exposes active-card stubborn metadata (missCount, priorMisses, isLeech) on non-exam review entries', () => {
  const card = { id: 'c1', kind: 'quiz', topic: 'Locks', prompt: 'Deadlock conditions?', options: [{ id: 'a', text: '4', correct: true }] };
  const baseState = {
    decks: [{ id: 'd1', title: 'OS', cards: [card] }],
    sources: [],
    teaching: [],
    feedback: [],
    workflowSessions: [],
    settings: { practice: { leechFailures: 3, leechWindow: 5, leechRate: 60 } },
    runs: [],
    attempts: [],
  };

  const cleanRun = {
    id: 'r0', mode: 'path', deckId: 'd1', index: 0, startedAt: '2026-11-20T00:00:00Z',
    entries: [{ deckId: 'd1', card }],
  };
  assert.equal(projection(baseState, cleanRun).stubborn, undefined, 'no stubborn field when never missed');

  const priorAttempts = [
    { deckId: 'd1', quiz_id: 'c1', grade: 1, timestamp: '2026-11-18T00:00:00Z' },
    { deckId: 'd1', quiz_id: 'c1', grade: 1, timestamp: '2026-11-19T00:00:00Z' },
    // Non-counted attempts must be ignored:
    { deckId: 'd1', quiz_id: 'c1', grade: 1, retry: true, timestamp: '2026-11-19T01:00:00Z' },
    { deckId: 'd1', quiz_id: 'c1', grade: 1, implicit: true, timestamp: '2026-11-19T02:00:00Z' },
    { deckId: 'd1', quiz_id: 'c1', grade: 1, assessment: 'self-report', timestamp: '2026-11-19T03:00:00Z' },
  ];
  const beforeAnswer = projection({ ...baseState, attempts: priorAttempts }, cleanRun);
  assert.deepEqual(beforeAnswer.stubborn, { missCount: 2, priorMisses: 2, isLeech: false });

  const afterMissState = {
    ...baseState,
    attempts: [
      ...priorAttempts,
      { runId: 'r1', deckId: 'd1', quiz_id: 'c1', grade: 1, timestamp: '2026-11-20T00:01:00Z' },
    ],
  };
  const afterMissRun = {
    id: 'r1', mode: 'path', deckId: 'd1', index: 0, startedAt: '2026-11-20T00:00:00Z',
    entries: [{ deckId: 'd1', card, revealed: true, feedback: { correct: false, grade: 1 } }],
  };
  assert.deepEqual(projection(afterMissState, afterMissRun).stubborn, { missCount: 3, priorMisses: 2, isLeech: true });

  const examRun = { ...afterMissRun, id: 'e1', mode: 'exam' };
  assert.equal(projection(afterMissState, examRun).stubborn, undefined, 'exam runs never leak stubborn metadata');
});

test('wrongDetail returns full untruncated explanation/misconception, distractor rationales, cloze context, rubric and oral feedback', () => {
  const longExplain = 'E'.repeat(1100);
  const longMisconception = 'M'.repeat(450);

  // 1. Choice card with both card explanation and picked distractor rationale + >800/>300 char text
  const choiceCard = {
    id: 'c-choice',
    kind: 'quiz',
    topic: 'Net',
    prompt: 'Why TCP slow start?',
    options: [
      { id: 'a', text: 'Probe capacity', correct: true },
      { id: 'b', text: 'Avoid DNS lookup', correct: false, explanation: 'DNS is unrelated to congestion control.' },
    ],
    explanation: longExplain,
    misconception: longMisconception,
  };
  const choiceState = {
    decks: [{ id: 'd1', cards: [choiceCard] }],
    attempts: [{ runId: 'r-choice', deckId: 'd1', quiz_id: 'c-choice', grade: 1, timestamp: '2026-11-20T00:00:00Z' }],
    runs: [{ id: 'r-choice', entries: [{ card: choiceCard, feedback: { selected: ['b'], correct: false, grade: 1 } }] }],
  };
  const choiceDetail = wrongDetail(choiceState, { deckId: 'd1', cardId: 'c-choice' });
  assert.equal(choiceDetail.explanation.length, 1100, 'explanation is not silently truncated at 800 chars');
  assert.equal(choiceDetail.misconception.length, 450, 'misconception is not silently truncated at 300 chars');
  assert.deepEqual(choiceDetail.distractorExplanations, [
    { id: 'b', text: 'Avoid DNS lookup', explanation: 'DNS is unrelated to congestion control.' },
  ]);

  // 2. Cloze card preserves sentence context & per-blank details
  const clozeCard = {
    id: 'c-cloze',
    kind: 'cloze',
    topic: 'DB',
    prompt: 'ACID',
    cloze: { text: 'Isolation prevents {{b1}} reads.', answers: [{ id: 'b1', value: 'dirty' }] },
  };
  const clozeState = {
    decks: [{ id: 'd1', cards: [clozeCard] }],
    attempts: [{ runId: 'r-cloze', deckId: 'd1', quiz_id: 'c-cloze', grade: 1, timestamp: '2026-11-20T00:00:00Z' }],
    runs: [{
      id: 'r-cloze',
      entries: [{
        card: clozeCard,
        feedback: {
          answers: { b1: 'stale' },
          details: [{ id: 'b1', expected: 'dirty', actual: 'stale', correct: false }],
          correct: false,
          grade: 1,
        },
      }],
    }],
  };
  const clozeDetail = wrongDetail(clozeState, { deckId: 'd1', cardId: 'c-cloze' });
  assert.equal(clozeDetail.cloze.text, 'Isolation prevents {{b1}} reads.');
  assert.deepEqual(clozeDetail.clozeAnswers, { b1: 'stale' });
  assert.equal(clozeDetail.clozeDetails[0].expected, 'dirty');

  // 3. Rubric-graded case card returns learner text, rubric, and selfGrade: null (not misclassified as self-assessment)
  const caseCard = { id: 'c-case', kind: 'open', topic: 'Arch', prompt: 'Design queues', answer: 'A'.repeat(600) };
  const rubric = { total: 2, max: 6, ratio: 0.33, band: 'weak', summary: 'Missing trade-offs.', criteria: [] };
  const caseState = {
    decks: [{ id: 'd1', cards: [caseCard] }],
    attempts: [{ runId: 'r-case', deckId: 'd1', quiz_id: 'c-case', grade: 1, assessment: 'rubric', learnerAnswer: 'Use Kafka.', rubric, timestamp: '2026-11-20T00:00:00Z' }],
    runs: [{ id: 'r-case', entries: [{ card: caseCard, feedback: { grade: 1, answer: 'Use Kafka.', rubric } }] }],
  };
  const caseDetail = wrongDetail(caseState, { deckId: 'd1', cardId: 'c-case' });
  assert.equal(caseDetail.selfGrade, null);
  assert.equal(caseDetail.yourAnswer, 'Use Kafka.');
  assert.equal(caseDetail.correctAnswer.length, 600, 'reference answer is not silently clipped at 400 chars');
  assert.deepEqual(caseDetail.rubric, rubric);

  // 4. Oral assessment returns oral answer, follow-up, reason, and correction using real createOralRun() entry shape (`entry.card.id`, no top-level `cardId`)
  const oralCard = { id: 'c-oral', kind: 'flashcard', topic: 'Sys', prompt: 'Explain Raft', answer: 'Leader election + log replication.' };
  const oralCorrection = { keywordExpansion: 'Tie leader lease to term checks.' };
  const oralState = {
    decks: [{ id: 'd1', cards: [oralCard] }],
    attempts: [{ runId: 'o1', deckId: 'd1', quiz_id: 'c-oral', grade: 1, assessment: 'oral', timestamp: '2026-11-20T00:00:00Z' }],
    runs: [],
    oralRuns: [{
      id: 'o1',
      entries: [{
        deckId: 'd1',
        deckTitle: 'Distributed Systems',
        card: structuredClone(oralCard),
        answer: 'Nodes vote for leader.',
        followup: 'What about split brain?',
        followupAnswer: 'Quorum prevents it.',
        assessment: { band: 'weak', reason: 'Missing log safety rule.', correction: oralCorrection },
      }],
    }],
  };
  const oralDetail = wrongDetail(oralState, { deckId: 'd1', cardId: 'c-oral' });
  assert.equal(oralDetail.yourAnswer, 'Nodes vote for leader.');
  assert.deepEqual(oralDetail.oralFollowup, { question: 'What about split brain?', answer: 'Quorum prevents it.' });
  assert.deepEqual(oralDetail.oralFeedback, { band: 'weak', reason: 'Missing log safety rule.', correction: oralCorrection });

  // Also preserves compatibility with legacy oral entries carrying top-level `cardId`
  const legacyOralState = {
    ...oralState,
    oralRuns: [{
      id: 'o1',
      entries: [{
        deckId: 'd1',
        cardId: 'c-oral',
        answer: 'Legacy oral answer.',
        followup: 'Legacy follow-up?',
        followupAnswer: 'Legacy follow-up answer.',
        assessment: { band: 'weak', reason: 'Legacy reason.' },
      }],
    }],
  };
  const legacyOralDetail = wrongDetail(legacyOralState, { deckId: 'd1', cardId: 'c-oral' });
  assert.equal(legacyOralDetail.yourAnswer, 'Legacy oral answer.');
  assert.deepEqual(legacyOralDetail.oralFollowup, { question: 'Legacy follow-up?', answer: 'Legacy follow-up answer.' });
  assert.deepEqual(legacyOralDetail.oralFeedback, { band: 'weak', reason: 'Legacy reason.' });
});

test('en.exam.json and en.wrongbook.json parse cleanly and have zero conflicting translations with other locale files', async () => {
  const dirUrl = new URL('../ui/locales/', import.meta.url);
  const owned = new Set(['en.exam.json', 'en.wrongbook.json']);
  const files = (await readdir(dirUrl)).filter((name) => /^en(\..+)?\.json$/.test(name)).sort();
  const seen = new Map();
  const conflicts = [];
  for (const name of files) {
    const entries = JSON.parse(await readFile(new URL(name, dirUrl), 'utf8'));
    for (const [k, v] of Object.entries(entries)) {
      if (!seen.has(k)) seen.set(k, { file: name, value: v });
      else if (seen.get(k).value !== v && (owned.has(name) || owned.has(seen.get(k).file))) {
        conflicts.push({ key: k, a: seen.get(k), b: { file: name, value: v } });
      }
    }
  }
  assert.deepEqual(conflicts, []);
});

test('source contracts: AnswerCard race guards, isolated exam clocks, debounced drafts, WrongBook Map lookups, and button/hook invariants', async () => {
  const answerCardSrc = await readText('ui/AnswerCard.jsx');
  assert.match(answerCardSrc, /activeKeyRef\.current !== originKey/);
  assert.match(answerCardSrc, /reqSeqRef\.current !== seq/);
  assert.match(answerCardSrc, /mountedRef\.current/);

  const useExamRunSrc = await readText('ui/exam/useExamRun.js');
  assert.match(useExamRunSrc, /export function useExamClock\(/);
  assert.match(useExamRunSrc, /tick = true/);
  assert.match(useExamRunSrc, /useNow\(/);
  assert.doesNotMatch(useExamRunSrc, /setInterval\(/);

  const examSrc = await readText('ui/Exam.jsx');
  assert.match(examSrc, /tick:\s*false/);
  assert.match(examSrc, /WrittenExamClock/);
  assert.match(examSrc, /phase === 'setup' \? recentExams\(data\)/);
  assert.match(examSrc, /onTogglePostmortem=\{togglePostmortem\}/);
  assert.equal((examSrc.match(/<button(?![\w-])/g) || []).length, 1);

  const caseSrc = await readText('ui/CaseWorkspace.jsx');
  assert.match(caseSrc, /tick:\s*false/);
  assert.match(caseSrc, /CasePaperClockStatus/);
  assert.match(caseSrc, /QuestionTimeBadge/);
  assert.match(caseSrc, /export const ScenarioPanel = React\.memo\(/);
  assert.match(caseSrc, /scheduleLocalSession/);
  assert.match(caseSrc, /window\.addEventListener\?\.\("pagehide"/);
  assert.equal((caseSrc.match(/<button(?![\w-])/g) || []).length, 4);

  const oralSrc = await readText('ui/OralExam.jsx');
  assert.match(oralSrc, /tick:\s*false/);
  assert.match(oralSrc, /ORAL_DRAFT_DEBOUNCE_MS/);
  assert.match(oralSrc, /onBlur=\{\(\) => flushDraft\(\)\}/);
  assert.equal((oralSrc.match(/<button(?![\w-])/g) || []).length, 0);

  const reportSrc = await readText('ui/exam/WrittenReport.jsx');
  assert.match(reportSrc, /QuestionQaDetail/);
  assert.match(reportSrc, /<ChoiceFeedback\b/);
  assert.match(reportSrc, /<AnswerState\b[^>]*multiple=\{isMulti\}/);
  assert.match(reportSrc, /onTogglePostmortem/);
  assert.equal((reportSrc.match(/<button(?![\w-])/g) || []).length, 0);

  const wbSrc = await readText('ui/WrongBook.jsx');
  assert.match(wbSrc, /const deckById = useMemo\(/);
  assert.match(wbSrc, /const cardByRef = useMemo\(/);
  assert.match(wbSrc, /const sourceById = useMemo\(/);
  assert.match(wbSrc, /const expandedTargets = useMemo\(/);
  assert.match(wbSrc, /function ExpandableText\(/);
  assert.match(wbSrc, /onToggleClinic/);
  assert.doesNotMatch(wbSrc, /data\?\.decks\.find\(\(d\) => d\.id === item\.deckId\)/);

  // Confirm exam-run controller still works as expected
  const ctl = createExamRun(() => ({ kind: 'exam', call: async () => ({}) }));
  assert.equal(ctl.getState().phase, 'setup');
  assert.equal(examTiming({ startedAt: '2026-01-01T00:00:00Z' }, Date.parse('2026-01-01T00:01:00Z'), 60000).expired, true);
});
