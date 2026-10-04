/* Search inside the reader. Matches are found in the rendered text of the reading
   column (case, width and extra whitespace ignored), turned into DOM ranges, and
   painted with the CSS Custom Highlight API: the page is never changed, so a
   search cannot disturb the passage marks or the selection tools. */
import { spanFormulas } from './formula.js';

/**
 * Folds text for matching: NFKC, lower case, runs of whitespace as one space, no leading
 * space. starts[i] / ends[i] give the original UTF-16 span of folded character i.
 */
export function foldWithMap(text) {
  let folded = '', index = 0;
  const starts = [], ends = [];
  for (const char of String(text ?? '')) {
    const start = index, end = index + char.length;
    index = end;
    if (/\s/.test(char)) {
      if (folded && !folded.endsWith(' ')) { folded += ' '; starts.push(start); ends.push(end); }
      else if (folded.endsWith(' ')) ends[ends.length - 1] = end;
      continue;
    }
    const piece = char.normalize('NFKC').toLowerCase();
    folded += piece;
    for (let at = 0; at < piece.length; at++) { starts.push(start); ends.push(end); }
  }
  return { folded, starts, ends };
}

/** The query as it is matched: folded and trimmed. */
export const foldQuery = query => foldWithMap(query).folded.trim();

/** Offsets (into the folded text) of every non-overlapping match of the folded needle. */
export function matchOffsets(folded, needle, limit = 1000) {
  const offsets = [];
  if (!needle) return offsets;
  for (let at = folded.indexOf(needle); at >= 0 && offsets.length < limit; at = folded.indexOf(needle, at + needle.length)) offsets.push(at);
  return offsets;
}

function textNodes(root) {
  const nodes = [], walker = root.ownerDocument.createTreeWalker(root, 4);
  let raw = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-study-marker], script, style')) continue;
    nodes.push({ node, start: raw.length });
    raw += node.textContent;
  }
  return { nodes, raw };
}

/** The last node that starts at or before `at` (strictly before it when `strict`). */
function lastStarting(nodes, at, strict = false) {
  let low = 0, high = nodes.length - 1, found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (strict ? nodes[middle].start < at : nodes[middle].start <= at) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return nodes[found];
}

/** DOM ranges for every match of `query` in the text of `root`, in reading order. */
export function findRanges(root, query, { limit = 1000 } = {}) {
  const needle = foldQuery(query);
  if (!root || !needle) return [];
  const { nodes, raw } = textNodes(root);
  if (!nodes.length) return [];
  const { folded, starts, ends } = foldWithMap(raw);
  const ranges = [];
  for (const at of matchOffsets(folded, needle, limit)) {
    const from = starts[at], to = ends[at + needle.length - 1];
    const first = lastStarting(nodes, from), last = lastStarting(nodes, to, true);
    const range = root.ownerDocument.createRange();
    try {
      range.setStart(first.node, Math.min(from - first.start, first.node.textContent.length));
      range.setEnd(last.node, Math.min(to - last.start, last.node.textContent.length));
      spanFormulas(range); // a match inside a formula paints the drawn formula, not its hidden source
      ranges.push(range);
    } catch { /* a node changed under us: skip this match */ }
  }
  return ranges;
}

export const supportsHighlights = () => typeof window !== 'undefined' && !!window.CSS?.highlights && typeof window.Highlight === 'function';

/** Paint every match and the current one; returns the function that clears them. */
export function paintMatches(ranges, current) {
  if (!supportsHighlights()) return () => {};
  const registry = window.CSS.highlights;
  if (ranges.length) registry.set('study-find', new window.Highlight(...ranges)); else registry.delete('study-find');
  if (ranges[current]) registry.set('study-find-current', new window.Highlight(ranges[current])); else registry.delete('study-find-current');
  return () => { registry.delete('study-find'); registry.delete('study-find-current'); };
}
