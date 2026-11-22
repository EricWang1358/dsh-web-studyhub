/**
 * Zero-dependency validated, atomic persistence for TUI-only preferences at `<DSH_HOME || ~/.dsh>/study/tui.json`.
 * Lives beside StudyHub Desktop's `desktop.json` (never inside the study library).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ThemeId, TuiPreferences, UiLanguage } from '../types/contracts.js';

export const THEME_IDS: readonly ThemeId[] = Object.freeze(['dsh-dark', 'warm-paper', 'nord', 'high-contrast']);
export const UI_LANGUAGES: readonly UiLanguage[] = Object.freeze(['zh', 'en']);
export const MAX_RECENT_COMMANDS = 12;
export const MAX_LAST_READ_PAGES = 100;
const MAX_LAST_READ_KEY_LENGTH = 160;
const MAX_LAST_READ_PAGE = 50_000;

const THEME_SET = new Set<string>(THEME_IDS);
const LANGUAGE_SET = new Set<string>(UI_LANGUAGES);

export const DEFAULT_TUI_PREFERENCES: Readonly<TuiPreferences> = Object.freeze({
  theme: 'dsh-dark',
  language: 'zh',
  sidebarCollapsed: false,
  mathUnicode: true,
  compactMode: false,
  showKeyHints: true,
  asciiMode: false,
  recentCommands: Object.freeze([]) as unknown as string[],
});

function parseTuiPreferencesObject(source: Record<string, unknown>): TuiPreferences {
  const theme =
    typeof source.theme === 'string' && THEME_SET.has(source.theme)
      ? (source.theme as ThemeId)
      : DEFAULT_TUI_PREFERENCES.theme;
  const language =
    typeof source.language === 'string' && LANGUAGE_SET.has(source.language)
      ? (source.language as UiLanguage)
      : DEFAULT_TUI_PREFERENCES.language;
  const sidebarCollapsed =
    typeof source.sidebarCollapsed === 'boolean' ? source.sidebarCollapsed : DEFAULT_TUI_PREFERENCES.sidebarCollapsed;
  const mathUnicode =
    typeof source.mathUnicode === 'boolean' ? source.mathUnicode : DEFAULT_TUI_PREFERENCES.mathUnicode;
  const compactMode =
    typeof source.compactMode === 'boolean' ? source.compactMode : DEFAULT_TUI_PREFERENCES.compactMode;
  const showKeyHints =
    typeof source.showKeyHints === 'boolean' ? source.showKeyHints : DEFAULT_TUI_PREFERENCES.showKeyHints;
  const asciiMode = typeof source.asciiMode === 'boolean' ? source.asciiMode : false;

  const recentCommands: string[] = [];
  if (Array.isArray(source.recentCommands)) {
    const seen = new Set<string>();
    for (const item of source.recentCommands) {
      if (typeof item !== 'string') continue;
      const id = item.trim().slice(0, 200);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      recentCommands.push(id);
      if (recentCommands.length >= MAX_RECENT_COMMANDS) break;
    }
  }

  let lastOpenAiPreset: string | undefined;
  if (typeof source.lastOpenAiPreset === 'string') {
    const trimmed = source.lastOpenAiPreset.trim();
    if (trimmed.length >= 1 && trimmed.length <= 64) {
      lastOpenAiPreset = trimmed;
    }
  }

  let lastReadPages: Record<string, number> | undefined;
  if (source.lastReadPages && typeof source.lastReadPages === 'object' && !Array.isArray(source.lastReadPages)) {
    const validEntries = new Map<string, number>();
    for (const [rawKey, rawVal] of Object.entries(source.lastReadPages as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key || key.length > MAX_LAST_READ_KEY_LENGTH) continue;
      if (typeof rawVal !== 'number' || !Number.isSafeInteger(rawVal) || rawVal < 1 || rawVal > MAX_LAST_READ_PAGE) {
        continue;
      }
      if (validEntries.has(key)) validEntries.delete(key);
      validEntries.set(key, rawVal);
    }
    if (validEntries.size > 0) {
      const entries = [...validEntries.entries()];
      const capped = entries.length > MAX_LAST_READ_PAGES ? entries.slice(-MAX_LAST_READ_PAGES) : entries;
      lastReadPages = Object.fromEntries(capped);
    }
  }

  const base: TuiPreferences = {
    theme,
    language,
    sidebarCollapsed,
    mathUnicode,
    compactMode,
    showKeyHints,
    asciiMode,
    recentCommands,
  };
  return {
    ...base,
    ...(lastOpenAiPreset ? { lastOpenAiPreset } : {}),
    ...(lastReadPages ? { lastReadPages } : {}),
  };
}

/** Field-level forgiving parser shim (zod-compatible `.safeParse(raw)` interface, zero dependencies). */
export const TuiPreferencesSchema = {
  safeParse(raw: unknown): { success: true; data: TuiPreferences } | { success: false; error: Error } {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { success: false, error: new Error('Expected preferences object') };
      }
      return { success: true, data: parseTuiPreferencesObject(raw as Record<string, unknown>) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },
};

export interface TuiPrefsLocation {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Explicit file path (overrides env/home resolution). */
  filePath?: string;
}

export function resolveStudyHome({ env = process.env, home = homedir() }: TuiPrefsLocation = {}): string {
  const override = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const dshHome = override ? (isAbsolute(override) ? resolve(override) : resolve(home, override)) : join(home, '.dsh');
  return join(dshHome, 'study');
}

export function tuiPreferencesPath(location: TuiPrefsLocation = {}): string {
  return location.filePath ? resolve(location.filePath) : join(resolveStudyHome(location), 'tui.json');
}

/** Parse arbitrary JSON-ish input into valid preferences (never throws). */
export function parseTuiPreferences(raw: unknown): TuiPreferences {
  try {
    const source =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return parseTuiPreferencesObject(source);
  } catch {
    return { ...DEFAULT_TUI_PREFERENCES, recentCommands: [] };
  }
}

/** Load preferences; a missing, unreadable or corrupt file yields defaults. */
export async function loadTuiPreferences(location: TuiPrefsLocation = {}): Promise<TuiPreferences> {
  try {
    const text = await readFile(tuiPreferencesPath(location), 'utf8');
    return parseTuiPreferences(JSON.parse(text));
  } catch {
    return { ...DEFAULT_TUI_PREFERENCES, recentCommands: [] };
  }
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || '';
      if (!RETRY_CODES.has(code) || attempt >= 5) throw error;
      await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
    }
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Atomically persist preferences (temp file + rename, serialized). Accepts a partial patch which is
 * merged over what is currently stored. Returns the validated preferences actually written.
 */
export async function saveTuiPreferences(
  prefs: Partial<TuiPreferences>,
  location: TuiPrefsLocation = {},
): Promise<TuiPreferences> {
  const run = writeQueue.then(async () => {
    const target = tuiPreferencesPath(location);
    const current = await loadTuiPreferences(location);
    const next = parseTuiPreferences({ ...current, ...prefs });
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await renameWithRetry(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return next;
  });
  writeQueue = run.catch(() => {});
  return run;
}
