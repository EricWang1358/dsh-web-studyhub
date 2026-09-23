/** Use cited material first, then the sources that produced the draft. A lone
 * library source is unambiguous; multiple unrelated sources are not. */
export function repairSourcesForCard(card, draft, sources) {
  const citedIds = new Set(card.citations?.map((ref) => ref.sourceId) || []);
  const cited = sources.filter((source) => citedIds.has(source.id));
  if (cited.length) return cited;
  const originalIds = new Set(draft.editorial?.generation?.sourceIds || []);
  const original = sources.filter((source) => originalIds.has(source.id));
  return original.length ? original : sources.length === 1 ? sources : [];
}
