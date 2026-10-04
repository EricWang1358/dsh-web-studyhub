/* Where linked passages are in the RENDERED text, and how they are painted (owner request, 2.3.2).
   The reader never changes the text for this: ranges are computed once per document or links change from one
   walk over the text nodes of each page, painted with the CSS Custom Highlight API (like search), and looked up
   again with Range.isPointInRange on click. Pure helpers over a DOM-like container, so they run under node:test. */
import { spanFormulas } from '../reader/formula.js';

export const HIGHLIGHT_NAMES = Object.freeze({ question: 'study-link-question', qa: 'study-link-qa', note: 'study-link-note' });
/** Where two kinds overlap, the higher priority decides the look: a question over a Q&A card over a note. */
const PRIORITY = { question: 2, qa: 1, note: 0 };

const SHOW_TEXT = 4;
const isSpace = char => /\s/.test(char);
const compact = value => String(value || '').replace(/\s/g, '');

/** The compact text (whitespace removed) of one page or the whole container, with the way back to its text nodes. */
function indexText(container, root) {
  const walker = container.ownerDocument.createTreeWalker(root, SHOW_TEXT), nodes = [], map = [];
  let raw = 0, text = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-study-marker]')) continue;
    const value = node.textContent;
    nodes.push({ node, start: raw });
    for (let index = 0; index < value.length; index++) if (!isSpace(value[index])) { map.push(raw + index); text += value[index]; }
    raw += value.length;
  }
  return { nodes, map, text };
}

/** The text node holding raw offset `at` (the last node starting at or before it; `strict` when it ends the range). */
function nodeAt(nodes, at, strict) {
  let low = 0, high = nodes.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (strict ? nodes[middle].start < at : nodes[middle].start <= at) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found < 0 ? null : nodes[found];
}

const commonSuffix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const commonPrefix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

/**
 * The position of a stored passage in compact text. The stored context comes from the source text, so Markdown
 * marks and layout it contains may not exist in the rendered text: first the exact context decides, and when it
 * rules everything out, a passage that is still unique, or clearly best matched by what context does agree, is used.
 */
function locate(index, selection) {
  const quote = compact(selection.quote), before = compact(selection.prefix), after = compact(selection.suffix);
  if (!quote) return null;
  const { text } = index, hits = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) hits.push(at);
  if (!hits.length) return null;
  const exact = hits.filter(at => (!before || (at >= before.length && text.startsWith(before, at - before.length))) && (!after || text.startsWith(after, at + quote.length)));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  if (hits.length === 1) return hits[0];
  const scored = hits.map(at => ({ at, score: commonSuffix(text.slice(Math.max(0, at - 40), at), before) + commonPrefix(text.slice(at + quote.length, at + quote.length + 40), after) }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score >= 4 && scored[0].score > scored[1].score ? scored[0].at : null;
}

/**
 * [{ group, range }] for every group whose passage is found in the rendered text. `groups` need `selection`
 * (sourceId, quote, prefix, suffix). One walk per page (or one for the whole container) however many groups there are.
 */
export function locateGroups(container, groups) {
  if (!container || !groups?.length) return [];
  const pages = new Map([...container.querySelectorAll('[data-study-source]')].map(page => [page.dataset.studySource, page]));
  const indexes = new Map(), entries = [];
  for (const group of groups) {
    const selection = group.selection;
    if (!selection?.quote) continue;
    const root = pages.get(selection.sourceId) || container;
    if (!indexes.has(root)) indexes.set(root, indexText(container, root));
    const index = indexes.get(root), at = locate(index, selection);
    if (at === null) continue;
    const length = compact(selection.quote).length, from = index.map[at], to = index.map[at + length - 1] + 1;
    const first = nodeAt(index.nodes, from, false), last = nodeAt(index.nodes, to, true);
    if (!first || !last) continue;
    try {
      const range = container.ownerDocument.createRange();
      range.setStart(first.node, Math.min(from - first.start, first.node.textContent.length));
      range.setEnd(last.node, Math.min(to - last.start, last.node.textContent.length));
      spanFormulas(range); // an underline over part of a formula covers the drawn formula
      entries.push({ group, range });
    } catch { /* the text changed under us: this passage is simply not underlined */ }
  }
  return entries;
}

const supported = () => typeof window !== 'undefined' && window.CSS?.highlights && typeof window.Highlight === 'function'
  ? { registry: window.CSS.highlights, Highlight: window.Highlight } : { registry: null, Highlight: null };

/** Paint every located passage in the highlight of its kind; returns the function that clears them all. */
export function paintLinkHighlights(entries, env = supported()) {
  const { registry, Highlight } = env || {};
  if (!registry || typeof Highlight !== 'function') return () => {};
  const byKind = {};
  for (const { group, range } of entries) (byKind[group.kind in PRIORITY ? group.kind : 'question'] ||= []).push(range);
  for (const kind of Object.keys(HIGHLIGHT_NAMES)) {
    if (!byKind[kind]?.length) { registry.delete(HIGHLIGHT_NAMES[kind]); continue; }
    const highlight = new Highlight(...byKind[kind]);
    highlight.priority = PRIORITY[kind];
    registry.set(HIGHLIGHT_NAMES[kind], highlight);
  }
  return () => { for (const name of Object.values(HIGHLIGHT_NAMES)) registry.delete(name); };
}

/** The passages under a point of the text (a node and an offset), the innermost first. Never throws on a replaced range. */
export function hitTest(entries, node, offset) {
  if (!node) return [];
  const found = [];
  for (const entry of entries) {
    try { if (entry.range.isPointInRange(node, offset)) found.push(entry); } catch { /* range no longer in the document */ }
  }
  return found.sort((a, b) => (a.group.selection?.quote?.length || 0) - (b.group.selection?.quote?.length || 0));
}

/** Whether a point (client pixels) is on the drawn text of a range, not just at a caret offset next to it. */
export function overText(range, x, y, slop = 1) {
  const rects = typeof range?.getClientRects === 'function' ? [...range.getClientRects()] : [];
  if (!rects.length) return true;
  return rects.some(rect => x >= rect.left - slop && x <= rect.right + slop && y >= rect.top - slop && y <= rect.bottom + slop);
}
