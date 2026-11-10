import { readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { id, parseStoredJson } from './util.js';

// The existing audio manifest writer, shared by domain and lifecycle mutations.
// This queue contains file operations, not Jobs or provider work.
const writing = new Map();
export function serializeJsonFile(file, operation) {
  const key = resolve(file);
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
export async function renameWithRetry(from, to, { rename = fsRename, wait } = {}) {
  return retryDenied(() => rename(from, to), { wait });
}
export async function atomicJson(file, value) {
  const temporary = `${file}.${id()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), 'utf8');
    await renameWithRetry(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
