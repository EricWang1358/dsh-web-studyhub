/* Which footnote each mark of a 复习全书 file cites, read the way book.write reads a file (lib/book-footnotes.js takeFootnotes: the first definition of
   its key AFTER the mark, else the last one), so a file with several 出处 lists that share a key ([^1] of the first part, [^1] of a section written
   after it) keeps every mark on its own list. Used by book.write's structural ops (lib/book-section-ops.js): a section that moves or goes takes along
   only the lists nothing outside it cites; a list a mark outside cites stays where it is. Pure, on lines. */
import { DEFINITION, isLabelLine } from './book-footnotes.js';

const MARK = /\[\^([\w-]{1,40})\](?!:)/g;
const isDefinition = line => DEFINITION.test(line.trim());

/** [{ line, key, def }]: every mark (outside definition lines) with the line of the definition it cites; a mark with no definition is left out. */
export function bindings(lines) {
  const defs = new Map();
  lines.forEach((line, at) => { const found = DEFINITION.exec(line.trim()); if (found) defs.set(found[1], [...(defs.get(found[1]) ?? []), at]); });
  const out = [];
  lines.forEach((line, at) => {
    if (isDefinition(line)) return;
    for (const match of line.matchAll(MARK)) { const list = defs.get(match[1]); if (list) out.push({ line: at, key: match[1], def: list.find(def => def > at) ?? list.at(-1) }); }
  });
  return out;
}

/** The footnote lists: runs of definitions with their 出处 label and the blank lines between, as [from, to). */
function listsOf(lines) {
  const out = [];
  let from = null, last = null;
  lines.forEach((line, at) => {
    const part = isDefinition(line) || isLabelLine(line), blank = !line.trim();
    if (part) { if (from === null) from = at; last = at; return; }
    if (blank && from !== null) return;
    if (from !== null) { if (lines.slice(from, last + 1).some(isDefinition)) out.push([from, last + 1]); from = null; }
  });
  if (from !== null && lines.slice(from, last + 1).some(isDefinition)) out.push([from, last + 1]);
  return out;
}

/** Of the lines [from, to), those that stay where they are when the range moves or goes: each footnote list in it that a mark OUTSIDE the range
    cites, and every line `fixed` names. -> Set of line indexes. */
export function stayingLines(lines, from, to, fixed = () => false) {
  const bound = bindings(lines), out = new Set();
  for (let at = from; at < to; at += 1) if (fixed(lines[at])) out.add(at);
  for (const [a, b] of listsOf(lines)) {
    if (a < from || b > to) continue;
    if (bound.some(item => item.def >= a && item.def < b && (item.line < from || item.line >= to))) for (let at = a; at < b; at += 1) out.add(at);
  }
  return out;
}

/** `at` moved up over the 出处 list (definitions, its label, blank lines) that ends the lines before it: a section put at the end of another goes before
    that list, as a reader expects (the writer checks that every mark still cites its own footnote, else puts it after the list). */
export function beforeLists(lines, at) {
  let up = at, seen = false;
  while (up > 0 && (!lines[up - 1].trim() || isDefinition(lines[up - 1]) || isLabelLine(lines[up - 1]))) { if (lines[up - 1].trim()) seen = true; up -= 1; }
  return seen ? up : at;
}

/** After `removed` lines went: the indexes (of the original lines) of definitions only the removed marks cited, and of 出处 labels whose list then
    holds no definition. They go with the text that cited them; a definition nothing cited before stays as it was. */
export function orphanedBy(lines, removed) {
  const bound = bindings(lines), out = new Set();
  const citers = new Map();
  for (const item of bound) citers.set(item.def, [...(citers.get(item.def) ?? []), item.line]);
  for (const [def, from] of citers) if (!removed.has(def) && from.every(line => removed.has(line))) out.add(def);
  for (const [a, b] of listsOf(lines)) {
    const left = [];
    for (let at = a; at < b; at += 1) if (isDefinition(lines[at]) && !removed.has(at) && !out.has(at)) left.push(at);
    if (!left.length) for (let at = a; at < b; at += 1) if (isLabelLine(lines[at]) && !removed.has(at)) out.add(at);
  }
  return out;
}

/** The definition lines outside `inside` (a Set of line indexes) that marks inside it cite: copied along when that text leaves the file. */
export const citedFrom = (lines, inside) => [...new Set(bindings(lines).filter(item => inside.has(item.line) && !inside.has(item.def)).map(item => item.def))].sort((a, b) => a - b);

/** What the marks cite, counted: Map 'key\u0000definition text' -> how many marks. */
export function citations(lines) {
  const counts = new Map();
  for (const item of bindings(lines)) { const id = `${item.key}\u0000${DEFINITION.exec(lines[item.def].trim())[2].trim()}`; counts.set(id, (counts.get(id) ?? 0) + 1); }
  return counts;
}
