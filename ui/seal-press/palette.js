/* Live CSS token resolution and motion preference helpers for ui/seal-press/.
   Reads computed theme tokens from the StudyHub root (.study-app / .study-seat) so carved seals,
   editorial ink marks, confetti bursts and exported postcards adapt across all 5 themes and 5 accents. */

const DEFAULT_PALETTE = Object.freeze({
  accent: '#c93d22',
  accentText: '#ec6a4a',
  accentInk: '#fff8f2',
  ok: '#5fb58a',
  okInk: '#78c39d',
  okMark: '#5fb58a52',
  warn: '#d9a441',
  warnInk: '#deb25d',
  warnMark: '#d9a44152',
  bad: '#d76c93',
  info: '#86a9c6',
  paper: '#ece4d6',
  paperInk: '#201b15',
  paperDim: '#5d5448',
  paperRule: '#d6cdc0',
  bgCanvas: '#161412',
  bgSurface: '#1e1b18',
  bgRaised: '#26231f',
  text: '#efe9df',
  textMuted: '#a59d91',
  line: '#332f2a',
  lineStrong: '#4a443c',
  theme: 'dark',
  palette: 'standard',
});

let colorProbeCtx = null;

function toHexByte(n) {
  const clamped = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  return (clamped < 16 ? '0' : '') + clamped.toString(16);
}

function rgbTripleToHex(r, g, b) {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

/** Normalize any CSS color string (hex, rgb/rgba, or CSS color function) to a 6-digit #rrggbb hex string. */
export function cssColorToHex(raw, fallback = DEFAULT_PALETTE.accent) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const shortHex = /^#([0-9a-f]{3,4})$/i.exec(text);
  if (shortHex) {
    const h = shortHex[1];
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  const fullHex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(text);
  if (fullHex) return `#${fullHex[1]}`.toLowerCase();
  const rgbMatch = /^rgba?\(\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)/i.exec(text);
  if (rgbMatch) {
    const scale = (v, pct) => (pct ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    return rgbTripleToHex(
      scale(rgbMatch[1], rgbMatch[2]),
      scale(rgbMatch[3], rgbMatch[4]),
      scale(rgbMatch[5], rgbMatch[6]),
    );
  }
  if (typeof document !== 'undefined') {
    try {
      if (!colorProbeCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        colorProbeCtx = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (colorProbeCtx) {
        colorProbeCtx.clearRect(0, 0, 1, 1);
        colorProbeCtx.fillStyle = '#000000';
        colorProbeCtx.fillStyle = text;
        colorProbeCtx.fillRect(0, 0, 1, 1);
        const data = colorProbeCtx.getImageData(0, 0, 1, 1).data;
        if (data && data.length >= 3 && data[3] > 0) {
          return rgbTripleToHex(data[0], data[1], data[2]);
        }
      }
    } catch {
      /* Canvas probe unavailable in restricted environments: fall back cleanly. */
    }
  }
  return fallback;
}

/** Find the closest StudyHub root holding data-theme / data-motion / tokens. */
export function findStudyRoot(element = null) {
  if (typeof document === 'undefined') return null;
  if (element && typeof element.closest === 'function') {
    const hit = element.closest('.study-app, .study-seat');
    if (hit) return hit;
  }
  return document.querySelector?.('.study-app, .study-seat') || document.documentElement || null;
}

/** True when reduced or off motion is active via StudyHub [data-motion] or OS prefers-reduced-motion. */
export function prefersReducedMotion(element = null) {
  if (typeof window === 'undefined') return true;
  const root = findStudyRoot(element);
  const attr = root?.getAttribute?.('data-motion');
  if (attr === 'reduced' || attr === 'off') return true;
  if (attr === 'full') return false;
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/** Resolve live StudyHub CSS custom properties as clean hex + raw token strings. */
export function resolveThemePalette(element = null) {
  const root = findStudyRoot(element);
  if (!root || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return { ...DEFAULT_PALETTE };
  }
  let styles = null;
  try {
    styles = window.getComputedStyle(root);
  } catch {
    return { ...DEFAULT_PALETTE };
  }
  const readRaw = (token, fallback) => {
    const val = styles.getPropertyValue(token)?.trim();
    return val || fallback;
  };
  const readHex = (token, fallback) => cssColorToHex(readRaw(token, fallback), fallback);
  return {
    accent: readHex('--accent', DEFAULT_PALETTE.accent),
    accentText: readHex('--accent-text', DEFAULT_PALETTE.accentText),
    accentInk: readHex('--accent-ink', DEFAULT_PALETTE.accentInk),
    ok: readHex('--ok', DEFAULT_PALETTE.ok),
    okInk: readHex('--ok-ink', DEFAULT_PALETTE.okInk),
    okMark: readRaw('--ok-mark', DEFAULT_PALETTE.okMark),
    warn: readHex('--warn', DEFAULT_PALETTE.warn),
    warnInk: readHex('--warn-ink', DEFAULT_PALETTE.warnInk),
    warnMark: readRaw('--warn-mark', DEFAULT_PALETTE.warnMark),
    bad: readHex('--bad', DEFAULT_PALETTE.bad),
    info: readHex('--info', DEFAULT_PALETTE.info),
    paper: readHex('--paper', DEFAULT_PALETTE.paper),
    paperInk: readHex('--paper-ink', DEFAULT_PALETTE.paperInk),
    paperDim: readHex('--paper-dim', DEFAULT_PALETTE.paperDim),
    paperRule: readHex('--paper-rule', DEFAULT_PALETTE.paperRule),
    bgCanvas: readHex('--bg-canvas', DEFAULT_PALETTE.bgCanvas),
    bgSurface: readHex('--bg-surface', DEFAULT_PALETTE.bgSurface),
    bgRaised: readHex('--bg-raised', DEFAULT_PALETTE.bgRaised),
    text: readHex('--text', DEFAULT_PALETTE.text),
    textMuted: readHex('--text-muted', DEFAULT_PALETTE.textMuted),
    line: readHex('--line', DEFAULT_PALETTE.line),
    lineStrong: readHex('--line-strong', DEFAULT_PALETTE.lineStrong),
    theme: root.getAttribute?.('data-theme') || DEFAULT_PALETTE.theme,
    palette: root.getAttribute?.('data-palette') || DEFAULT_PALETTE.palette,
  };
}
