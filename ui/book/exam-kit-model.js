/* The exam answer kit's words as the page draws them (ui/book/BookExamKit.jsx): a template cut into its words and its [slots], a fill cut into its slot names
   and values ("Seeds: prescriptions ｜ Capability: open APIs"). KaTeX math (`$...$`, `$$...$$`, `\[...\]`, `\(...\)`), code spans, footnotes (`[^1]`), and
   Markdown links/images are never split as slots. Pure, no React. */

const SLOT = /\[[^\][\n]{1,80}\]/g;
const PROTECTED = [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /`[^`\n]+`/g, /\$\$[\s\S]*?\$\$/g, /\\\[[\s\S]*?\\\]/g, /\\\([\s\S]*?\\\)/g, /(?<!\\)\$(?!\$)(?:\\.|[^$\\\n])+\$/g];

function protectedRanges(text) {
  const ranges = [];
  for (const re of PROTECTED) {
    for (const found of text.matchAll(re)) ranges.push([found.index, found.index + found[0].length]);
  }
  return ranges;
}

const inProtected = (ranges, start, end) => ranges.some(([a, b]) => start < b && end > a);

/** -> [{ text, slot? }]: the template's words, each [slot] a part of its own, safely preserving KaTeX math and Markdown syntax. */
export function templateParts(template) {
  const parts = [], text = String(template ?? '');
  if (!text) return parts;
  const blocked = protectedRanges(text);
  let at = 0;
  for (const found of text.matchAll(SLOT)) {
    const start = found.index, end = start + found[0].length, inner = found[0].slice(1, -1);
    if (inProtected(blocked, start, end)) continue;
    if (inner.startsWith('^')) continue;
    if (start > 0 && text[start - 1] === '!') continue;
    if (text[end] === '(' || text[end] === '[') continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: found[0], slot: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** -> [{ slot?, value }]: the fill's "Slot: value" pairs (separated by ｜ or |); words that name no slot stay whole. */
export function fillParts(fill) {
  return String(fill ?? '').split(/\s*[｜|]\s*/).filter(Boolean).map(part => {
    const found = /^([^:：]{1,40})[:：]\s*(.+)$/s.exec(part);
    return found ? { slot: found[1].trim(), value: found[2].trim() } : { value: part };
  });
}
