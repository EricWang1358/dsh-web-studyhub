/* Where one card points into the sources: the one reading of a card's links, for decks and drafts alike (资料掌握度, coverage). Pure, no Node modules. */

/**
 * Where one card points: Map<sourceId, { start, end }> over its selections and citations (the selection's offsets, else where the
 * cited quote first stands in the source text; null when unknown). `sources` is a Map<sourceId, source>.
 */
export function cardSourcePlaces(card, sources) {
  const places = new Map(), place = (sourceId, start, end) => {
    if (typeof sourceId !== 'string' || !sourceId) return;
    const known = places.get(sourceId);
    if (!known || (known.start === null && Number.isInteger(start))) places.set(sourceId, { start: Number.isInteger(start) ? start : null, end: Number.isInteger(end) ? end : null });
  };
  for (const selection of card.selections || []) place(selection?.sourceId, selection?.start, selection?.end);
  for (const citation of card.citations || []) {
    if (!citation) continue;
    if (citation.selection) place(citation.selection.sourceId || citation.sourceId, citation.selection.start, citation.selection.end);
    else {
      const text = sources.get(citation.sourceId)?.text, at = text && citation.quote ? String(text).indexOf(citation.quote) : -1;
      place(citation.sourceId, at >= 0 ? at : null, at >= 0 ? at + citation.quote.length : null);
    }
  }
  return places;
}

/**
 * Every place one card points to, one entry per selection and per citation (a card that cites two passages of one source is in both):
 * [{ sourceId, start, end }] with null offsets when unknown. A quote is found by `locate(sourceId)` (lib/quote-locate.js createLocator, which also
 * finds a quote written a little differently from the stored text); without it by plain search. Same sources, same order as cardSourcePlaces reads them.
 */
export function cardPlaceList(card, sources, locate) {
  const out = [], push = (sourceId, start, end) => {
    if (typeof sourceId !== 'string' || !sourceId) return;
    out.push({ sourceId, start: Number.isInteger(start) ? start : null, end: Number.isInteger(end) ? end : null });
  };
  for (const selection of card?.selections || []) push(selection?.sourceId, selection?.start, selection?.end);
  for (const citation of card?.citations || []) {
    if (!citation) continue;
    if (citation.selection) { push(citation.selection.sourceId || citation.sourceId, citation.selection.start, citation.selection.end); continue; }
    const quote = typeof citation.quote === 'string' ? citation.quote : '', text = sources.get(citation.sourceId)?.text;
    let found = null;
    if (quote && typeof text === 'string') { const at = text.indexOf(quote); found = at >= 0 ? { start: at, end: at + quote.length } : locate?.(citation.sourceId)?.(quote) ?? null; }
    push(citation.sourceId, found?.start, found?.end);
  }
  return out;
}
