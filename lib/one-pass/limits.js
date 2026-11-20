/* ONE PASS (docs/plans/2026-11-21-feat-one-pass-generation-plan.md): the numbers of the strategy, in one place and nowhere else.
   Every one was measured in the plan's third round (section 10) with a thinking model on an English and a Chinese material. */

export const ONE_PASS_LIMITS = Object.freeze({
  /** The most characters of material one write call is given. Consecutive sections are packed up to it; a longer section is given alone, never cut. */
  portionChars: 9000,
  /** The most cards one write call is asked for: a longer reply came back broken in the plan's second round and lost a whole portion. */
  cardsPerReply: 12,
  /** The most cards one review call judges: a review of 18 cards judged very differently from one of 7 (plan, section 5 item 4). */
  reviewBatch: 7,
  /** A card whose correct option is longer than the longest wrong option by more than this ratio is sent back to have its options rewritten. */
  optionLengthRatio: 1.25,
  /** The characters of material on each side of a card's quote that the review is given, instead of the whole material. */
  windowChars: 350,
  /** The lower end of the question forecast: the share of the planned questions a one-pass run keeps at least (measured 88% and 100%; the rest is margin). */
  forecastKeepShare: 0.8,
  /** The most cards the final same-fact merge sends in its one call (lib/one-pass/merge.js); a run with more skips that call and keeps the program's merge only. */
  sameFactCards: 600,
  /** The most cards one group of the same-fact reply may hold; a larger group is not believed and removes nothing. */
  sameFactGroup: 3,
  /** The most of a round's cards the same-fact reply may remove (at least one may always go); a reply that would remove more is ignored and every card stays. */
  sameFactShare: 0.2,
});

/** The question kinds one pass writes. A run that asks for any other kind is written by the staged pipeline. */
export const ONE_PASS_KINDS = Object.freeze(['quiz']);
