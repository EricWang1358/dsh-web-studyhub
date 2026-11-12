import { publicCard } from '../../domain.js';
import { currentFollowups } from '../../followup.js';
import { rubricAttemptPassed } from '../../course-method-progress.js';
import { cardReadingLocation } from '../../reading-order/card-reading-order.js';

/* The look-back of a finished practice round (#1009): one row per question of the round (a re-ask is the same question), in the order it was asked, for the
   result page's 「本轮题目」. The panel reads it once with review.lookBack {runId} (a read: it changes nothing). It is NOT part of the run's projection: every
   main-chat tool result of a run (review.get / answer / move / end) would carry a few KB per question, and the main chat is refused the read itself
   (lib/assistant-boundary.js). An answered question carries what the learner saw when it was answered (the card in its option order, the answer given, the
   solution with today's Q&A); an unanswered one carries only the question, so the answer is not spoiled before it is practised. While a question of the round
   is still open there are no rows, and a mock exam never has them (its report has its own rules). */

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
  const finished = run.closedAt || run.index >= run.entries.length;
  if (!finished || run.mode === 'exam') return [];
  const decks = new Map(s.decks.map((deck) => [deck.id, deck]));
  const live = (deckId, cardId) => decks.get(deckId)?.cards.find((card) => card.id === cardId);
  return run.entries.filter((entry) => !entry.retry).map((entry, at) => {
    const deckId = entry.deckId ?? run.deckId;
    const current = live(deckId, entry.card.id) || entry.card;
    const location = cardReadingLocation(current, s.sources);
    const status = statusOf(entry);
    const answered = status !== 'unanswered';
    return {
      number: at + 1, deckId, cardId: entry.card.id, kind: entry.card.kind, status,
      ...(entry.assistance?.hintUsed || entry.feedback?.hintGraded ? { hinted: true } : {}),
      ...(location?.page != null ? { page: location.page, ...(location.unit ? { unit: location.unit } : {}) } : {}),
      // The prompt once: in the card for an answered question, alone for an unanswered one.
      ...(answered ? {
        card: publicCard(entry.card, entry.order),
        feedback: entry.feedback,
        // The question as it was answered, with the Q&A it has now (a 帮我弄懂 answer may have arrived since).
        solution: { ...solution(entry.card), followups: currentFollowups(entry.keepSnapshot ? entry.card : current) },
      } : { prompt: String(entry.card.prompt || '') }),
    };
  });
}
