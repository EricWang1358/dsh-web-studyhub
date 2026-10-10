/* The version history of the 复习全书 (docs/plans/review-book.md I7): OUTSIDE the library's sources, one small JSON file per course under the library
   folder (`book-history/<hash of the course>.json`), so the versions never weigh on a read of the library. Each entry is the text a write replaced:
   { file, version, text, at }. At most HISTORY_KEPT entries, fewer when their texts pass HISTORY_CHARS. Written whole through a temporary file and a
   rename (a failed write leaves the previous history). The book's own write comes first: a history that could not be written loses a version, never the book. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HISTORY_KEPT = 20;
export const HISTORY_CHARS = 4_000_000;
const pathOf = (root, course) => join(root, 'book-history', `${createHash('sha256').update(JSON.stringify(['course-book-history', course])).digest('hex').slice(0, 32)}.json`);

/** The entries kept: the newest HISTORY_KEPT, then the oldest dropped while the texts are larger than HISTORY_CHARS (one is always kept). */
export function capHistory(entries) {
  const kept = entries.slice(-HISTORY_KEPT);
  while (kept.length > 1 && kept.reduce((sum, entry) => sum + String(entry.text ?? '').length, 0) > HISTORY_CHARS) kept.shift();
  return kept;
}

export async function readHistory(root, course) {
  if (!root) return [];
  try { const data = JSON.parse(await readFile(pathOf(root, course), 'utf8')); return Array.isArray(data.entries) ? data.entries : []; } catch { return []; }
}

async function writeHistory(root, course, entries) {
  const path = pathOf(root, course), temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(join(root, 'book-history'), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ course, entries })}\n`, 'utf8');
  await rename(temporary, path);
}

/** Keeps the texts some writes replaced (`items`: [{ file, version, text }]); nothing to keep, nothing written. */
export async function pushHistory(root, course, items) {
  const list = (items || []).filter(item => item && typeof item.text === 'string');
  if (!root || !list.length) return readHistory(root, course);
  const at = new Date().toISOString(), entries = capHistory([...(await readHistory(root, course)), ...list.map(item => ({ file: item.file, version: item.version, text: item.text, at }))]);
  await writeHistory(root, course, entries);
  return entries;
}

/** The newest entry of a file, or null. */
export const lastOf = (entries, file) => [...entries].reverse().find(entry => entry.file === file) ?? null;

/** Drops one entry (the version taken back). */
export async function dropHistory(root, course, entry) {
  const entries = await readHistory(root, course), at = entries.findIndex(item => item.file === entry.file && item.version === entry.version && item.at === entry.at);
  if (at < 0) return entries;
  entries.splice(at, 1);
  await writeHistory(root, course, entries);
  return entries;
}

/** How many earlier versions each file has: { [file]: n }. */
export const historyCounts = entries => entries.reduce((counts, entry) => ({ ...counts, [entry.file]: (counts[entry.file] || 0) + 1 }), {});
