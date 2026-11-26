import { realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename as fsRename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { id, parseStoredJson } from './util.js';

function resolveExistingAncestorRealpath(dirPath) {
  let current = resolve(dirPath);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(dirPath);
      tail.push(basename(current));
      current = parent;
    }
  }
}

const canonicalFileKey = file => {
  const resolved = resolve(file);
  const parent = dirname(resolved);
  const canonical = parent === resolved ? resolved : join(resolveExistingAncestorRealpath(parent), basename(resolved));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};
const IGNORABLE_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EROFS']);
const errText = error => (error instanceof Error ? error.message : String(error));

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
  mode,
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
    const handle = mode !== undefined ? await open(temporary, 'wx', mode) : await open(temporary, 'wx');
    try {
      await handle.writeFile(content, dataEncoding);
      if (sync) {
        try { await handle.sync(); } catch (syncError) {
          if (!IGNORABLE_SYNC_CODES.has(syncError?.code)) throw syncError;
        }
      }
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

/** Parse JSON text that must decode to a plain object (rejects primitives, null, and arrays). */
export function parseJsonObject(text) {
  const parsed = parseStoredJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

/**
 * Atomically copy a corrupt JSON file aside to `<file>.corrupt-<ts>-<id>.bak` before overwriting it.
 * Never swallows backup failures: throws a coded `corrupt-backup-failed` error so callers abort
 * instead of silently destroying the only remaining copy of the file (#1354 D11).
 */
export async function backupCorruptJsonFile(file, { mode, sync = true, rename = fsRename, wait, tries } = {}) {
  const backupPath = `${file}.corrupt-${Date.now()}-${id()}.bak`;
  try {
    const bytes = await readFile(file);
    await atomicWriteFile(backupPath, bytes, { mode, sync, ensureDir: true, rename, wait, tries });
    return { backupPath, bytes: bytes.byteLength };
  } catch (error) {
    throw Object.assign(
      new Error(`Existing ${basename(file)} could not be backed up (${errText(error)}); refusing to overwrite it`),
      { code: 'corrupt-backup-failed', targetPath: file, backupPath, cause: error },
    );
  }
}

/**
 * The `onCorrupt` policy of a write that may replace a damaged file: start again from `recover`, but only after
 * `backupCorruptJsonFile` has copied the damaged bytes aside (a failed copy aborts the write).
 */
export const backupThenRecover = (file, recover, backupOptions) => () => ({ recover, beforeWrite: () => backupCorruptJsonFile(file, backupOptions) });

/**
 * Serialized atomic read-modify-write for a JSON file (#1354 P3):
 * - Queues overlapping updates for the same canonical path via `serializeJsonFile`.
 * - Aborts by default on read errors (other than `ENOENT`) or corrupt JSON instead of clobbering.
 * - `onCorrupt` / `onReadError` may return `{ recover, beforeWrite? }`, `{ skip }`, or `{ abort: true }`.
 *   `beforeWrite` runs only after `mutator(prev)` succeeds, so validation failures never leave `.bak` files.
 */
export async function atomicUpdateJson(file, mutator, {
  parse = parseStoredJson,
  onCorrupt,
  onReadError,
  space,
  trailingNewline = true,
  mode,
  sync = true,
  ensureDir = true,
  queue = true,
  rename = fsRename,
  wait,
  tries,
} = {}) {
  const run = async () => {
    let raw = null;
    let prev;
    let beforeWrite = null;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const policy = await onReadError?.(error, file);
        if (!policy || policy.abort || (!('skip' in policy) && !('recover' in policy))) {
          throw Object.assign(
            new Error(`Existing ${basename(file)} could not be read (${error?.code ?? errText(error)}); refusing to overwrite it`),
            { code: 'json-unreadable', cause: error },
          );
        }
        if ('skip' in policy) return { path: file, updated: false, value: policy.skip };
        prev = policy.recover;
        beforeWrite = policy.beforeWrite ?? null;
      }
    }
    if (raw !== null) {
      try {
        prev = parse(raw, file);
      } catch (error) {
        const policy = await onCorrupt?.(error, raw, file);
        if (!policy || policy.abort || (!('skip' in policy) && !('recover' in policy))) {
          throw Object.assign(
            new Error(`Existing ${basename(file)} is not valid JSON (${errText(error)}); refusing to overwrite it`),
            { code: 'json-corrupt', cause: error },
          );
        }
        if ('skip' in policy) return { path: file, updated: false, value: policy.skip };
        prev = policy.recover;
        beforeWrite = policy.beforeWrite ?? null;
      }
    }
    const next = await mutator(prev);
    if (next === undefined) return { path: file, updated: false, value: prev };
    if (beforeWrite) await beforeWrite();
    await atomicJson(file, next, { space, trailingNewline, mode, sync, ensureDir, rename, wait, tries });
    return { path: file, updated: true, value: next };
  };
  return queue ? serializeJsonFile(file, run) : run();
}
