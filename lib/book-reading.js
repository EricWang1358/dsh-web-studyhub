/* The reading record of the 复习全书's main-chat tools (docs/review-book-agent.md): which parts of which material pages were opened with source.pages,
   so book.coverage can say how much of a point's own pages were really read before it was written. OUTSIDE the library's sources and outside the
   version history: one small JSON file beside it, `book-history/reading.json` (the history's backup reads only its own `<hash>.json` files, so this
   record is not in a portable backup; it is a convenience, losing it loses no text). Also the quotes book.write had to drop per point, so a quote dropped
   twice can be named.

   { version: 1, sources: { [sourceId]: [[from, to], ...] }, points: { [course \0 hid]: { at, sources: [sourceId] } }, dropped: { [course \0 hid]: [hash] } }

   Written whole through a temporary file and a rename, one write at a time per library folder in this process (the book's writer queue module, on a key
   of its own so a read never waits for a book write). Two app processes recording at the same moment are not ordered (the last rename wins): accepted. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bookQueue } from './course-book-writer.js';

export const READING_FILE = 'reading.json';
/** The most ranges one source keeps (merged first), the most points and dropped quotes remembered. */
export const RANGES_KEPT = 64, POINTS_KEPT = 2000, POINT_SOURCES_KEPT = 400, DROPPED_KEPT = 50;
const pathOf = root => join(root, 'book-history', READING_FILE);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({ version: 1, sources: {}, points: {}, dropped: {} });
export const pointKey = (course, hid) => `${course ?? ''}\u0000${hid}`;
export const quoteHash = quote => createHash('sha256').update(String(quote ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/** The record of the library at `root` (an empty one when there is none or it cannot be read). */
export async function readReading(root) {
  if (!root) return empty();
  try {
    const data = JSON.parse(await readFile(pathOf(root), 'utf8'));
    return { version: 1, sources: object(data.sources) ? data.sources : {}, points: object(data.points) ? data.points : {}, dropped: object(data.dropped) ? data.dropped : {} };
  } catch { return empty(); }
}

/** `ranges` with [from, to) added: sorted, disjoint, touching ranges merged; at most RANGES_KEPT (the closest neighbours merged when over). */
export function addRange(ranges, from, to) {
  const list = [...(Array.isArray(ranges) ? ranges : []).filter(item => Array.isArray(item) && item[1] > item[0]), [from, to]].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of list) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  while (merged.length > RANGES_KEPT) {
    let best = 1;
    for (let at = 2; at < merged.length; at++) if (merged[at][0] - merged[at - 1][1] < merged[best][0] - merged[best - 1][1]) best = at;
    merged[best - 1][1] = merged[best][1];
    merged.splice(best, 1);
  }
  return merged;
}

/** How many characters of [from, to) the ranges hold. */
export function coveredChars(ranges, from, to) {
  let sum = 0;
  for (const [start, end] of Array.isArray(ranges) ? ranges : []) sum += Math.max(0, Math.min(end, to) - Math.max(start, from));
  return sum;
}

async function writeReading(root, data) {
  const path = pathOf(root), temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(join(root, 'book-history'), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(data)}\n`, 'utf8');
  await rename(temporary, path);
}

/** One change of the record, in turn: `change(data)` mutates it; written only when it returns true. -> the record after. */
export function updateReading(root, change) {
  return bookQueue(`${root ?? ''}\u0000reading`, async () => {
    const data = await readReading(root);
    if (root && change(data)) await writeReading(root, data);
    return data;
  });
}

/** Records what a source.pages call showed (`reads`: [{ sourceId, from, to }]) and, with `point`, that the point's work opened those sources. */
export function recordReads(root, reads, point = null) {
  const list = (reads || []).filter(item => typeof item?.sourceId === 'string' && Number.isInteger(item.from) && Number.isInteger(item.to) && item.to > item.from);
  if (!root || !list.length) return readReading(root);
  return updateReading(root, data => {
    for (const read of list) data.sources[read.sourceId] = addRange(data.sources[read.sourceId], read.from, read.to);
    if (point) {
      const old = data.points[point];
      delete data.points[point];
      data.points[point] = { at: new Date().toISOString(), sources: [...new Set([...(old?.sources || []), ...list.map(read => read.sourceId)])].slice(-POINT_SOURCES_KEPT) };
      const keys = Object.keys(data.points);
      for (const key of keys.slice(0, Math.max(0, keys.length - POINTS_KEPT))) delete data.points[key];
    }
    return true;
  });
}

/** Remembers the quotes a write of `point` dropped -> the hashes that had been dropped before (a quote dropped twice). */
export async function rememberDropped(root, point, quotes) {
  const hashes = (quotes || []).map(quoteHash);
  if (!root || !hashes.length) return new Set();
  let before = new Set();
  await updateReading(root, data => {
    const old = Array.isArray(data.dropped[point]) ? data.dropped[point] : [];
    before = new Set(old.filter(hash => hashes.includes(hash)));
    data.dropped[point] = [...old.filter(hash => !hashes.includes(hash)), ...hashes].slice(-DROPPED_KEPT);
    return true;
  });
  return before;
}
