/** The text a selected-passage question is written from. A short table cell needs its nearby labels as evidence;
    the selected position stays exact and bounded surrounding text supplies the context. Shared by the generation
    pipeline (lib/contexts/generation/selection.js) and its token estimate, so both read the same evidence. */
export function selectionEvidenceText(sourceText, selection) {
  const text = String(sourceText ?? '');
  if (selection.quote.length >= 12) return selection.quote;
  return text.slice(Math.max(0, selection.start - 300), Math.min(text.length, selection.end + 300));
}
