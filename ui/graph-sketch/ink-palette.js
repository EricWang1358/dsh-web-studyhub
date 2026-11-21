import { useEffect, useState } from 'react';

/* Shared deterministic hash, numeric utilities, and live theme-token palette resolution
   used by FSRS Ink Tide (ForecastInkTide) and Knowledge Graph Sketch mode (graph-sketch). */

/** FNV-1a 32-bit hash returning a positive non-zero 31-bit seed for roughjs. */
export function hashString(input) {
  const str = String(input ?? 'studyhub');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const positive = (h >>> 0) & 0x7fffffff;
  return positive || 1;
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Default fallback palette mirroring ui/tokens.css dark Ink Desk tokens.
 * Used during SSR or before computed tokens are read from `.study-app`.
 */
export const DEFAULT_PALETTE = Object.freeze({
  canvas: '#161412',
  sunken: '#110f0d',
  paper: '#1e1b18',
  raised: '#26231f',
  lineSoft: '#332f2a',
  line: '#332f2a',
  lineStrong: '#4a443c',
  ink: '#efe9df',
  inkDim: '#c5bdb1',
  inkMuted: '#a59d91',
  inkFaint: '#958e84',
  decorFaint: '#6f685e',
  accent: '#c93d22',
  accentSoft: '#ec6a4a',
  accentText: '#ec6a4a',
  accentInk: '#fff8f2',
  ok: '#5fb58a',
  warn: '#d9a441',
  bad: '#d76c93',
  info: '#86a9c6',
  isLight: false,
  contrast: 'normal',
});

const TOKEN_MAP = [
  ['canvas', '--bg-canvas'],
  ['sunken', '--bg-sunken'],
  ['paper', '--bg-surface'],
  ['raised', '--bg-raised'],
  ['lineSoft', '--line-soft'],
  ['line', '--line'],
  ['lineStrong', '--line-strong'],
  ['ink', '--text'],
  ['inkDim', '--text-dim'],
  ['inkMuted', '--text-muted'],
  ['inkFaint', '--text-faint'],
  ['decorFaint', '--decor-faint'],
  ['accent', '--accent'],
  ['accentSoft', '--accent-soft'],
  ['accentText', '--accent-text'],
  ['accentInk', '--accent-ink'],
  ['ok', '--ok'],
  ['warn', '--warn'],
  ['bad', '--bad'],
  ['info', '--info'],
];

/**
 * Read live computed CSS tokens from the nearest `.study-app` or `.study-seat` host
 * so Dark, Light, OLED, Paper, High Contrast, and all 5 accent presets tint the
 * roughjs & SVG artwork seamlessly (and export as concrete standalone colors).
 */
export function resolveInkPalette(element = null) {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return DEFAULT_PALETTE;
  }
  const host = element?.closest?.('.study-app, .study-seat')
    || document.querySelector('.study-app, .study-seat')
    || document.documentElement;
  if (!host) return DEFAULT_PALETTE;
  const styles = getComputedStyle(host);
  const next = { ...DEFAULT_PALETTE };
  for (const [key, cssVar] of TOKEN_MAP) {
    const val = styles.getPropertyValue(cssVar)?.trim();
    if (val) next[key] = val;
  }
  const theme = host.getAttribute?.('data-theme') || '';
  const paletteAttr = host.getAttribute?.('data-palette') || '';
  next.isLight = theme === 'light' || paletteAttr === 'paper';
  next.contrast = host.getAttribute?.('data-contrast') || 'normal';
  return next;
}

/** Reactive palette hook that re-reads tokens whenever theme/accent/palette attributes change. */
export function useInkPalette(containerRef) {
  const [palette, setPalette] = useState(DEFAULT_PALETTE);
  useEffect(() => {
    const sync = () => setPalette(resolveInkPalette(containerRef?.current));
    sync();
    const host = containerRef?.current?.closest?.('.study-app, .study-seat')
      || document.querySelector('.study-app, .study-seat');
    if (!host || typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(sync);
    observer.observe(host, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette', 'data-accent', 'data-contrast', 'class'],
    });
    return () => observer.disconnect();
  }, [containerRef]);
  return palette;
}
