import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { listRecords } from '../../mineru-history.js';

/* What the conversion history knows about the file a converted book was made from (lib/mineru-history.js): its name and size always, its hash and the
   path the learner gave when they gave one. A converted book keeps no original of its own; this is what lets the original be recognised, and offered again,
   without reading it. Nothing here writes. */

/** The conversion that made `documentId` (the newest), or null. A record names its document as soon as the book is saved, before the conversion is closed. */
export async function conversionOf(root, documentId) {
  const records = await listRecords(root).catch(() => []);
  return records.find(record => record.documentId === documentId) ?? null;
}

/** How the record vouches for a file without anyone reading it: 'hash' (the same bytes), 'record' (the name and size it had, only when the record has no hash to compare), or null. */
export function vouchedBy(record, { hash, size, name }) {
  if (!record) return null;
  if (record.sourceHash) return record.sourceHash === hash ? 'hash' : null; // a hash on record decides: the same name and size with another hash is another file
  return record.filename && record.bytes === size && record.filename.toLowerCase() === String(name).toLowerCase() ? 'record' : null;
}

/** The file the conversion read, offered again: { path, bytes, filename } while it is still there with the size it had; else null. */
export async function convertedFile(record) {
  if (!record?.sourcePath) return null;
  const info = await stat(record.sourcePath).catch(() => null);
  if (!info?.isFile() || info.size !== record.bytes) return null;
  return { path: record.sourcePath, bytes: info.size, filename: record.filename || basename(record.sourcePath) };
}
