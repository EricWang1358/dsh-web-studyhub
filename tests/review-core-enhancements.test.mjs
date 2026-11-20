import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projection } from '../lib/study-state.js';

async function loadOperations(t) {
  try {
    return await import('../lib/contexts/study/operations.js');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip(`npm dependency unavailable in workspace: ${err.message.split('\n')[0]}`);
      return null;
    }
    throw err;
  }
}

function makeStudyHarness(createOperations, cards) {
  const state = {
    settings: {},
    decks: [{ id: 'd1', title: 'Systems', course: 'CS', cards: structuredClone(cards) }],
    sources: [],
    runs: [],
    attempts: [],
    teaching: [],
    inbox: [],
  };
  const ports = {
    state: {
      read: async () => state,
      update: async (fn) => fn(state),
    },
    work: { translateInflight: new Map() },
  };
  const { mutations } = createOperations(ports);
  return { state, mutations };
}

test('Batch 2.2: low self-grades (0, 1, 2) never auto-advance with advanceOnSelfGrade, while passing grades (3–5) do', async (t) => {
  const mod = await loadOperations(t);
  if (!mod) return;
  for (const grade of [0, 1, 2]) {
    const { state, mutations } = makeStudyHarness(mod.createOperations, [
      { id: 'f1', kind: 'flashcard', topic: 'T', prompt: 'Q1?', answer: 'A1', explanation: 'E1' },
      { id: 'f2', kind: 'flashcard', topic: 'T', prompt: 'Q2?', answer: 'A2', explanation: 'E2' },
    ]);
    const started = mutations['review.start'](state, { deckId: 'd1', mode: 'flashcard', fresh: true });
    const firstId = started.card.id;
    mutations['review.reveal'](state, { runId: started.id, cardId: firstId });
    const res = mutations['review.answer'](state, { runId: started.id, cardId: firstId, grade, advanceOnSelfGrade: true });
    assert.equal(res.card.id, firstId, `grade ${grade} stays on ${firstId}`);
    assert.equal(res.selfGradeAdvanced, undefined, `grade ${grade} does not set selfGradeAdvanced`);
    assert.equal(res.feedback?.grade, grade);
    assert.equal(res.feedback?.correct, false);
    assert.equal(!!res.feedback?.retryQueued, grade <= 1, `grade ${grade} retryQueued matches <= 1 threshold`);
  }

  for (const grade of [3, 4, 5]) {
    const { state, mutations } = makeStudyHarness(mod.createOperations, [
      { id: 'f1', kind: 'flashcard', topic: 'T', prompt: 'Q1?', answer: 'A1', explanation: 'E1' },
      { id: 'f2', kind: 'flashcard', topic: 'T', prompt: 'Q2?', answer: 'A2', explanation: 'E2' },
    ]);
    const started = mutations['review.start'](state, { deckId: 'd1', mode: 'flashcard', fresh: true });
    const firstId = started.card.id;
    const secondId = firstId === 'f1' ? 'f2' : 'f1';
    mutations['review.reveal'](state, { runId: started.id, cardId: firstId });
    const res = mutations['review.answer'](state, { runId: started.id, cardId: firstId, grade, advanceOnSelfGrade: true });
    assert.equal(res.card.id, secondId, `grade ${grade} auto-advances to ${secondId}`);
    assert.equal(res.selfGradeAdvanced, true);
    assert.equal(res.gradedFeedback?.grade, grade);
    assert.ok(res.gradedFeedback?.nextDue, 'gradedFeedback carries nextDue for brief status cue');
  }
});

test('Batch 4.2: review.answer accepts inline assistance and draft directly without requiring prior review.draft.save', async (t) => {
  const mod = await loadOperations(t);
  if (!mod) return;
  const { state, mutations } = makeStudyHarness(mod.createOperations, [
    {
      id: 'q1',
      kind: 'quiz',
      topic: 'T',
      prompt: 'Pick A',
      options: [
        { id: 'a', text: 'A', correct: true, explanation: 'Right' },
        { id: 'b', text: 'B', correct: false, explanation: 'Wrong' },
      ],
    },
    { id: 'f1', kind: 'flashcard', topic: 'T', prompt: 'Explain?', answer: 'Because' },
  ]);
  const run = mutations['review.start'](state, { deckId: 'd1', mode: 'path', fresh: true, ordered: true });
  const answered = mutations['review.answer'](state, {
    runId: run.id,
    cardId: 'q1',
    selected: ['a'],
    assistance: { hintUsed: true },
  });
  assert.equal(answered.feedback.correct, true);
  assert.equal(answered.feedback.grade, 3, 'hintUsed caps correct auto-grade to 3');
  assert.equal(answered.feedback.hintGraded, true);
  assert.equal(state.attempts.at(-1).assistance.hintUsed, true);

  // Open/flashcard scratchpad draft piggybacked on review.answer survives review.undo
  mutations['review.move'](state, { runId: run.id, direction: 1 });
  mutations['review.reveal'](state, { runId: run.id, cardId: 'f1' });
  mutations['review.answer'](state, {
    runId: run.id,
    cardId: 'f1',
    grade: 2,
    draft: { text: 'Inline scratchpad without prior draft.save' },
  });
  const undone = mutations['review.undo'](state, { runId: run.id });
  assert.equal(undone.card.id, 'f1');
  assert.equal(undone.draft?.text, 'Inline scratchpad without prior draft.save');
});

test('Batch 2.5: review.grade.adjust { clozeEquivalent: true } overrides failed cloze, updates SRS, removes tail retry, and supports saveAccept', async (t) => {
  const mod = await loadOperations(t);
  if (!mod) return;
  const { state, mutations } = makeStudyHarness(mod.createOperations, [
    {
      id: 'c1',
      kind: 'cloze',
      topic: 'Consensus',
      prompt: '',
      cloze: {
        text: 'Raft elects a {{role}} per term.',
        blanks: [{ id: 'role' }],
        answers: [{ id: 'role', value: 'leader', accept: [] }],
      },
      explanation: 'A single leader handles log replication.',
    },
    { id: 'f2', kind: 'flashcard', topic: 'Consensus', prompt: 'Next?', answer: 'Yes' },
  ]);
  const run = mutations['review.start'](state, { deckId: 'd1', mode: 'path', fresh: true, ordered: true });
  const wrong = mutations['review.answer'](state, {
    runId: run.id,
    cardId: 'c1',
    answers: { role: 'primary node' },
  });
  assert.equal(wrong.feedback.correct, false);
  assert.equal(wrong.feedback.grade, 1);
  assert.equal(wrong.feedback.retryQueued, true);
  assert.equal(wrong.navigation.length, 3, 'tail retry queued on miss');

  const adjusted = mutations['review.grade.adjust'](state, {
    runId: run.id,
    entryIndex: 0,
    cardId: 'c1',
    clozeEquivalent: true,
    saveAccept: true,
  });
  assert.equal(adjusted.feedback.correct, true);
  assert.equal(adjusted.feedback.grade, 4);
  assert.equal(adjusted.feedback.gradeOriginal, 1);
  assert.equal(adjusted.feedback.clozeEquivalent, true);
  assert.equal(adjusted.feedback.retryQueued, false);
  assert.equal(adjusted.feedback.details[0].correct, true);
  assert.equal(adjusted.feedback.details[0].equivalent, true);
  assert.equal(adjusted.navigation.length, 2, 'unpractised tail retry removed');
  assert.equal(state.decks[0].cards[0].review.repetitions, 1, 'SRS updated to passing repetition');
  assert.deepEqual(state.decks[0].cards[0].cloze.answers[0].accept, ['primary node'], 'optional saveAccept stored synonym');
  assert.equal(state.attempts.at(-1).grade, 4);
  assert.equal(state.attempts.at(-1).clozeEquivalent, true);

  // Stubborn metadata projection stays coherent after adjustment
  const proj = projection(state, state.runs[0]);
  assert.equal(proj.stubborn, undefined, 'passed card after equivalence override has 0 misses');
});

test('Backend operations.js contract: low-grade no-skip, inline assistance/draft, and clozeEquivalent override', () => {
  const opsSrc = readFileSync('lib/contexts/study/operations.js', 'utf8');
  assert.match(opsSrc, /a\.advanceOnSelfGrade === true && grade >= 3 && run\.mode !== "exam"/, 'low grades (< 3) never auto-advance');
  assert.match(opsSrc, /if \(a\.assistance && typeof a\.assistance === "object"\)/, 'review.answer accepts inline assistance');
  assert.match(opsSrc, /if \(a\.draft && typeof a\.draft === "object"\)/, 'review.answer accepts inline draft');
  assert.match(opsSrc, /"review\.grade\.adjust":\s*\(s, a\)\s*=>\s*\{\s*if \(!a\?\.clozeEquivalent\) return gradingMutations\["review\.grade\.adjust"\]\(s, a\);/, 'review.grade.adjust extends gradingMutations for clozeEquivalent');
  assert.match(opsSrc, /clozeEquivalent: true/, 'marks feedback and attempt with clozeEquivalent');
  assert.match(opsSrc, /settlePrerequisiteCredit\(s,/, 're-settles prerequisite credit on cloze equivalence override');
});

test('Batch 1.1 + 4.3 + 4.4: Recall Veil CSS, usePinQuestion read-before-write, stable sync hooks, memoized App shell, and split busy context', () => {
  const questionCss = readFileSync('ui/review/question.css', 'utf8');
  assert.match(questionCss, /\.question-area:has\(\[data-retell-drafting\]\)\s*>\s*\.explanation:not\(:hover,\s*:focus-within\)/);
  assert.doesNotMatch(questionCss, /\.review-body\s*>\s*\.explanation:has\(~\s*\[data-retell-drafting\]\)/, 'dead selector removed');
  assert.match(questionCss, /\.grade\.warn\s*\{/);
  assert.match(questionCss, /\.option--pending\s*\{/);
  assert.match(questionCss, /\.stubborn-cue\s*\{/);
  assert.match(questionCss, /\.explanation-inline-ask\s*\{/);

  const pinSrc = readFileSync('ui/review/usePinQuestion.js', 'utf8');
  const writeIdx = pinSrc.indexOf('area.style.minHeight = minHeight');
  const lastReadIdx = pinSrc.lastIndexOf('getBoundingClientRect()', pinSrc.indexOf('const offset ='));
  assert.ok(writeIdx > 0 && lastReadIdx > 0 && lastReadIdx < writeIdx, 'all card/scroller getBoundingClientRect reads happen before writing minHeight');

  const syncSrc = readFileSync('ui/review/use-review-run-sync.js', 'utf8');
  assert.match(syncSrc, /const setAutoAdvancePaused = session\.setAutoAdvancePaused;/);
  assert.doesNotMatch(syncSrc, /\}, \[session\]\);/, 'useAutopilotPause no longer depends on unstable session object');
  assert.match(syncSrc, /const pollNow = session\.pollNow \|\| session\.pollRun;/);
  assert.doesNotMatch(syncSrc, /\[ended\.watch, ended\.done, session\]/, 'useAssistWatch no longer depends on unstable session object');

  const appSrc = readFileSync('ui/App.jsx', 'utf8');
  assert.match(appSrc, /<StudyBusyProvider store=\{core\.busyStore\} study=\{study\}>/);
  assert.doesNotMatch(appSrc, /\[core\.call, core\.act, core\.busy,/, 'StudyServicesContext memo no longer depends on core.busy');
  assert.match(appSrc, /const app = useMemo\(/);
  assert.match(appSrc, /const board = useMemo\(/);

  for (const file of ['ui/app/AppSidebar.jsx', 'ui/app/AppTopbar.jsx', 'ui/app/AppModalHost.jsx']) {
    assert.match(readFileSync(file, 'utf8'), /React\.memo\(/, `${file} wrapped with React.memo`);
  }

  const sessionSrc = readFileSync('ui/review/useReviewSession.js', 'utf8');
  assert.match(sessionSrc, /const SAVES_FIRST = new Set\(\['review\.move'\]\)/, 'review.answer removed from serial SAVES_FIRST waterfall');
  assert.match(sessionSrc, /export function useLiveSession\(/);

  const qRunSrc = readFileSync('ui/review/QuestionRun.jsx', 'utf8');
  assert.match(qRunSrc, /const AssistFormPanel = React\.memo\(/);
  assert.match(qRunSrc, /const InlineExplanationAsk = React\.memo\(/);
  assert.match(qRunSrc, /activeEntryKeyRef\.current !== originKey/, 'async race guard present in extracted forms');
  assert.match(qRunSrc, /<NextDue feedback=\{run\.feedback\} telemetry=\{run\.feedbackTelemetry\} hideWhy className="next-due--verdict"/);
  assert.match(qRunSrc, /run\.stubborn/);
  assert.match(qRunSrc, /SimilarTry/);
  assert.match(qRunSrc, /grade-group--\$\{group\.key\}/);
  assert.match(qRunSrc, /key:\s*"fail"/);
  assert.match(qRunSrc, /key:\s*"pass"/);

  const qPartsSrc = readFileSync('ui/review/QuestionParts.jsx', 'utf8');
  assert.match(qPartsSrc, /onMarkEquivalent=/);
  assert.match(qPartsSrc, /clozeEquivalent: true/);

  const debriefSrc = readFileSync('ui/CoachDebrief.jsx', 'utf8');
  assert.match(debriefSrc, /ctaMode/);
});

test('Locale integrity: all ui/uiFormat strings in edited review components have English translations and zero key conflicts across en*.json', () => {
  const localesDir = 'ui/locales';
  const files = readdirSync(localesDir).filter((f) => f.startsWith('en') && f.endsWith('.json')).sort();
  const merged = new Map();
  const conflicts = [];
  for (const file of files) {
    const json = JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
    for (const [k, v] of Object.entries(json)) {
      if (merged.has(k) && merged.get(k).value !== v) {
        conflicts.push({ key: k, a: merged.get(k).file, b: file });
      }
      merged.set(k, { file, value: v });
    }
  }
  assert.deepEqual(conflicts, [], `Conflicting English locale keys: ${JSON.stringify(conflicts)}`);

  const han = /[\u3400-\u9fff]/;
  const polishReview = JSON.parse(readFileSync('ui/locales/en.polish-review.json', 'utf8'));
  for (const [k, v] of Object.entries(polishReview)) {
    assert.doesNotMatch(v, han, `English translation for "${k}" must not contain Han characters: "${v}"`);
  }

  // Check every literal ui("...") / uiFormat("...") call in our edited review UI files resolves in merged en*.json.
  const missing = [];
  const checkFiles = [
    'ui/review/QuestionRun.jsx',
    'ui/review/QuestionParts.jsx',
    'ui/NextDue.jsx',
    'ui/ReviewToolbar.jsx',
    'ui/CoachDebrief.jsx',
    'ui/review/useReviewSession.js',
  ];
  const callRe = /\bui(?:Format)?\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of checkFiles) {
    const src = readFileSync(file, 'utf8');
    let m;
    while ((m = callRe.exec(src))) {
      const key = m[2];
      if (!han.test(key)) continue;
      if (!merged.has(key)) missing.push({ file, key });
    }
  }
  assert.deepEqual(missing, [], `Missing English locale keys: ${JSON.stringify(missing)}`);
});
