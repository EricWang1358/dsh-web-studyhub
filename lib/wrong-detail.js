import { findCard } from './prereq.js';
import { learnerAnswer } from './coach.js';
import { isMasteryAttempt } from './mastery.js';

/* One wrong-book row opened up: what the learner answered, the correct answer
   and the explanation, from data the library already stores. Read-only. */

const clip = (text, n = 400) => String(text ?? '').slice(0, n);

function correctAnswerOf(card) {
  if (Array.isArray(card.options) && card.options.some((option) => option.correct))
    return card.options.filter((option) => option.correct).map((option) => option.text).join('；');
  if (card.cloze?.answers?.length) return card.cloze.answers.map((answer) => answer.value).join('；');
  return clip(card.answer);
}

export function wrongDetail(state, ref) {
  const { deck, card } = findCard(state, ref, '这道题');
  let latest = null;
  for (const attempt of state.attempts || []) {
    if (!isMasteryAttempt(attempt) || attempt.deckId !== deck.id || attempt.quiz_id !== card.id) continue;
    if (!latest || attempt.timestamp >= latest.timestamp) latest = attempt;
  }
  // The run entry holds what was answered, as the question looked then.
  const entry = latest?.runId
    ? state.runs?.find((run) => run.id === latest.runId)?.entries?.findLast((e) => e.card?.id === card.id && !e.retry && e.feedback)
    : null;
  const shown = entry?.card || card;
  const answer = entry ? learnerAnswer(shown, entry.feedback, { selfGraded: latest?.assessment === 'self' }) : null;
  const selfGrade = answer?.kind === 'self-assessment' ? answer.grade : null;
  const explanation = shown.explanation
    || (Array.isArray(shown.options) ? shown.options.filter((option) => !option.correct && entry?.feedback?.selected?.includes(option.id))
      .map((option) => option.explanation).filter(Boolean).join(' ') : '')
    || '';
  return {
    deckId: deck.id, cardId: card.id, kind: card.kind, prompt: card.prompt,
    yourAnswer: answer && selfGrade === null ? answer.text : null,
    selfGrade,
    lastGrade: latest?.grade ?? null,
    correctAnswer: correctAnswerOf(shown),
    explanation: clip(explanation, 800),
    misconception: clip(shown.misconception, 300),
  };
}
