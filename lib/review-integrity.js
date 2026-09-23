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

export function reviewedCardFingerprint(card) {
  const content = Object.fromEntries(REVIEW_FIELDS.filter((key) => card[key] !== undefined)
    .map((key) => [key, card[key]]));
  const serialized = JSON.stringify(canonical(content));
  // FNV-1a over UTF-16 code units. This is a change detector, not an auth token.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= BigInt(serialized.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${serialized.length}:${hash.toString(16).padStart(16, "0")}`;
}

export function reviewedCardStatus(draft) {
  const marks = draft.editorial?.reviewedCards;
  if (!marks || typeof marks !== "object" || Array.isArray(marks)) return null;
  const cards = draft.cards || [];
  const unchanged = cards.filter((card) => marks[card.id] === reviewedCardFingerprint(card)).length;
  return { unchanged, changed: cards.length - unchanged, total: cards.length };
}
