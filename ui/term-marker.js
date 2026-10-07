/**
 * `[[term]]`: a key term that an answer marks so the reader can make it clickable. The one definition of the
 * syntax, shared by the Markdown renderer and by whatever saves or copies an answer. A marker is one line, 1 to
 * 60 characters, with no brackets inside; anything else (unbalanced, empty, too long) is just text.
 */
export const TERM_SOURCE = String.raw`\[\[\s*([^\[\]\n]{0,58}?[^\s\[\]\n])\s*\]\]`;
export const TERM_PATTERN = new RegExp(TERM_SOURCE);

const unmarked = part => part.replace(new RegExp(TERM_SOURCE, 'g'), '$1');

/** The text without markers, for a saved card or a copy; code spans and fenced blocks keep what they say. */
export function stripTermMarkers(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('[[')) return text;
  let fenced = false;
  return text.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : line.split(/(`[^`\n]*`)/).map((part, i) => i % 2 ? part : unmarked(part)).join('');
  }).join('\n');
}
