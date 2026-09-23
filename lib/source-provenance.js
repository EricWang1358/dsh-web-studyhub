export const JSON_CARD_SOURCE = "json-card-self-reference";

export function isJsonCardSource(source) {
  return source?.provenance === JSON_CARD_SOURCE ||
    (source?.provenance === undefined && /^JSON 导入：/.test(source?.title || ""));
}

export function selfCitedCardCount(cards, sources) {
  const selfIds = new Set(sources.filter(isJsonCardSource).map((source) => source.id));
  return cards.filter((card) => Array.isArray(card.citations) && card.citations.length &&
    card.citations.every((ref) => selfIds.has(ref.sourceId))).length;
}
