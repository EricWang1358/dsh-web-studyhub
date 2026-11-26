/**
 * Dedicated, atomic persistence for TUI usage data at `<DSH_HOME || ~/.dsh>/study/tui-usage.json`.
 *
 * Separated from user preferences (`tui.json`) per #1354 D11:
 * - Stores ONLY structural IDs & counters (registered assistant chip IDs and last-practice IDs).
 * - NEVER persists raw user-typed text or card stem previews (`promptPreview`).
 * - Carries schema `version: 1`, tolerates UTF-8 BOM, refuses to overwrite unknown/future versions
 *   ([C38]), leaves corrupt/unreadable files untouched on passive writes, and requires a successful
 *   `.corrupt-*.bak` backup before explicit recovery.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AssistantCommandStat, LastPracticeContext } from '../types/contracts.js';
import { extractPersistableChipStats } from '../shell/assistant-chips.js';
import { atomicCopyFile, atomicUpdateJson, type AtomicFsOps } from './atomic-write.js';
import { resolveStudyHome, type TuiPrefsLocation } from './tui-prefs.js';

export const TUI_USAGE_SCHEMA_VERSION = 1;

export interface TuiUsageData {
  /** Per-page recommended chip ID frequency (ONLY registered `chip:*` IDs, never free text). */
  assistantChipStats?: Record<string, Record<string, AssistantCommandStat>>;
  /** Last active practice position (structural IDs & numbers only; `promptPreview` is always omitted). */
  lastPracticeContext?: LastPracticeContext;
}

export interface TuiUsageLocation extends TuiPrefsLocation {
  /** When true, allow backing up and replacing a corrupt `tui-usage.json`. Never overrides unreadable or unsupported-version files. */
  recover?: boolean;
  /** Internal / test fault-injection hooks forwarded to atomic persistence & corrupt backup. */
  fsOps?: AtomicFsOps;
}

export interface LoadTuiUsageResult {
  usage: TuiUsageData;
  status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'unsupported-version';
  error?: string;
}

class UnsupportedUsageVersionError extends Error {
  readonly code = 'usage-unsupported-version';
  readonly version: unknown;
  constructor(version: unknown) {
    super(
      `Unsupported tui-usage.json schema version ${String(version)} (supported: ${TUI_USAGE_SCHEMA_VERSION}); refusing to overwrite usage data`,
    );
    this.name = 'UnsupportedUsageVersionError';
    this.version = version;
  }
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectUnsupportedVersion(raw: Record<string, unknown>): { version: unknown } | null {
  if (!Object.hasOwn(raw, 'version') || raw.version === undefined) return null;
  if (raw.version === TUI_USAGE_SCHEMA_VERSION) return null;
  return { version: raw.version };
}

function sanitizeLastPracticeContext(rawVal: unknown): LastPracticeContext | undefined {
  if (!rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) return undefined;
  const raw = rawVal as Record<string, unknown>;
  const runId = typeof raw.runId === 'string' ? raw.runId.trim().slice(0, 128) : '';
  const cardId = typeof raw.cardId === 'string' ? raw.cardId.trim().slice(0, 128) : '';
  if (!runId || !cardId) return undefined;
  const cardIndex =
    typeof raw.cardIndex === 'number' && Number.isSafeInteger(raw.cardIndex) && raw.cardIndex >= 0
      ? raw.cardIndex
      : 0;
  const deckId = typeof raw.deckId === 'string' && raw.deckId.trim() ? raw.deckId.trim().slice(0, 128) : undefined;
  const total =
    typeof raw.total === 'number' && Number.isSafeInteger(raw.total) && raw.total > 0 ? raw.total : undefined;
  const savedAt =
    typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) && raw.savedAt > 0 ? raw.savedAt : Date.now();
  // #1354 D11: explicitly omit `promptPreview` so question stem text is never written to disk.
  return {
    runId,
    cardId,
    ...(deckId ? { deckId } : {}),
    cardIndex,
    ...(total ? { total } : {}),
    savedAt,
  };
}

/** Parse arbitrary JSON-ish input into sanitized `TuiUsageData` (never throws, never retains free text). */
export function parseTuiUsage(raw: unknown): TuiUsageData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const assistantChipStats = extractPersistableChipStats(
    source.assistantChipStats as Record<string, Record<string, AssistantCommandStat>> | undefined,
  );
  const lastPracticeContext = sanitizeLastPracticeContext(source.lastPracticeContext);
  return {
    ...(assistantChipStats ? { assistantChipStats } : {}),
    ...(lastPracticeContext ? { lastPracticeContext } : {}),
  };
}

export function tuiUsagePath(location: TuiPrefsLocation = {}): string {
  return location.filePath ? resolve(location.filePath) : join(resolveStudyHome(location), 'tui-usage.json');
}

/** Load usage data with explicit status so callers can distinguish missing, corrupt, unreadable, and newer versions. */
export async function loadTuiUsageSafe(location: TuiPrefsLocation = {}): Promise<LoadTuiUsageResult> {
  let text: string;
  try {
    text = await readFile(tuiUsagePath(location), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return { usage: {}, status: 'missing' };
    }
    return {
      usage: {},
      status: 'unreadable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const parsed: unknown = JSON.parse(stripUtf8Bom(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { usage: {}, status: 'corrupt', error: 'Expected usage JSON object' };
    }
    const unsupported = detectUnsupportedVersion(parsed as Record<string, unknown>);
    if (unsupported !== null) {
      return {
        usage: {},
        status: 'unsupported-version',
        error: new UnsupportedUsageVersionError(unsupported.version).message,
      };
    }
    return { usage: parseTuiUsage(parsed), status: 'ok' };
  } catch (err) {
    return {
      usage: {},
      status: 'corrupt',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function loadTuiUsage(location: TuiPrefsLocation = {}): Promise<TuiUsageData> {
  return (await loadTuiUsageSafe(location)).usage;
}

async function backupCorruptUsageFile(target: string, fsOps?: AtomicFsOps): Promise<string> {
  const backupPath = `${target}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`;
  await atomicCopyFile(target, backupPath, { mode: 0o600, fsOps });
  return backupPath;
}

function mergeChipStatsMaps(
  prev: Record<string, Record<string, AssistantCommandStat>> | undefined,
  incoming: Record<string, Record<string, AssistantCommandStat>> | undefined,
): Record<string, Record<string, AssistantCommandStat>> | undefined {
  const cleanPrev = extractPersistableChipStats(prev);
  const cleanIncoming = extractPersistableChipStats(incoming);
  if (!cleanPrev && !cleanIncoming) return undefined;
  const combined: Record<string, Record<string, AssistantCommandStat>> = {};
  if (cleanPrev) {
    for (const [page, map] of Object.entries(cleanPrev)) {
      combined[page] = { ...map };
    }
  }
  if (cleanIncoming) {
    for (const [page, map] of Object.entries(cleanIncoming)) {
      const target = { ...(combined[page] ?? {}) };
      for (const [chipId, stat] of Object.entries(map)) {
        const cur = target[chipId];
        target[chipId] = cur
          ? { count: Math.max(cur.count, stat.count), lastUsedAt: Math.max(cur.lastUsedAt, stat.lastUsedAt) }
          : { ...stat };
      }
      combined[page] = target;
    }
  }
  return extractPersistableChipStats(combined);
}

/**
 * Atomically merge and persist sanitized TUI usage data into `tui-usage.json`.
 *
 * Protection rules (#1354 D11):
 * - Unreadable file (e.g. EACCES / EISDIR): refuses overwrite and throws.
 * - Unsupported/future schema version ([C38]): passive save skips; `recover: true` throws; bytes stay intact.
 * - Corrupt JSON: passive save skips and leaves original bytes untouched; `recover: true` backs up
 *   the corrupt file first (aborting if backup fails) before writing.
 */
export async function saveTuiUsage(
  patch: Partial<TuiUsageData>,
  location: TuiUsageLocation = {},
): Promise<TuiUsageData> {
  const target = tuiUsagePath(location);
  const allowRecover = location.recover === true;
  let merged: TuiUsageData | undefined;

  const res = await atomicUpdateJson<TuiUsageData>(
    target,
    (prev) => {
      const mergedChipStats = mergeChipStatsMaps(prev?.assistantChipStats, patch.assistantChipStats);
      merged = parseTuiUsage({
        ...(prev ?? {}),
        ...patch,
        ...(mergedChipStats ? { assistantChipStats: mergedChipStats } : {}),
      });
      return merged;
    },
    {
      fsOps: location.fsOps,
      stringify: (value) => `${JSON.stringify({ version: TUI_USAGE_SCHEMA_VERSION, ...value }, null, 2)}\n`,
      parse: (text) => {
        const parsed: unknown = JSON.parse(stripUtf8Bom(text));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Expected usage JSON object');
        }
        const unsupported = detectUnsupportedVersion(parsed as Record<string, unknown>);
        if (unsupported !== null) {
          throw new UnsupportedUsageVersionError(unsupported.version);
        }
        return parseTuiUsage(parsed);
      },
      onCorrupt: async (error) => {
        const recovered = parseTuiUsage(patch);
        if (error instanceof UnsupportedUsageVersionError) {
          if (!allowRecover) return { skip: recovered };
          throw error;
        }
        if (!allowRecover) {
          return { skip: recovered };
        }
        await backupCorruptUsageFile(target, location.fsOps);
        return { recover: recovered };
      },
    },
  );
  return merged ?? (res.value as TuiUsageData);
}
