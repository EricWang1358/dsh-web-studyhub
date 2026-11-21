import { clamp, createSeededRandom, fbm1D, lerp, round1 } from './seed-prng.js';
import { PLATE_HEIGHT, PLATE_WIDTH, formatColophonText } from './herbarium-svg.js';

/* Edition II: 千里山水卷 (Ink-Wash Shan-Shui)
   MIT Lineage: LingDong-/shan-shui-inf layered procedural mountain ridges,
   vertical cunfa (皴法) rock-strata hatching, drifting mist bands, riverside
   pavilion & drifting ink sail shaped by real heatmap cadence and deck mastery. */

const MARGIN = 22;
const INNER = 30;
const LEFT = INNER + 6;
const RIGHT = PLATE_WIDTH - INNER - 6;
const BOTTOM = PLATE_HEIGHT - INNER - 6;

function toPathList(roughGen, drawable, fallback) {
  if (!roughGen || !drawable) return fallback;
  return roughGen.toPaths(drawable).map((p) => ({
    d: p.d,
    stroke: p.stroke || 'none',
    strokeWidth: p.strokeWidth ?? 1,
    fill: p.fill || 'none',
  }));
}

function makeLine(roughGen, x1, y1, x2, y2, opts) {
  const rx1 = round1(x1), ry1 = round1(y1), rx2 = round1(x2), ry2 = round1(y2);
  const fallback = [{ d: `M${rx1} ${ry1} L${rx2} ${ry2}`, stroke: opts.stroke, strokeWidth: opts.strokeWidth ?? 1, fill: 'none' }];
  if (!roughGen) return fallback;
  return toPathList(roughGen, roughGen.line(rx1, ry1, rx2, ry2, { fixedDecimalPlaceDigits: 1, ...opts }), fallback);
}

function makeCurve(roughGen, points, opts) {
  const pts = points.map(([x, y]) => [round1(x), round1(y)]);
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += ` L${pts[i][0]} ${pts[i][1]}`;
  const fallback = [{ d, stroke: opts.stroke, strokeWidth: opts.strokeWidth ?? 1, fill: 'none' }];
  if (!roughGen) return fallback;
  return toPathList(roughGen, roughGen.curve(pts, { fixedDecimalPlaceDigits: 1, ...opts }), fallback);
}

function makeCircle(roughGen, cx, cy, diameter, opts) {
  const rcx = round1(cx), rcy = round1(cy), rd = round1(diameter), r = round1(diameter / 2);
  const fallback = [{
    d: `M${round1(rcx - r)} ${rcy} a${r} ${r} 0 1 0 ${rd} 0 a${r} ${r} 0 1 0 ${-rd} 0`,
    stroke: opts.stroke || 'none',
    strokeWidth: opts.strokeWidth ?? 1,
    fill: opts.fill || 'none',
  }];
  if (!roughGen) return fallback;
  return toPathList(roughGen, roughGen.circle(rcx, rcy, rd, { fixedDecimalPlaceDigits: 1, ...opts }), fallback);
}

function makeRect(roughGen, x, y, w, h, opts) {
  const rx = round1(x), ry = round1(y), rw = round1(w), rh = round1(h);
  const fallback = [{ d: `M${rx} ${ry} H${round1(rx + rw)} V${round1(ry + rh)} H${rx} Z`, stroke: opts.stroke || 'none', strokeWidth: opts.strokeWidth ?? 1, fill: opts.fill || 'none' }];
  if (!roughGen) return fallback;
  return toPathList(roughGen, roughGen.rectangle(rx, ry, rw, rh, { fixedDecimalPlaceDigits: 1, ...opts }), fallback);
}

/** Build a smooth normalized [0..1] cadence curve from heatmap counts. */
function buildCadenceSampler(heatmap) {
  const slice = Array.isArray(heatmap) ? heatmap.slice(-84) : [];
  const max = slice.reduce((m, d) => Math.max(m, Number(d?.count) || 0), 0);
  if (!slice.length || max <= 0) return () => 0.18;
  const counts = slice.map((d) => (Number(d?.count) || 0) / max);
  return (t) => {
    const pos = clamp(t, 0, 1) * (counts.length - 1);
    let sum = 0;
    let weight = 0;
    const center = Math.round(pos);
    for (let k = Math.max(0, center - 4); k <= Math.min(counts.length - 1, center + 4); k++) {
      const dist = pos - k;
      const w = Math.exp(-(dist * dist) / 4.2);
      sum += counts[k] * w;
      weight += w;
    }
    return weight ? sum / weight : 0.18;
  };
}

/** Build a closed smooth mountain silhouette polygon path + ridge sample points. */
function buildMountainRange({
  seed, baseY, peakHeight, freq, cadenceFn, cadenceWeight, masteryBoost, steps = 64,
  leftX = LEFT, rightX = RIGHT, bottomY = BOTTOM,
}) {
  const rng = createSeededRandom(seed);
  // 2-3 broad dramatic Shan-Shui massif envelopes
  const massifs = Array.from({ length: 3 }, (_, i) => ({
    center: 0.16 + i * 0.34 + rng.range(-0.08, 0.08),
    spread: rng.range(0.11, 0.2),
    amp: rng.range(0.55, 1.0),
  }));

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = lerp(leftX, rightX, t);
    const edgeFade = Math.sin(clamp(t, 0, 1) * Math.PI);
    const edgeWeight = Math.pow(edgeFade, 0.38);

    let massif = 0;
    for (const m of massifs) {
      const d = (t - m.center) / m.spread;
      massif = Math.max(massif, m.amp * Math.exp(-d * d * 1.4));
    }
    const noise = fbm1D(t * freq + 2.3, seed, 4);
    const cadence = cadenceFn(t);
    const elevation = edgeWeight * (
      massif * 0.54
      + noise * 0.34
      + cadence * cadenceWeight
      + masteryBoost * 0.12
    );
    const y = clamp(baseY - elevation * peakHeight, 62, bottomY - 18);
    points.push([round1(x), round1(y)]);
  }

  let fillD = `M${round1(leftX)} ${round1(bottomY)}`;
  for (const [x, y] of points) fillD += ` L${x} ${y}`;
  fillD += ` L${round1(rightX)} ${round1(bottomY)} Z`;

  return { points, fillD };
}

/** Draw subtle vertical/angled cunfa (皴法) rock-strata hatching down mountain flanks. */
function buildCunfaStrokes(points, seed, palette, roughGen, density = 14) {
  const rng = createSeededRandom(seed ^ 0x44f1);
  const strokes = [];
  const stride = Math.max(2, Math.floor(points.length / density));
  for (let i = 2; i < points.length - 2; i += stride) {
    const [x, y] = points[i];
    const slope = points[Math.min(points.length - 1, i + 1)][1] - points[Math.max(0, i - 1)][1];
    const drop = rng.range(20, 56);
    const drift = slope >= 0 ? rng.range(8, 20) : rng.range(-20, -8);
    const sub = makeCurve(
      roughGen,
      [
        [x, y + 4],
        [x + drift * 0.45, y + drop * 0.52],
        [x + drift, y + drop],
      ],
      {
        stroke: palette.inkDim,
        strokeWidth: 0.85,
        roughness: 1.15,
        disableMultiStroke: true,
        seed: rng.int(1, 99999),
      },
    );
    for (const p of sub) strokes.push({ ...p, opacity: 0.32 });
  }
  return strokes;
}

/** Tiny hand-sketched riverside scholar's pavilion (亭) perched on the left bank. */
function buildPavilion(x, y, palette, roughGen, seed) {
  const lines = [
    // Upturned double eaves
    [x - 16, y - 10, x, y - 18],
    [x, y - 18, x + 16, y - 10],
    [x - 12, y - 6, x + 12, y - 6],
    // Twin slender pillars
    [x - 7, y - 6, x - 7, y + 4],
    [x + 7, y - 6, x + 7, y + 4],
    // Stone terrace base
    [x - 13, y + 4, x + 13, y + 4],
  ];
  const out = [];
  lines.forEach(([x1, y1, x2, y2], idx) => {
    for (const p of makeLine(roughGen, x1, y1, x2, y2, {
      stroke: palette.ink,
      strokeWidth: idx < 2 ? 1.3 : 1.0,
      roughness: 0.8,
      disableMultiStroke: true,
      seed: seed + idx * 13,
    })) {
      out.push({ ...p, opacity: 0.72 });
    }
  });
  return out;
}

/** Tiny drifting ink sailboat (扁舟) on the calm lower river. */
function buildSailboat(x, y, scale, palette, roughGen, seed) {
  const s = scale;
  const out = [];
  // Curved sampan hull
  for (const p of makeCurve(roughGen, [
    [x - 14 * s, y],
    [x, y + 3.5 * s],
    [x + 15 * s, y - 0.8 * s],
  ], {
    stroke: palette.ink,
    strokeWidth: 1.25,
    roughness: 0.85,
    disableMultiStroke: true,
    seed: seed + 3,
  })) {
    out.push({ ...p, opacity: 0.78 });
  }
  // Mast & angled sail
  const sailLines = [
    [x - 1 * s, y, x - 1 * s, y - 16 * s],
    [x - 1 * s, y - 15 * s, x + 9 * s, y - 4 * s],
    [x - 1 * s, y - 4 * s, x + 9 * s, y - 4 * s],
  ];
  sailLines.forEach(([x1, y1, x2, y2], idx) => {
    for (const p of makeLine(roughGen, x1, y1, x2, y2, {
      stroke: palette.inkDim,
      strokeWidth: 0.95,
      roughness: 0.75,
      disableMultiStroke: true,
      seed: seed + 19 + idx * 7,
    })) {
      out.push({ ...p, opacity: 0.7 });
    }
  });
  return out;
}

/** Subtle foreground mountain pine silhouettes perched along near ridge crests based on mastery. */
function buildMasteryPines(nearPoints, deckXs, garden, palette, roughGen) {
  if (garden.isEmpty || !nearPoints.length) return [];
  const masteryCount = clamp(
    Math.floor((garden.totals.mastered || 0) / 4) + Math.floor((garden.totals.overallMastery || 0) / 22),
    garden.totals.overallMastery >= 20 ? 2 : 0,
    6,
  );
  if (masteryCount <= 0) return [];
  const rng = createSeededRandom(garden.seed ^ 0x501e);
  const strokes = [];
  const placed = [...deckXs];

  for (let i = 0; i < masteryCount; i++) {
    let chosen = null;
    for (let tries = 0; tries < 24; tries++) {
      const idx = rng.int(5, nearPoints.length - 6);
      const [px, py] = nearPoints[idx];
      if (py > 326 || py < 120) continue;
      if (placed.every((ox) => Math.abs(ox - px) >= 34)) {
        placed.push(px);
        chosen = [px, py];
        break;
      }
    }
    if (!chosen) continue;
    const [x, y] = chosen;
    const s = rng.range(0.75, 1.15);
    // Tiny ink-wash trunk + two tiered pine canopies
    strokes.push({
      d: `M${round1(x)} ${round1(y + 2)} L${round1(x)} ${round1(y - 10 * s)}`,
      stroke: palette.inkDim,
      strokeWidth: 0.9,
      fill: 'none',
      opacity: 0.62,
    });
    const tiers = [
      [[x - 6 * s, y - 4 * s], [x, y - 9 * s], [x + 6 * s, y - 4 * s]],
      [[x - 4.5 * s, y - 8 * s], [x, y - 13 * s], [x + 4.5 * s, y - 8 * s]],
    ];
    for (const pts of tiers) {
      for (const p of makeCurve(roughGen, pts, {
        stroke: palette.ok,
        strokeWidth: 1.0,
        roughness: 0.85,
        disableMultiStroke: true,
        seed: rng.int(1, 99999),
      })) {
        strokes.push({ ...p, fill: palette.ok, fillOpacity: 0.2, opacity: 0.66 });
      }
    }
  }
  return strokes;
}

/** Render a clickable deck peak marker nestled closely onto a sculpted mountain ridge. */
function renderRidgeLandmark(item, x, y, ridgeY, palette, roughGen) {
  const rng = createSeededRandom(item.seed);
  const strokes = [];

  // Short grounded plinth stroke (<= 8px) seating the landmark cleanly onto the ridge contour
  const stemBottom = Math.min(ridgeY, y + 8);
  if (stemBottom > y + 2) {
    strokes.push({
      d: `M${round1(x)} ${round1(y + 3)} L${round1(x)} ${round1(stemBottom)}`,
      stroke: palette.inkMuted,
      strokeWidth: 0.9,
      fill: 'none',
      opacity: 0.58,
    });
  }

  if (item.stage === 'mastered') {
    const layers = [
      [x, y - 11, x - 9, y - 2, x + 9, y - 2],
      [x, y - 5, x - 11, y + 5, x + 11, y + 5],
    ];
    for (const [ax, ay, bx, by, cx, cy] of layers) {
      for (const p of makeCurve(roughGen, [[bx, by], [ax, ay], [cx, cy], [bx, by]], {
        stroke: palette.ok,
        strokeWidth: 1.2,
        roughness: 0.9,
        disableMultiStroke: true,
        seed: rng.int(1, 99999),
      })) {
        strokes.push({ ...p, fill: palette.ok, fillOpacity: 0.24, opacity: 0.9 });
      }
    }
    for (const p of makeCircle(roughGen, x, y - 14, 5.5, {
      stroke: palette.accent,
      strokeWidth: 1,
      fill: palette.accent,
      fillStyle: 'solid',
      roughness: 0.7,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.92 });
    }
    return { strokes, hitRadius: 20 };
  }

  if (item.stage === 'learning') {
    const r = 8.5;
    const pts = [[x, y - r], [x + r * 0.82, y], [x, y + r], [x - r * 0.82, y], [x, y - r]];
    for (const p of makeCurve(roughGen, pts, {
      stroke: palette.warn,
      strokeWidth: 1.25,
      roughness: 0.9,
      disableMultiStroke: true,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, fill: palette.warn, fillOpacity: 0.28, opacity: 0.9 });
    }
    for (const p of makeCircle(roughGen, x, y, 4.5, {
      stroke: palette.warn,
      strokeWidth: 0.9,
      fill: palette.warn,
      fillStyle: 'solid',
      roughness: 0.6,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.9 });
    }
    return { strokes, hitRadius: 19 };
  }

  if (item.stage === 'weak') {
    // Grounded berry ridge cairn nestled directly onto the mountain contour (no tall lollipop stem)
    for (const p of makeCircle(roughGen, x, y, 17, {
      stroke: palette.bad,
      strokeWidth: 0.9,
      strokeLineDash: [3, 3],
      roughness: 0.9,
      disableMultiStroke: true,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.56 });
    }
    for (const p of makeCircle(roughGen, x, y, 9.8, {
      stroke: palette.bad,
      strokeWidth: 1.2,
      fill: palette.bad,
      fillStyle: 'hachure',
      hachureGap: 3.2,
      roughness: 1.0,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.88 });
    }
    return { strokes, hitRadius: 20 };
  }

  // 'fresh' — quiet ink milestone circle
  for (const p of makeCircle(roughGen, x, y, 9.5, {
    stroke: palette.inkMuted,
    strokeWidth: 1.15,
    fill: palette.paper,
    fillStyle: 'solid',
    roughness: 0.85,
    seed: rng.int(1, 99999),
  })) {
    strokes.push({ ...p, opacity: 0.85 });
  }
  return { strokes, hitRadius: 18 };
}

/**
 * Generate the complete Ink-Wash Shan-Shui scroll scene.
 * Pure & deterministic: driven directly by `heatmap` cadence & deck mastery.
 */
export function buildShanshuiScene(garden, palette, roughGen = null) {
  const cadenceFn = buildCadenceSampler(garden.heatmap);
  const masteryBoost = garden.totals.overallMastery / 100;
  const emptyScale = garden.isEmpty ? 0.58 : 1;

  // Scroll collector frame
  const framePaths = [
    ...makeRect(roughGen, MARGIN, MARGIN, PLATE_WIDTH - MARGIN * 2, PLATE_HEIGHT - MARGIN * 2, {
      stroke: palette.lineStrong,
      strokeWidth: 1.2,
      roughness: 0.9,
      disableMultiStroke: true,
      seed: garden.seed + 11,
    }).map((p) => ({ ...p, opacity: 0.75 })),
    ...makeRect(roughGen, INNER, INNER, PLATE_WIDTH - INNER * 2, PLATE_HEIGHT - INNER * 2, {
      stroke: palette.line,
      strokeWidth: 0.75,
      roughness: 0.65,
      disableMultiStroke: true,
      seed: garden.seed + 17,
    }).map((p) => ({ ...p, opacity: 0.55 })),
  ];

  // Cinnabar sun/moon seal in upper-right sky
  const sunCenter = { x: 824, y: 102 };
  const sunPaths = makeCircle(roughGen, sunCenter.x, sunCenter.y, 44, {
    stroke: palette.accent,
    strokeWidth: 1.2,
    fill: palette.accent,
    fillStyle: 'hachure',
    hachureAngle: -32,
    hachureGap: 4.5,
    roughness: 1.1,
    seed: garden.seed + 41,
  }).map((p) => ({ ...p, opacity: 0.72 }));

  // 3 atmospheric mountain ranges (far -> mid -> near)
  const far = buildMountainRange({
    seed: garden.seed ^ 0x1101,
    baseY: 250,
    peakHeight: 145 * emptyScale,
    freq: 3.1,
    cadenceFn,
    cadenceWeight: 0.32,
    masteryBoost,
    steps: 60,
  });
  const mid = buildMountainRange({
    seed: garden.seed ^ 0x2202,
    baseY: 298,
    peakHeight: 155 * emptyScale,
    freq: 4.2,
    cadenceFn,
    cadenceWeight: 0.42,
    masteryBoost,
    steps: 64,
  });
  const near = buildMountainRange({
    seed: garden.seed ^ 0x3303,
    baseY: 356,
    peakHeight: 132 * emptyScale,
    freq: 5.0,
    cadenceFn,
    cadenceWeight: 0.28,
    masteryBoost: masteryBoost * 0.85,
    steps: 64,
  });

  const midOutline = makeCurve(roughGen, mid.points.filter((_, i) => i % 2 === 0), {
    stroke: palette.inkMuted,
    strokeWidth: 1.05,
    roughness: 1.05,
    disableMultiStroke: true,
    seed: garden.seed + 53,
  }).map((p) => ({ ...p, opacity: 0.55 }));

  const nearOutline = makeCurve(roughGen, near.points.filter((_, i) => i % 2 === 0), {
    stroke: palette.inkDim,
    strokeWidth: 1.4,
    roughness: 1.15,
    disableMultiStroke: true,
    seed: garden.seed + 61,
  }).map((p) => ({ ...p, opacity: 0.72 }));

  const cunfaDensity = garden.isEmpty ? 6 : clamp(10 + Math.floor(garden.totals.activeDays / 4), 10, 22);
  const cunfaPaths = [
    ...buildCunfaStrokes(mid.points, garden.seed + 71, palette, roughGen, Math.floor(cunfaDensity * 0.7)),
    ...buildCunfaStrokes(near.points, garden.seed + 83, palette, roughGen, cunfaDensity),
  ];

  // Layered mountain planes & drifting mist rectangles
  const ranges = [
    { id: 'far', fillD: far.fillD, fill: palette.info, opacity: palette.isLight ? 0.17 : 0.2 },
    { id: 'mid', fillD: mid.fillD, fill: palette.inkMuted, opacity: palette.isLight ? 0.2 : 0.24 },
    { id: 'near', fillD: near.fillD, fill: palette.inkDim, opacity: palette.isLight ? 0.26 : 0.3 },
  ];

  const mistBands = [
    { x: LEFT, y: 214, width: RIGHT - LEFT, height: 64, opacity: 0.46 },
    { x: LEFT, y: 278, width: RIGHT - LEFT, height: 68, opacity: 0.54 },
    { x: LEFT, y: 332, width: RIGHT - LEFT, height: 54, opacity: 0.64 },
  ];
  // Dedicated water-mist fade dissolving the foreground mountain base smoothly into palette.paper
  const waterFadeBand = { x: LEFT, y: 330, width: RIGHT - LEFT, height: BOTTOM - 330 + 2 };

  // Calm river ripples in lower water band
  const rng = createSeededRandom(garden.seed ^ 0x9911);
  const riverPaths = [];
  for (let i = 0; i < 11; i++) {
    const rx = rng.range(LEFT + 40, RIGHT - 160);
    const ry = rng.range(358, BOTTOM - 10);
    const rw = rng.range(48, 120);
    for (const p of makeLine(roughGen, rx, ry, rx + rw, ry, {
      stroke: palette.info,
      strokeWidth: 0.85,
      roughness: 0.65,
      disableMultiStroke: true,
      seed: garden.seed + 101 + i,
    })) {
      riverPaths.push({ ...p, opacity: 0.34 });
    }
  }

  // Riverside scholar's pavilion & drifting sailboats
  const pavilionPaths = !garden.isEmpty
    ? buildPavilion(126, 336, palette, roughGen, garden.seed + 211)
    : [];
  const boatPaths = [
    ...buildSailboat(696, 378, 1.0, palette, roughGen, garden.seed + 241),
    ...(garden.totals.activeDays >= 5 || garden.totals.streak >= 3
      ? buildSailboat(546, 389, 0.72, palette, roughGen, garden.seed + 257)
      : []),
  ];

  // Anchor clickable deck landmarks nestled closely along the mountain skyline
  const visible = garden.items.slice(0, 24);
  const sampleY = (pts, targetX) => {
    const t = clamp((targetX - LEFT) / (RIGHT - LEFT), 0, 1);
    const idx = clamp(Math.round(t * (pts.length - 1)), 0, pts.length - 1);
    return pts[idx][1];
  };

  const nodes = visible.map((item, idx) => {
    const itemRng = createSeededRandom(item.seed);
    const slot = (idx + 0.5) / Math.max(1, visible.length);
    const x = round1(clamp(
      lerp(LEFT + 76, RIGHT - 92, slot) + itemRng.range(-12, 12),
      LEFT + 62,
      RIGHT - 74,
    ));
    // Higher mastery decks crown mid ridges; lower mastery nestle directly onto foreground ridge crests
    const targetRange = item.mastery >= 55 ? mid.points : near.points;
    const ridgeY = sampleY(targetRange, x);
    const lift = item.stage === 'weak' ? 4 : item.stage === 'mastered' ? 7 : 6;
    const y = round1(clamp(ridgeY - lift, 74, 332));
    const { strokes, hitRadius } = renderRidgeLandmark(item, x, y, ridgeY, palette, roughGen);
    return {
      id: item.id,
      item,
      x,
      y,
      ridgeY,
      hitRadius,
      strokes,
    };
  });

  const pinePaths = buildMasteryPines(near.points, nodes.map((n) => n.x), garden, palette, roughGen);

  // Carved cinnabar seal in lower-right with stylized mountain glyph (Han-free)
  const sx = PLATE_WIDTH - INNER - 46;
  const sy = PLATE_HEIGHT - INNER - 46;
  const sealPaths = [
    ...makeRect(roughGen, sx, sy, 34, 34, {
      stroke: palette.accent,
      strokeWidth: 1.6,
      roughness: 1.2,
      disableMultiStroke: true,
      seed: garden.seed + 307,
    }).map((p) => ({ ...p, opacity: 0.88 })),
    {
      d: `M${sx + 7} ${sy + 23} L${sx + 13} ${sy + 12} L${sx + 18} ${sy + 19} L${sx + 22} ${sy + 14} L${sx + 27} ${sy + 23}`,
      stroke: palette.accent,
      strokeWidth: 1.4,
      fill: 'none',
      opacity: 0.85,
    },
  ];

  return {
    edition: 'shanshui',
    width: PLATE_WIDTH,
    height: PLATE_HEIGHT,
    framePaths,
    sunPaths,
    ranges,
    mistBands,
    waterFadeBand,
    ridgeOutlines: [...midOutline, ...nearOutline],
    cunfaPaths,
    pinePaths,
    riverPaths,
    pavilionPaths,
    boatPaths,
    nodes,
    sealPaths,
    colophon: formatColophonText(garden),
  };
}
