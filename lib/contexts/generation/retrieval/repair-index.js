import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from '../../../atomic-json.js';
import { RetrievalError } from '../../../retrieval.js';
import { RESET_MARKER, canIngest, readManifest, retrievalHome, writeManifest } from '../../../retrieval-index.js';
import { INDEX_TEXT } from '../../../retrieval-messages.js';

/* The Repair action of Settings › Search extension, offered only while the search extension is installed but its server is not running (retrieval.status
   companion.notStarted). It does what the extension does with an index its server cannot open (packages/studyhub-retrieval/heal.js): the
   table folder is moved aside to chunks.lance.broken-<time> (never deleted) and reset.json says when, why and where. StudyHub cannot open
   the table itself (LanceDB is the extension's), and the extension already moves aside every table it finds broken when DSH starts, so
   here the learner's choice is the reason: what is left is an index the server still does not start with. This library's manifest is
   emptied as well (its pages listed as `reset`), so the next build sends every page again. DSH has to be restarted to start the server. */

/** <time> of chunks.lance.broken-<time>, the same as the extension's: the moment in UTC, safe in a Windows file name. */
export const resetStamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const exists = path => stat(path).then(() => true, () => false);

/** Resolves { at, movedTo (null when there was no index folder) }; rejects with retrieval-running or retrieval-repair-failed. */
export async function repairIndex({ port, root, now = () => new Date() }) {
  if (canIngest(port)) throw new RetrievalError('retrieval-running', INDEX_TEXT.repairRunning);
  const home = retrievalHome(), table = join(home, 'lancedb', 'chunks.lance'), date = now();
  let movedTo = null;
  if (await exists(table)) {
    const base = `${table}.broken-${resetStamp(date)}`;
    let target = base;
    for (let n = 2; await exists(target); n++) target = `${base}-${n}`;
    try { await renameWithRetry(table, target); } catch { throw new RetrievalError('retrieval-repair-failed', INDEX_TEXT.repairFailed); }
    movedTo = target;
  }
  const marker = { at: date.toISOString(), reason: 'repair', movedTo };
  await mkdir(home, { recursive: true });
  await writeFile(join(home, RESET_MARKER), `${JSON.stringify(marker)}\n`, 'utf8');
  const manifest = await readManifest(root);
  await writeManifest(root, { sources: {}, reset: [...new Set([...(manifest.reset || []), ...Object.keys(manifest.sources)])] });
  return { at: marker.at, movedTo };
}
