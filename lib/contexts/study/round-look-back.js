import { publicCard } from '../../domain.js';
import { currentFollowups } from '../../followup.js';
import { rubricAttemptPassed } from '../../course-method-progress.js';
import { cardReadingLocation } from '../../reading-order/card-reading-order.js';

/* The look-back of a finished practice round (#1009): one row per question of the round (a re-ask is the same question), in the order it was asked, for the
   result page's 「本轮题目」. It is part of the run's projection once the round is finished, so opening a row asks the host for nothing and can change nothing.
   An answered question carries what the learner saw when it was answered (the card in its option order, the answer given, the solution with today's Q&A);
   an unanswered one carries only the question, so the answer is not spoiled before it is practised. A mock exam never has it (its report has its own rules). */

/** How the first answer of a question went: right, wrong, self-reported (a hands-on task's 写完了), or not answered. The result page's counts use the same rule. */
function statusOf(entry) {
  const feedback = entry.feedback;
  if (!feedback) return 'unanswered';
  if (feedback.selfReported || feedback.assessment === 'self-report') return 'self';
  const passed = feedback.taskCheck
    ? rubricAttemptPassed({ assessment: 'task-static', taskCheck: feedback.taskCheck, correct: feedback.correct })
    : feedback.grade >= 3;
  return passed ? 'right' : 'wrong';
}

/**
 * The rows of the look-back. `s`: the library state; `run`: the finished run; `solution(card)`: the solution view the open question gets on reveal
 * (lib/study-state.js), so the look-back shows what the question showed.
 */
export function roundLookBack(s, run, solution) {
  const decks = new Map(s.decks.map((deck) => [deck.id, deck]));
  const live = (deckId, cardId) => decks.get(deckId)?.cards.find((card) => card.id === cardId);
  const retried = new Set(run.entries.filter((entry) => entry.retry && entry.feedback).map((entry) => `${entry.deckId ?? run.deckId}\0${entry.card.id}`));
  return run.entries.flatMap((entry, index) => (entry.retry ? [] : [{ entry, index }])).map(({ entry, index }, at) => {
    const deckId = entry.deckId ?? run.deckId;
    const current = live(deckId, entry.card.id) || entry.card;
    const location = cardReadingLocation(current, s.sources);
    const status = statusOf(entry);
    const answered = status !== 'unanswered';
    return {
      number: at + 1, index, deckId, cardId: entry.card.id, kind: entry.card.kind, topic: entry.card.topic || '', prompt: String(entry.card.prompt || ''), status,
      ...(entry.assistance?.hintUsed || entry.feedback?.hintGraded ? { hinted: true } : {}),
      ...(retried.has(`${deckId}\0${entry.card.id}`) ? { retried: true } : {}),
      ...(location?.page != null ? { page: location.page, ...(location.unit ? { unit: location.unit } : {}) } : {}),
      ...(answered ? {
        card: publicCard(entry.card, entry.order),
        feedback: entry.feedback,
        // The question as it was answered, with the Q&A it has now (a 帮我弄懂 answer may have arrived since).
        solution: { ...solution(entry.card), followups: currentFollowups(entry.keepSnapshot ? entry.card : current) },
      } : {}),
    };
  });
}
