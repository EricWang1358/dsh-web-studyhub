import { Chalk, type ChalkInstance } from 'chalk';
import { resolveColorCapability } from '../cli-args.js';
import type { ThemeId } from '../types/contracts.js';
import { useTuiStore } from '../state/store.js';

/**
 * Flat design-token bag. Every value is a truecolor hex string usable directly as
 * Ink `color` / `borderColor` / `backgroundColor`, or with `chalk.hex()`.
 */
export interface ThemeTokens {
  id: ThemeId;
  label: string;
  /** true for dark-background palettes */
  dark: boolean;

  /** Brand / primary accent (focus, active selection, headings). */
  primary: string;
  /** Soft secondary accent (links, sub-headings, info pills). */
  accent: string;
  success: string;
  warning: string;
  error: string;
  /** AI / model accent (agy, LLM responses). */
  ai: string;
  info: string;

  /** Primary foreground text. */
  text: string;
  /** Secondary text (meta, captions). */
  muted: string;
  /** Tertiary / disabled text, dividers drawn as text. */
  dim: string;

  /** Idle border colour. */
  border: string;
  /** Focused / active border colour. */
  borderActive: string;

  /** Terminal background assumed by the palette (for inverse pills). */
  bg: string;
  /** Elevated surface (modals, code blocks, pills). */
  surface: string;
  /** Selected row background + foreground. */
  selectionBg: string;
  selectionFg: string;

  heading: string;
  code: string;
  codeBg: string;
  link: string;
  quote: string;

  /** Chart track (empty part of progress bars). */
  track: string;
  /** Heatmap intensity scale: [empty, low, mid, high, max]. */
  heat: readonly [string, string, string, string, string];
}

export const THEME_IDS: readonly ThemeId[] = Object.freeze([
  'dsh-dark',
  'warm-paper',
  'nord',
  'high-contrast',
  'warm-amber',
]);

function define(t: ThemeTokens): ThemeTokens {
  return Object.freeze({ ...t, heat: Object.freeze([...t.heat]) as ThemeTokens['heat'] });
}

const DSH_DARK: ThemeTokens = define({
  id: 'dsh-dark',
  label: 'DSH Dark',
  dark: true,
  primary: '#5b7dff',
  accent: '#7da1de',
  success: '#38d39f',
  warning: '#f5b841',
  error: '#f06478',
  ai: '#a78bfa',
  info: '#7da1de',
  text: '#e6edf3',
  muted: '#8b949e',
  dim: '#6b7482',
  border: '#30363d',
  borderActive: '#5b7dff',
  bg: '#0d1117',
  surface: '#161b22',
  selectionBg: '#1f2a4d',
  selectionFg: '#ffffff',
  heading: '#9fb4ff',
  code: '#f5b841',
  codeBg: '#1c2230',
  link: '#7da1de',
  quote: '#8b949e',
  track: '#262c36',
  heat: ['#21262d', '#1d3b6e', '#2f56c4', '#5b7dff', '#9fb4ff'],
});

const WARM_PAPER: ThemeTokens = define({
  id: 'warm-paper',
  label: 'Warm Paper',
  dark: false,
  primary: '#a54822',
  accent: '#3f6e8c',
  success: '#256e43',
  warning: '#8c5a00',
  error: '#b8323f',
  ai: '#6b4fbb',
  info: '#3f6e8c',
  text: '#2b2520',
  muted: '#6f655b',
  dim: '#857a6b',
  border: '#cfc3b0',
  borderActive: '#a54822',
  bg: '#f7f1e6',
  surface: '#efe6d6',
  selectionBg: '#ead8c0',
  selectionFg: '#1e1915',
  heading: '#8c3d1c',
  code: '#8c3d1c',
  codeBg: '#ece2cf',
  link: '#3f6e8c',
  quote: '#6f655b',
  track: '#e1d6c3',
  heat: ['#e8dfcf', '#f0c9a4', '#e19a63', '#c86b34', '#8c3d1c'],
});

const NORD: ThemeTokens = define({
  id: 'nord',
  label: 'Nord',
  dark: true,
  primary: '#88c0d0',
  accent: '#81a1c1',
  success: '#a3be8c',
  warning: '#ebcb8b',
  // Calibrated for WCAG AA (>= 4.5:1 on bg #2e3440)
  error: '#e08790',
  ai: '#c09bb9',
  info: '#7da0c4',
  text: '#eceff4',
  muted: '#9aa5b8',
  dim: '#7b88a1',
  border: '#3b4252',
  borderActive: '#88c0d0',
  bg: '#2e3440',
  surface: '#3b4252',
  selectionBg: '#434c5e',
  selectionFg: '#eceff4',
  heading: '#8fbcbb',
  code: '#ebcb8b',
  codeBg: '#3b4252',
  link: '#81a1c1',
  quote: '#9aa5b8',
  track: '#434c5e',
  heat: ['#3b4252', '#4c6a7a', '#5e81ac', '#81a1c1', '#88c0d0'],
});

const HIGH_CONTRAST: ThemeTokens = define({
  id: 'high-contrast',
  label: 'High Contrast',
  dark: true,
  primary: '#ffd700',
  accent: '#00e5ff',
  success: '#00ff7f',
  warning: '#ffb000',
  error: '#ff4d4d',
  ai: '#ff79ff',
  info: '#00e5ff',
  text: '#ffffff',
  muted: '#d0d0d0',
  dim: '#a0a0a0',
  border: '#ffffff',
  borderActive: '#ffd700',
  bg: '#000000',
  surface: '#1a1a1a',
  selectionBg: '#ffd700',
  selectionFg: '#000000',
  heading: '#ffd700',
  code: '#00e5ff',
  codeBg: '#1a1a1a',
  link: '#00e5ff',
  quote: '#d0d0d0',
  track: '#444444',
  heat: ['#333333', '#005f87', '#0087d7', '#00afff', '#ffffff'],
});

/** Low-blue-light eye-care theme #1 (Round 84 Track A3): warm dark amber palette, calibrated >= 4.5:1 WCAG AA. */
const WARM_AMBER: ThemeTokens = define({
  id: 'warm-amber',
  label: 'Warm Amber',
  dark: true,
  primary: '#e8a45a',
  accent: '#d9b574',
  success: '#8fc17d',
  warning: '#f2c15c',
  error: '#e87d6b',
  ai: '#d39cc6',
  info: '#8fb4a8',
  text: '#ede0cc',
  muted: '#b5a48e',
  dim: '#8e7e6c',
  border: '#44392e',
  borderActive: '#e8a45a',
  bg: '#1c1814',
  surface: '#26201a',
  selectionBg: '#3f3224',
  selectionFg: '#fbf3e4',
  heading: '#f4c88c',
  code: '#f2c15c',
  codeBg: '#2b231b',
  link: '#d9b574',
  quote: '#b5a48e',
  track: '#332a21',
  heat: ['#2b231b', '#5c4124', '#8f602b', '#c48338', '#f2c15c'],
});

const THEMES: Readonly<Record<ThemeId, ThemeTokens>> = Object.freeze({
  'dsh-dark': DSH_DARK,
  'warm-paper': WARM_PAPER,
  nord: NORD,
  'high-contrast': HIGH_CONTRAST,
  'warm-amber': WARM_AMBER,
});

/** Resolve a palette by id (unknown ids fall back to `dsh-dark`). */
export function getTheme(id: ThemeId | string | null | undefined): ThemeTokens {
  return (id && (THEMES as Record<string, ThemeTokens>)[id]) || DSH_DARK;
}

export function listThemes(): ThemeTokens[] {
  return THEME_IDS.map((id) => THEMES[id]);
}

/** Cycle to the next palette id (used by `/theme`). */
export function nextThemeId(id: ThemeId): ThemeId {
  const idx = THEME_IDS.indexOf(id);
  return THEME_IDS[(idx + 1) % THEME_IDS.length];
}

/** Tone → colour helper shared by pills, toasts and badges. */
export type Tone = 'neutral' | 'primary' | 'accent' | 'info' | 'success' | 'warning' | 'error' | 'ai' | 'muted';

export function toneColor(theme: ThemeTokens, tone: Tone = 'neutral'): string {
  switch (tone) {
    case 'primary':
      return theme.primary;
    case 'accent':
      return theme.accent;
    case 'info':
      return theme.info;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'ai':
      return theme.ai;
    case 'muted':
      return theme.muted;
    default:
      return theme.text;
  }
}

/** React hook: the active palette from store preferences (re-renders only on theme change). */
export function useTheme(): ThemeTokens {
  const id = useTuiStore((s) => s.preferences.theme);
  return getTheme(id);
}

/** Terminal color support level matching Chalk (`0` = none / NO_COLOR, `1` = basic 16, `2` = 256, `3` = truecolor). */
export type ColorLevel = 0 | 1 | 2 | 3;

const COLOR_LEVEL_KEY = Symbol.for('@studyhub-tui/colorLevel');
type GlobalColorState = typeof globalThis & { [COLOR_LEVEL_KEY]?: ColorLevel };

/** Return the active terminal color level, resolving from env/TTY capability when unset. */
export function getColorLevel(): ColorLevel {
  const override = (globalThis as GlobalColorState)[COLOR_LEVEL_KEY];
  if (override !== undefined) return override;
  return resolveColorCapability(process.env, { isTTY: Boolean(process.stdout?.isTTY) }).level;
}

/** Override the active terminal color level at runtime (or in tests). */
export function setColorLevel(level: ColorLevel): void {
  (globalThis as GlobalColorState)[COLOR_LEVEL_KEY] = level;
}

const CHALK_CACHE: Partial<Record<ColorLevel, ChalkInstance>> = {};

/** Return a cached Chalk instance respecting the provided or active ColorLevel. */
export function makeChalk(level: ColorLevel = getColorLevel()): ChalkInstance {
  let instance = CHALK_CACHE[level];
  if (!instance) {
    instance = new Chalk({ level });
    CHALK_CACHE[level] = instance;
  }
  return instance;
}
