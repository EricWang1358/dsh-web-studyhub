// The model's review applies to the card content it saw, not to later edits.
// This module stays browser-safe so the draft editor can show the state before saving.
const REVIEW_FIELDS = [
  "kind", "topic", "objective", "prompt", "answer", "hint", "explanation",
  "misconception", "citations", "options", "rubric", "cloze", "followUp", "debrief",
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Where a citation's quote stands in its source (citation.at = { start, end }) is stamped by the pipeline AFTER the review (lib/card-places.js stampPlaces, called from lib/batch.js
// once a part has passed its review): derived position metadata, not content the reviewer judged. The quote and the sourceId stay in the fingerprint, so a changed passage still
// reads as an edit; a selection (the learner's own pick) also stays. Only the key `at` of a citation is left out.
const withoutPlaces = (citations) => (Array.isArray(citations)
  ? citations.map((citation) => {
    if (!citation || typeof citation !== "object" || Array.isArray(citation) || !("at" in citation)) return citation;
    const { at: _place, ...rest } = citation;
    return rest;
  })
  : citations);

function fingerprintOf(card, { places }) {
  const content = Object.fromEntries(REVIEW_FIELDS.filter((key) => card[key] !== undefined)
    .map((key) => [key, key === "citations" && !places ? withoutPlaces(card[key]) : card[key]]));
  const serialized = JSON.stringify(canonical(content));
  // FNV-1a over UTF-16 code units. This is a change detector, not an auth token.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= BigInt(serialized.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${serialized.length}:${hash.toString(16).padStart(16, "0")}`;
}

export const reviewedCardFingerprint = (card) => fingerprintOf(card, { places: false });

/**
 * What marks written before the position was left out used to be: the same content with each citation's `at` included. A mark made after the position was stamped (a repair, the
 * publication check, a card taken over from a bank) carries it, and the card it was made for still matches it, so it must not turn into "edited" overnight.
 */
export const legacyReviewedCardFingerprint = (card) => fingerprintOf(card, { places: true });

/**
 * Is this card what the review saw? `mark` is the fingerprint stored for the card (draft.editorial.reviewedCards[card.id]). True when it matches the card's fingerprint, or, for a mark
 * written before the position was left out, the card exactly as it was then. Any other difference is an edit after the review.
 */
export function cardMatchesReview(mark, card) {
  if (typeof mark !== "string" || !card) return false;
  if (mark === reviewedCardFingerprint(card)) return true;
  return Array.isArray(card.citations) && card.citations.some((citation) => citation && typeof citation === "object" && "at" in citation)
    && mark === legacyReviewedCardFingerprint(card);
}

// A committed deck is deep-frozen, so what its cards fingerprint to cannot change: the snapshot asks for every deck on every
// changed poll, and the fingerprint (canonical JSON of each card) was a third of the snapshot's own time. A draft being edited is
// not frozen and is always recomputed.
const statusOfFrozen = new WeakMap();
export function reviewedCardStatus(draft) {
  const frozen = Object.isFrozen(draft) && Object.isFrozen(draft.cards) && Object.isFrozen(draft.editorial);
  if (frozen && statusOfFrozen.has(draft)) return statusOfFrozen.get(draft);
  const marks = draft.editorial?.reviewedCards;
  let status = null;
  if (marks && typeof marks === "object" && !Array.isArray(marks)) {
    const cards = draft.cards || [];
    const unchanged = cards.filter((card) => cardMatchesReview(marks[card.id], card)).length;
    status = { unchanged, changed: cards.length - unchanged, total: cards.length };
  }
  if (frozen) statusOfFrozen.set(draft, status);
  return status;
}
