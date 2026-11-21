/* Local preferences for the Home Desk Play strip (hide/restore) and
   per-session scratchpad state so closing and reopening mid-review keeps
   derivations intact. Safe under SSR and restricted storage environments. */

import { browserSession, browserStorage } from '../storage.js';

export const DESK_PLAY_STORAGE_KEY = 'study-desk-play';
export const SCRATCHPAD_SESSION_KEY = 'study-desk-scratchpad-session';
export const MAX_SAVED_STROKES = 200;

const VALID_TOOLS = new Set(['brush', 'box', 'circle', 'arrow']);
const VALID_INKS = new Set(['ink', 'cinnabar', 'jade', 'steel']);
const VALID_WEIGHTS = new Set(['fine', 'medium', 'broad']);
const VALID_PAPERS = new Set(['blank', 'grid', 'ruled']);

export const DEFAULT_DESK_PLAY_PREFS = Object.freeze({ hidden: false });

export const DEFAULT_SCRATCHPAD_STATE = Object.freeze({
  strokes: Object.freeze([]),
  tool: 'brush',
  ink: 'ink',
  weight: 'medium',
  paper: 'ruled',
});

const memoryFallback = new Map();

function resolveStorage(kind, explicit) {
  if (explicit) return explicit;
  return kind === 'session' ? browserSession() : browserStorage();
}

export function readDeskPlayPrefs(storage) {
  const store = resolveStorage('local', storage);
  try {
    const raw = store ? store.getItem(DESK_PLAY_STORAGE_KEY) : memoryFallback.get(DESK_PLAY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DESK_PLAY_PREFS };
    const parsed = JSON.parse(raw);
    return { hidden: Boolean(parsed && typeof parsed === 'object' && parsed.hidden) };
  } catch {
    return { ...DEFAULT_DESK_PLAY_PREFS };
  }
}

export function writeDeskPlayPrefs(patch, storage) {
  const next = { ...readDeskPlayPrefs(storage), ...(patch && typeof patch === 'object' ? { hidden: Boolean(patch.hidden) } : {}) };
  const serialized = JSON.stringify(next);
  const store = resolveStorage('local', storage);
  if (store) {
    try { store.setItem(DESK_PLAY_STORAGE_KEY, serialized); } catch { /* quota or blocked storage */ }
  } else {
    memoryFallback.set(DESK_PLAY_STORAGE_KEY, serialized);
  }
  return next;
}

function sanitizePoint(pt) {
  if (!Array.isArray(pt) || pt.length < 2) return null;
  const x = Number(pt[0]);
  const y = Number(pt[1]);
  const p = pt.length >= 3 ? Number(pt[2]) : 0.5;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Number.isFinite(p) ? Math.max(0.05, Math.min(1, Math.round(p * 100) / 100)) : 0.5];
}

function sanitizeStroke(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = VALID_TOOLS.has(item.kind) ? item.kind : null;
  if (!kind) return null;
  const ink = VALID_INKS.has(item.ink) ? item.ink : 'ink';
  const weight = VALID_WEIGHTS.has(item.weight) ? item.weight : 'medium';
  const id = typeof item.id === 'string' && item.id ? item.id : `s-${Math.abs(Math.floor(Number(item.seed) || 1))}`;
  if (kind === 'brush') {
    if (!Array.isArray(item.points)) return null;
    const points = item.points.map(sanitizePoint).filter(Boolean);
    if (!points.length) return null;
    return { id, kind, ink, weight, points };
  }
  const x1 = Number(item.x1), y1 = Number(item.y1), x2 = Number(item.x2), y2 = Number(item.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const seed = Number.isInteger(item.seed) && item.seed > 0 ? item.seed : 1;
  return {
    id, kind, ink, weight, seed,
    x1: Math.round(x1 * 10) / 10,
    y1: Math.round(y1 * 10) / 10,
    x2: Math.round(x2 * 10) / 10,
    y2: Math.round(y2 * 10) / 10,
  };
}

export function sanitizeScratchpadState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SCRATCHPAD_STATE, strokes: [] };
  }
  const strokes = Array.isArray(raw.strokes)
    ? raw.strokes.slice(-MAX_SAVED_STROKES).map(sanitizeStroke).filter(Boolean)
    : [];
  return {
    strokes,
    tool: VALID_TOOLS.has(raw.tool) ? raw.tool : DEFAULT_SCRATCHPAD_STATE.tool,
    ink: VALID_INKS.has(raw.ink) ? raw.ink : DEFAULT_SCRATCHPAD_STATE.ink,
    weight: VALID_WEIGHTS.has(raw.weight) ? raw.weight : DEFAULT_SCRATCHPAD_STATE.weight,
    paper: VALID_PAPERS.has(raw.paper) ? raw.paper : DEFAULT_SCRATCHPAD_STATE.paper,
  };
}

export function readScratchpadSession(storage) {
  const store = resolveStorage('session', storage);
  try {
    const raw = store ? store.getItem(SCRATCHPAD_SESSION_KEY) : memoryFallback.get(SCRATCHPAD_SESSION_KEY);
    if (!raw) return { ...DEFAULT_SCRATCHPAD_STATE, strokes: [] };
    return sanitizeScratchpadState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SCRATCHPAD_STATE, strokes: [] };
  }
}

export function writeScratchpadSession(state, storage) {
  const clean = sanitizeScratchpadState(state);
  const serialized = JSON.stringify(clean);
  const store = resolveStorage('session', storage);
  if (store) {
    try { store.setItem(SCRATCHPAD_SESSION_KEY, serialized); } catch { /* quota or blocked storage */ }
  } else {
    memoryFallback.set(SCRATCHPAD_SESSION_KEY, serialized);
  }
  return clean;
}

export function clearScratchpadSession(storage) {
  const prev = readScratchpadSession(storage);
  return writeScratchpadSession({ ...prev, strokes: [] }, storage);
}
