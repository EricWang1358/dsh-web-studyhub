/* The links a learning note holds (#1017), browser-safe: written by lib/contexts/notes/question-note.js, read by the note page (ui/BlogNotes.jsx).
   A fragment link, so the reader's sanitizer keeps it and a public copy of the note shows a plain link that goes nowhere. Pure. */

/** The link of a card's citation in a note: the note page reads it (card.get) and opens the reader at that quote. */
export const citeHref = (deckId, cardId, index) => `#studyhub-cite/${encodeURIComponent(deckId)}/${encodeURIComponent(cardId)}/${index}`;
/** { deckId, cardId, index } of a citeHref, else null. */
export function parseCiteHref(href) {
  const match = /^#studyhub-cite\/([^/]+)\/([^/]+)\/(\d+)$/.exec(String(href ?? ''));
  if (!match) return null;
  try { return { deckId: decodeURIComponent(match[1]), cardId: decodeURIComponent(match[2]), index: Number(match[3]) }; } catch { return null; }
}
