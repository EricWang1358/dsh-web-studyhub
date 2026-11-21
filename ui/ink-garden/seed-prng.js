import { useEffect, useState } from 'react';
import { shortDeckTitles } from '../charts/chart-math.js';

/* Deterministic PRNG, value noise, theme-token palette resolution, and study-data
   normalization shared by all three Living Ink Gallery print editions.
   Zero external side effects so every geometry generator is 100% reproducible. */

/** FNV-1a 32-bit hash returning a positive non-zero 31-bit seed for roughjs & PRNG. */
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

/** Mulberry32 deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random helper with convenient range & pick utilities. */
export function createSeededRandom(seed) {
  const seedInt = typeof seed === 'number' && Number.isFinite(seed)
    ? ((Math.abs(Math.floor(seed)) & 0x7fffffff) || 1)
    : hashString(seed);
  const next = mulberry32(seedInt);
  return {
    seed: seedInt,
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
    pick: (list) => (list.length ? list[Math.floor(next() * list.length)] : undefined),
  };
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const round1 = (v) => Math.round(v * 10) / 10;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function hashInt(n, seed) {
  let x = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic smooth 1D value noise in [0, 1]. */
export function valueNoise1D(x, seed = 1) {
  const i0 = Math.floor(x);
  const f = smoothstep(x - i0);
  return lerp(hashInt(i0, seed), hashInt(i0 + 1, seed), f);
}

/** Multi-octave fractional Brownian motion (fBm) in [0, 1] for shan-shui ridges. */
export function fbm1D(x, seed = 1, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise1D(x * freq, seed + o * 97);
    norm += amp;
    amp *= 0.5;
    freq *= 2.02;
  }
  return norm ? sum / norm : 0.5;
}

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
export function resolveGardenPalette(element = null) {
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
export function useGardenPalette(containerRef) {
  const [palette, setPalette] = useState(DEFAULT_PALETTE);
  useEffect(() => {
    const sync = () => setPalette(resolveGardenPalette(containerRef?.current));
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

/**
 * Determine a deck's visual botanical/celestial stage without ever using shame/wilting metaphors:
 * - 'mastered': status === 'done' or mastery >= 80 with no weak items
 * - 'weak': has active weak cards or listed weak topics needing gentle care
 * - 'learning': has started studying (mastery > 0 or non-new cards > 0)
 * - 'fresh': unopened / unlearned bud awaiting first session
 */
export function classifyDeckStage({ status, mastery, counts, weakTopicCount, total }) {
  if (status === 'done' || (mastery >= 80 && !(counts.weak > 0) && !weakTopicCount && total > 0)) {
    return 'mastered';
  }
  if (counts.weak > 0 || weakTopicCount > 0) {
    return 'weak';
  }
  const studied = counts.mastered + counts.familiar + counts.learning;
  if (status === 'active' || mastery > 0 || studied > 0) {
    return 'learning';
  }
  return 'fresh';
}

/**
 * Normalize Dashboard `stats`, `decks`, and `progress` into a single deterministic
 * dataset consumed by Herbarium, Shan-Shui, and Astrolabe renderers.
 */
export function normalizeGardenData({ stats = null, decks = [], progress = null, course = '*' } = {}) {
  const safeDecks = Array.isArray(decks) ? decks.filter((d) => d && !d.archived && !d.systemKind) : [];
  const progMap = progress && typeof progress === 'object' ? progress : {};
  const weakByDeck = new Map();
  for (const row of stats?.weakTopics || []) {
    if (!row?.deckId) continue;
    const list = weakByDeck.get(row.deckId) || [];
    list.push({
      topic: row.topic || '',
      wrong: Number(row.wrong) || 0,
      cards: Array.isArray(row.cards) ? row.cards : [],
    });
    weakByDeck.set(row.deckId, list);
  }
  const dueByDeck = new Map();
  const todayForecast = stats?.forecast?.days?.[0];
  for (const ref of todayForecast?.cards || []) {
    if (!ref?.deckId) continue;
    dueByDeck.set(ref.deckId, (dueByDeck.get(ref.deckId) || 0) + 1);
  }

  const rawTitles = safeDecks.map((d) => d.title || d.id || '');
  const shortened = safeDecks.length > 1 ? shortDeckTitles(rawTitles) : rawTitles;

  const items = safeDecks.map((deck, index) => {
    const p = progMap[deck.id] || null;
    const rawCounts = p?.counts || deck.counts || {};
    const counts = {
      mastered: Number(rawCounts.mastered) || 0,
      familiar: Number(rawCounts.familiar) || 0,
      learning: Number(rawCounts.learning) || 0,
      weak: Number(rawCounts.weak) || 0,
      new: Number(rawCounts.new) || 0,
    };
    const sumCounts = counts.mastered + counts.familiar + counts.learning + counts.weak + counts.new;
    const total = Number.isFinite(p?.total)
      ? p.total
      : Number.isFinite(deck.total)
        ? deck.total
        : Array.isArray(deck.cards)
          ? deck.cards.filter((c) => !c?.suspended).length
          : sumCounts;
    const mastery = clamp(Math.round(Number(p?.mastery ?? deck.mastery ?? 0) || 0), 0, 100);
    const due = Number.isFinite(p?.due)
      ? p.due
      : Number.isFinite(deck.due)
        ? deck.due
        : (dueByDeck.get(deck.id) || 0);
    const weakTopics = weakByDeck.get(deck.id) || [];
    const weakCards = [];
    const seenWeak = new Set();
    for (const wt of weakTopics) {
      for (const ref of wt.cards) {
        const key = `${ref.deckId}\0${ref.cardId}`;
        if (!seenWeak.has(key)) {
          seenWeak.add(key);
          weakCards.push(ref);
        }
      }
    }
    const status = p?.status || deck.status || (total > 0 && mastery >= 80 && !counts.weak ? 'done' : mastery > 0 ? 'active' : 'todo');
    const stage = classifyDeckStage({
      status,
      mastery,
      counts,
      weakTopicCount: weakTopics.length,
      total,
    });
    const fullTitle = deck.title || deck.id || '';
    const shortTitle = shortened[index] || fullTitle;
    return {
      id: deck.id,
      title: fullTitle,
      shortTitle,
      course: deck.course ?? deck.folder ?? '',
      total,
      mastery,
      due,
      status,
      stage,
      counts,
      weakTopics,
      weakCards: weakCards.slice(0, 200),
      seed: hashString(deck.id || fullTitle || `deck-${index}`),
      scope: [{ deckId: deck.id }],
    };
  });

  const totals = stats?.totals || {};
  const heatmap = Array.isArray(stats?.heatmap) ? stats.heatmap : [];
  const totalCards = items.reduce((s, d) => s + d.total, 0);
  const weightedMastery = totalCards > 0
    ? Math.round(items.reduce((s, d) => s + d.mastery * d.total, 0) / totalCards)
    : items.length > 0
      ? Math.round(items.reduce((s, d) => s + d.mastery, 0) / items.length)
      : 0;
  const stageCounts = { mastered: 0, learning: 0, weak: 0, fresh: 0 };
  for (const item of items) stageCounts[item.stage]++;

  const attempts = Number(totals.attempts) || 0;
  const activeDays = Number(totals.activeDays) || 0;
  const streak = Number(totals.streak) || 0;
  const dueTotal = Number.isFinite(totals.due)
    ? totals.due
    : items.reduce((s, d) => s + d.due, 0);

  return {
    items,
    stageCounts,
    course,
    heatmap,
    today: stats?.today || '',
    totals: {
      attempts,
      activeDays,
      streak,
      due: dueTotal,
      cards: Number.isFinite(totals.cards) ? totals.cards : totalCards,
      mastered: Number.isFinite(totals.mastered) ? totals.mastered : items.reduce((s, d) => s + d.counts.mastered, 0),
      weak: Number.isFinite(totals.weak) ? totals.weak : items.reduce((s, d) => s + d.counts.weak, 0),
      overallMastery: weightedMastery,
      deckCount: items.length,
    },
    isEmpty: items.length === 0 && attempts === 0,
    seed: hashString(items.map((d) => d.id).join('|') || `${course}:${activeDays}:${attempts}`),
  };
}
