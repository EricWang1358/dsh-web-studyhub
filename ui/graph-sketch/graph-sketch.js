import { DEFAULT_PALETTE, hashString, round1 } from './ink-palette.js';

/* Pure logic for Knowledge Graph Wave 2 enhancements:
   1. Prerequisite & structural lineage spotlight (Obsidian-style neighborhood focus)
   2. Hand-drawn roughjs ink-line geometry (double-ink node frames, mastery hachure,
      organic sketchy Bezier curves) using live CSS theme tokens
   3. 100% offline standalone SVG serialization & download */

export const GRAPH_STYLES = Object.freeze(['crisp', 'sketch']);

export function edgeKey(type, from, to) {
  return `${type}:${from}->${to}`;
}

/**
 * Compute the connected lineage around `activeNodeId` in both 'structure' and 'path' modes:
 * - Recursively traverses upstream & downstream prerequisite chains (cycle-safe BFS)
 * - Includes direct structural ancestors & descendants via treeEdges
 * - In 'path' mode, includes adjacent order arrows touching the active step
 */
export function computeLineage(layout, activeNodeId, mode = 'structure') {
  if (!layout || !activeNodeId || !layout.posOf?.has(activeNodeId)) return null;

  const connectedNodes = new Set([activeNodeId]);
  const upstreamPrereq = new Set();
  const downstreamPrereq = new Set();
  const highlightedEdges = new Set();

  const prereqIn = new Map();
  const prereqOut = new Map();
  for (const e of layout.prereqEdges || []) {
    if (!prereqOut.has(e.from)) prereqOut.set(e.from, []);
    prereqOut.get(e.from).push(e.to);
    if (!prereqIn.has(e.to)) prereqIn.set(e.to, []);
    prereqIn.get(e.to).push(e.from);
  }

  // BFS upstream prerequisites (what this node depends on)
  const upQueue = [activeNodeId];
  const upSeen = new Set([activeNodeId]);
  while (upQueue.length) {
    const cur = upQueue.shift();
    for (const prev of prereqIn.get(cur) || []) {
      highlightedEdges.add(edgeKey('prereq', prev, cur));
      connectedNodes.add(prev);
      upstreamPrereq.add(prev);
      if (!upSeen.has(prev)) {
        upSeen.add(prev);
        upQueue.push(prev);
      }
    }
  }

  // BFS downstream dependents (what builds on this node)
  const downQueue = [activeNodeId];
  const downSeen = new Set([activeNodeId]);
  while (downQueue.length) {
    const cur = downQueue.shift();
    for (const next of prereqOut.get(cur) || []) {
      highlightedEdges.add(edgeKey('prereq', cur, next));
      connectedNodes.add(next);
      downstreamPrereq.add(next);
      if (!downSeen.has(next)) {
        downSeen.add(next);
        downQueue.push(next);
      }
    }
  }

  // Structural ancestry & descendants via treeEdges
  const parentOf = new Map();
  const childrenOf = new Map();
  for (const e of layout.treeEdges || []) {
    parentOf.set(e.to, e.from);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
  }

  let ancestor = activeNodeId;
  const ancSeen = new Set([activeNodeId]);
  while (parentOf.has(ancestor)) {
    const parent = parentOf.get(ancestor);
    if (ancSeen.has(parent)) break;
    ancSeen.add(parent);
    highlightedEdges.add(edgeKey('tree', parent, ancestor));
    connectedNodes.add(parent);
    ancestor = parent;
  }

  const descQueue = [activeNodeId];
  const descSeen = new Set([activeNodeId]);
  while (descQueue.length) {
    const cur = descQueue.shift();
    for (const child of childrenOf.get(cur) || []) {
      highlightedEdges.add(edgeKey('tree', cur, child));
      connectedNodes.add(child);
      if (!descSeen.has(child)) {
        descSeen.add(child);
        descQueue.push(child);
      }
    }
  }

  // In path mode, also highlight the immediate sequential step links touching activeNodeId
  if (mode === 'path' && Array.isArray(layout.placed)) {
    const idx = layout.placed.findIndex((p) => p.key === activeNodeId);
    if (idx > 0) {
      highlightedEdges.add(`order:${idx - 1}`);
      connectedNodes.add(layout.placed[idx - 1].key);
    }
    if (idx >= 0 && idx + 1 < layout.placed.length) {
      highlightedEdges.add(`order:${idx}`);
      connectedNodes.add(layout.placed[idx + 1].key);
    }
  }

  return {
    activeId: activeNodeId,
    connectedNodes,
    upstreamPrereq,
    downstreamPrereq,
    highlightedEdges,
    upstreamCount: upstreamPrereq.size,
    downstreamCount: downstreamPrereq.size,
  };
}

function levelColors(level, ghost, palette) {
  if (ghost) {
    return { stroke: palette.lineStrong, fill: null, fillOpacity: 0, dashed: true };
  }
  switch (level) {
    case 'mastered':
      return { stroke: palette.ok, fill: palette.ok, fillOpacity: palette.isLight ? 0.18 : 0.22, dashed: false };
    case 'familiar':
      return { stroke: palette.ok, fill: palette.ok, fillOpacity: palette.isLight ? 0.12 : 0.15, dashed: false };
    case 'learning':
      return { stroke: palette.warn, fill: palette.warn, fillOpacity: palette.isLight ? 0.17 : 0.21, dashed: false };
    case 'weak':
      return { stroke: palette.bad, fill: palette.bad, fillOpacity: palette.isLight ? 0.18 : 0.22, dashed: false };
    default:
      return { stroke: palette.decorFaint, fill: palette.decorFaint, fillOpacity: palette.isLight ? 0.11 : 0.15, dashed: false };
  }
}

/** Generate organic double-ink roughjs paths for a single placed graph node (in local 0..w, 0..h space). */
export function sketchNodePaths(placedNode, level, palette, roughGen = null, compact = false) {
  const { w, h, kind, key, node } = placedNode;
  const ghost = Boolean(node?.ghost || kind === 'ghost');
  const style = levelColors(level, ghost, palette);
  const seed = hashString(key || node?.id || 'gn');

  if (!roughGen) {
    const d = `M2 2 H${round1(w - 2)} V${round1(h - 2)} H2 Z`;
    return [
      ...(style.fill ? [{ d, stroke: 'none', strokeWidth: 0, fill: style.fill, opacity: style.fillOpacity }] : []),
      { d, stroke: style.stroke, strokeWidth: kind === 'deck' ? 1.5 : 1.15, fill: 'none', opacity: 0.9, dashArray: style.dashed ? '4 3' : undefined },
    ];
  }

  const out = [];
  const baseRect = roughGen.rectangle(1, 1, Math.max(4, w - 2), Math.max(4, h - 2), {
    stroke: style.stroke,
    strokeWidth: kind === 'deck' ? 1.45 : 1.1,
    fill: style.fill || undefined,
    fillStyle: 'hachure',
    fillWeight: 0.6,
    hachureAngle: kind === 'deck' ? -38 : -48,
    hachureGap: compact ? 11 : 9.5,
    roughness: kind === 'card' ? 0.95 : 1.15,
    bowing: 1.1,
    disableMultiStroke: compact || kind === 'card',
    strokeLineDash: style.dashed ? [4, 3] : undefined,
    fixedDecimalPlaceDigits: 1,
    seed,
  });

  const paths = roughGen.toPaths(baseRect);
  paths.forEach((p, idx) => {
    const isHatch = paths.length > 1 && idx === 0 && Boolean(style.fill);
    out.push({
      d: p.d,
      stroke: p.stroke || style.stroke,
      strokeWidth: p.strokeWidth ?? 1,
      fill: p.fill || 'none',
      opacity: isHatch ? Math.min(0.26, Number((style.fillOpacity + 0.04).toFixed(2))) : 0.92,
      dashArray: !isHatch && style.dashed ? '4 3' : undefined,
    });
  });

  // Subtle architectural inner hairline on deck & path-card frames for double-ink editorial depth
  if (!compact && !ghost && (kind === 'deck' || kind === 'pcard')) {
    const inner = roughGen.rectangle(3.5, 3.5, Math.max(4, w - 7), Math.max(4, h - 7), {
      stroke: style.stroke,
      strokeWidth: 0.65,
      roughness: 0.75,
      disableMultiStroke: true,
      fixedDecimalPlaceDigits: 1,
      seed: seed + 17,
    });
    for (const p of roughGen.toPaths(inner)) {
      out.push({ d: p.d, stroke: p.stroke || style.stroke, strokeWidth: p.strokeWidth ?? 0.65, fill: 'none', opacity: 0.44 });
    }
  }

  return out;
}

function sampleCubic(x0, y0, x1, y1, x2, y2, x3, y3, steps = 6) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
    const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
    pts.push([round1(x), round1(y)]);
  }
  return pts;
}

/** Generate sketchy hand-inked curve path(s) between two endpoints matching Graph's Bezier geometry. */
export function sketchBezierEdge(x1, y1, x2, y2, kind, palette, roughGen = null, seed = 1, dir = 1) {
  const sign = dir < 0 ? -1 : 1;
  const dx = Math.max(26, Math.abs(x2 - x1) * 0.45);
  const cx1 = x1 + sign * dx, cy1 = y1, cx2 = x2 - sign * dx, cy2 = y2;
  const fallbackD = `M ${round1(x1)} ${round1(y1)} C ${round1(cx1)} ${round1(cy1)}, ${round1(cx2)} ${round1(cy2)}, ${round1(x2)} ${round1(y2)}`;
  return sketchCubicPath(fallbackD, kind, palette, roughGen, seed);
}

const CUBIC_RE = /^M\s*([-\d.]+)\s+([-\d.]+)\s+C\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)$/;

/** Sketch any formatted cubic Bezier path string with edge styling for tree/order/prereq. */
export function sketchCubicPath(pathD, kind, palette, roughGen = null, seed = 1) {
  const isPrereq = kind === 'prereq';
  const stroke = isPrereq ? palette.accent : kind === 'order' ? palette.decorFaint : palette.lineStrong;
  const strokeWidth = isPrereq ? 1.45 : 1.25;
  const dashArray = isPrereq ? '5 4' : undefined;
  const opacity = isPrereq ? 0.92 : kind === 'order' ? 0.8 : 0.78;
  if (!roughGen) {
    return [{ d: pathD, stroke, strokeWidth, dashArray, opacity }];
  }
  const m = CUBIC_RE.exec(String(pathD || '').trim());
  if (!m) {
    return [{ d: pathD, stroke, strokeWidth, dashArray, opacity }];
  }
  const pts = sampleCubic(
    Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]),
    Number(m[5]), Number(m[6]), Number(m[7]), Number(m[8]),
    5,
  );
  const curve = roughGen.curve(pts, {
    stroke,
    strokeWidth,
    roughness: isPrereq ? 1.1 : 0.9,
    bowing: kind === 'order' ? 0.85 : 0.9,
    disableMultiStroke: true,
    fixedDecimalPlaceDigits: 1,
    seed,
  });
  return roughGen.toPaths(curve).map((p) => ({
    d: p.d,
    stroke: p.stroke || stroke,
    strokeWidth: p.strokeWidth ?? strokeWidth,
    dashArray,
    opacity,
  }));
}

/** Sketch an already-formatted cubic Bezier path string (used for path-mode `orderPaths`). */
export function sketchOrderCurve(pathD, palette, roughGen = null, seed = 1) {
  return sketchCubicPath(pathD, 'order', palette, roughGen, seed);
}

/** Build a clean standalone inline CSS block so exported Graph SVGs retain exact theme colors outside StudyHub. */
function buildStandaloneGraphCss(palette) {
  const p = palette || DEFAULT_PALETTE;
  const fontUi = 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  return [
    `text { font-family: ${fontUi}; }`,
    `.gn-node { stroke-width: 1.2; fill: ${p.paper}; }`,
    `.gn-deck { stroke-width: 1.5; }`,
    `.gn-mastered { fill: ${p.paper}; stroke: ${p.ok}; }`,
    `.gn-familiar { fill: ${p.paper}; stroke: ${p.ok}; }`,
    `.gn-learning { fill: ${p.paper}; stroke: ${p.warn}; }`,
    `.gn-weak { fill: ${p.paper}; stroke: ${p.bad}; }`,
    `.gn-new { fill: ${p.paper}; stroke: ${p.decorFaint}; }`,
    `.gn-ghost { fill: none; stroke: ${p.line}; stroke-dasharray: 4 3; }`,
    `.gn-label { fill: ${p.ink}; font-size: 13px; }`,
    `.gn-deck-label { font-weight: 500; }`,
    `.gn-meta { fill: ${p.inkMuted}; font-size: 12px; }`,
    `.gn-ghost-label { fill: ${p.inkFaint}; }`,
    `.gn-tree { fill: none; stroke: ${p.lineStrong}; stroke-width: 1.4; }`,
    `.gn-prereq { fill: none; stroke: ${p.accent}; stroke-width: 1.4; stroke-dasharray: 5 4; }`,
    `.gn-order { fill: none; stroke: ${p.decorFaint}; stroke-width: 1.4; }`,
    `.gn-arrow { stroke: none; }`,
    `.gn-arrow-prereq { fill: ${p.accent}; }`,
    `.gn-arrow-order { fill: ${p.decorFaint}; }`,
  ].join('\n');
}

function escapeXml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function buildGraphFilename(mode = 'structure', styleMode = 'crisp') {
  const safeMode = String(mode || 'structure').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const safeStyle = String(styleMode || 'crisp').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return `studyhub-knowledge-graph-${safeMode}-${safeStyle}.svg`;
}

/** Serialize a live Graph `<svg>` (or SVG string in tests) into a standalone themed XML SVG document. */
export function serializeGraphSvg(svgOrMarkup, options = {}) {
  const width = Math.max(1, Math.round(Number(options.width) || 800));
  const height = Math.max(1, Math.round(Number(options.height) || 600));
  const palette = options.palette || DEFAULT_PALETTE;
  const bg = palette.paper || DEFAULT_PALETTE.paper;
  const embeddedCss = buildStandaloneGraphCss(palette);

  if (typeof svgOrMarkup === 'string') {
    const trimmed = svgOrMarkup.trim();
    if (!trimmed.startsWith('<svg')) return '';
    let markup = /\bxmlns=/.test(trimmed)
      ? trimmed
      : trimmed.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    const preamble = `<style>${embeddedCss}</style><rect width="${width}" height="${height}" fill="${escapeXml(bg)}" />`;
    markup = markup.replace(/(<svg[^>]*>)/, `$1${preamble}`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
  }

  if (!svgOrMarkup || typeof svgOrMarkup.cloneNode !== 'function') return '';
  const clone = svgOrMarkup.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  // Clear transient spotlight dimming classes before exporting the clean map
  clone.querySelectorAll?.('.gn-spotlight-dim, .gn-spotlight-edge-dim')?.forEach((el) => {
    el.classList?.remove?.('gn-spotlight-dim', 'gn-spotlight-edge-dim');
  });

  const doc = svgOrMarkup.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (doc?.createElementNS) {
    const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = embeddedCss;
    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('fill', bg);
    clone.insertBefore(rect, clone.firstChild);
    clone.insertBefore(styleEl, clone.firstChild);
  }

  const serializer = typeof XMLSerializer === 'function' ? new XMLSerializer() : null;
  const raw = serializer ? serializer.serializeToString(clone) : clone.outerHTML || '';
  return raw ? `<?xml version="1.0" encoding="UTF-8"?>\n${raw}` : '';
}

/** Export the current Knowledge Graph as an offline standalone `.svg` file. */
export function exportGraphSvg(svgElement, filename, options = {}) {
  const xml = serializeGraphSvg(svgElement, options);
  if (!xml || typeof document === 'undefined') return false;
  let href = '';
  let revoke = false;
  if (typeof Blob === 'function' && typeof URL?.createObjectURL === 'function') {
    try {
      href = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
      revoke = true;
    } catch {
      href = '';
    }
  }
  if (!href) href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (revoke && typeof URL?.revokeObjectURL === 'function') {
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  }
  return true;
}
