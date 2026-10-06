import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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
export async function atomicJson(file, value) {
  const temporary = `${file}.${id()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 500)));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
