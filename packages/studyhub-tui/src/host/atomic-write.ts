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
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

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

export async function renameWithRetry(from: string, to: string, maxAttempts = 6): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || '';
      if (!RETRY_CODES.has(code) || attempt >= maxAttempts - 1) throw error;
      await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
    }
  }
}

export async function atomicWriteTextFile(
  targetPath: string,
  content: string,
): Promise<{ bytes: number }> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temp, content, 'utf8');
  try {
    await renameWithRetry(temp, targetPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { bytes: Buffer.byteLength(content, 'utf8') };
}

export async function atomicWriteJsonFile(
  targetPath: string,
  payload: unknown,
): Promise<{ bytes: number }> {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  return atomicWriteTextFile(targetPath, json);
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
