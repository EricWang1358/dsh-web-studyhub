/**
 * Terminal multiplexer & capability compatibility matrix (Round 88 Track C5).
 *
 * Centralizes `tmux` / `screen` DCS passthrough wrapping and unified terminal feature probing
 * across tmux, GNU screen, Windows Terminal, iTerm2, WezTerm, Kitty, VSCode, TERM=dumb, NO_COLOR,
 * `--ascii`, and non-TTY streams.
 */
import { resolveColorCapability } from '../cli-args.js';
import { supportsOsc8 } from './osc8.js';
import { supportsOscNotify, supportsOscTitle } from './terminal-title.js';

export type MultiplexerKind = 'tmux' | 'screen' | 'none';

/** Detect whether the process is running inside tmux or GNU screen. */
export function detectMultiplexer(env: NodeJS.ProcessEnv = process.env): MultiplexerKind {
  if (env.TMUX && String(env.TMUX).trim()) return 'tmux';
  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term.startsWith('tmux')) return 'tmux';
  if (env.STY && String(env.STY).trim()) return 'screen';
  if (term.startsWith('screen')) return 'screen';
  return 'none';
}

/**
 * Wrap an OSC escape sequence in DCS passthrough when running under tmux or GNU screen.
 * - tmux: `\x1bPtmux;<ESC-doubled-seq>\x1b\\`
 * - screen: `\x1bP<seq>\x1b\\`
 * - none: untouched `seq`
 */
export function wrapMultiplexerPassthrough(seq: string, mux: MultiplexerKind): string {
  if (!seq || mux === 'none') return seq;
  if (mux === 'tmux') {
    return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  }
  return `\x1bP${seq}\x1b\\`;
}

export interface TerminalCompatMatrix {
  mux: MultiplexerKind;
  colorLevel: 0 | 1 | 2 | 3;
  osc52Copy: boolean;
  osc8Hyperlink: boolean;
  osc2Title: boolean;
  osc9Notify: boolean;
  sgrAltClick: boolean;
}

export function probeTerminalCompatMatrix(opts: {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  asciiMode?: boolean;
  platform?: NodeJS.Platform;
} = {}): TerminalCompatMatrix {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdout?.isTTY);
  const asciiMode = Boolean(opts.asciiMode);
  const mux = detectMultiplexer(env);
  const color = resolveColorCapability(env, { isTTY, platform: opts.platform });
  const term = String(env.TERM ?? '').trim().toLowerCase();
  const isDumb = term === 'dumb';

  return {
    mux,
    colorLevel: color.level,
    osc52Copy: isTTY && !isDumb,
    osc8Hyperlink: supportsOsc8({ env, isTTY, asciiMode }),
    osc2Title: supportsOscTitle({ env, isTTY, asciiMode }),
    osc9Notify: supportsOscNotify({ env, isTTY, asciiMode }),
    sgrAltClick: isTTY && !isDumb,
  };
}
