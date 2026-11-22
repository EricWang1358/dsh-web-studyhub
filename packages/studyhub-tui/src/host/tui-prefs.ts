/**
 * Zod-validated, atomic persistence for TUI-only preferences at `<DSH_HOME || ~/.dsh>/study/tui.json`.
 * Lives beside StudyHub Desktop's `desktop.json` (never inside the study library).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ThemeId, TuiPreferences, UiLanguage } from '../types/contracts.js';

export const THEME_IDS: readonly ThemeId[] = Object.freeze(['dsh-dark', 'warm-paper', 'nord', 'high-contrast']);
export const UI_LANGUAGES: readonly UiLanguage[] = Object.freeze(['zh', 'en']);
export const MAX_RECENT_COMMANDS = 12;

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

const recentCommands = z
  .array(z.unknown())
  .transform((items) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      const id = item.trim().slice(0, 200);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= MAX_RECENT_COMMANDS) break;
    }
    return out;
  })
  .catch([]);

/** Field-level forgiving schema: one bad field falls back to its default, the rest survive. */
export const TuiPreferencesSchema = z.object({
  theme: z.enum(['dsh-dark', 'warm-paper', 'nord', 'high-contrast']).catch(DEFAULT_TUI_PREFERENCES.theme),
  language: z.enum(['zh', 'en']).catch(DEFAULT_TUI_PREFERENCES.language),
  sidebarCollapsed: z.boolean().catch(DEFAULT_TUI_PREFERENCES.sidebarCollapsed),
  mathUnicode: z.boolean().catch(DEFAULT_TUI_PREFERENCES.mathUnicode),
  compactMode: z.boolean().catch(DEFAULT_TUI_PREFERENCES.compactMode),
  showKeyHints: z.boolean().catch(DEFAULT_TUI_PREFERENCES.showKeyHints),
  asciiMode: z.boolean().default(false).catch(false),
  recentCommands: recentCommands.default([]),
  lastOpenAiPreset: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .catch(undefined),
});

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
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const parsed = TuiPreferencesSchema.safeParse(source);
    if (!parsed.success) return { ...DEFAULT_TUI_PREFERENCES, recentCommands: [] };
    const { lastOpenAiPreset, ...rest } = parsed.data;
    return lastOpenAiPreset ? { ...rest, lastOpenAiPreset } : rest;
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
