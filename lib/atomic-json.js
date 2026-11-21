import { mkdir, open, readFile, rename as fsRename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { id, parseStoredJson } from './util.js';

const canonicalFileKey = file => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file));

// The existing audio manifest writer, shared by domain and lifecycle mutations.
// This queue contains file operations, not Jobs or provider work.
const writing = new Map();
export function serializeJsonFile(file, operation) {
  const key = canonicalFileKey(file);
  const pending = (writing.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  writing.set(key, pending);
  void pending.finally(() => { if (writing.get(key) === pending) writing.delete(key); }).catch(() => {});
  return pending;
}
export const readJsonFile = file => readFile(file, 'utf8').then(parseStoredJson);
// Windows scanners and indexers can briefly deny opening, reading or replacing a file. Ask again after a growing pause, only for that denial
// (EPERM, EACCES, EBUSY; a missing file or any other error answers at once), and give up with the last error after `tries` tries.
export async function retryDenied(operation, { tries = 8, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const baseMs = Number(process.env.STUDY_FS_RETRY_MS) > 0 ? Number(process.env.STUDY_FS_RETRY_MS) : 25;
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= tries - 1) throw error;
      await wait(Math.min(baseMs * 2 ** attempt, baseMs * 20));
    }
  }
}
// Retry the same completed file (never replay the write, never unlink the destination: readers must always see a whole file).
export async function renameWithRetry(from, to, { rename = fsRename, wait, tries } = {}) {
  return retryDenied(() => rename(from, to), { wait, ...(tries !== undefined ? { tries } : {}) });
}
/**
 * Atomically write `content` (string or Buffer/Uint8Array) to `file` via exclusive temp file (`wx`),
 * optional `fsync` before close, Windows-safe `renameWithRetry`, and guaranteed `.tmp` cleanup on error.
 */
export async function atomicWriteFile(file, content, {
  encoding,
  sync = false,
  ensureDir = false,
  tempPath,
  beforeReplace,
  rename = fsRename,
  wait,
  tries,
} = {}) {
  if (ensureDir) await mkdir(dirname(file), { recursive: true });
  const temporary = tempPath || `${file}.${id()}.tmp`;
  const dataEncoding = encoding ?? (typeof content === 'string' ? 'utf8' : undefined);
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(content, dataEncoding);
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeReplace?.(temporary);
    await renameWithRetry(temporary, file, { rename, wait, tries });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
export async function atomicJson(file, value, { space, trailingNewline = false, ...options } = {}) {
  const text = JSON.stringify(value, null, space) + (trailingNewline ? '\n' : '');
  await atomicWriteFile(file, text, { ...options, encoding: 'utf8' });
}
