/**
 * Terminal OSC 2 window title progress & OSC 9 background completion notifications (Round 87 Track C4).
 *
 * Emits standard terminal title (`\x1b]2;<title>\x07`) and desktop notification (`\x1b]9;<msg>\x07`)
 * sequences on capable TTYs while degrading safely to a no-op under `NO_COLOR`, `asciiMode`,
 * `TERM=dumb`, or non-TTY streams, and rejecting/stripping control bytes to prevent escape injection.
 */
import type { UiLanguage } from '../types/contracts.js';

export interface OscTerminalDetectOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  asciiMode?: boolean;
}

const NOTIFY_TERM_PROGRAMS = new Set(['iterm.app', 'wezterm', 'ghostty', 'warpterminal', 'kitty']);

export function sanitizeOscText(text: string, maxLen = 96): string {
  const clean = String(text ?? '')
    .replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

export function supportsOscTitle(opts: OscTerminalDetectOptions = {}): boolean {
  if (opts.asciiMode) return false;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const override = String(env.STUDYHUB_TUI_OSC_TITLE ?? '').trim().toLowerCase();
  if (override === '0' || override === 'false' || override === 'no' || override === 'off') return false;
  if (override === '1' || override === 'true' || override === 'yes' || override === 'on') return true;
  const isTTY = opts.isTTY ?? Boolean(process.stdout?.isTTY);
  if (!isTTY) return false;
  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term === 'dumb') return false;
  return true;
}

export function supportsOscNotify(opts: OscTerminalDetectOptions = {}): boolean {
  if (opts.asciiMode) return false;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const override = String(env.STUDYHUB_TUI_OSC_NOTIFY ?? '').trim().toLowerCase();
  if (override === '0' || override === 'false' || override === 'no' || override === 'off') return false;
  if (override === '1' || override === 'true' || override === 'yes' || override === 'on') return true;
  const isTTY = opts.isTTY ?? Boolean(process.stdout?.isTTY);
  if (!isTTY) return false;
  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term === 'dumb') return false;
  if (env.WT_SESSION || env.ITERM_SESSION_ID || env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE) return true;
  const prog = String(env.TERM_PROGRAM ?? '').trim().toLowerCase();
  return NOTIFY_TERM_PROGRAMS.has(prog);
}

/** Build a safe OSC 2 title sequence (`\x1b]2;...\x07`); returns `''` if title sanitizes to empty. */
export function formatOsc2Title(title: string): string {
  const safe = sanitizeOscText(title, 96);
  return safe ? `\x1b]2;${safe}\x07` : '';
}

/** Build a safe OSC 9 notification sequence (`\x1b]9;...\x07`); returns `''` if message sanitizes to empty. */
export function formatOsc9Notification(message: string): string {
  const safe = sanitizeOscText(message, 120);
  return safe ? `\x1b]9;${safe}\x07` : '';
}

export function buildReviewWindowTitle(params: {
  at: number;
  total: number;
  title?: string;
  lang: UiLanguage;
}): string {
  const progress = `${Math.max(1, params.at)}/${Math.max(1, params.total)}`;
  const prefix = params.lang === 'en' ? `StudyHub · Review ${progress}` : `StudyHub · 刷题 ${progress}`;
  const cleanTitle = sanitizeOscText(params.title ?? '', 40);
  return cleanTitle ? `${prefix} · ${cleanTitle}` : prefix;
}

/** Build OSC 2 window title for an active mock exam session (Round 96 Track C9). */
export function buildExamWindowTitle(params: {
  kind: 'written' | 'case' | 'oral';
  at: number;
  total: number;
  timerText?: string;
  lang: UiLanguage;
}): string {
  const progress = `${Math.max(1, params.at)}/${Math.max(1, params.total)}`;
  const kindLabel =
    params.lang === 'en'
      ? params.kind === 'oral'
        ? 'Oral'
        : params.kind === 'case'
          ? 'Case'
          : 'Exam'
      : params.kind === 'oral'
        ? '口试'
        : params.kind === 'case'
          ? '案例考'
          : '模考';
  const cleanTimer = sanitizeOscText(params.timerText ?? '', 16);
  const base = `StudyHub · ${kindLabel} ${progress}`;
  return cleanTimer ? `${base} · ${cleanTimer}` : base;
}

/** Build OSC 2 window title for active background jobs (Round 96 Track C9). */
export function buildTaskProgressTitle(params: {
  runningCount: number;
  label?: string;
  lang: UiLanguage;
}): string {
  const count = Math.max(0, Math.floor(params.runningCount));
  if (count <= 0) return 'StudyHub';
  const prefix = params.lang === 'en' ? `StudyHub · ${count} running` : `StudyHub · ${count} 项任务运行中`;
  const cleanLabel = sanitizeOscText(params.label ?? '', 36);
  return cleanLabel ? `${prefix} · ${cleanLabel}` : prefix;
}

export interface WriteOscOptions extends OscTerminalDetectOptions {
  stream?: { write: (s: string) => unknown; isTTY?: boolean };
  enabled?: boolean;
}

export function writeTerminalTitle(title: string, opts: WriteOscOptions = {}): boolean {
  const stream = opts.stream ?? process.stdout;
  const enabled = opts.enabled ?? supportsOscTitle({ ...opts, isTTY: opts.isTTY ?? Boolean(stream?.isTTY) });
  if (!enabled || !stream?.write) return false;
  const seq = formatOsc2Title(title);
  if (!seq) return false;
  stream.write(seq);
  return true;
}

export function writeTerminalNotification(message: string, opts: WriteOscOptions = {}): boolean {
  const stream = opts.stream ?? process.stdout;
  const enabled = opts.enabled ?? supportsOscNotify({ ...opts, isTTY: opts.isTTY ?? Boolean(stream?.isTTY) });
  if (!enabled || !stream?.write) return false;
  const seq = formatOsc9Notification(message);
  if (!seq) return false;
  stream.write(seq);
  return true;
}
