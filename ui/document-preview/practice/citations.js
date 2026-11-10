/* The passage a question points at, for "看这题的原文". Pure. The same reading of citations and selections as
   ui/CitationDisclosure.jsx (a citation carries its selection, or the card's selection of the same quote does). */
import { isJsonCardSource } from '../../../lib/source-provenance.js';

const keyOf = selection => JSON.stringify([selection?.documentId, selection?.revision, selection?.sourceId, selection?.start, selection?.end, selection?.quote]);

/**
 * The citations of `card` that point into a material the learner has, in the order they are cited: `{ sourceId, quote, selection?, source }`.
 * Passages that only cite an imported question's own JSON are not a source to check against and are left out.
 */
export function usableCitations(card, sources = []) {
  const byId = new Map(sources.map(source => [source.id, source])), selections = card?.selections || [];
  const list = (card?.citations || []).map(citation => ({ ...citation,
    selection: citation.selection || selections.find(selection => selection.sourceId === citation.sourceId && selection.quote === citation.quote) }));
  for (const selection of selections) if (!list.some(citation => citation.selection && keyOf(citation.selection) === keyOf(selection))) list.push({ sourceId: selection.sourceId, quote: selection.quote, selection });
  return list.filter(citation => byId.has(citation.sourceId) && !isJsonCardSource(byId.get(citation.sourceId))).map(citation => ({ ...citation, source: byId.get(citation.sourceId) }));
}

/** What opening a citation shows: `{ source, quote }`, where `source` carries the selection (so the reader opens at that passage and highlights the quote). */
export const citationTarget = citation => ({ source: citation.selection ? { ...citation.source, selection: citation.selection } : citation.source,
  quote: citation.quote || citation.selection?.quote || '' });

/**
 * The first citation of `card` that points into a material the learner has: `{ source, quote }`, where `source` carries the
 * selection (so the reader opens at that passage and highlights the quote). null when there is none.
 */
export function firstCitation(card, sources = []) {
  const usable = usableCitations(card, sources);
  const pick = usable.find(citation => citation.selection) || usable[0];
  return pick ? citationTarget(pick) : null;
}
