/**
 * Shared cross-platform atomic file write helpers for StudyHub TUI exports & persistence.
 * Uses temp file + rename with retry on Windows transient lock errors (`EBUSY`/`EPERM`/`EACCES`),
 * cleaning up any orphaned temporary file on failure.
 *
 * Export helpers enforce:
 * 1. Unique, collision-free filenames containing optional course/deck slug + local timestamp
 *    (`YYYY-MM-DD-HHmmss`) and auto-incremented `-2`/`-3` suffix when a target already exists.
 * 2. Strict sandbox containment under `<libraryRoot>/backups/` for user-supplied `--export` /
 *    backup filenames (rejecting absolute paths, drive letters, UNC paths, and `..` escapes).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const IGNORABLE_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EROFS']);

export interface AtomicFsOps {
  writeAndSync?: (tempPath: string, data: string | Uint8Array, mode?: number) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  onSync?: (tempPath: string) => void;
}

export interface AtomicWriteOptions {
  mode?: number;
  /** Flush file contents to disk via fsync before atomic rename (default true). */
  sync?: boolean;
  /** Internal / test fault-injection hooks. */
  fsOps?: AtomicFsOps;
}

export function todayLocalYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function localTimestampCompact(now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${todayLocalYmd(now)}-${hh}${mm}${ss}`;
}

/**
 * Convert a course, deck, or note title into a filesystem-safe slug (preserving Unicode/CJK letters).
 */
export function sanitizeExportSlug(raw: string | undefined | null, maxLen = 40): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .trim()
    .replace(/\.\.+/g, '-')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/[-.]+$/g, '');
}

export interface BackupFileOptions {
  label?: string | null;
  now?: Date;
}

export function defaultBackupFilePath(
  libraryRoot: string | undefined | null,
  prefix: string,
  ext: string,
  labelOrDate?: string | Date | BackupFileOptions | null,
  maybeDate?: Date,
): string {
  const base = libraryRoot && libraryRoot.trim() ? libraryRoot : process.cwd();
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  let label = '';
  let now: Date = maybeDate ?? new Date();
  if (labelOrDate instanceof Date) {
    now = labelOrDate;
  } else if (typeof labelOrDate === 'string') {
    label = sanitizeExportSlug(labelOrDate);
  } else if (labelOrDate && typeof labelOrDate === 'object') {
    label = sanitizeExportSlug(labelOrDate.label);
    if (labelOrDate.now instanceof Date) now = labelOrDate.now;
  }
  const stamp = localTimestampCompact(now);
  const stem = label ? `${prefix}-${label}-${stamp}` : `${prefix}-${stamp}`;
  return join(base, 'backups', `${stem}${cleanExt}`);
}

/**
 * Return a non-colliding file path: if `targetPath` already exists, appends `-2`, `-3`, ...
 * before the extension so exports never silently overwrite existing files.
 */
export function resolveUniqueFilePath(targetPath: string): string {
  if (!existsSync(targetPath)) return targetPath;
  const dir = dirname(targetPath);
  const ext = extname(targetPath);
  const stem = basename(targetPath, ext);
  for (let seq = 2; seq <= 9999; seq += 1) {
    const candidate = join(dir, `${stem}-${seq}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${randomUUID().slice(0, 8)}${ext}`);
}

function isDisallowedAbsoluteOrDrivePath(raw: string): boolean {
  if (isAbsolute(raw)) return true;
  if (/^[a-zA-Z]:/.test(raw)) return true;
  if (raw.startsWith('/') || raw.startsWith('\\')) return true;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return true;
  return false;
}

/**
 * Safely resolve an export path strictly inside `<libraryRoot>/backups/`.
 * - Empty input falls back to a timestamped default filename inside `backups/`.
 * - Rejects absolute paths, Windows drive-prefixed paths, UNC paths, and any `..` traversal.
 * - Always resolves to a unique path (`-2`, `-3`, ...) so existing backups are never overwritten.
 */
export function resolveSafeBackupExportPath(
  libraryRoot: string | undefined | null,
  rawInput: string | undefined | null,
  prefix: string,
  ext: string,
  labelOrDate?: string | Date | BackupFileOptions | null,
  maybeDate?: Date,
): string {
  const base = libraryRoot && libraryRoot.trim() ? resolve(libraryRoot) : resolve(process.cwd());
  const backupsRoot = resolve(base, 'backups');
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  const trimmed = typeof rawInput === 'string' ? rawInput.trim() : '';

  if (!trimmed) {
    return resolveUniqueFilePath(defaultBackupFilePath(base, prefix, cleanExt, labelOrDate, maybeDate));
  }

  if (isDisallowedAbsoluteOrDrivePath(trimmed)) {
    throw new Error(
      `Unsafe export path "${trimmed}": absolute paths are not allowed; provide a relative filename inside backups/.`,
    );
  }

  const segments = trimmed.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === '..' || seg === '.')) {
    throw new Error(
      `Unsafe export path "${trimmed}": path traversal ("..") is not allowed; target must stay inside backups/.`,
    );
  }

  // Allow optional leading "backups/" prefix only when the user passes a relative path like "backups/foo.json".
  const normalizedSegments =
    segments[0].toLowerCase() === 'backups' && segments.length > 1 ? segments.slice(1) : segments;
  const relJoined = join(...normalizedSegments);
  const withExt = relJoined.toLowerCase().endsWith(cleanExt.toLowerCase())
    ? relJoined
    : `${relJoined}${cleanExt}`;
  const candidate = resolve(backupsRoot, withExt);
  const relFromBackups = relative(backupsRoot, candidate);
  if (
    !relFromBackups ||
    relFromBackups === '.' ||
    relFromBackups.startsWith('..') ||
    isAbsolute(relFromBackups)
  ) {
    throw new Error(
      `Unsafe export path "${trimmed}": target must stay inside ${backupsRoot}.`,
    );
  }

  return resolveUniqueFilePath(candidate);
}

export async function renameWithRetry(
  from: string,
  to: string,
  maxAttempts = 6,
  renameImpl: (src: string, dst: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || '';
      if (!RETRY_CODES.has(code) || attempt >= maxAttempts - 1) throw error;
      await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
    }
  }
}

async function defaultWriteAndSync(
  tempPath: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const fh = await open(tempPath, 'w', opts?.mode);
  try {
    if (typeof data === 'string') {
      await fh.writeFile(data, 'utf8');
    } else {
      await fh.writeFile(data);
    }
    if (opts?.sync !== false) {
      try {
        await fh.sync();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code || '';
        if (!IGNORABLE_SYNC_CODES.has(code)) throw err;
      }
      opts?.fsOps?.onSync?.(tempPath);
    }
  } finally {
    await fh.close();
  }
}

async function atomicWritePayload(
  targetPath: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): Promise<{ bytes: number }> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${randomUUID()}.tmp`;
  const renameImpl = opts?.fsOps?.rename ?? rename;
  try {
    if (opts?.fsOps?.writeAndSync) {
      await opts.fsOps.writeAndSync(temp, data, opts.mode);
    } else {
      await defaultWriteAndSync(temp, data, opts);
    }
    await renameWithRetry(temp, targetPath, 6, renameImpl);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
  return { bytes };
}

export async function atomicWriteTextFile(
  targetPath: string,
  content: string,
  opts?: AtomicWriteOptions,
): Promise<{ bytes: number }> {
  return atomicWritePayload(targetPath, content, opts);
}

export async function atomicWriteJsonFile(
  targetPath: string,
  payload: unknown,
  opts?: AtomicWriteOptions,
): Promise<{ bytes: number }> {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  return atomicWriteTextFile(targetPath, json, opts);
}

/**
 * Atomically copy `srcPath` to `destPath` via temp + fsync + rename so backups and staged
 * intake files are never half-written on failure (#1354 P3-b).
 */
export async function atomicCopyFile(
  srcPath: string,
  destPath: string,
  opts?: AtomicWriteOptions,
): Promise<{ bytes: number }> {
  const bytes = await readFile(srcPath);
  return atomicWritePayload(destPath, bytes, opts);
}

/**
 * Value returned by an {@link atomicUpdateJson} mutator to report a result WITHOUT touching the
 * file (e.g. a passive preferences patch over a corrupt file must not clobber it).
 */
export class AtomicSkip<T = unknown> {
  readonly value: T | undefined;
  constructor(value?: T) {
    this.value = value;
  }
}

/** Outcome of one {@link atomicUpdateJson} read-modify-write (#1354 P3-b). */
export interface AtomicUpdateJsonResult<T> {
  path: string;
  /** False when nothing was written (mutator returned `undefined` or an {@link AtomicSkip}). */
  updated: boolean;
  value: T | undefined;
  bytes: number;
}

/**
 * What to do when the existing target cannot be used as the mutation baseline.
 * `recover` supplies the baseline to mutate (the caller usually backed the file up first),
 * `skip` leaves the file untouched and reports `value`, `abort` refuses to write and throws.
 */
export type AtomicBaselinePolicy<T> = { recover: T } | { skip: T | undefined } | { abort: true };

export interface AtomicUpdateJsonOptions<T> extends AtomicWriteOptions {
  /** Parse existing file text. Default `JSON.parse`. Throwing routes to `onCorrupt`. */
  parse?: (text: string, path: string) => T;
  /** Corrupt / non-object existing content policy. Default: abort (file stays byte-identical). */
  onCorrupt?: (
    error: Error,
    raw: string,
    path: string,
  ) => AtomicBaselinePolicy<T> | Promise<AtomicBaselinePolicy<T>>;
  /** Read failure policy (EACCES/EBUSY/...). ENOENT always means "no previous value". Default: abort. */
  onReadError?: (error: Error, path: string) => AtomicBaselinePolicy<T> | Promise<AtomicBaselinePolicy<T>>;
  /** Serialize the mutated value. Default pretty JSON + trailing newline. */
  stringify?: (value: T) => string;
  /** Serialize overlapping updates of the same path in-process (default true). */
  queue?: boolean;
}

const updateQueues = new Map<string, Promise<unknown>>();

/**
 * Read -> mutate -> write a JSON file as ONE atomic unit (#1354 P3-b).
 *
 * - The mutation is computed from the freshly read content, so overlapping updates never lose data.
 * - The write goes through {@link atomicWriteTextFile} (temp + fsync + rename): a failure at any
 *   point leaves the original file byte-identical and no `.tmp` behind.
 * - A read/parse failure aborts by default instead of clobbering the file with defaults.
 * - Returning `undefined` (or an {@link AtomicSkip}) skips the write but still reports a value.
 *
 * Errors propagate unchanged so callers can surface them; the previous on-disk content is intact.
 */
export async function atomicUpdateJson<T>(
  targetPath: string,
  mutator: (prev: T | undefined) => T | AtomicSkip<T> | undefined | Promise<T | AtomicSkip<T> | undefined>,
  opts?: AtomicUpdateJsonOptions<T>,
): Promise<AtomicUpdateJsonResult<T>> {
  const run = async (): Promise<AtomicUpdateJsonResult<T>> => {
    let raw: string | null = null;
    let prev: T | undefined;
    try {
      raw = await readFile(targetPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') {
        const err = error instanceof Error ? error : new Error(errText(error));
        const policy = await opts?.onReadError?.(err, targetPath);
        if (!policy || 'abort' in policy) {
          throw new Error(
            `Existing ${basename(targetPath)} could not be read (${code ?? err.message}); refusing to overwrite it`,
            { cause: err },
          );
        }
        if ('skip' in policy) {
          return { path: targetPath, updated: false, value: policy.skip, bytes: 0 };
        }
        prev = policy.recover;
      }
    }

    if (raw !== null) {
      try {
        const parse = opts?.parse ?? ((text: string) => JSON.parse(text) as T);
        prev = parse(raw, targetPath);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(errText(error));
        const policy = await opts?.onCorrupt?.(err, raw, targetPath);
        if (!policy || 'abort' in policy) {
          throw new Error(
            `Existing ${basename(targetPath)} is not valid JSON (${err.message}); refusing to overwrite it`,
            { cause: err },
          );
        }
        if ('skip' in policy) {
          return { path: targetPath, updated: false, value: policy.skip, bytes: 0 };
        }
        prev = policy.recover;
      }
    }

    const next = await mutator(prev);
    if (next === undefined) {
      return { path: targetPath, updated: false, value: prev, bytes: 0 };
    }
    if (next instanceof AtomicSkip) {
      return { path: targetPath, updated: false, value: next.value, bytes: 0 };
    }
    const payload = (opts?.stringify ?? ((value: T) => `${JSON.stringify(value, null, 2)}\n`))(next);
    const { bytes } = await atomicWriteTextFile(targetPath, payload, opts);
    return { path: targetPath, updated: true, value: next, bytes };
  };

  if (opts?.queue === false) return run();

  const previous = updateQueues.get(targetPath) ?? Promise.resolve();
  const chained = previous.then(run, run);
  const tail = chained.catch(() => {});
  updateQueues.set(targetPath, tail);
  void tail.finally(() => {
    if (updateQueues.get(targetPath) === tail) updateQueues.delete(targetPath);
  });
  return chained;
}

/** Raised when `run()` failed AND restoring the pre-write snapshot also failed (#1354 P3-b). */
export class AtomicRollbackError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;
  constructor(targetPath: string, originalError: unknown, rollbackError: unknown) {
    super(
      `${basename(targetPath)} was not restored after a failed write (${errText(rollbackError)}); ` +
        `original error: ${errText(originalError)}`,
    );
    this.name = 'AtomicRollbackError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}

/**
 * Run a single logical write against `targetPath` and restore the exact pre-write state if it
 * throws (#1354 P3-b).
 *
 * `run` may perform any write (including several steps on the same path); on failure the previous
 * bytes are restored atomically, or the file is removed when it did not exist before. A successful
 * run is returned untouched, and a successful rollback rethrows the original error so callers keep
 * their existing catch/notice logic.
 */
export async function withRollback<R>(
  targetPath: string,
  run: () => Promise<R>,
  opts?: AtomicWriteOptions,
): Promise<R> {
  let snapshot: Buffer | null = null;
  try {
    snapshot = await readFile(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') throw error;
  }

  try {
    return await run();
  } catch (error) {
    try {
      if (snapshot === null) {
        await rm(targetPath, { force: true });
      } else {
        await atomicWritePayload(targetPath, snapshot, opts);
      }
    } catch (rollbackError) {
      throw new AtomicRollbackError(targetPath, error, rollbackError);
    }
    throw error;
  }
}

export interface AtomicBatchEntry {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

/** A target whose restore/removal failed while rolling back a failed batch write (#1454). */
export interface AtomicBatchRollbackFailure {
  path: string;
  error: unknown;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Raised when a batch write failed AND at least one already-committed target could not be restored
 * or removed (#1454). The original commit error plus every rollback failure are reported together,
 * because the on-disk state may now mix old and new contents and the caller must not assume a
 * clean revert just because it only saw the first error.
 */
export class AtomicBatchWriteError extends Error {
  readonly originalError: unknown;
  readonly rollbackFailures: readonly AtomicBatchRollbackFailure[];

  constructor(originalError: unknown, rollbackFailures: readonly AtomicBatchRollbackFailure[]) {
    const details = rollbackFailures.map((f) => `${f.path}: ${errText(f.error)}`).join('; ');
    super(
      `Atomic batch write failed (${errText(originalError)}); rollback also failed for ${rollbackFailures.length} file(s): ${details}. On-disk state may mix old and new contents.`,
      { cause: originalError },
    );
    this.name = 'AtomicBatchWriteError';
    this.originalError = originalError;
    this.rollbackFailures = rollbackFailures;
  }
}

/**
 * Multi-file transactional atomic write (#1354 P3-b):
 * 1. Stages & fsyncs EVERY temp file before touching any target.
 * 2. Snapshots prior target bytes, then renames each temp -> target.
 * 3. If ANY stage or rename fails, rolls back EVERY already-renamed target (restoring prior bytes
 *    or removing newly created targets) and deletes every staged `.tmp` file.
 * 4. If a rollback step itself fails, throws `AtomicBatchWriteError` carrying both the original
 *    commit error and every failed restore, so callers know the disk may be in a mixed state (#1454).
 */
export async function atomicWriteFilesBatch(
  entries: readonly AtomicBatchEntry[],
  opts?: Pick<AtomicWriteOptions, 'sync' | 'fsOps'>,
): Promise<{ count: number; totalBytes: number }> {
  if (entries.length === 0) return { count: 0, totalBytes: 0 };

  const renameImpl = opts?.fsOps?.rename ?? rename;
  const staged: Array<{
    target: string;
    temp: string;
    bytes: number;
    hadOriginal: boolean;
    originalBytes: Buffer | null;
  }> = [];

  try {
    // Phase 1: Stage & fsync all temp files before mutating any destination
    for (const entry of entries) {
      await mkdir(dirname(entry.path), { recursive: true });
      const temp = `${entry.path}.${randomUUID()}.tmp`;
      const record = {
        target: entry.path,
        temp,
        bytes: typeof entry.content === 'string' ? Buffer.byteLength(entry.content, 'utf8') : entry.content.byteLength,
        hadOriginal: false,
        originalBytes: null as Buffer | null,
      };
      staged.push(record);
      if (opts?.fsOps?.writeAndSync) {
        await opts.fsOps.writeAndSync(temp, entry.content, entry.mode);
      } else {
        await defaultWriteAndSync(temp, entry.content, { mode: entry.mode, sync: opts?.sync, fsOps: opts?.fsOps });
      }
    }

    // Phase 2: Snapshot pre-existing targets for deterministic rollback
    for (const item of staged) {
      try {
        item.originalBytes = await readFile(item.target);
        item.hadOriginal = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') throw err;
        item.hadOriginal = false;
        item.originalBytes = null;
      }
    }

    // Phase 3: Commit renames sequentially; roll back already-committed files in LIFO order on failure
    const committed: typeof staged = [];
    for (const item of staged) {
      try {
        await renameWithRetry(item.temp, item.target, 6, renameImpl);
        committed.push(item);
      } catch (commitErr) {
        const rollbackFailures: AtomicBatchRollbackFailure[] = [];
        for (let i = committed.length - 1; i >= 0; i -= 1) {
          const prev = committed[i];
          try {
            if (prev.hadOriginal && prev.originalBytes !== null) {
              await atomicWritePayload(prev.target, prev.originalBytes, {
                sync: opts?.sync,
                fsOps: opts?.fsOps,
              });
            } else {
              await rm(prev.target, { force: true });
            }
          } catch (restoreErr) {
            rollbackFailures.push({ path: prev.target, error: restoreErr });
          }
        }
        if (rollbackFailures.length > 0) {
          throw new AtomicBatchWriteError(commitErr, rollbackFailures);
        }
        throw commitErr;
      }
    }

    return {
      count: staged.length,
      totalBytes: staged.reduce((sum, item) => sum + item.bytes, 0),
    };
  } catch (error) {
    await Promise.all(staged.map((item) => rm(item.temp, { force: true }).catch(() => {})));
    throw error;
  }
}

/**
 * Atomically write a text export to a guaranteed unique path (never overwrites existing files).
 */
export async function atomicWriteExportText(
  targetPath: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const uniquePath = resolveUniqueFilePath(targetPath);
  const { bytes } = await atomicWriteTextFile(uniquePath, content);
  return { path: uniquePath, bytes };
}

/**
 * Atomically write a JSON export to a guaranteed unique path (never overwrites existing files).
 */
export async function atomicWriteExportJson(
  targetPath: string,
  payload: unknown,
): Promise<{ path: string; bytes: number }> {
  const uniquePath = resolveUniqueFilePath(targetPath);
  const { bytes } = await atomicWriteJsonFile(uniquePath, payload);
  return { path: uniquePath, bytes };
}
