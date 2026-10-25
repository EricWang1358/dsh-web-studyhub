/* The version history of the 复习全书 (docs/plans/review-book.md I7): OUTSIDE the library's sources, one small JSON file per course under the library
   folder (`book-history/<hash of the course>.json`), so the versions never weigh on a read of the library. Each entry is the text a write replaced:
   { file, version, text, at, redo? }. At most HISTORY_KEPT entries, fewer when their texts pass HISTORY_CHARS (two files of the largest size a file
   may have). The structure's entries (`book.structure`, lib/course-book-structure.js) have their own allowance, so the files' writes never push the
   last structure changes out (and a large one never pushes the files' versions out): the newest STRUCTURE_KEPT, fewer past STRUCTURE_CHARS, the newest
   one always. A structure entry holds the text of the files it removed only; the files it rewrote have their own entries of the same write (`at`).
   `redo: true` marks the text a 回退到上一版 replaced (course.book.revert): a revert never destroys a text, `redo` takes it back; such an entry is not a
   version to step back to (lastOf, historyCounts leave it out). Written whole through a temporary file and a
   rename (a failed write leaves the previous history). The book's own write comes first: a history that could not be written loses a version, never the book.
   The writes of one course are ordered by the course's writer queue in this process; two app processes writing the same course's history at the same
   moment are not ordered (the last rename wins and a version can be lost; the book itself stays whole under the store's own lock). Accepted. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_TEXT_MAX } from './course-book-edit.js';
import { STRUCTURE_FILE } from './course-book-own-titles.js';

export const HISTORY_KEPT = 20;
export const HISTORY_CHARS = 2 * FILE_TEXT_MAX;
export const STRUCTURE_KEPT = 10, STRUCTURE_CHARS = FILE_TEXT_MAX;
const pathOf = (root, course) => join(root, 'book-history', `${createHash('sha256').update(JSON.stringify(['course-book-history', course])).digest('hex').slice(0, 32)}.json`);

const newest = (list, count, chars) => {
  const kept = list.slice(-count);
  while (kept.length > 1 && kept.reduce((sum, entry) => sum + String(entry.text ?? '').length, 0) > chars) kept.shift();
  return kept;
};
/** The entries kept, in their order: of the files' entries the newest HISTORY_KEPT, of the structure's the newest STRUCTURE_KEPT; in each, the oldest
    dropped while the texts are larger than HISTORY_CHARS (the newest one is always kept). */
export function capHistory(entries) {
  const keep = new Set([...newest(entries.filter(entry => entry.file !== STRUCTURE_FILE), HISTORY_KEPT, HISTORY_CHARS), ...newest(entries.filter(entry => entry.file === STRUCTURE_FILE), STRUCTURE_KEPT, STRUCTURE_CHARS)]);
  return entries.filter(entry => keep.has(entry));
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

/** Keeps the texts some writes replaced (`items`: [{ file, version, text, redo? }], all of one moment `at`); nothing to keep, nothing written. */
export async function pushHistory(root, course, items) {
  const list = (items || []).filter(item => item && typeof item.text === 'string');
  if (!root || !list.length) return readHistory(root, course);
  const at = new Date().toISOString(), entries = capHistory([...(await readHistory(root, course)), ...list.map(item => ({ file: item.file, version: item.version, text: item.text, at, ...(item.redo ? { redo: true } : {}) }))]);
  await writeHistory(root, course, entries);
  return entries;
}

/** The newest version of a file to step back to (a `redo` entry is not one), or null. */
export const lastOf = (entries, file) => [...entries].reverse().find(entry => entry.file === file && !entry.redo) ?? null;
/** The newest text a 回退到上一版 of the file replaced, or null. */
export const lastRedo = (entries, file) => [...entries].reverse().find(entry => entry.file === file && entry.redo) ?? null;

/** Drops one entry (the version taken back), and `also` ([{ file, version, at }]: the entries of the same write an undo of the structure took back). */
export async function dropHistory(root, course, entry, also = []) {
  const entries = await readHistory(root, course), gone = [entry, ...also];
  const left = entries.filter(item => !gone.some(drop => item.file === drop.file && item.version === drop.version && item.at === drop.at && !item.redo === !drop.redo));
  if (left.length === entries.length) return entries;
  await writeHistory(root, course, left);
  return left;
}

/* The history travels with a portable backup (`export` / `restore` of lib/contexts/library/operations.js list what they carry, like the skeleton
   diagrams): `portableBookHistory: { format, files: [{ name, entries }] }`. A restore checks every file first, then writes them. */
export const HISTORY_BACKUP = 'study-book-history/v1';
const NAME = /^[0-9a-f]{32}\.json$/;

/** Every course's history file under the library, for a backup ([] when there is none). */
export async function exportHistoryFiles(root) {
  if (!root) return [];
  const names = await readdir(join(root, 'book-history')).catch(() => []), files = [];
  for (const name of names.filter(item => NAME.test(item)).sort()) {
    try { const data = JSON.parse(await readFile(join(root, 'book-history', name), 'utf8')); if (Array.isArray(data.entries)) files.push({ name, course: data.course ?? null, entries: data.entries }); } catch { /* an unreadable file is left out */ }
  }
  return files;
}

/** The files of a backup's history section, checked; a section that is not readable is refused before anything is written. */
export function verifyHistoryBackup(section) {
  if (section?.format !== HISTORY_BACKUP || !Array.isArray(section.files)) throw new Error('Portable backup has an unreadable review book history section');
  for (const file of section.files) {
    if (!NAME.test(String(file?.name)) || !Array.isArray(file.entries) || file.entries.some(entry => typeof entry?.text !== 'string' || typeof entry?.file !== 'string'))
      throw new Error('Portable backup has an unreadable review book history file');
  }
  return section.files.map(file => ({ name: file.name, course: file.course ?? null, entries: capHistory(file.entries) }));
}

/** Writes the checked history files back (each through a temporary file and a rename). */
export async function restoreHistoryFiles(root, files) {
  if (!root || !files.length) return;
  await mkdir(join(root, 'book-history'), { recursive: true });
  for (const file of files) {
    const path = join(root, 'book-history', file.name), temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ course: file.course, entries: file.entries })}\n`, 'utf8');
    await rename(temporary, path);
  }
}

/** How many earlier versions each file has: { [file]: n }. */
export const historyCounts = entries => entries.reduce((counts, entry) => (entry.redo ? counts : { ...counts, [entry.file]: (counts[entry.file] || 0) + 1 }), {});
