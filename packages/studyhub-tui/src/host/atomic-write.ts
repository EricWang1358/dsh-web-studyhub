/**
 * Shared cross-platform atomic file write helpers for StudyHub TUI exports & persistence.
 * Uses temp file + rename with retry on Windows transient lock errors (`EBUSY`/`EPERM`/`EACCES`),
 * cleaning up any orphaned temporary file on failure.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function todayLocalYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function defaultBackupFilePath(
  libraryRoot: string | undefined | null,
  prefix: string,
  ext: string,
  now: Date = new Date(),
): string {
  const base = libraryRoot && libraryRoot.trim() ? libraryRoot : process.cwd();
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  return join(base, 'backups', `${prefix}-${todayLocalYmd(now)}${cleanExt}`);
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
