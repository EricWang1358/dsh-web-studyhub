/**
 * OSC 8 Terminal Hyperlinks with safe fallback (Round 84 Track C2).
 *
 * Emits `\x1b]8;;<url>\x07<label>\x1b]8;;\x07` on capable TTY terminals so source citations
 * and file locations are Cmd/Ctrl-clickable, while degrading cleanly to plain `label` under
 * `NO_COLOR`, `--ascii`, `TERM=dumb`, or non-TTY streams.
 */
import { pathToFileURL } from 'node:url';

const OSC8_TERM_PROGRAMS = new Set([
  'wezterm',
  'iterm.app',
  'vscode',
  'hyper',
  'alacritty',
  'kitty',
  'ghostty',
  'warpterminal',
]);

const ALLOWED_SCHEMES_RE = /^(?:https?|file):\/\//i;

export interface Osc8DetectOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  asciiMode?: boolean;
}

/** Detect whether the current terminal safely supports OSC 8 hyperlinks. */
export function supportsOsc8(opts: Osc8DetectOptions = {}): boolean {
  if (opts.asciiMode) return false;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;

  const override = String(env.STUDYHUB_TUI_OSC8 ?? '').trim().toLowerCase();
  if (override === '0' || override === 'false' || override === 'no' || override === 'off') return false;
  if (override === '1' || override === 'true' || override === 'yes' || override === 'on') return true;

  const isTTY = opts.isTTY ?? Boolean(process.stdout?.isTTY);
  if (!isTTY) return false;

  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term === 'dumb') return false;

  if (env.WT_SESSION || env.ITERM_SESSION_ID || env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE || env.VTE_VERSION) {
    return true;
  }
  const termProgram = String(env.TERM_PROGRAM ?? '').trim().toLowerCase();
  if (OSC8_TERM_PROGRAMS.has(termProgram)) return true;

  const colorterm = String(env.COLORTERM ?? '').trim().toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;

  return false;
}

/** Convert an absolute local file path (POSIX or Windows) into a safe `file://` URL with optional `#page=N`. */
export function buildFileHyperlinkUrl(filePath: string, page?: number): string {
  const clean = String(filePath ?? '').trim();
  if (!clean) return '';
  if (ALLOWED_SCHEMES_RE.test(clean)) return clean;
  try {
    const base = pathToFileURL(clean).href;
    if (typeof page === 'number' && Number.isFinite(page) && page >= 1) {
      return `${base}#page=${Math.floor(page)}`;
    }
    return base;
  } catch {
    return '';
  }
}

export interface FormatOsc8Options extends Osc8DetectOptions {
  /** Force enable/disable explicitly (overrides auto-detection). */
  enabled?: boolean;
}

/** Wrap `label` in an OSC 8 hyperlink when supported; otherwise return plain `label` untouched. */
export function formatOsc8Link(label: string, url: string | null | undefined, opts: FormatOsc8Options = {}): string {
  const safeLabel = String(label ?? '');
  const safeUrl = String(url ?? '').trim();
  if (!safeLabel || !safeUrl || !ALLOWED_SCHEMES_RE.test(safeUrl)) return safeLabel;
  // Reject control characters inside URL to prevent terminal escape injection
  if (/[\x00-\x1f\x7f]/.test(safeUrl)) return safeLabel;
  const enabled = opts.enabled ?? supportsOsc8(opts);
  if (!enabled) return safeLabel;
  return `\x1b]8;;${safeUrl}\x07${safeLabel}\x1b]8;;\x07`;
}
