/* Running furniture of a converted document: the lines that repeat on a large share of its pages (a training class's contact lines on every page, a
   running title the converter did not mark, the page numbers). They are left out of the stored text at conversion (lib/converted-document.js), and each page
   keeps what it lost, so the learner can put it back word for word. Pure, no I/O, no Node modules.

   A line is left out when, on the pages of ONE document, it is on at least REPEATED.minPages pages and at least REPEATED.share of the pages with text:
     - the same line (spaces folded), at least REPEATED.minChars visible characters and no short label ("解：", "Solution:");
     - or the same line but for its numbers, with at most REPEATED.pageLetters letters, whose first number follows the page (page + a constant offset on at
       least REPEATED.tracking of them): a page number, "- 3 -", "第 3 页 共 40 页", "Page 3 of 40" (a sentence that names its page is no page number).
   Never: a heading, a formula ($$ blocks, a line with $ or \( \[), code (``` and ~~~ blocks), a table row, a converter's mark for a
   picture ([Figure]: a picture of that page), a line on fewer pages, and nothing on a page that would be left without text. The blank lines around a removed line go with it, so no gap is left.
   What a page lost is `repeated`: runs [index, ...lines], `index` its first line in the page's text as it was; restoreRepeatedLines puts them back. */

export const REPEATED = Object.freeze({ minPages: 3, share: 0.4, minChars: 4, labelChars: 16, pageLetters: 6, tracking: 0.8 });

const FENCE = /^ {0,3}(?:```|~~~)/;
const FORMULA_MARK = /\$|\\\(|\\\[/;
const PICTURE = /^\[(?:figure|image|picture|图|图片)\]$/i;
const LABEL = /[:：]$/;
const visible = text => text.replace(/\s/g, '').length;
const letters = text => (text.match(/\p{L}/gu) || []).length;

/** The lines of one page that may be furniture: [{ index, text }] (text with its spaces folded). */
function candidates(text) {
  const out = [];
  let code = false, math = false;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (FENCE.test(raw)) { code = !code; return; }
    if (code) return;
    if (line.startsWith('$$')) { if (line === '$$' || !(line.length > 2 && line.endsWith('$$'))) math = !math; return; }
    if (math || !line || line.startsWith('#') || line.startsWith('|') || FORMULA_MARK.test(line) || PICTURE.test(line)) return;
    out.push({ index, text: line.replace(/\s+/g, ' ') });
  });
  return out;
}

/** Map(key -> { texts: Set, first: text, pages: Map(page -> [index]) }) over every page's candidates. */
function groupBy(lists, keyOf) {
  const groups = new Map();
  for (const { page, lines } of lists) for (const line of lines) {
    const key = keyOf(line);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, { texts: new Set(), first: line.text, pages: new Map() });
    const group = groups.get(key);
    group.texts.add(line.text);
    if (!group.pages.has(page)) group.pages.set(page, []);
    group.pages.get(page).push(line);
  }
  return groups;
}

const often = (group, total) => group.pages.size >= REPEATED.minPages && group.pages.size >= REPEATED.share * total;
const exactOk = text => visible(text) >= REPEATED.minChars && !(LABEL.test(text) && text.length < REPEATED.labelChars);

/** Does the first number of the line follow the page (page + one offset on most of them)? */
function followsPage(group) {
  const offsets = new Map();
  for (const [page, lines] of group.pages) {
    const offset = Number(/\d+/.exec(lines[0].text)?.[0]) - page;
    offsets.set(offset, (offsets.get(offset) || 0) + 1);
  }
  return Math.max(...offsets.values()) >= REPEATED.tracking * group.pages.size;
}

/** The indexes to drop from one page's lines: the furniture and the blank lines next to it that would leave a gap (or lead or trail the page). */
function dropped(lines, furniture) {
  const drop = new Set(furniture);
  let tail = lines.length;
  while (tail > 0 && (drop.has(tail - 1) || !lines[tail - 1].trim())) tail -= 1;
  let lastBlank = true;
  lines.forEach((line, at) => {
    if (drop.has(at)) return;
    const blank = !line.trim();
    if (blank && (drop.has(at - 1) || drop.has(at + 1)) && (lastBlank || at >= tail)) { drop.add(at); return; }
    lastBlank = blank;
  });
  return [...drop].sort((a, b) => a - b);
}

/** Consecutive indexes as runs [index, ...lines]. */
function runsOf(lines, indexes) {
  const runs = [];
  for (const at of indexes) {
    const last = runs.at(-1);
    if (last && last[0] + last.length - 1 === at) last.push(lines[at]); else runs.push([at, lines[at]]);
  }
  return runs;
}

/**
 * pages: [{ page, text, ... }] of one document (the pages with text). -> { pages (each with its text without the furniture and, when it lost any, `repeated`),
 * lines: [{ text, pages }] (what was left out, most pages first), count (the lines left out in all) }.
 */
export function dropRepeatedLines(pages) {
  const list = Array.isArray(pages) ? pages : [], total = list.length;
  const lists = list.map(one => ({ page: one.page, lines: candidates(String(one.text ?? '')) }));
  const chosen = [];
  const exact = groupBy(lists, line => line.text);
  for (const group of exact.values()) if (often(group, total) && exactOk(group.first)) chosen.push(group);
  const taken = new Set(chosen.map(group => group.first));
  const numbered = groupBy(lists, line => (taken.has(line.text) || !/\d/.test(line.text) || letters(line.text) > REPEATED.pageLetters ? null : line.text.replace(/\d+/g, '0')));
  for (const group of numbered.values()) if (group.texts.size > 1 && often(group, total) && followsPage(group)) chosen.push(group);
  if (!chosen.length) return { pages: list, lines: [], count: 0 };
  const left = new Map(chosen.map(group => [group, 0]));
  const out = list.map(one => {
    const furniture = chosen.flatMap(group => (group.pages.get(one.page) || []).map(line => line.index));
    if (!furniture.length) return one;
    const lines = String(one.text).split('\n'), gone = dropped(lines, furniture), drop = new Set(gone);
    // A page left without text keeps everything: it is no furniture of anything.
    if (lines.every((line, at) => drop.has(at) || !line.trim())) return one;
    for (const group of chosen) if (group.pages.has(one.page)) left.set(group, left.get(group) + 1);
    return { ...one, text: lines.filter((_, at) => !drop.has(at)).join('\n'), repeated: runsOf(lines, gone) };
  });
  const order = new Map(chosen.map((group, at) => [group, at]));
  const lines = chosen.filter(group => left.get(group) > 0).sort((a, b) => left.get(b) - left.get(a) || order.get(a) - order.get(b))
    .map(group => ({ text: group.first, pages: left.get(group) }));
  const count = out.reduce((sum, one) => sum + linesIn(one.repeated), 0);
  return { pages: out, lines, count };
}

/** How many lines (blank lines not counted) a page's runs hold. */
export const linesIn = runs => (Array.isArray(runs) ? runs : []).reduce((sum, run) => sum + run.slice(1).filter(line => String(line).trim()).length, 0);

/** A page's text with what dropRepeatedLines left out put back where it was. */
export function restoreRepeatedLines(text, runs) {
  if (!Array.isArray(runs) || !runs.length) return text;
  const lines = String(text).split('\n');
  for (const [at, ...back] of runs) lines.splice(at, 0, ...back);
  return lines.join('\n');
}
