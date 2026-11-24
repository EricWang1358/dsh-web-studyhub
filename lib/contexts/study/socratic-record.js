/* The inline Socratic aggregate kept on a question (card.socratic, #1316) and the one way it is read: the wrong book row, its detail and the statistics.
   A Socratic step is not an answer, so it never enters the answer log (state.attempts); like guided teaching's card.retell, the card keeps the aggregate. */

export const SOCRATIC_STAGES = Object.freeze(['ask', 'answer', 'judge', 'retell', 'summary']);
export const SOCRATIC_MAX_HINT_LEVEL = 2;
/** The stages a card's record rests in between steps: 'ask' is only the opening turn's. */
const RESTING_STAGES = SOCRATIC_STAGES.filter((stage) => stage !== 'ask');

const record = (card) => (card?.socratic && typeof card.socratic === 'object' ? card.socratic : null);
const highestHint = (socratic) => Math.max(0, Math.min(SOCRATIC_MAX_HINT_LEVEL, Number(socratic.maxHintLevelUsed ?? socratic.hintLevel) || 0));

/** "This question used hint level N": what the wrong book shows of a question's Socratic tutoring, or null when it had none. */
export function socraticBadge(card) {
  const socratic = record(card);
  return socratic ? { stage: socratic.stage, hintLevel: highestHint(socratic), retellPassed: Boolean(socratic.retellPassed) } : null;
}

/** Statistics over the questions tutored since `sinceMs`: how many, how many retold, by highest hint level and by stage. */
export function socraticTally(cards, sinceMs = 0) {
  const tally = {
    cards: 0,
    retold: 0,
    hintLevels: Object.fromEntries(Array.from({ length: SOCRATIC_MAX_HINT_LEVEL + 1 }, (_, level) => [level, 0])),
    stages: Object.fromEntries(RESTING_STAGES.map((stage) => [stage, 0])),
  };
  for (const card of cards || []) {
    const socratic = record(card);
    if (!socratic || !(Number(socratic.updatedAt) >= sinceMs)) continue;
    tally.cards += 1;
    if (socratic.retellPassed) tally.retold += 1;
    tally.hintLevels[highestHint(socratic)] += 1;
    if (Object.hasOwn(tally.stages, socratic.stage)) tally.stages[socratic.stage] += 1;
  }
  return tally;
}
