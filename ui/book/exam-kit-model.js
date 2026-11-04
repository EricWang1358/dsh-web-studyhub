/* The exam answer kit's words as the page draws them (ui/book/BookExamKit.jsx): a template cut into its words and its [slots], a fill cut into its slot names
   and values ("Seeds: prescriptions ｜ Capability: open APIs"). Pure, no React. */

const SLOT = /\[[^\][\n]{1,80}\]/g;

/** -> [{ text, slot? }]: the template's words, each [slot] a part of its own. */
export function templateParts(template) {
  const parts = [], text = String(template ?? '');
  let at = 0;
  for (const found of text.matchAll(SLOT)) {
    if (found.index > at) parts.push({ text: text.slice(at, found.index) });
    parts.push({ text: found[0], slot: true });
    at = found.index + found[0].length;
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
