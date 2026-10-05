import { fileNameOf } from './document-title.js';
import { sectionsBySource, sectionsInRange, sliceRangeOf } from './sections.js';

/* What each part of a question run covers, so the 任务 console can follow a part to its material (资料部分 → 在资料中查看). Pure.

   A question run is split into parts (lib/batch.js planGeneration); each part has the source objects it is written from. The job records, per part and from the
   moment the parts are planned (a waiting part has it too), `{ part, sourceIds, sourceCount, label }`: the ids of the sources (each once, at most PART_PLAN_SOURCES;
   `sourceCount` is how many there really are) and a short label of the range ("Book · 第 12–14 页", or the titles of notes and transcripts), at most PART_PLAN_LABEL
   characters. lib/job-contract.js reads it into partList[i].sourceIds / .sourceCount / .range. A PDF page is a source of its own, so its page is `document.page`.

   Where a part sits inside its sources is `ranges: [{ sourceId, start, end }]` (at most PART_PLAN_RANGES; pieces that touch are one range): the offsets lib/batch.js cut the
   part's slices at. When the run passes the sections of its sources (lib/sections.js), the label is made from the sections those ranges are in instead of the title of the source:
   「录音 2 · 第 1–5 部分」 for a transcript, 「§2.1–2.3」 for numbered Markdown headings, 「第 3–5 段」 for text with no structure. A section belongs to a part when most of it is
   in the part's range, so a part that is cut in the middle of a transcript part is not named for the few lines of it that fall in. `open` is where the reader opens for the part: the start of the
   first section the label names (a part whose range begins in the tail of the recording before names, and opens at, the recording after it). */

export const PART_PLAN_SOURCES = 20;
export const PART_PLAN_RANGES = 20;
export const PART_PLAN_LABEL = 80;

const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;
const span = (one, many) => (from, to) => (from === to ? one(from) : many(from, to));
const ZH = { range: span((n) => `第 ${n} 页`, (from, to) => `第 ${from}–${to} 页`), join: '、', recording: (n) => `录音 ${n}`, parts: span((n) => `第 ${n} 部分`, (from, to) => `第 ${from}–${to} 部分`),
  windows: span((n) => `第 ${n} 段`, (from, to) => `第 ${from}–${to} 段`), numbered: (from, to) => (from === to ? `§${from}` : `§${from}–${to}`), titled: (from, to) => (from === to ? `「${from}」` : `「${from}」–「${to}」`), with: ' · ' };

const EN = { range: span((n) => `p. ${n}`, (from, to) => `pp. ${from}–${to}`), join: ', ', recording: (n) => `Recording ${n}`, parts: span((n) => `part ${n}`, (from, to) => `parts ${from}–${to}`),
  windows: span((n) => `segment ${n}`, (from, to) => `segments ${from}–${to}`), numbered: ZH.numbered, titled: ZH.titled, with: ' · ' };
/** How a label is written in a language ('en' or anything else, which is Chinese). */
export const partPlanText = (language) => (language === 'en' ? EN : ZH);

/** The text of a label cut to `max` characters, with an ellipsis when something was left out. */
export const clipLabel = (text, max = PART_PLAN_LABEL) => {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…` : value;
};

/** The name and page of a source as the label shows them: a PDF page is its book and page number, anything else its title. */
function nameOf(source) {
  const page = source?.document?.page, title = String(source?.title ?? '');
  if (Number.isInteger(page)) return { name: fileNameOf(source.document.bookTitle || source.document.filename || title.replace(PAGE_SUFFIX, '')), page };
  return { name: fileNameOf(title.replace(PAGE_SUFFIX, '')), page: null };
}

/** The label of the sources of one part: documents in turn, each with its consecutive page runs; sources without pages by their titles. */
function labelOf(ids, text) {
  const groups = [];
  for (const source of ids) {
    const { name, page } = nameOf(source), last = groups.at(-1);
    if (!name) continue;
    if (!last || last.name !== name) { groups.push({ name, runs: page === null ? [] : [{ from: page, to: page }] }); continue; }
    if (page === null) continue;
    const run = last.runs.at(-1);
    if (run && page === run.to + 1) run.to = page; else last.runs.push({ from: page, to: page });
  }
  return groups.map((group) => (group.runs.length ? `${group.name} · ${group.runs.map((run) => text.range(run.from, run.to)).join(text.join)}` : group.name)).join(text.join);
}

/* ---------- the ranges ---------- */

/** The ranges the pieces of a part were cut at, in order, pieces that touch merged: [{ sourceId, start, end }]. */
function rangesOf(pieces) {
  const out = [];
  for (const piece of pieces) {
    if (typeof piece?.id !== 'string' || !piece.id) continue;
    const { start, end } = sliceRangeOf(piece), last = out.at(-1);
    if (!(end > start)) continue;
    if (last && last.sourceId === piece.id && last.end === start) last.end = end;
    else out.push({ sourceId: piece.id, start, end });
  }
  return out;
}

/* ---------- labels from sections ---------- */

const NUMBERING = /^\s*(\d+(?:\.\d+)*)(?:[.)、．]|\s|$)/;

/** The leaf sections a range holds: those with most of their text in it (else, when none has, those it touches). */
function held(list, range) {
  const leaves = sectionsInRange(list, range.start, range.end).filter((section) => section.leaf);
  const own = (section) => Math.min(section.end, range.end) - Math.max(section.start, range.start);
  const most = leaves.filter((section) => section.chars > 0 && own(section) * 2 >= section.chars);
  return most.length ? most : leaves;
}

/** Consecutive runs of numbers [from, to] in the order they come in (a number twice in a row, a carried-on part, is one). */
function runsOf(numbers) {
  const runs = [];
  for (const number of numbers) {
    const run = runs.at(-1);
    if (run && (number === run.to || number === run.to + 1)) run.to = number;
    else runs.push({ from: number, to: number });
  }
  return runs;
}

/** What the sections of one range are called: 录音 2 · 第 1–5 部分 / §2.1–2.3 / 「A」–「C」 / 第 3–5 段. '' when they have nothing to say. */
function sectionLabel(sections, words) {
  if (!sections.length) return '';
  const kinds = new Set(sections.map((section) => section.kind));
  if (kinds.size === 1 && kinds.has('part')) {
    const byRecording = [];
    for (const section of sections) {
      const key = section.recording ?? null, last = byRecording.at(-1);
      if (last && last.key === key) last.numbers.push(section.part); else byRecording.push({ key, numbers: [section.part] });
    }
    return byRecording.map(({ key, numbers }) => {
      const parts = runsOf(numbers.filter((number) => Number.isInteger(number))).map((run) => words.parts(run.from, run.to)).join(words.join);
      return key === null ? parts : [words.recording(key), parts].filter(Boolean).join(words.with);
    }).filter(Boolean).join(words.join);
  }
  if (kinds.size === 1 && kinds.has('window')) return words.windows(sections[0].n, sections.at(-1).n);
  if (kinds.has('page')) return '';
  const titled = sections.filter((section) => section.title);
  if (!titled.length) return '';
  const numbers = [titled[0], titled.at(-1)].map((section) => NUMBERING.exec(section.title)?.[1]);
  if (numbers[0] && numbers[1]) return words.numbered(numbers[0], numbers[1]);
  const short = (section) => (section.title.length > 24 ? `${section.title.slice(0, 23)}…` : section.title);
  return words.titled(short(titled[0]), short(titled.at(-1)));
}

/**
 * The label of a part from the sections of its sources. Page sources keep the label of their book and pages; every other source with sections is named by the sections its ranges
 * are in, and by its title too when the part is made of more than one document. Sources with no sections keep their titles.
 */
function labelFromSections(pieces, ranges, bySource, words) {
  const several = new Set(pieces.map((piece) => nameOf(piece).name).filter(Boolean)).size > 1, order = [];
  for (const piece of pieces) {
    const list = bySource.get(piece.id);
    if (Number.isInteger(piece?.document?.page) || !list?.length) { order.push({ plain: piece }); continue; }
    if (order.some((item) => item.id === piece.id)) continue;
    const label = sectionLabel(ranges.filter((range) => range.sourceId === piece.id).flatMap((range) => held(list, range)), words), name = nameOf(piece).name;
    order.push(label ? { id: piece.id, text: several && name ? `${name}${words.with}${label}` : label } : { plain: piece });
  }
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push(labelOf(run, words)); run = []; };
  for (const item of order) {
    if (item.plain) run.push(item.plain);
    else { flush(); out.push(item.text); }
  }
  flush();
  return out.filter(Boolean).join(words.join);
}

/** Where the reader opens for a part: the start of the first section its label names (its heading, even when the range begins a little after it), in the source of the first range that has one. */
function openOf(ranges, bySource) {
  for (const range of ranges) {
    const list = bySource.get(range.sourceId), first = list?.length ? held(list, range)[0] : null;
    if (first) return { sourceId: range.sourceId, start: first.start };
  }
  return null;
}

/**
 * The plan of a run's parts, from what planGeneration cut: [{ part, sourceIds, sourceCount, label, ranges }] in part order (parts are numbered from 1).
 * `text` says how a page range and a list are written ({ range(from, to), join, ... }); the default is Chinese. `sections` (lib/sections.js sectionsOf of the run's sources) makes the
 * label name the sections each range is in; without it a label is made of titles and pages as before.
 */
export function partPlanOf(planned, text = ZH, { sections } = {}) {
  if (!Array.isArray(planned)) return [];
  const words = { ...ZH, ...text }, bySource = sectionsBySource(sections || []);
  return planned.map((entry, index) => {
    const seen = new Set(), unique = [], pieces = Array.isArray(entry?.sources) ? entry.sources : [];
    for (const source of pieces) {
      if (typeof source?.id !== 'string' || !source.id || seen.has(source.id)) continue;
      seen.add(source.id); unique.push(source);
    }
    const all = rangesOf(pieces), label = bySource.size ? labelFromSections(pieces.filter((piece) => typeof piece?.id === 'string' && piece.id), all, bySource, words) : labelOf(unique, words);
    const ranges = all.slice(0, PART_PLAN_RANGES), open = bySource.size ? openOf(all, bySource) : null;
    return { part: index + 1, sourceIds: unique.slice(0, PART_PLAN_SOURCES).map((source) => source.id), sourceCount: unique.length, label: clipLabel(label), ...(ranges.length ? { ranges } : {}), ...(open ? { open } : {}) };
  });
}

/** The ranges of a stored plan entry made safe to read: whole-number offsets, a source id, at most PART_PLAN_RANGES. */
function readRanges(value) {
  const out = [];
  for (const range of Array.isArray(value) ? value : []) {
    if (out.length >= PART_PLAN_RANGES) break;
    if (typeof range?.sourceId === 'string' && range.sourceId && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start)
      out.push({ sourceId: range.sourceId, start: range.start, end: range.end });
  }
  return out;
}

/** The place a stored plan entry opens at, or null. */
const readOpen = (value) => (typeof value?.sourceId === 'string' && value.sourceId && Number.isInteger(value.start) && value.start >= 0 ? { sourceId: value.sourceId, start: value.start } : null);

/** The plan a job record carries, made safe to read: only well-formed entries, ids and label bounded. Keyed by part number. */
export function readPartPlan(plan) {
  const byPart = new Map();
  for (const entry of Array.isArray(plan) ? plan : []) {
    if (!entry || !Number.isInteger(entry.part) || entry.part < 1) continue;
    const ids = (Array.isArray(entry.sourceIds) ? entry.sourceIds : []).filter((id) => typeof id === 'string' && id).slice(0, PART_PLAN_SOURCES);
    const label = clipLabel(entry.label), ranges = readRanges(entry.ranges), open = readOpen(entry.open);
    if (!ids.length && !label) continue;
    byPart.set(entry.part, { ...(ids.length ? { sourceIds: ids, sourceCount: Number.isInteger(entry.sourceCount) && entry.sourceCount >= ids.length ? entry.sourceCount : ids.length } : {}),
      ...(label ? { range: label } : {}), ...(ranges.length ? { ranges } : {}), ...(open ? { open } : {}) });
  }
  return byPart;
}
