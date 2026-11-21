/* Pure calligraphic ink stroke & roughjs diagram engine + SVG / 2x PNG export.
   Uses `perfect-freehand` (MIT) for velocity/pressure-tapered calligraphy brush
   strokes and `roughjs` (MIT) for sketchy STEM boxes, circles, and arrows. */

export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 560;

export const INK_TOOLS = Object.freeze([
  Object.freeze({ id: 'brush', label: '毛笔' }),
  Object.freeze({ id: 'box', label: '方框' }),
  Object.freeze({ id: 'circle', label: '圆环' }),
  Object.freeze({ id: 'arrow', label: '箭头' }),
]);

export const PAPER_STYLES = Object.freeze([
  Object.freeze({ id: 'blank', label: '宣纸' }),
  Object.freeze({ id: 'grid', label: '方格' }),
  Object.freeze({ id: 'ruled', label: '横线' }),
]);

export const STROKE_WEIGHTS = Object.freeze([
  Object.freeze({ id: 'fine', label: '细', brushSize: 3.6, roughWidth: 1.5 }),
  Object.freeze({ id: 'medium', label: '中', brushSize: 6.8, roughWidth: 2.3 }),
  Object.freeze({ id: 'broad', label: '粗', brushSize: 11.5, roughWidth: 3.5 }),
]);

export const INK_PIGMENTS = Object.freeze([
  Object.freeze({ id: 'ink', label: '松烟墨', token: '--paper-ink' }),
  Object.freeze({ id: 'cinnabar', label: '朱砂', token: '--accent' }),
  Object.freeze({ id: 'jade', label: '石绿', token: '--ok' }),
  Object.freeze({ id: 'steel', label: '靛青', token: '--info' }),
]);

const WEIGHT_BY_ID = new Map(STROKE_WEIGHTS.map((item) => [item.id, item]));

export const FALLBACK_PALETTE = Object.freeze({
  paper: '#f6f1e7',
  rule: 'rgba(32, 22, 12, 0.12)',
  ink: '#201b15',
  cinnabar: '#c03a1f',
  jade: '#1c613f',
  steel: '#3b6f9c',
});

/** Read live CSS tokens from the `.sh-paper` scratchpad element so exported SVG/PNG matches the active theme. */
export function resolveInkPalette(element) {
  if (!element || typeof globalThis.getComputedStyle !== 'function') {
    return { ...FALLBACK_PALETTE };
  }
  const style = globalThis.getComputedStyle(element);
  const read = (prop, fallback) => {
    const value = style.getPropertyValue(prop)?.trim();
    return value || fallback;
  };
  return {
    paper: read('--paper', FALLBACK_PALETTE.paper),
    rule: read('--paper-rule', FALLBACK_PALETTE.rule),
    ink: read('--paper-ink', FALLBACK_PALETTE.ink),
    cinnabar: read('--accent', FALLBACK_PALETTE.cinnabar),
    jade: read('--ok', FALLBACK_PALETTE.jade),
    steel: read('--info', FALLBACK_PALETTE.steel),
  };
}

export function pigmentColor(palette, inkId) {
  return palette?.[inkId] || palette?.ink || FALLBACK_PALETTE.ink;
}

/**
 * Map viewport client coordinates into SVG viewBox coordinates accurately even when
 * the SVG is letterboxed (e.g. `max-height: 58dvh`, `aspect-ratio: 4/3`) or scaled
 * via `--study-ui-scale`. Prefers `getScreenCTM().inverse()` with a letterbox-aware
 * `getBoundingClientRect()` fallback.
 */
export function clientToCanvasPoint(svg, clientX, clientY, width = CANVAS_WIDTH, height = CANVAS_HEIGHT) {
  if (!svg || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const clamp = (x, y) => [
    Math.max(0, Math.min(width, Math.round(x * 10) / 10)),
    Math.max(0, Math.min(height, Math.round(y * 10) / 10)),
  ];

  const ctm = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
  if (ctm && typeof ctm.inverse === 'function') {
    try {
      const inv = ctm.inverse();
      let local = null;
      if (typeof svg.createSVGPoint === 'function') {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        local = pt.matrixTransform(inv);
      } else if (typeof globalThis.DOMPoint === 'function') {
        local = new globalThis.DOMPoint(clientX, clientY).matrixTransform(inv);
      }
      if (local && Number.isFinite(local.x) && Number.isFinite(local.y)) {
        return clamp(local.x, local.y);
      }
    } catch { /* singular CTM: fall through to bounding-box math */ }
  }

  const rect = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = rect.left + (rect.width - width * scale) / 2;
  const offsetY = rect.top + (rect.height - height * scale) / 2;
  return clamp((clientX - offsetX) / scale, (clientY - offsetY) / scale);
}

export function weightSpec(weightId) {
  return WEIGHT_BY_ID.get(weightId) || STROKE_WEIGHTS[1];
}

/** Convert `perfect-freehand` outline polygon points into a smooth closed SVG path string. */
export function getSvgPathFromStroke(points) {
  if (!Array.isArray(points) || !points.length) return '';
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${x.toFixed(2)} ${y.toFixed(2)} L ${(x + 0.1).toFixed(2)} ${y.toFixed(2)} Z`;
  }
  const d = [];
  const [x0, y0] = points[0];
  const [x1, y1] = points[1];
  d.push(`M ${x0.toFixed(2)} ${y0.toFixed(2)}`);
  d.push(`Q ${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`);
  for (let i = 1; i < points.length; i += 1) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[(i + 1) % points.length];
    d.push(`Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${((cx + nx) / 2).toFixed(2)} ${((cy + ny) / 2).toFixed(2)}`);
  }
  d.push('Z');
  return d.join(' ');
}

/** Run `perfect-freehand`'s `getStroke()` with calligraphic brush feel (tapered entry/exit, natural ink flow). */
export function strokePathData(getStrokeFn, points, weightId = 'medium') {
  if (typeof getStrokeFn !== 'function' || !Array.isArray(points) || !points.length) return '';
  const { brushSize } = weightSpec(weightId);
  // Single-tap ink dot: synthesize a gentle 2-point micro-dab so taps leave a clean calligraphic dot.
  const input = points.length === 1
    ? [points[0], [points[0][0] + 0.5, points[0][1] + 0.5, points[0][2] ?? 0.6]]
    : points;
  const outline = getStrokeFn(input, {
    size: brushSize,
    thinning: 0.62,
    smoothing: 0.56,
    streamline: 0.52,
    simulatePressure: input.every((pt) => pt[2] === undefined || pt[2] === 0.5),
    start: { taper: points.length > 2 ? brushSize * 1.4 : 0, cap: true },
    end: { taper: points.length > 2 ? brushSize * 1.8 : 0, cap: true },
  });
  return getSvgPathFromStroke(outline);
}

/** Constrain shape end-point when Shift is held (square box, circle, or 45-degree arrow). */
export function snapShapeEnd(kind, x1, y1, x2, y2, constrain = false) {
  if (!constrain) return { x2, y2 };
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (kind === 'box' || kind === 'circle') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x2: x1 + (dx < 0 ? -side : side), y2: y1 + (dy < 0 ? -side : side) };
  }
  if (kind === 'arrow') {
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return { x2, y2 };
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x2: x1 + Math.cos(angle) * dist, y2: y1 + Math.sin(angle) * dist };
  }
  return { x2, y2 };
}

/** Compute main shaft + two balanced arrowhead barbs for a directional diagram arrow. */
export function buildArrowGeometry(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 4) {
    return { shaft: [x1, y1, x2, y2], leftBarb: null, rightBarb: null };
  }
  const angle = Math.atan2(dy, dx);
  const barbLen = Math.max(11, Math.min(24, dist * 0.28));
  const spread = (28 * Math.PI) / 180;
  return {
    shaft: [x1, y1, x2, y2],
    leftBarb: [x2, y2, x2 - barbLen * Math.cos(angle - spread), y2 - barbLen * Math.sin(angle - spread)],
    rightBarb: [x2, y2, x2 - barbLen * Math.cos(angle + spread), y2 - barbLen * Math.sin(angle + spread)],
  };
}

/** Convert a sketchy shape stroke (`box` | `circle` | `arrow`) into SVG path descriptors via `roughjs` generator. */
export function shapePaths(roughGenerator, item, color) {
  if (!roughGenerator || !item) return [];
  const { roughWidth } = weightSpec(item.weight);
  const opts = {
    seed: item.seed || 1,
    stroke: color,
    strokeWidth: roughWidth,
    roughness: 1.35,
    bowing: 1.1,
    fill: 'none',
  };
  const x = Math.min(item.x1, item.x2);
  const y = Math.min(item.y1, item.y2);
  const w = Math.abs(item.x2 - item.x1);
  const h = Math.abs(item.y2 - item.y1);

  if (item.kind === 'box') {
    if (w < 2 && h < 2) return [];
    return roughGenerator.toPaths(roughGenerator.rectangle(x, y, Math.max(2, w), Math.max(2, h), opts));
  }
  if (item.kind === 'circle') {
    if (w < 2 && h < 2) return [];
    return roughGenerator.toPaths(roughGenerator.ellipse(x + w / 2, y + h / 2, Math.max(2, w), Math.max(2, h), opts));
  }
  if (item.kind === 'arrow') {
    const geom = buildArrowGeometry(item.x1, item.y1, item.x2, item.y2);
    const out = [...roughGenerator.toPaths(roughGenerator.line(...geom.shaft, opts))];
    if (geom.leftBarb) out.push(...roughGenerator.toPaths(roughGenerator.line(...geom.leftBarb, { ...opts, seed: (item.seed || 1) + 17 })));
    if (geom.rightBarb) out.push(...roughGenerator.toPaths(roughGenerator.line(...geom.rightBarb, { ...opts, seed: (item.seed || 1) + 31 })));
    return out;
  }
  return [];
}

function escapeXmlAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render the entire scratchpad (paper stock, optional grid/ruling, calligraphy & roughjs shapes) to standalone SVG XML. */
export function buildExportSvg({
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
  paper = 'ruled',
  strokes = [],
  palette = FALLBACK_PALETTE,
  getStrokeFn,
  roughGenerator,
}) {
  const safePaper = escapeXmlAttr(palette.paper || FALLBACK_PALETTE.paper);
  const safeRule = escapeXmlAttr(palette.rule || FALLBACK_PALETTE.rule);
  const safeCinnabar = escapeXmlAttr(palette.cinnabar || FALLBACK_PALETTE.cinnabar);

  const defs = [];
  const bgLayers = [`  <rect width="${width}" height="${height}" fill="${safePaper}" />`];

  if (paper === 'grid') {
    defs.push(
      `    <pattern id="sh-export-grid" width="28" height="28" patternUnits="userSpaceOnUse">`,
      `      <path d="M 28 0 L 0 0 0 28" fill="none" stroke="${safeRule}" stroke-width="1" />`,
      `    </pattern>`,
    );
    bgLayers.push(`  <rect width="${width}" height="${height}" fill="url(#sh-export-grid)" />`);
  } else if (paper === 'ruled') {
    defs.push(
      `    <pattern id="sh-export-ruled" width="${width}" height="32" patternUnits="userSpaceOnUse" patternTransform="translate(0 44)">`,
      `      <line x1="0" y1="31.5" x2="${width}" y2="31.5" stroke="${safeRule}" stroke-width="1" />`,
      `    </pattern>`,
    );
    bgLayers.push(`  <rect width="${width}" height="${height}" fill="url(#sh-export-ruled)" />`);
    bgLayers.push(`  <line x1="24" y1="42" x2="${width - 24}" y2="42" stroke="${safeCinnabar}" stroke-width="1.5" stroke-opacity="0.65" />`);
  }

  const strokeNodes = [];
  for (const item of strokes) {
    const color = escapeXmlAttr(pigmentColor(palette, item.ink));
    if (item.kind === 'brush') {
      const d = strokePathData(getStrokeFn, item.points, item.weight);
      if (d) strokeNodes.push(`  <path d="${escapeXmlAttr(d)}" fill="${color}" />`);
    } else {
      for (const path of shapePaths(roughGenerator, item, color)) {
        if (!path?.d) continue;
        strokeNodes.push(
          `  <path d="${escapeXmlAttr(path.d)}" fill="none" stroke="${color}" stroke-width="${Number(path.strokeWidth) || 2}" stroke-linecap="round" stroke-linejoin="round" />`,
        );
      }
    }
  }

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    ...(defs.length ? ['  <defs>', ...defs, '  </defs>'] : []),
    ...bgLayers,
    ...strokeNodes,
    '</svg>',
  ];
  return lines.join('\n');
}

/** Rasterize standalone SVG markup into a crisp 2x HiDPI PNG Blob completely offline. */
export function exportSvgToPngBlob(svgMarkup, { width = CANVAS_WIDTH, height = CANVAS_HEIGHT, scale = 2 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      reject(new Error('Canvas export requires a browser environment'));
      return;
    }
    const img = new Image();
    const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Unable to acquire 2D canvas context')); return; }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('PNG encoding failed'));
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('SVG rasterization failed'));
    img.src = encoded;
  });
}

const two = (n) => (n < 10 ? `0${n}` : String(n));

export function scratchpadFilename(ext) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    two(now.getMonth() + 1),
    two(now.getDate()),
    '-',
    two(now.getHours()),
    two(now.getMinutes()),
  ].join('');
  return `studyhub-scratchpad-${stamp}.${ext}`;
}

export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
