export const INDEPENDENT_SOURCE = "independent-source";
export const JSON_CARD_SOURCE = "json-card-self-reference";
export const AI_DRAFTED_SOURCE = "ai-drafted-unverified";

export const AI_DRAFTED_TITLE_RE = /AI\s*撰写\s*[·・-]\s*未核对/i;

export function normalizeSourceProvenance(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === INDEPENDENT_SOURCE || value === JSON_CARD_SOURCE || value === AI_DRAFTED_SOURCE) return value;
  throw new Error("Invalid source provenance");
}

export function isJsonCardSource(source) {
  return source?.provenance === JSON_CARD_SOURCE ||
    (source?.provenance === undefined && /^JSON 导入：/.test(source?.title || ""));
}

export function isAiDraftedSource(source) {
  return source?.provenance === AI_DRAFTED_SOURCE ||
    (source?.provenance === undefined && AI_DRAFTED_TITLE_RE.test(source?.title || ""));
}

export function resolveSourceProvenance(source) {
  if (isJsonCardSource(source)) return JSON_CARD_SOURCE;
  if (isAiDraftedSource(source)) return AI_DRAFTED_SOURCE;
  return INDEPENDENT_SOURCE;
}

export function selfCitedCardCount(cards, sources) {
  const selfIds = new Set(sources.filter(isJsonCardSource).map((source) => source.id));
  return cards.filter((card) => Array.isArray(card.citations) && card.citations.length &&
    card.citations.every((ref) => selfIds.has(ref.sourceId))).length;
}

export function aiDraftedCitedCardCount(cards, sources) {
  if (!Array.isArray(cards) || !Array.isArray(sources) || !cards.length || !sources.length) return 0;
  const aiIds = new Set(sources.filter(isAiDraftedSource).map((source) => source.id));
  if (!aiIds.size) return 0;
  return cards.filter((card) =>
    (Array.isArray(card?.citations) && card.citations.some((ref) => aiIds.has(ref?.sourceId))) ||
    (Array.isArray(card?.selections) && card.selections.some((sel) => aiIds.has(sel?.sourceId)))
  ).length;
}
