import { findCard } from './prereq.js';
import { learnerAnswer } from './coach.js';
import { isCountedWrongBookAttempt } from './mastery.js';
import { socraticBadge } from './contexts/study/socratic-record.js';

/* One wrong-book row opened up: what the learner answered, the correct answer,
   picked distractor rationale, cloze context, case/oral rubric feedback and
   the full explanation, from data the library already stores. Read-only. */

const textOf = (text) => String(text ?? '');

function correctAnswerOf(card) {
  if (Array.isArray(card.options) && card.options.some((option) => option.correct))
    return card.options.filter((option) => option.correct).map((option) => option.text).join('；');
  if (card.cloze?.answers?.length) return card.cloze.answers.map((answer) => answer.value).join('；');
  return textOf(card.answer);
}

export function wrongDetail(state, ref, { view = 'weak' } = {}) {
  const { deck, card } = findCard(state, ref, '这道题');
  let latest = null, missed = null;
  for (const attempt of state.attempts || []) {
    if (!isCountedWrongBookAttempt(attempt) || attempt.deckId !== deck.id || attempt.quiz_id !== card.id) continue;
    if (!latest || attempt.timestamp >= latest.timestamp) latest = attempt;
    if (attempt.grade < 3 && (!missed || attempt.timestamp >= missed.timestamp)) missed = attempt;
  }
  // A fixed mistake (the history view) opens on the answer that was wrong, not on the one that cleared it.
  const shownAttempt = view === 'history' && missed ? missed : latest;
  // The run entry holds what was answered, as the question looked then.
  const entry = shownAttempt?.runId
    ? state.runs?.find((run) => run.id === shownAttempt.runId)?.entries?.findLast((e) => e.card?.id === card.id && !e.retry && e.feedback)
    : null;
  const oralEntry = shownAttempt?.assessment === 'oral' && shownAttempt?.runId
    ? state.oralRuns?.find((run) => run.id === shownAttempt.runId)?.entries?.findLast((e) => (e.card?.id ?? e.cardId) === card.id && (e.deckId == null || e.deckId === deck.id))
    : null;
  const shown = entry?.card || oralEntry?.card || card;
  const rubric = entry?.feedback?.rubric || shownAttempt?.rubric || null;
  const correction = entry?.feedback?.correction || shownAttempt?.correction || null;
  const isRubricAttempt = shownAttempt?.assessment === 'rubric' || !!rubric;
  const answer = entry && !isRubricAttempt
    ? learnerAnswer(shown, entry.feedback, { selfGraded: shownAttempt?.assessment === 'self' })
    : null;
  const selfGrade = !isRubricAttempt && answer?.kind === 'self-assessment' ? answer.grade : null;
  const yourAnswer = isRubricAttempt
    ? (entry?.feedback?.answer || shownAttempt?.learnerAnswer || null)
    : oralEntry?.answer
      ? oralEntry.answer
      : (answer && selfGrade === null ? answer.text : null);
  const distractorExplanations = Array.isArray(shown.options) && Array.isArray(entry?.feedback?.selected)
    ? shown.options
      .filter((option) => !option.correct && entry.feedback.selected.includes(option.id) && option.explanation)
      .map((option) => ({ id: option.id, text: textOf(option.text), explanation: textOf(option.explanation) }))
    : [];
  const explanation = shown.explanation
    ? textOf(shown.explanation)
    : distractorExplanations.map((item) => item.explanation).join(' ');
  const oralFeedback = oralEntry?.assessment
    ? {
      band: oralEntry.assessment.band || null,
      reason: textOf(oralEntry.assessment.reason),
      ...(oralEntry.assessment.correction ? { correction: oralEntry.assessment.correction } : {}),
    }
    : null;
  const oralFollowup = oralEntry?.followup
    ? { question: textOf(oralEntry.followup), answer: textOf(oralEntry.followupAnswer) }
    : null;
  return {
    deckId: deck.id, cardId: card.id, kind: card.kind, prompt: card.prompt,
    yourAnswer,
    selfGrade,
    lastGrade: latest?.grade ?? null,
    // 已订正: the grade and the moment of the answer that was wrong, so the page can say what was missed.
    ...(view === 'history' && missed ? { missedGrade: missed.grade, missedAt: missed.timestamp } : {}),
    correctAnswer: correctAnswerOf(shown),
    explanation,
    misconception: textOf(shown.misconception),
    ...(distractorExplanations.length ? { distractorExplanations } : {}),
    ...(shown.kind === 'cloze' && shown.cloze?.text ? {
      cloze: shown.cloze,
      ...(entry?.feedback?.answers ? { clozeAnswers: entry.feedback.answers } : {}),
      ...(Array.isArray(entry?.feedback?.details) ? { clozeDetails: entry.feedback.details } : {}),
    } : {}),
    ...(rubric ? { rubric } : {}),
    ...(correction ? { correction } : {}),
    ...(oralFeedback ? { oralFeedback } : {}),
    ...(oralFollowup ? { oralFollowup } : {}),
    ...(card.socratic ? { socratic: socraticBadge(card) } : {}),
  };
}
