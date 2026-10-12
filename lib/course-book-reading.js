import { createHash } from 'node:crypto';
import { COVERAGE_DEFAULT, COVERAGE_LEVELS } from './book-settings.js';

/* 复习全书: how much of a knowledge point's material one build reads, by 讲解详尽程度 (settings.book.coverage, lib/book-settings.js). Pure, no I/O; shared by the
   build (lib/contexts/generation/book/work.js) and the page's read (lib/course-book-inputs.js), so both agree on what was read and when an explanation is current.

   A point whose passages fit LEAF_CHARS is read whole, at every level: its explanation is the same at every level (one call shared with other points).
   A bigger point:
     brief (精简)    a beginning of each passage, LEAF_CHARS in all, in one call shared with other points: the reading of 3.4, before levels existed;
     standard (标准) and full (详尽): its passages in order cut into ranges of at most PASS_CHARS (a page is never cut, unless it alone is bigger; a source
                    without pages is cut at a line), and at most `passes` of those ranges, spread evenly with the first and the last always among them. Each
                    range is one pass: its own call, its own 梳理 / 讲解 / cites, shown under 「第 a–b 页」.
   The fingerprint of an explanation: brief and whole readings keep 3.4's (the passages and the language), so notes written before levels existed count as 精简;
   a reading in passes adds the ranges it read. A level enters the fingerprint only through those ranges: the same level again reads the same ranges (nothing
   to ask), a higher level asks again only where it reads more, and an explanation that read more than the level asks for is kept (acceptedPrints). */

/** The characters a point is read from in one shared call (brief, or a point that fits), and the least an excerpt keeps of one passage. */
export const LEAF_CHARS = 12000;
export const PASSAGE_MIN = 400;
/** The characters of material one pass of a big point shows (well under lib/limits.js CALL_CHARS with the rules around them). */
export const PASS_CHARS = 20000;
/** Per level: the most passes of a big point, and the most cites its explanation keeps in all. */
export const LEVELS = Object.freeze({ brief: Object.freeze({ passes: 1, cites: 4 }), standard: Object.freeze({ passes: 3, cites: 10 }), full: Object.freeze({ passes: 8, cites: 24 }) });
/** The most cites one pass keeps (and asks for). */
export const PASS_CITES = 8;

const sha = value => createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const short = value => sha(value).slice(0, 16);
const lengthOf = list => list.reduce((sum, item) => sum + item.text.length, 0);
export const levelOf = value => (COVERAGE_LEVELS.includes(value) ? value : COVERAGE_DEFAULT);

/** The fingerprint of a leaf's explanation read whole or as a brief excerpt: its passages and the language (3.4's). */
export const bodyFingerprint = (language, segments) => short(['body', language === 'en' ? 'en' : 'zh', segments.map(item => [item.sourceId, item.start, item.end, sha(item.text)])]);
/** The fingerprint of an explanation read in passes: the passages, the language and the ranges read. */
const passesFingerprint = (language, segments, read) => short(['body', language === 'en' ? 'en' : 'zh', segments.map(item => [item.sourceId, item.start, item.end, sha(item.text)]),
  'read', read.map(range => [range.sourceId, range.start, range.end])]);

/** The passages as one shared call shows them: all of them under `limit`, else a beginning of each, shared out so a short one keeps all of itself. */
export function excerpt(segments, limit = LEAF_CHARS) {
  const total = lengthOf(segments);
  if (total <= limit) return segments.map(item => ({ ...item, cut: false }));
  const sizes = new Map(), order = segments.map((item, at) => at).sort((a, b) => segments[a].text.length - segments[b].text.length);
  let left = limit, count = segments.length;
  for (const at of order) {
    const share = Math.max(PASSAGE_MIN, Math.floor(left / count--)), size = Math.min(segments[at].text.length, share);
    sizes.set(at, size); left = Math.max(0, left - size);
  }
  return segments.map((item, at) => ({ ...item, text: item.text.slice(0, sizes.get(at)), end: item.start + sizes.get(at), cut: sizes.get(at) < item.text.length }));
}

/** A passage that alone is bigger than a pass: a page keeps its beginning (it is not cut in two); a source without pages is cut at a line (else a space). */
function piecesOf(segment) {
  if (segment.text.length <= PASS_CHARS) return [{ ...segment, cut: false }];
  if (Number.isInteger(segment.page)) return [{ ...segment, text: segment.text.slice(0, PASS_CHARS), end: segment.start + PASS_CHARS, cut: true }];
  const pieces = [];
  for (let from = 0; from < segment.text.length;) {
    let to = Math.min(segment.text.length, from + PASS_CHARS);
    if (to < segment.text.length) {
      const line = segment.text.lastIndexOf('\n', to), space = segment.text.lastIndexOf(' ', to);
      to = line > from + PASS_CHARS / 2 ? line + 1 : space > from + PASS_CHARS / 2 ? space + 1 : to;
    }
    pieces.push({ ...segment, text: segment.text.slice(from, to), start: segment.start + from, end: segment.start + to, cut: false });
    from = to;
  }
  return pieces;
}

/** The ranges of a big point: its passages in order, packed into ranges of at most PASS_CHARS. */
export function rangesOf(segments) {
  const ranges = [];
  let current = [], size = 0;
  for (const piece of segments.flatMap(piecesOf)) {
    if (current.length && size + piece.text.length > PASS_CHARS) { ranges.push(current); current = []; size = 0; }
    current.push(piece); size += piece.text.length;
  }
  if (current.length) ranges.push(current);
  return ranges;
}

/** Which of `count` ranges `most` passes read: all when they are enough, else spread evenly, the first and the last always among them. */
export function chooseRanges(count, most) {
  if (count <= most) return Array.from({ length: count }, (_, at) => at);
  if (most <= 1) return [0];
  return Array.from({ length: most }, (_, at) => Math.round(at * (count - 1) / (most - 1)));
}

/** What a pass's heading names: per material (in order) its pages a–b, else its characters when the source has no pages, else the material whole. */
export function rangeLabels(pieces) {
  const labels = [];
  for (const piece of pieces) {
    const last = labels.at(-1), paged = Number.isInteger(piece.page);
    if (last && last.material === piece.material && paged && last.unit === 'page') { last.from = Math.min(last.from, piece.page); last.to = Math.max(last.to, piece.page); continue; }
    if (paged) labels.push({ material: piece.material, unit: 'page', from: piece.page, to: piece.page });
    else if (!piece.span || (piece.start === piece.span[0] && piece.end === piece.span[1])) labels.push({ material: piece.material, unit: 'whole' });
    else labels.push({ material: piece.material, unit: 'char', from: piece.start + 1, to: piece.end });
  }
  return labels;
}

const rangeOf = item => ({ sourceId: item.sourceId, start: item.start, end: item.end });

/**
 * How a point is read at `level`: { mode: 'whole' | 'excerpt' | 'passes', fingerprint, read: [{ sourceId, start, end }], shown? (whole / excerpt: the passages one
 * shared call shows), passes? ([{ pieces, labels, quotes }]: one call each), of? (the ranges the material has) }.
 */
export function readingOf(segments, level, language) {
  const list = Array.isArray(segments) ? segments : [], at = levelOf(level);
  if (lengthOf(list) <= LEAF_CHARS || at === 'brief') {
    const shown = excerpt(list);
    return { mode: shown.some(item => item.cut) ? 'excerpt' : 'whole', fingerprint: bodyFingerprint(language, list), shown, read: shown.map(rangeOf) };
  }
  // A piece remembers the passage it was cut from, so a heading can say "the whole material" when it is all of it.
  const ranges = rangesOf(list.map(item => ({ ...item, span: [item.start, item.end] }))), chosen = chooseRanges(ranges.length, LEVELS[at].passes).map(index => ranges[index]);
  const total = Math.min(LEVELS[at].cites, chosen.length * PASS_CITES), base = Math.floor(total / chosen.length), extra = total % chosen.length;
  const passes = chosen.map((pieces, index) => ({ pieces: pieces.map(({ span: _span, ...piece }) => piece), labels: rangeLabels(pieces), quotes: base + (index < extra ? 1 : 0) }));
  const read = passes.flatMap(pass => pass.pieces.map(rangeOf));
  return { mode: 'passes', fingerprint: passesFingerprint(language, list, read), read, passes, of: ranges.length };
}

/** The fingerprints an explanation may have and still be current when `level` is asked for: the readings of that level and of every level above it. */
export function acceptedPrints(segments, level, language) {
  return new Set(COVERAGE_LEVELS.slice(COVERAGE_LEVELS.indexOf(levelOf(level))).map(each => readingOf(segments, each, language).fingerprint));
}

/** The fingerprint of an explanation of which only some passes were written: it matches no reading, so the next build asks the point again. */
export const partialPrint = (fingerprint, done) => short(['partial', fingerprint, done]);

/**
 * How much of a point's material `read` covers: { unit: 'page', read, total, partial } when every passage is a page of its source (a page is read when all of
 * it was shown, partial when only some), else { unit: 'char', read, total }; `chars` is { read, total } either way.
 */
export function coverageOf(segments, read) {
  const list = Array.isArray(segments) ? segments : [], ranges = Array.isArray(read) ? read : [];
  const covered = item => ranges.filter(range => range.sourceId === item.sourceId)
    .reduce((sum, range) => sum + Math.max(0, Math.min(item.end, range.end) - Math.max(item.start, range.start)), 0);
  const parts = list.map(item => ({ item, size: item.end - item.start, got: Math.min(item.end - item.start, covered(item)) }));
  const chars = { read: parts.reduce((sum, part) => sum + part.got, 0), total: parts.reduce((sum, part) => sum + part.size, 0) };
  if (!list.length || !list.every(item => Number.isInteger(item.page))) return { unit: 'char', read: chars.read, total: chars.total, chars };
  const pages = new Map();
  for (const part of parts) { const page = pages.get(part.item.sourceId) || { size: 0, got: 0 }; page.size += part.size; page.got += part.got; pages.set(part.item.sourceId, page); }
  const all = [...pages.values()];
  return { unit: 'page', read: all.filter(page => page.got >= page.size).length, total: all.length, partial: all.filter(page => page.got > 0 && page.got < page.size).length, chars };
}

/**
 * What a saved explanation read and what reading more would mean: { level (the level whose reading it is, null when none: out of date or partly written),
 * coverage (coverageOf), more (the next level that reads more of the material, or null) }. An explanation without `read` (written whole, as an excerpt, or before
 * levels existed) read the brief reading.
 */
export function bodyReading(body, segments, language) {
  if (!body || body.empty) return null;
  const readings = COVERAGE_LEVELS.map(level => [level, readingOf(segments, level, language)]);
  const level = readings.findLast(([, reading]) => reading.fingerprint === body.fingerprint)?.[0] ?? null;
  const read = Array.isArray(body.read) ? body.read : readings[0][1].read, coverage = coverageOf(segments, read);
  const more = readings.find(([, reading]) => coverageOf(segments, reading.read).chars.read > coverage.chars.read)?.[0] ?? null;
  return { level, coverage, more };
}
