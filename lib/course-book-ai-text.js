/* 弄懂 / 「加一段」 in the 复习全书 (M4, docs/plans/review-book.md): an AI block, written into the point's own file `<leaf>.mine.md`, anchored to the passage
   it is about. Pure text rules, browser-safe (the page, the stitch and the export place the blocks with these).

     <!-- sh:ai id=<id> at=<anchor hash> state=new|kept -->
     关于：「the selected words」          (the visible first line: what the block is about)

     the text (补充 (资料以外) marked where it goes beyond the materials)
     <!-- /sh:ai -->

   The anchor is the selected words with a little of the text before and after them, in the generated (or own) file of the point. The block is shown right
   AFTER the paragraph that holds the selected words (found again with the quote locator, so a paragraph that moved or was edited a little still holds it); a
   block whose words are no longer in the point is shown at the end of the point, marked 原位置已变. A block anchored to a heading (「在这里加一段」, `at=h:<id>`)
   is shown right under its heading. The block is the learner's text once written: the program never edits it, except 重新生成 / 删除 the learner asks for. */
import { createLocator } from './quote-locate.js';

export const CONTEXT_CHARS = 32;
const AI = /<!-- sh:ai id=(\S+) at=(\S+) state=(new|kept) -->\n((?:(?!<!-- sh:ai )[\s\S])*?)\n<!-- \/sh:ai -->/g;
export const AI_MARKER_LINE = /^<!-- \/?sh:ai\b[^>]*-->$/;
const WORDS = { zh: { about: '关于', open: '「', close: '」', sep: '：' }, en: { about: 'About', open: '“', close: '”', sep: ': ' } };
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** A short stable hash (FNV-1a, 32 bits), browser-safe. */
export function shortHash(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text ?? '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}

/** The anchor of selected words in a text: where they are (the quote locator, so Markdown marks or spacing do not matter) and the hash of them with a little
    context around. -> { start, end, hash, quote } or null when the text does not hold them. */
export function anchorIn(text, words) {
  const source = String(text ?? ''), quote = squash(words);
  if (!quote) return null;
  const at = source.indexOf(quote) >= 0 ? { start: source.indexOf(quote), end: source.indexOf(quote) + quote.length } : createLocator(source)(quote);
  if (!at) return null;
  const context = source.slice(Math.max(0, at.start - CONTEXT_CHARS), Math.min(source.length, at.end + CONTEXT_CHARS));
  return { start: at.start, end: at.end, quote, hash: shortHash(squash(context)) };
}
export const headingAnchor = headingId => `h:${headingId}`;

/** One block. `about`: the selected words (or the heading's title); `body`: the model's text, already checked. */
export function aiBlock({ id, at, about, body, state = 'new' }, language) {
  const words = wordsOf(language), shown = squash(about).replace(/[「」“”]/g, '').slice(0, 120);
  return `<!-- sh:ai id=${id} at=${at} state=${state} -->\n${words.about}${words.sep}${words.open}${shown}${words.close}\n\n${String(body ?? '').trim()}\n<!-- /sh:ai -->`;
}

/** The AI blocks of a text: [{ id, at, state, about, body, raw, start, end }]. `about` is the selected words of its first line. */
export function aiBlocks(text) {
  return [...String(text ?? '').matchAll(AI)].map(match => {
    const [first, ...rest] = match[4].split('\n'), about = /^[^：:]*[：:]\s*[「“](.*)[」”]\s*$/.exec(first)?.[1] ?? '';
    return { id: match[1], at: match[2], state: match[3], about, first, body: rest.join('\n').trim(), raw: match[0], start: match.index, end: match.index + match[0].length };
  });
}

/** The text with the block of `id` replaced by `next` (a whole block), or without it when `next` is ''. Null when there is no such block. */
export function replaceAiBlock(text, id, next) {
  const source = String(text ?? ''), block = aiBlocks(source).find(item => item.id === id);
  if (!block) return null;
  if (next) return source.slice(0, block.start) + next + source.slice(block.end);
  const from = source.slice(0, block.start).replace(/\n{1,2}$/, '').length;
  return source.slice(0, from) + source.slice(block.end).replace(/^\n(?=\n)/, '');
}

/** A new block in the own file: right after block `after` (a follow-up goes under the block it continues), else at the end. Never over existing text. */
export function insertAiBlock(text, block, { after } = {}) {
  const source = String(text ?? ''), parent = after ? aiBlocks(source).find(item => item.id === after) : null;
  if (parent) return `${source.slice(0, parent.end)}\n\n${block}${source.slice(parent.end)}`;
  return source.trim() ? `${source.replace(/\n*$/, '')}\n\n${block}\n` : `${block}\n`;
}

/** Paragraphs of a text (blank-line separated, a code fence kept whole): [{ start, end }]. */
function paragraphs(text) {
  const out = [], lines = text.split('\n');
  let at = 0, start = null, fenced = false;
  lines.forEach((line, index) => {
    const end = at + line.length;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (line.trim() || fenced) { if (start === null) start = at; } else if (start !== null) { out.push({ start, end: at - 1 }); start = null; }
    if (index === lines.length - 1 && start !== null) out.push({ start, end });
    at = end + 1;
  });
  return out;
}

/**
 * Where the blocks of a point go: `files` [{ name, text }] in reading order (its generated file, then its own file without the blocks), `blocks` (aiBlocks of
 * the own file). -> { top: [{ block, status }] (under the heading), parts: [{ name, text } | { block, status }], lost } where
 * `status` is 'same' (the words and their context as they were), 'moved' (found again: the paragraph moved or changed a little) or, for `lost` (shown at the end of the point, 原位置已变), 'gone'.
 */
export function weaveBlocks(files, blocks) {
  const placed = new Map(), lost = [], top = [];
  for (const block of blocks) {
    if (block.at.startsWith('h:')) { top.push({ block, status: 'same' }); continue; }
    let found = null;
    for (const file of files) {
      const anchor = anchorIn(file.text, block.about);
      if (!anchor) continue;
      const paragraph = paragraphs(file.text).find(item => anchor.start >= item.start && anchor.start <= item.end) || { end: file.text.length };
      found = { name: file.name, cut: paragraph.end, status: anchor.hash === block.at ? 'same' : 'moved' };
      break;
    }
    if (!found) { lost.push({ block, status: 'gone' }); continue; }
    const key = `${found.name}\u0000${found.cut}`;
    if (!placed.has(key)) placed.set(key, { ...found, blocks: [] });
    placed.get(key).blocks.push({ block, status: found.status });
  }
  const parts = [];
  for (const file of files) {
    const cuts = [...placed.values()].filter(item => item.name === file.name).sort((a, b) => a.cut - b.cut);
    let from = 0;
    for (const cut of cuts) {
      const piece = file.text.slice(from, cut.cut).trim();
      if (piece) parts.push({ name: file.name, text: piece });
      parts.push(...cut.blocks);
      from = cut.cut;
    }
    const rest = file.text.slice(from).trim();
    if (rest) parts.push({ name: file.name, text: rest });
  }
  return { top, parts, lost };
}

/** The own file without its AI blocks (they are shown in their places). */
export const withoutAiBlocks = text => aiBlocks(text).reduceRight((rest, block) => rest.slice(0, block.start) + rest.slice(block.end), String(text ?? '')).replace(/\n{3,}/g, '\n\n').trim();
