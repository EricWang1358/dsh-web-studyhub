/* Sections: the one definition of the units a source is made of (the unit of coverage), shared by the backend (what a run's part covers, which sections have
   questions) and the reader (its outline). Pure, no I/O and no Node modules: the browser bundle imports it (like lib/material-summary.js).

   `sectionsOf(sources, options)` takes a source, or an ordered group of sources (a PDF's pages, the volumes of one recording), and returns the sections in
   reading order. Each is
     { id, sourceId, kind, level, title, start, end, chars, leaf, ...extras }
   with `start` / `end` offsets into the stored text of `sourceId` (end exclusive). The sections of a source TILE its text: the first starts at 0, each starts
   where the one before ends, the last ends at the end of the text; nothing is dropped and nothing is counted twice. Text before the first heading belongs to the
   first section. A section ends where the next one of ANY level starts, so a parent holds only its own heading lines; `leaf` is false for a section that is
   followed (in the same source) by a deeper one, i.e. the sections to count coverage on are the leaves. `id` is unique within a source and stable: it is made of
   the section's own numbering, never of its offset, so a re-computation of the same text, and a text corrected elsewhere, give the same ids.

   Where the sections come from, first match wins (README docs/plans/coverage-generation):
     1. a kept outline (lib/document-outline.js chaptersOfOutline; options.outline / options.chapters)        kind 'chapter'
     2. PDF / PowerPoint pages: one section per page (a converter's chapter is carried on it as `chapter`)     kind 'page'
     3. an audio transcript: `## N. filename` recordings (level 1) and `【第N部分：…】` parts (level 2, or 1 when
        there are no recordings). The labels 英文原句 / 中文对照 / [English original] … and the furniture a
        transcript writes at a recording's start are never sections                                           kind 'recording' | 'part'
     4. Markdown headings (# to ####), at least two                                                          kind 'heading'
     5. fixed windows of about WINDOW_CHARS characters cut at paragraph boundaries                            kind 'window'
   Extras: `recording` (the number of `## N.`), `part` (the number in the part's own heading), `page`, `chapter` (index, or { index, title, level } on a page),
   `n` (ordinal of a window), `continued` (the section carries on from the previous source: the second volume of a recording, the next page of a chapter),
   `front` (kept-outline text before the first chapter), `heading` ({ start, end }: the heading line, when the section starts with one; the section may
   start before it when it holds the text above the first heading). A recording split across two volumes has its sections in each volume, with `recording: n`,
   so a view can join them. */

/** About how many characters a window of text with no structure holds. */
export const WINDOW_CHARS = 8000;

const PART_ZH = /^【(第[^【】\n]+?部分(?:[：:][^【】\n]*)?)】[ \t]*$/;
const PART_EN = /^\[(Part (\d+)(?::[ \t]*[^\]\n]*)?)\][ \t]*$/;
const RECORDING = /^## (\d{1,3})\.[ \t]+(\S.*?)[ \t]*$/;
const RULE = /^={20,}[ \t]*$/;
const LABEL_ZH = /^【[^【】\n]{1,80}】[ \t]*$/;
const LABELS_EN = new Set(['[English original]', '[Chinese translation]', '[Chinese original]', '[English translation]']);
const LABEL_TITLES = new Set(['英文原句', '中文对照', '中文原文', '英文对照', 'english original', 'chinese translation', 'chinese original', 'english translation']);
const MARKDOWN = /^ {0,3}(#{1,4})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(?:```|~~~)/;

/** Whether a line is the heading of a transcript part: 【第一部分：标题】, or [Part 1: Title] when the transcript is written in English. */
export const isPartHeading = line => PART_ZH.test(String(line ?? '')) || PART_EN.test(String(line ?? ''));

/** Whether a line is a label inside a transcript part (【英文原句】, 【中文对照】, [English original] …): text of its part, never a section. */
export const isSectionLabel = line => {
  const text = String(line ?? '').trim();
  return LABELS_EN.has(text) || (LABEL_ZH.test(text) && !PART_ZH.test(text));
};

/** Whether a heading's words are one of the labels of a transcript part (### 英文原句, ### 中文对照): the heading of a Markdown transcript's label is no section. */
export const isLabelTitle = title => LABEL_TITLES.has(String(title ?? '').trim().toLowerCase());

/** The four lines a transcript writes at the start of each recording (80 "=", the 《title》 line, the English title, 80 "="): furniture, not content. */
export const isTranscriptFurniture = chunk => {
  const lines = String(chunk ?? '').split('\n').map(line => line.trimEnd());
  return lines.length >= 3 && lines.length <= 6 && RULE.test(lines[0]) && RULE.test(lines.at(-1));
};

const ZH_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 12 for "十二", 105 for "一百零五", the number itself for digits; null when it is not a number. */
export function zhNumberValue(text) {
  const value = String(text ?? '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  let total = 0, current = 0, seen = false;
  for (const char of value) {
    if (char in ZH_DIGITS) { current = ZH_DIGITS[char]; seen = true; }
    else if (char === '十') { total += (current || 1) * 10; current = 0; seen = true; }
    else if (char === '百') { total += (current || 1) * 100; current = 0; seen = true; }
    else return null;
  }
  return seen ? total + current : null;
}

/* ---------- reading the sources ---------- */

const sourceList = input => {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.sources)) return input.sources;
  return input ? [input] : [];
};
const textOf = source => typeof source?.text === 'string' ? source.text : '';
const idOf = (source, index) => typeof source?.id === 'string' && source.id ? source.id : `source-${index}`;

/** Each line of `text` that begins with one of `first` (a quick test before any pattern): [start, end (without the line break and a trailing \r), next line start]. */
function* linesOf(text, first) {
  for (let at = 0; at < text.length;) {
    let next = text.indexOf('\n', at);
    const lineEnd = next < 0 ? text.length : next;
    next = next < 0 ? text.length : next + 1;
    if (first.includes(text[at])) yield [at, text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd, next];
    at = next;
  }
}

/** Gives ids that are unique within a source: a repeat gets "~2", "~3". */
const uniqueIds = () => {
  const seen = new Map();
  return base => { const count = (seen.get(base) || 0) + 1; seen.set(base, count); return count === 1 ? base : `${base}~${count}`; };
};

const finish = (list, sourceId) => {
  list.forEach((section, index) => {
    section.sourceId = sourceId;
    section.chars = section.end - section.start;
    const next = list[index + 1];
    section.leaf = !(next && next.level > section.level);
  });
  return list;
};

/* ---------- transcripts ---------- */

/** The boundaries of a transcript in one text: recordings (`## N. filename`) and parts. null when it is not a transcript. */
function transcriptBoundaries(text, audio) {
  const boundaries = [];
  let furniture = false;
  for (const [start, end, next] of linesOf(text, '#【[=')) {
    const line = text.slice(start, end);
    let match;
    if (text[start] === '=') { if (RULE.test(line)) furniture = true; continue; }
    if (text[start] === '#') {
      if ((match = RECORDING.exec(line))) boundaries.push({ at: start, body: next, kind: 'recording', n: Number(match[1]), title: match[2] });
    } else if (text[start] === '【') {
      if ((match = PART_ZH.exec(line))) {
        const title = match[1], numeral = /^第(.+?)部分/.exec(title);
        boundaries.push({ at: start, body: next, kind: 'part', title, number: numeral ? zhNumberValue(numeral[1]) : null, head: [start, end] });
      }
    } else if ((match = PART_EN.exec(line))) {
      // In a Chinese transcript the English title sits under the 【第N部分】 line; it is that part's subtitle, not a part.
      const before = boundaries.at(-1);
      if (before?.kind === 'part' && before.zh !== false && PART_ZH.test(text.slice(before.head[0], before.head[1])) && text.slice(before.body, start).trim() === '') continue;
      boundaries.push({ at: start, body: next, kind: 'part', title: match[1], number: Number(match[2]), head: [start, end], zh: false });
    }
  }
  const parts = boundaries.filter(item => item.kind === 'part').length, recordings = boundaries.length - parts;
  const yes = parts >= 2 || (parts >= 1 && recordings >= 1) || (recordings >= 1 && furniture) || (!!audio && parts + recordings >= 1);
  return yes ? boundaries : null;
}

function transcriptSections(text, boundaries, carried) {
  const hasRecordings = boundaries.some(item => item.kind === 'recording');
  const id = uniqueIds(), out = [];
  let recording = null;
  boundaries.forEach((boundary, index) => {
    const start = index === 0 ? 0 : boundary.at, end = index + 1 < boundaries.length ? boundaries[index + 1].at : text.length;
    if (boundary.kind === 'recording') {
      recording = boundary.n;
      const before = carried.get(boundary.n);
      // The text after the heading of a recording that begins in an earlier volume carries on that volume's last part; a fresh recording opens with its furniture.
      const first = /\S/.exec(text.slice(boundary.body, end));
      const rest = first ? text.slice(boundary.body + first.index, boundary.body + first.index + 40).split('\n')[0].trimEnd() : '';
      const continued = !!first && !RULE.test(rest);
      const split = continued ? boundary.body : end;
      out.push({ id: id(`r${boundary.n}`), kind: 'recording', level: 1, title: boundary.title, recording: boundary.n, start, end: split, heading: { start: boundary.at, end: boundary.body } });
      if (continued) {
        out.push({ id: id(`r${boundary.n}.cont`), kind: 'part', level: 2, title: before?.title ?? '', recording: boundary.n, ...(before?.number != null ? { part: before.number } : {}),
          continued: true, start: split, end });
      }
      return;
    }
    const number = boundary.number ?? (out.filter(item => item.kind === 'part' && item.recording === recording && !item.continued).length + 1);
    out.push({ id: id(recording !== null && hasRecordings ? `r${recording}.p${number}` : `p${number}`), kind: 'part', level: hasRecordings ? 2 : 1, title: boundary.title,
      ...(recording !== null && hasRecordings ? { recording } : {}), part: number, start, end, heading: { start: boundary.head[0], end: boundary.head[1] } });
  });
  // What the next volume of a recording carries on from.
  for (const item of out) if (item.kind === 'part' && item.recording != null && !item.continued) carried.set(item.recording, { number: item.part, title: item.title });
  return out;
}

/* ---------- Markdown headings ---------- */

function markdownBoundaries(text) {
  const found = [];
  let fenced = false;
  for (const [start, end, next] of linesOf(text, '#`~ ')) {
    const line = text.slice(start, end);
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = MARKDOWN.exec(line);
    if (match && !isLabelTitle(match[2])) found.push({ at: start, body: next, end, depth: match[1].length, title: match[2].trim() });
  }
  return found;
}

function markdownSections(text, found) {
  const base = Math.min(...found.map(item => item.depth)), id = uniqueIds();
  return found.map((item, index) => ({ id: id(`h${index}`), kind: 'heading', level: item.depth - base + 1, title: item.title,
    start: index === 0 ? 0 : item.at, end: index + 1 < found.length ? found[index + 1].at : text.length, heading: { start: item.at, end: item.end } }));
}

/* ---------- windows ---------- */

/** [start, end] pairs that cut `text` between `from` and `to` into pieces of about `max` characters at paragraph (else line) breaks. */
export function windowRanges(text, from = 0, to = text.length, max = WINDOW_CHARS) {
  const out = [];
  let at = from;
  while (to - at > max * 1.25) {
    const limit = at + max;
    let cut = text.lastIndexOf('\n\n', limit);
    if (cut >= at + max * 0.5) cut += 2;
    else { cut = text.lastIndexOf('\n', limit); if (cut >= at + max * 0.5) cut += 1; else cut = limit; }
    if (cut > at && cut < to && cut === limit && /[\uDC00-\uDFFF]/.test(text[cut] ?? '')) cut -= 1;
    out.push([at, cut]);
    at = cut;
  }
  if (to > at) out.push([at, to]);
  return out;
}

function windowSections(text, max) {
  if (!text.trim()) return [];
  return windowRanges(text, 0, text.length, max).map(([start, end], index) => ({ id: `w${index + 1}`, kind: 'window', level: 1, title: '', n: index + 1, start, end }));
}

/* ---------- pages ---------- */

function pageSection(source, text, id) {
  const page = source.document.page, chapter = source.document.chapter;
  return { id: id(`pg${page}`), kind: 'page', level: 1, title: '', page, start: 0, end: text.length,
    ...(Number.isInteger(chapter?.index) ? { chapter: { index: chapter.index, title: String(chapter.title ?? ''), level: Number(chapter.level) || 1 } } : {}) };
}

/* ---------- a kept outline ---------- */

/** The chapters a kept outline defines at `level`: its entries down to that level, numbered in order, each with its place. */
export function chaptersOfOutline(outline, level = 1) {
  const entries = Array.isArray(outline?.entries) ? outline.entries : [];
  return entries.filter(entry => entry?.anchor && entry.level <= level)
    .map((entry, index) => ({ index, title: entry.title, level: entry.level, sourceId: entry.anchor.sourceId, offset: entry.anchor.offset || 0 }));
}

function outlineSections(items, chapters) {
  const place = new Map(items.map((item, index) => [item.id, index]));
  const starts = chapters.filter(chapter => place.has(chapter.sourceId))
    .sort((a, b) => place.get(a.sourceId) - place.get(b.sourceId) || (Number(a.offset) || 0) - (Number(b.offset) || 0) || a.index - b.index);
  if (!starts.length) return null;
  const bySource = new Map();
  for (const chapter of starts) { if (!bySource.has(chapter.sourceId)) bySource.set(chapter.sourceId, []); bySource.get(chapter.sourceId).push(chapter); }
  const made = new Map();
  let open = null;
  for (const item of items) {
    const id = uniqueIds(), list = [], own = bySource.get(item.id) || [], length = item.text.length;
    const piece = (chapter, start, end, extra = {}) => list.push({ id: id(`c${chapter.index}`), kind: 'chapter', level: chapter.level, title: String(chapter.title ?? ''), chapter: chapter.index, start, end, ...extra });
    if (!own.length) {
      if (open) piece(open, 0, length, { continued: true });
      else list.push({ id: id('front'), kind: 'chapter', level: 1, title: '', front: true, start: 0, end: length });
    } else {
      const first = Math.min(length, Math.max(0, Number(own[0].offset) || 0));
      if (open && first > 0) piece(open, 0, first, { continued: true });
      own.forEach((chapter, index) => {
        const start = index === 0 && !(open && first > 0) ? 0 : Math.min(length, Math.max(0, Number(chapter.offset) || 0));
        const end = index + 1 < own.length ? Math.min(length, Math.max(start, Number(own[index + 1].offset) || 0)) : length;
        piece(chapter, start, end);
      });
      open = own.at(-1);
    }
    made.set(item.id, list);
  }
  return made;
}

/* ---------- the entry point ---------- */

/**
 * The sections of a source or of an ordered group of sources, each source's in reading order, the sources in the order given.
 * `sources`: a source `{ id, text, document?, audio? }`, an array of them, or `{ sources }`.
 * options: `outline` (a kept outline; its chapters at `level`, default its segmentation level, else 1) or `chapters` (chaptersOfOutline's shape);
 * `windows: false` leaves out the fixed windows of text with no structure (a reader has no use for them); `windowChars`.
 */
export function sectionsOf(sources, options = {}) {
  const items = sourceList(sources).map((source, index) => ({ source, id: idOf(source, index), text: textOf(source) }));
  if (!items.length) return [];
  const chapters = Array.isArray(options.chapters) ? options.chapters
    : options.outline ? chaptersOfOutline(options.outline, options.level ?? options.outline.segmentation?.level ?? 1) : [];
  const kept = chapters.length ? outlineSections(items, chapters) : null;
  const max = Math.max(500, Number(options.windowChars) || WINDOW_CHARS), carried = new Map(), out = [];
  for (const item of items) {
    const { source, text } = item;
    let list = kept?.get(item.id);
    if (!list) {
      const id = uniqueIds();
      if (Number.isInteger(source?.document?.page)) list = [pageSection(source, text, id)];
      else {
        const transcript = transcriptBoundaries(text, source?.audio);
        if (transcript) list = transcriptSections(text, transcript, carried);
        else {
          const found = markdownBoundaries(text);
          list = found.length >= 2 ? markdownSections(text, found) : options.windows === false ? [] : windowSections(text, max);
        }
      }
    }
    out.push(...finish(list, item.id));
  }
  return out;
}

/* ---------- helpers for the people of the sections ---------- */

/** The sections of each source, in order: Map(sourceId → sections). */
export function sectionsBySource(sections) {
  const map = new Map();
  for (const section of sections || []) { if (!map.has(section.sourceId)) map.set(section.sourceId, []); map.get(section.sourceId).push(section); }
  return map;
}

/** The sections of ONE source (as sectionsBySource lists them) that overlap [start, end), in order. A point (end === start) finds the section it sits in. */
export function sectionsInRange(list, start, end = start) {
  const found = [];
  for (const section of list || []) {
    if (end > start ? section.start >= end : section.start > start) break;
    if (end > start ? section.end > start : start < section.end || (section.start === start && section.end === start)) found.push(section);
  }
  return found;
}

/** The section of one source's list that holds `offset`; the last one when it is at the very end; null for no sections. */
export function sectionAt(list, offset) {
  if (!list?.length) return null;
  let low = 0, high = list.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (list[middle].start <= offset) low = middle; else high = middle - 1;
  }
  return list[low];
}

/** The sections to count coverage on: the leaves. */
export const leavesOf = sections => (sections || []).filter(section => section.leaf);

/* ---------- where a generation slice was cut ---------- */

/** Marks a piece of a source (a copy of the source with its text cut, lib/batch.js) with the offsets it was cut at. The mark is not enumerable: prompts, JSON and comparisons see the piece unchanged. */
export function withSliceRange(piece, start, end) {
  Object.defineProperty(piece, 'sliceRange', { value: { start, end }, enumerable: false, configurable: true, writable: true });
  return piece;
}

/** The offsets of a piece into the stored text of its source: where lib/batch.js cut it, else the whole text (a piece nobody cut). */
export const sliceRangeOf = piece => piece?.sliceRange && Number.isInteger(piece.sliceRange.start) && Number.isInteger(piece.sliceRange.end) ? { ...piece.sliceRange }
  : { start: 0, end: typeof piece?.text === 'string' ? piece.text.length : 0 };

/**
 * The section of a source an offset is in, for opening the reader there: { sectionId, kind, title, recording?, page? } or null (an unknown source, no text).
 * `sources` is the group the source belongs to (its other volumes give a carried-on recording its part).
 */
export function sectionAtOffset(sources, sourceId, offset = 0) {
  const list = sectionsBySource(sectionsOf(sources)).get(sourceId), section = sectionAt(list, Math.max(0, Number(offset) || 0));
  return section ? { sectionId: section.id, kind: section.kind, title: section.title, ...(section.recording != null ? { recording: section.recording } : {}), ...(section.page ? { page: section.page } : {}) } : null;
}
