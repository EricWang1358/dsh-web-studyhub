/* Pure helpers shared by the selected-passage pipeline (lib/contexts/generation), its token estimate and the reader's
   learning panel (ui/document-preview), so all three read a passage the same way. */

/** The text a selected-passage question is written from. A short table cell needs its nearby labels as evidence;
    the selected position stays exact and bounded surrounding text supplies the context. */
export function selectionEvidenceText(sourceText, selection) {
  const text = String(sourceText ?? '');
  if (selection.quote.length >= 12) return selection.quote;
  return text.slice(Math.max(0, selection.start - 300), Math.min(text.length, selection.end + 300));
}

/** Two selections are the same passage when they point at the same text of the same material. */
export const passageKey = selection => [selection?.sourceId || '', Number.isInteger(selection?.start) ? `${selection.start}:${selection.end}` : selection?.quote || ''].join('|');
