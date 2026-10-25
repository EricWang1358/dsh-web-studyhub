/* Which footnote each mark of a 复习全书 file cites, read the way book.write reads a file (lib/book-footnotes.js takeFootnotes: the first definition of
   its key AFTER the mark, else the last one), so a file with several 出处 lists that share a key ([^1] of the first part, [^1] of a section written
   after it) keeps every mark on its own list. Used by book.write's structural ops (lib/book-section-ops.js): a section that moves or goes takes along
   only the lists nothing outside it cites; a list a mark outside cites stays where it is; and afterwards EACH mark must cite the footnote it cited
   before (tagMarks / markCitations: every mark carries its own tag through the op). Lines inside code fences are code: no mark, no definition, no list
   (takeFootnotes, #477's, still reads them: a known limit of the ordinary writes, not of these ops). Pure, on lines. */
import { DEFINITION, isLabelLine } from './book-footnotes.js';

const MARK = /\[\^([\w-]{1,40})\](?!:)(?:\u0001(\d+)\u0001)?/g;
const FENCE = /^\s*(```|~~~)/;
const TAG = /\u0001\d+\u0001/g;

/** The lines inside code fences (the fence lines too): a Set of indexes. */
function fencedOf(lines) {
  const out = new Set();
  let fenced = false;
  lines.forEach((line, at) => { if (FENCE.test(line)) { out.add(at); fenced = !fenced; } else if (fenced) out.add(at); });
  return out;
}
const isDefinitionAt = (lines, fenced, at) => !fenced.has(at) && DEFINITION.test(lines[at].trim());
const isLabelAt = (lines, fenced, at) => !fenced.has(at) && isLabelLine(lines[at]);

/** [{ line, key, def, tag? }]: every mark outside code and definition lines with the line of the definition it cites; a mark with none is left out. */
export function bindings(lines) {
  const fenced = fencedOf(lines), defs = new Map();
  lines.forEach((line, at) => { if (!isDefinitionAt(lines, fenced, at)) return; const key = DEFINITION.exec(line.trim())[1]; defs.set(key, [...(defs.get(key) ?? []), at]); });
  const out = [];
  lines.forEach((line, at) => {
    if (fenced.has(at) || isDefinitionAt(lines, fenced, at)) return;
    for (const match of line.matchAll(MARK)) {
      const list = defs.get(match[1]);
      if (list) out.push({ line: at, key: match[1], def: list.find(def => def > at) ?? list.at(-1), ...(match[2] ? { tag: match[2] } : {}) });
    }
  });
  return out;
}

/** The footnote lists: runs of definitions with their 出处 label and the blank lines between (outside code), as [from, to). */
function listsOf(lines) {
  const fenced = fencedOf(lines), out = [];
  let from = null, last = null;
  const close = () => { if (from !== null && lines.slice(from, last + 1).some((_, i) => isDefinitionAt(lines, fenced, from + i))) out.push([from, last + 1]); from = null; };
  lines.forEach((line, at) => {
    if (isDefinitionAt(lines, fenced, at) || isLabelAt(lines, fenced, at)) { if (from === null) from = at; last = at; return; }
    if (!line.trim() && !fenced.has(at) && from !== null) return;
    close();
  });
  close();
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
  const fenced = fencedOf(lines);
  let up = at, seen = false;
  while (up > 0 && !fenced.has(up - 1) && (!lines[up - 1].trim() || isDefinitionAt(lines, fenced, up - 1) || isLabelAt(lines, fenced, up - 1))) { if (lines[up - 1].trim()) seen = true; up -= 1; }
  return seen ? up : at;
}

/** After `removed` lines went: the indexes (of the original lines) of definitions only the removed marks cited, and of 出处 labels whose list then
    holds no definition. They go with the text that cited them; a definition nothing cited before stays as it was. */
export function orphanedBy(lines, removed) {
  const bound = bindings(lines), fenced = fencedOf(lines), out = new Set(), citers = new Map();
  for (const item of bound) citers.set(item.def, [...(citers.get(item.def) ?? []), item.line]);
  for (const [def, from] of citers) if (!removed.has(def) && from.every(line => removed.has(line))) out.add(def);
  for (const [a, b] of listsOf(lines)) {
    const left = [];
    for (let at = a; at < b; at += 1) if (isDefinitionAt(lines, fenced, at) && !removed.has(at) && !out.has(at)) left.push(at);
    if (!left.length) for (let at = a; at < b; at += 1) if (isLabelAt(lines, fenced, at) && !removed.has(at)) out.add(at);
  }
  return out;
}

/** The definition lines outside `inside` (a Set of line indexes) that marks inside it cite: copied along when that text leaves the file. */
export const citedFrom = (lines, inside) => [...new Set(bindings(lines).filter(item => inside.has(item.line) && !inside.has(item.def)).map(item => item.def))].sort((a, b) => a - b);

/** Every mark outside code and definition lines given its own tag (`[^k]` + \u0001n\u0001), so it can be followed through an op. -> lines. */
export function tagMarks(lines) {
  const fenced = fencedOf(lines);
  let next = 0;
  return lines.map((line, at) => (fenced.has(at) || isDefinitionAt(lines, fenced, at) ? line : line.replace(MARK, mark => `${mark}\u0001${next++}\u0001`)));
}
/** What each tagged mark cites: Map tag -> 'key\u0000definition text'. */
export function markCitations(lines) {
  const out = new Map();
  for (const item of bindings(lines)) if (item.tag) out.set(item.tag, `${item.key}\u0000${DEFINITION.exec(lines[item.def].trim())[2].trim()}`);
  return out;
}
/** The tags taken out again. */
export const untag = text => String(text ?? '').replace(TAG, '');
