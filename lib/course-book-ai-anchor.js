/* The words an AI block is about, found again inside a rendered paragraph (复习全书 M4, the dashed underline of ui/book/ai-anchors.js). Pure, browser-safe:
   the page hands over the text of the paragraph's text nodes in reading order (so words across a <strong> or a link are one run) and the quotes, and gets back,
   per run of words, which pieces of which text nodes to mark. Matching is the quote locator's (the words as written, else their letters and digits), so
   spacing and Markdown marks do not matter. Words that are not found, or that would overlap another block's words, get no mark; the block is unaffected. */
import { createLocator } from './quote-locate.js';

const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
/** A fuzzy hit much longer than the quote is a stretch of text that merely starts and ends alike: not the words. */
const stretched = (hit, quote) => hit.end - hit.start > quote.length * 3 + 20;

/** The pieces of `texts` (one string per text node) a [start, end) range of the joined text covers: [{ index, from, to }] with from < to. */
export function piecesOf(texts, start, end) {
  const out = [];
  let at = 0;
  texts.forEach((text, index) => {
    const from = Math.max(start, at) - at, to = Math.min(end, at + text.length) - at;
    if (to > from) out.push({ index, from, to });
    at += text.length;
  });
  return out;
}

/**
 * texts: the text of each text node, in order; anchors: [{ id, quote }] (the words of each block). -> [{ ids, start, end, pieces }] in reading order:
 * `ids` the blocks that share these words (the same words twice is one mark), `pieces` where they are ({ index, from, to } per text node).
 */
export function anchorSegments(texts, anchors) {
  const joined = (texts || []).join(''), locate = createLocator(joined), groups = [];
  for (const { id, quote } of anchors || []) {
    const words = squash(quote);
    if (!words || !joined) continue;
    const hit = locate(words);
    if (!hit || hit.end <= hit.start || stretched(hit, words)) continue;
    const same = groups.find(group => group.start === hit.start && group.end === hit.end);
    if (same) { if (!same.ids.includes(id)) same.ids.push(id); continue; }
    if (groups.some(group => hit.start < group.end && group.start < hit.end)) continue;
    groups.push({ ids: [id], start: hit.start, end: hit.end });
  }
  return groups.sort((a, b) => a.start - b.start).map(group => ({ ...group, pieces: piecesOf(texts, group.start, group.end) }));
}
