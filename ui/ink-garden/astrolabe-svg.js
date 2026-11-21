import { clamp, createSeededRandom, lerp, round1 } from './seed-prng.js';
import { PLATE_HEIGHT, PLATE_WIDTH } from './herbarium-svg.js';

/* Edition III: 铜版星象图 (Engraved Astrolabe)
   Hand-etched roughjs concentric mastery orbits, celestial meridian arcs,
   degree bezel ticks, course-grouped constellation filaments, and clickable
   deck star glyphs. Pure & deterministic. */

const MARGIN = 22;
const INNER = 30;
export const ASTRO_CX = 480;
export const ASTRO_CY = 220;
const ORBIT_RADII = [52, 96, 140, 178];

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

function makeEllipse(roughGen, cx, cy, w, h, opts) {
  const rcx = round1(cx), rcy = round1(cy), rx = round1(w / 2), ry = round1(h / 2);
  const fallback = [{
    d: `M${round1(rcx - rx)} ${rcy} a${rx} ${ry} 0 1 0 ${round1(w)} 0 a${rx} ${ry} 0 1 0 ${round1(-w)} 0`,
    stroke: opts.stroke || 'none',
    strokeWidth: opts.strokeWidth ?? 1,
    fill: opts.fill || 'none',
  }];
  if (!roughGen) return fallback;
  return toPathList(roughGen, roughGen.ellipse(rcx, rcy, round1(w), round1(h), { fixedDecimalPlaceDigits: 1, ...opts }), fallback);
}

function makeRect(roughGen, x, y, w, h, opts) {
  const rx = round1(x), ry = round1(y), rw = round1(w), rh = round1(h);
  const fallback = [{ d: `M${rx} ${ry} H${round1(rx + rw)} V${round1(ry + rh)} H${rx} Z`, stroke: opts.stroke || 'none', strokeWidth: opts.strokeWidth ?? 1, fill: opts.fill || 'none' }];
  if (!roughGen) return fallback;
  return toPathList(roughGen, roughGen.rectangle(rx, ry, rw, rh, { fixedDecimalPlaceDigits: 1, ...opts }), fallback);
}

/** Generate N-pointed engraved star polygon path string. */
function starPath(cx, cy, points, outerR, innerR, rot = -Math.PI / 2) {
  const coords = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const theta = rot + (i * Math.PI) / points;
    coords.push(`${round1(cx + Math.cos(theta) * r)} ${round1(cy + Math.sin(theta) * r)}`);
  }
  return `M${coords[0]} L${coords.slice(1).join(' L')} Z`;
}

/** Map deck mastery & stage onto polar coordinates with course-grouped sectors & collision repulsion. */
function placeConstellationStars(items) {
  if (!items.length) return [];
  const visible = items.slice(0, 28);
  // Stable course grouping so related decks form recognizable constellations
  const sorted = [...visible].sort((a, b) => (a.course || '').localeCompare(b.course || '') || a.id.localeCompare(b.id));
  const total = sorted.length;

  const placed = sorted.map((item, idx) => {
    const rng = createSeededRandom(item.seed);
    const baseAngle = -Math.PI / 2 + (idx / total) * Math.PI * 2 + rng.range(-0.14, 0.14);
    // Higher mastery orbits closer to the zenith center; new decks sit on the outer rim
    let radius;
    if (item.stage === 'mastered') {
      radius = lerp(42, 74, 1 - clamp((item.mastery - 80) / 20, 0, 1));
    } else if (item.stage === 'fresh') {
      radius = rng.range(150, 170);
    } else {
      radius = lerp(146, 82, clamp(item.mastery / 80, 0, 1));
    }
    return {
      item,
      angle: baseAngle,
      radius,
      x: round1(ASTRO_CX + Math.cos(baseAngle) * radius),
      y: round1(ASTRO_CY + Math.sin(baseAngle) * radius),
    };
  });

  // Gentle deterministic relaxation pass to prevent star label/marker overlap
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.1 && dist < 34) {
          const push = (34 - dist) * 0.35;
          const nx = dx / dist, ny = dy / dist;
          a.x = round1(clamp(a.x - nx * push, 110, PLATE_WIDTH - 110));
          a.y = round1(clamp(a.y - ny * push, 52, PLATE_HEIGHT - 52));
          b.x = round1(clamp(b.x + nx * push, 110, PLATE_WIDTH - 110));
          b.y = round1(clamp(b.y + ny * push, 52, PLATE_HEIGHT - 52));
        }
      }
    }
  }
  return placed;
}

/** Render one clickable deck star glyph with stage-specific engraving and optional due moonlet. */
function renderStarGlyph(node, palette, roughGen) {
  const { item, x, y } = node;
  const rng = createSeededRandom(item.seed);
  const strokes = [];
  const scale = clamp(Math.log2((item.total || 4) + 2) / 5, 0.78, 1.28);

  if (item.stage === 'mastered') {
    const outer = round1(11.5 * scale);
    const inner = round1(3.8 * scale);
    strokes.push({
      d: starPath(x, y, 8, outer, inner),
      stroke: palette.ok,
      strokeWidth: 1.15,
      fill: palette.ok,
      fillOpacity: 0.25,
      opacity: 0.92,
    });
    for (const p of makeCircle(roughGen, x, y, 6.2 * scale, {
      stroke: palette.accent,
      strokeWidth: 1.0,
      fill: palette.accent,
      fillStyle: 'solid',
      roughness: 0.7,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.92 });
    }
  } else if (item.stage === 'learning') {
    const outer = round1(10 * scale);
    const inner = round1(3.6 * scale);
    strokes.push({
      d: starPath(x, y, 4, outer, inner),
      stroke: palette.warn,
      strokeWidth: 1.2,
      fill: palette.warn,
      fillOpacity: 0.28,
      opacity: 0.9,
    });
    for (const p of makeCircle(roughGen, x, y, 4.6 * scale, {
      stroke: palette.warn,
      strokeWidth: 0.85,
      fill: palette.warn,
      fillStyle: 'solid',
      roughness: 0.65,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.9 });
    }
  } else if (item.stage === 'weak') {
    for (const p of makeCircle(roughGen, x, y, 18 * scale, {
      stroke: palette.bad,
      strokeWidth: 0.9,
      strokeLineDash: [3, 3],
      roughness: 0.9,
      disableMultiStroke: true,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.62 });
    }
    strokes.push({
      d: starPath(x, y, 4, 8.5 * scale, 3.2 * scale, Math.PI / 4),
      stroke: palette.bad,
      strokeWidth: 1.2,
      fill: palette.bad,
      fillOpacity: 0.34,
      opacity: 0.92,
    });
  } else {
    // 'fresh' — charted new star diamond awaiting exploration
    strokes.push({
      d: starPath(x, y, 4, 7.5 * scale, 3.2 * scale),
      stroke: palette.inkMuted,
      strokeWidth: 1.1,
      fill: palette.paper,
      fillOpacity: 0.9,
      opacity: 0.84,
    });
  }

  // Subtle orbiting moonlet pip when cards are due in this deck
  if (item.due > 0) {
    const mx = round1(x + 11.5 * scale);
    const my = round1(y - 8.5 * scale);
    strokes.push({
      d: `M${round1(mx - 2.4)} ${my} a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0`,
      stroke: palette.accent,
      strokeWidth: 0.9,
      fill: palette.accent,
      opacity: 0.86,
    });
  }

  return { strokes, hitRadius: 19 };
}

/**
 * Generate the complete Engraved Astrolabe celestial print scene.
 * Pure & deterministic.
 */
export function buildAstrolabeScene(garden, palette, roughGen = null) {
  const rng = createSeededRandom(garden.seed ^ 0x77c1);

  // Plate frame
  const framePaths = [
    ...makeRect(roughGen, MARGIN, MARGIN, PLATE_WIDTH - MARGIN * 2, PLATE_HEIGHT - MARGIN * 2, {
      stroke: palette.lineStrong,
      strokeWidth: 1.2,
      roughness: 0.85,
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

  // Concentric mastery rings & outer brass bezel
  const ringPaths = [];
  ORBIT_RADII.forEach((r, idx) => {
    const isInner = idx === 0;
    const isBezel = idx === ORBIT_RADII.length - 1;
    const paths = makeCircle(roughGen, ASTRO_CX, ASTRO_CY, r * 2, {
      stroke: isInner ? palette.ok : isBezel ? palette.inkDim : palette.lineStrong,
      strokeWidth: isBezel ? 1.35 : 0.95,
      roughness: 0.85,
      disableMultiStroke: true,
      strokeLineDash: idx === 1 || idx === 2 ? [4, 4] : undefined,
      seed: garden.seed + 101 + idx * 17,
    });
    for (const p of paths) {
      ringPaths.push({ ...p, opacity: isBezel ? 0.68 : isInner ? 0.52 : 0.58 });
    }
  });
  // Outer hairline bezel ring
  for (const p of makeCircle(roughGen, ASTRO_CX, ASTRO_CY, 374, {
    stroke: palette.line,
    strokeWidth: 0.75,
    roughness: 0.65,
    disableMultiStroke: true,
    seed: garden.seed + 179,
  })) {
    ringPaths.push({ ...p, opacity: 0.5 });
  }

  // Tilted celestial meridian ellipses + equinoctial / solstitial axes
  const meridianPaths = [
    ...makeEllipse(roughGen, ASTRO_CX, ASTRO_CY, 356, 132, {
      stroke: palette.info,
      strokeWidth: 0.85,
      roughness: 0.85,
      disableMultiStroke: true,
      seed: garden.seed + 211,
    }).map((p) => ({ ...p, opacity: 0.36 })),
    ...makeEllipse(roughGen, ASTRO_CX, ASTRO_CY, 148, 356, {
      stroke: palette.info,
      strokeWidth: 0.85,
      roughness: 0.85,
      disableMultiStroke: true,
      seed: garden.seed + 223,
    }).map((p) => ({ ...p, opacity: 0.36 })),
    ...makeLine(roughGen, ASTRO_CX - 216, ASTRO_CY, ASTRO_CX + 216, ASTRO_CY, {
      stroke: palette.lineStrong,
      strokeWidth: 0.8,
      roughness: 0.7,
      disableMultiStroke: true,
      seed: garden.seed + 233,
    }).map((p) => ({ ...p, opacity: 0.48 })),
    ...makeLine(roughGen, ASTRO_CX, ASTRO_CY - 192, ASTRO_CX, ASTRO_CY + 192, {
      stroke: palette.lineStrong,
      strokeWidth: 0.8,
      roughness: 0.7,
      disableMultiStroke: true,
      seed: garden.seed + 239,
    }).map((p) => ({ ...p, opacity: 0.48 })),
  ];

  // Degree bezel ticks (36 around the 178px brass ring)
  const tickPaths = [];
  for (let i = 0; i < 36; i++) {
    const theta = (i * Math.PI * 2) / 36;
    const major = i % 3 === 0;
    const r0 = major ? 172 : 175;
    const r1 = major ? 186 : 182;
    tickPaths.push({
      d: `M${round1(ASTRO_CX + Math.cos(theta) * r0)} ${round1(ASTRO_CY + Math.sin(theta) * r0)} L${round1(ASTRO_CX + Math.cos(theta) * r1)} ${round1(ASTRO_CY + Math.sin(theta) * r1)}`,
      stroke: major ? palette.inkDim : palette.decorFaint,
      strokeWidth: major ? 1.15 : 0.75,
      fill: 'none',
      opacity: major ? 0.65 : 0.45,
    });
  }

  // Central compass rose & zenith dial
  const corePaths = [
    {
      d: starPath(ASTRO_CX, ASTRO_CY, 8, 22, 6),
      stroke: palette.inkMuted,
      strokeWidth: 0.9,
      fill: palette.inkMuted,
      fillOpacity: 0.14,
      opacity: 0.7,
    },
    ...makeCircle(roughGen, ASTRO_CX, ASTRO_CY, 16, {
      stroke: palette.accent,
      strokeWidth: 1.15,
      fill: palette.paper,
      fillStyle: 'solid',
      roughness: 0.8,
      seed: garden.seed + 263,
    }).map((p) => ({ ...p, opacity: 0.88 })),
  ];

  // Ambient background starlight flecks in the margins
  const dustDots = Array.from({ length: 34 }, () => {
    const side = rng.chance(0.5);
    const x = side ? rng.range(54, 240) : rng.range(PLATE_WIDTH - 240, PLATE_WIDTH - 54);
    const y = rng.range(52, PLATE_HEIGHT - 56);
    return { cx: round1(x), cy: round1(y), r: round1(rng.range(0.8, 1.7)), opacity: round1(rng.range(0.22, 0.55)) };
  });

  // Deck stars & course-grouped constellation filaments
  const placed = placeConstellationStars(garden.items);
  const filamentPaths = [];
  const byCourse = new Map();
  for (const node of placed) {
    const key = node.item.course || '__default';
    const list = byCourse.get(key) || [];
    list.push(node);
    byCourse.set(key, list);
  }
  for (const group of byCourse.values()) {
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1], b = group[i];
      for (const p of makeLine(roughGen, a.x, a.y, b.x, b.y, {
        stroke: palette.info,
        strokeWidth: 0.9,
        strokeLineDash: [3, 4],
        roughness: 0.8,
        disableMultiStroke: true,
        seed: a.item.seed ^ b.item.seed,
      })) {
        filamentPaths.push({ ...p, opacity: 0.45 });
      }
    }
  }

  const nodes = placed.map((node) => {
    const { strokes, hitRadius } = renderStarGlyph(node, palette, roughGen);
    return {
      id: node.item.id,
      item: node.item,
      x: node.x,
      y: node.y,
      hitRadius,
      strokes,
    };
  });

  // Carved cinnabar seal in lower-right with 4-point compass star (Han-free)
  const sx = PLATE_WIDTH - INNER - 46;
  const sy = PLATE_HEIGHT - INNER - 46;
  const sealPaths = [
    ...makeRect(roughGen, sx, sy, 34, 34, {
      stroke: palette.accent,
      strokeWidth: 1.6,
      roughness: 1.2,
      disableMultiStroke: true,
      seed: garden.seed + 313,
    }).map((p) => ({ ...p, opacity: 0.88 })),
    {
      d: starPath(sx + 17, sy + 17, 4, 9.5, 3),
      stroke: palette.accent,
      strokeWidth: 1.15,
      fill: palette.accent,
      fillOpacity: 0.2,
      opacity: 0.86,
    },
  ];

  return {
    edition: 'astrolabe',
    width: PLATE_WIDTH,
    height: PLATE_HEIGHT,
    framePaths,
    ringPaths,
    meridianPaths,
    tickPaths,
    corePaths,
    dustDots,
    filamentPaths,
    nodes,
    sealPaths,
  };
}
