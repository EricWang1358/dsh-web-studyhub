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
// Windows scanners and indexers can briefly deny replacing a file. Retry the same completed file (never replay the write,
// never unlink the destination: readers must always see a whole file) and give up with the last error after 8 tries.
export async function renameWithRetry(from, to, { rename = fsRename, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await wait(Math.min(25 * 2 ** attempt, 500));
    }
  }
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
