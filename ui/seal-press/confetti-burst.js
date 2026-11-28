/* Palette-locked confetti bursts via lazy `canvas-confetti` (ISC).
   Mandatory safety rules:
   - ALWAYS pass `useWorker: false` AND `disableForReducedMotion: true` (strict web-demo CSP forbids Blob workers).
   - Never fire under OS `prefers-reduced-motion: reduce`, StudyHub `[data-motion="reduced"|"off"]`, or hidden tabs.
   - Always resolve live StudyHub CSS tokens (--accent, --ok, --warn, --paper) converted to #rrggbb hex. */
import { getCachedAppearance } from '../appearance-prefs.js';
import { cssColorToHex, findStudyRoot, prefersReducedMotion, resolveThemePalette } from './palette.js';

let confettiModulePromise = null;
let workerFreeCannon = null;
let cachedShapes = null;

const PAPER_SLIP_PATH = 'M 0 0 L 14 0 L 14 6 L 0 6 Z';
const PLUM_PETAL_PATH = 'M 6 0 C 10 2 11 7 6 12 C 1 7 2 2 6 0 Z';
const INK_DIAMOND_PATH = 'M 5 0 L 10 5 L 5 10 L 0 5 Z';

/** Build CSP-safe, reduced-motion-safe confetti options locked to the active StudyHub palette. */
export function buildConfettiOptions({
  palette,
  origin = { x: 0.5, y: 0.44 },
  reducedMotion = false,
  variant = 'stamp',
  shapes = null,
} = {}) {
  if (reducedMotion) return null;
  const p = palette || {};
  const colors = [
    cssColorToHex(p.accent, '#c93d22'),
    cssColorToHex(p.ok, '#5fb58a'),
    cssColorToHex(p.warn, '#d9a441'),
    cssColorToHex(p.paper, '#ece4d6'),
  ];
  const isSweep = variant === 'clean-sweep';
  return {
    useWorker: false,
    disableForReducedMotion: true,
    particleCount: isSweep ? 34 : 24,
    spread: isSweep ? 68 : 54,
    startVelocity: isSweep ? 28 : 23,
    decay: 0.92,
    gravity: 0.78,
    ticks: 150,
    scalar: 0.88,
    zIndex: 90,
    origin: {
      x: Math.max(0.08, Math.min(0.92, Number(origin?.x) || 0.5)),
      y: Math.max(0.12, Math.min(0.88, Number(origin?.y) || 0.44)),
    },
    colors,
    shapes: Array.isArray(shapes) && shapes.length ? shapes : ['square', 'circle'],
  };
}

function originFromElement(anchorEl) {
  if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function' || typeof window === 'undefined') {
    return { x: 0.5, y: 0.42 };
  }
  const rect = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  if (rect.width <= 0 && rect.height <= 0) return { x: 0.5, y: 0.42 };
  return {
    x: (rect.left + rect.width / 2) / vw,
    y: (rect.top + rect.height / 2) / vh,
  };
}

function buildCustomShapes(confettiMod) {
  if (cachedShapes) return cachedShapes;
  const fromPath = confettiMod?.shapeFromPath;
  if (typeof fromPath !== 'function' || typeof Path2D !== 'function' || typeof DOMMatrix !== 'function') {
    return ['square', 'circle'];
  }
  try {
    cachedShapes = [
      fromPath({ path: PAPER_SLIP_PATH }),
      fromPath({ path: PLUM_PETAL_PATH }),
      fromPath({ path: INK_DIAMOND_PATH }),
    ];
    return cachedShapes;
  } catch {
    return ['square', 'circle'];
  }
}

async function getCannon() {
  if (workerFreeCannon) return workerFreeCannon;
  if (!confettiModulePromise) {
    confettiModulePromise = import('canvas-confetti').then((mod) => mod?.default || mod).catch(() => {
      confettiModulePromise = null;
      return null;
    });
  }
  const confettiMod = await confettiModulePromise;
  if (!confettiMod) return null;
  const create = confettiMod.create;
  if (typeof create !== 'function') return null;
  // IMPORTANT: Always create a dedicated worker-free cannon; canvas-confetti's default export forces useWorker: true.
  workerFreeCannon = {
    fire: create(null, { useWorker: false, resize: true, disableForReducedMotion: true }),
    mod: confettiMod,
  };
  return workerFreeCannon;
}

function isMinimalModeActive(anchorEl = null) {
  try {
    if (getCachedAppearance().minimal === 'on') return true;
  } catch { /* ignore storage errors */ }
  const root = findStudyRoot(anchorEl);
  return root?.getAttribute?.('data-minimal') === 'on';
}

/**
 * Fire a restrained, palette-locked paper-slip & plum-petal burst.
 * Returns true if fired, false if suppressed by minimal mode, reduced-motion, hidden tab, or SSR.
 */
export async function fireSealConfetti({ anchorEl = null, origin = null, variant = 'stamp' } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (document.hidden === true) return false;
  if (prefersReducedMotion(anchorEl) || isMinimalModeActive(anchorEl)) return false;

  const palette = resolveThemePalette(anchorEl);
  const cannon = await getCannon();
  if (!cannon) return false;
  if (document.hidden === true || prefersReducedMotion(anchorEl) || isMinimalModeActive(anchorEl)) return false;

  const shapes = buildCustomShapes(cannon.mod);
  const resolvedOrigin = origin || originFromElement(anchorEl);
  const options = buildConfettiOptions({
    palette,
    origin: resolvedOrigin,
    reducedMotion: false,
    variant,
    shapes,
  });
  if (!options) return false;
  try {
    cannon.fire(options);
    return true;
  } catch {
    return false;
  }
}

/** Reset cached module/cannon state (for unit tests). */
export function resetConfettiForTests() {
  workerFreeCannon?.fire?.reset?.();
  workerFreeCannon = null;
  confettiModulePromise = null;
  cachedShapes = null;
}
