/**
 * Centralized Unicode / ASCII glyph table (#1354 P2 terminal compatibility).
 *
 * Single source of truth for UI chrome glyphs so views and shell components
 * select Unicode vs pure-ASCII fallbacks through one table instead of scattering
 * inline `asciiMode ? ... : ...` ternaries. Zero external dependencies.
 */

export const GLYPHS = Object.freeze({
  ellipsis: ['…', '...'],
  rule: ['─', '-'],
  vrule: ['│', '|'],
  bar: ['▎', '|'],
  activeBar: ['▌', '>'],
  play: ['▶', '>'],
  dot: ['●', '*'],
  dotOpen: ['○', 'o'],
  bullet: ['•', '-'],
  middot: ['·', '-'],
  check: ['✔', '+'],
  cross: ['✖', 'x'],
  close: ['✕', 'x'],
  warn: ['▲', '!'],
  info: ['ℹ', 'i'],
  empty: ['◌', 'o'],
  arrowRight: ['→', '>'],
  arrowLeft: ['←', '<'],
  chevron: ['›', '>'],
  cursor: ['❯', '>'],
  tip: ['💡', '*'],
  sync: ['⟳', '*'],
  times: ['×', 'x'],
} as const satisfies Record<string, readonly [unicode: string, ascii: string]>);

export type GlyphId = keyof typeof GLYPHS;

/** Return the canonical Unicode or pure-ASCII glyph for `id`. */
export function glyph(id: GlyphId, asciiMode: boolean): string {
  return asciiMode ? GLYPHS[id][1] : GLYPHS[id][0];
}

const UNICODE_HAIRLINE_POOL = GLYPHS.rule[0].repeat(400);
const ASCII_HAIRLINE_POOL = GLYPHS.rule[1].repeat(400);

/** Return a horizontal hairline rule of `width` columns (fast sliced pool up to 400 cols). */
export function hairline(width: number, asciiMode: boolean): string {
  const n = Math.max(0, Math.floor(width));
  if (n === 0) return '';
  const pool = asciiMode ? ASCII_HAIRLINE_POOL : UNICODE_HAIRLINE_POOL;
  return n <= pool.length ? pool.slice(0, n) : glyph('rule', asciiMode).repeat(n);
}
