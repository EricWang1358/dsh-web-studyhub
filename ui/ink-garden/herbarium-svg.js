import { clamp, createSeededRandom, round1 } from './seed-prng.js';

/* Edition I: 墨梅标本志 (Ink Herbarium)
   MIT Lineage: antfu/100 ArtPlum recursive organic branching + roughjs sketchy
   ink strokes & hachure blossoms. Each deck is deterministically seeded by its
   id and mapped to a living botanical state (never wilting or shaming). */

export const PLATE_WIDTH = 960;
export const PLATE_HEIGHT = 440;

const MARGIN = 22;
const INNER = 30;

/** Subtle archival numeral colophon (`YYYY.MM · NN%`) shared across all 3 editions (Han-free). */
export function formatColophonText(garden) {
  const today = String(garden?.today || '');
  const ym = /^\d{4}-\d{2}/.test(today) ? today.slice(0, 7).replace('-', '.') : '';
  if ((garden?.totals?.deckCount || 0) > 0) {
    const pct = `${clamp(Math.round(Number(garden.totals.overallMastery) || 0), 0, 100)}%`;
    return ym ? `${ym} · ${pct}` : pct;
  }
  return ym;
}

function toPathList(roughGen, drawable, fallback) {
  if (!roughGen || !drawable) return fallback;
  const paths = roughGen.toPaths(drawable);
  return paths.map((p) => ({
    d: p.d,
    stroke: p.stroke || 'none',
    strokeWidth: p.strokeWidth ?? 1,
    fill: p.fill || 'none',
  }));
}

function makeLine(roughGen, x1, y1, x2, y2, opts) {
  const rx1 = round1(x1), ry1 = round1(y1), rx2 = round1(x2), ry2 = round1(y2);
  const fallback = [{
    d: `M${rx1} ${ry1} L${rx2} ${ry2}`,
    stroke: opts.stroke,
    strokeWidth: opts.strokeWidth ?? 1,
    fill: 'none',
  }];
  if (!roughGen) return fallback;
  return toPathList(
    roughGen,
    roughGen.line(rx1, ry1, rx2, ry2, { fixedDecimalPlaceDigits: 1, ...opts }),
    fallback,
  );
}

function makeCurve(roughGen, points, opts) {
  const pts = points.map(([x, y]) => [round1(x), round1(y)]);
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += ` L${pts[i][0]} ${pts[i][1]}`;
  const fallback = [{ d, stroke: opts.stroke, strokeWidth: opts.strokeWidth ?? 1, fill: 'none' }];
  if (!roughGen) return fallback;
  return toPathList(
    roughGen,
    roughGen.curve(pts, { fixedDecimalPlaceDigits: 1, ...opts }),
    fallback,
  );
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
  return toPathList(
    roughGen,
    roughGen.circle(rcx, rcy, rd, { fixedDecimalPlaceDigits: 1, ...opts }),
    fallback,
  );
}

function makePolygon(roughGen, points, opts) {
  const pts = points.map(([x, y]) => [round1(x), round1(y)]);
  const d = `M${pts.map(([x, y]) => `${x} ${y}`).join(' L')} Z`;
  const fallback = [{
    d,
    stroke: opts.stroke || 'none',
    strokeWidth: opts.strokeWidth ?? 1,
    fill: opts.fill || 'none',
  }];
  if (!roughGen) return fallback;
  return toPathList(
    roughGen,
    roughGen.polygon(pts, { fixedDecimalPlaceDigits: 1, ...opts }),
    fallback,
  );
}

function makeRect(roughGen, x, y, w, h, opts) {
  const rx = round1(x), ry = round1(y), rw = round1(w), rh = round1(h);
  const fallback = [{
    d: `M${rx} ${ry} H${round1(rx + rw)} V${round1(ry + rh)} H${rx} Z`,
    stroke: opts.stroke || 'none',
    strokeWidth: opts.strokeWidth ?? 1,
    fill: opts.fill || 'none',
  }];
  if (!roughGen) return fallback;
  return toPathList(
    roughGen,
    roughGen.rectangle(rx, ry, rw, rh, { fixedDecimalPlaceDigits: 1, ...opts }),
    fallback,
  );
}

function polar2cart(x, y, r, theta) {
  return [x + r * Math.cos(theta), y + r * Math.sin(theta)];
}

/** Build almond-shaped botanical leaf polygon centered along `angle` starting at (x, y). */
function leafPolygon(x, y, length, width, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const px = -sin, py = cos;
  const pts = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bulge = Math.sin(t * Math.PI) * width;
    pts.push([x + cos * length * t + px * bulge, y + sin * length * t + py * bulge]);
  }
  for (let i = steps - 1; i >= 1; i--) {
    const t = i / steps;
    const bulge = -Math.sin(t * Math.PI) * width;
    pts.push([x + cos * length * t + px * bulge, y + sin * length * t + py * bulge]);
  }
  return pts;
}

/** ArtPlum-inspired recursive organic plum bough generator. */
function growPlumBoughs(garden, palette, roughGen) {
  const rng = createSeededRandom(garden.seed ^ 0x51a7);
  const branchPaths = [];
  const anchors = [];
  const sparse = !garden.isEmpty && garden.items.length <= 3;
  // Give 1–3 deck libraries a sweeping golden-ratio primary bough (maxDepth = 5) so the scroll breathes gracefully.
  const maxDepth = garden.isEmpty
    ? 3
    : sparse
      ? 5
      : clamp(4 + Math.floor(Math.log2(garden.items.length + 2)), 4, 6);
  const branchCap = garden.isEmpty ? 28 : sparse ? 96 : 112;
  let count = 0;

  const insideSafe = (x, y) => x >= 76 && x <= PLATE_WIDTH - 96 && y >= 62 && y <= PLATE_HEIGHT - 66;

  function step(x, y, rad, depth, length, weight) {
    if (depth <= 0 || count >= branchCap) return;
    count++;
    const segLen = length * rng.range(0.86, 1.12);
    const midAngle = rad + rng.range(-0.13, 0.13);
    const [mx, my] = polar2cart(x, y, segLen * 0.52, midAngle);
    const [nx, ny] = polar2cart(x, y, segLen, rad);

    const strokeOpacity = depth >= 4 ? 0.88 : depth >= 2 ? 0.72 : 0.56;
    const paths = makeCurve(roughGen, [[x, y], [mx, my], [nx, ny]], {
      stroke: palette.inkDim,
      strokeWidth: round1(weight),
      roughness: depth >= 4 ? 1.25 : 0.95,
      bowing: 1.35,
      seed: rng.int(1, 99999),
      disableMultiStroke: depth <= 1,
    });
    for (const p of paths) {
      branchPaths.push({ ...p, opacity: strokeOpacity });
    }

    if (insideSafe(nx, ny)) {
      anchors.push({
        x: round1(nx),
        y: round1(ny),
        angle: rad,
        depth,
        priority: (depth <= 2 ? 2 : 1) + (ny < PLATE_HEIGHT - 96 ? 0.45 : 0) + (nx > 180 && nx < 760 ? 0.35 : 0),
      });
    }

    if (nx < 44 || nx > PLATE_WIDTH - 44 || ny < 40 || ny > PLATE_HEIGHT - 36) return;

    const nextLen = segLen * rng.range(0.77, 0.89);
    const nextWeight = Math.max(0.85, weight * 0.75);

    // Primary continuation gently sweeps across the golden section
    const drift = rng.range(-0.18, 0.18);
    step(nx, ny, rad + drift, depth - 1, nextLen, nextWeight);

    // ArtPlum fork with organic asymmetry
    const forkChance = depth >= maxDepth - 1 ? 0.94 : garden.isEmpty ? 0.45 : sparse ? 0.74 : 0.68;
    if (rng.chance(forkChance)) {
      const side = rng.chance(0.5) ? 1 : -1;
      const spread = rng.range(0.28, 0.56) * side;
      step(nx, ny, rad + spread, depth - 1, nextLen * rng.range(0.75, 0.96), nextWeight * 0.88);
    }
    if (!garden.isEmpty && depth >= 3 && rng.chance(sparse ? 0.38 : 0.32)) {
      const counter = rng.range(-0.6, -0.3);
      step(nx, ny, rad + counter, depth - 2, nextLen * 0.74, nextWeight * 0.8);
    }
  }

  // Primary sweeping plum bough across the golden-ratio diagonal
  step(46, 384, sparse ? -0.36 : -0.44, maxDepth, sparse ? 124 : 108, sparse ? 4.2 : 3.8);

  // Balanced counter-bough sweeping softly from upper-right
  if (!garden.isEmpty) {
    step(914, 114, Math.PI - (sparse ? 0.28 : 0.34), sparse ? 4 : Math.max(3, maxDepth - 1), sparse ? 96 : 88, sparse ? 3.0 : 2.8);
    if (sparse || garden.items.length >= 6) {
      step(248, 404, -1.04, sparse ? 3 : Math.max(3, maxDepth - 1), sparse ? 82 : 76, 2.5);
    }
  } else {
    // Calm companion twig in empty state
    step(896, 134, Math.PI - 0.22, 2, 74, 2.1);
  }

  return { branchPaths, anchors };
}

/** Pick well-spaced non-overlapping anchors on the plum boughs for each deck. */
function placeDeckSpecimens(items, anchors, gardenSeed) {
  if (!items.length) return [];
  const rng = createSeededRandom(gardenSeed ^ 0x2b3c);
  const visible = items.slice(0, 28);
  const candidates = [...anchors].sort((a, b) => b.priority - a.priority);
  const chosen = [];
  const minDist = visible.length > 16 ? 44 : 56;

  for (const item of visible) {
    const itemRng = createSeededRandom(item.seed);
    let pick = null;
    for (let pass = 0; pass < 2 && !pick; pass++) {
      const thresh = pass === 0 ? minDist : minDist * 0.65;
      const startIdx = candidates.length ? itemRng.int(0, Math.min(candidates.length - 1, 8)) : 0;
      for (let k = 0; k < candidates.length; k++) {
        const c = candidates[(startIdx + k) % candidates.length];
        const ok = chosen.every((u) => Math.hypot(u.x - c.x, u.y - c.y) >= thresh);
        if (ok) {
          pick = c;
          break;
        }
      }
    }
    if (!pick) {
      const idx = chosen.length;
      const col = idx % 6;
      const row = Math.floor(idx / 6);
      pick = {
        x: round1(138 + col * 134 + rng.range(-18, 18)),
        y: round1(118 + row * 78 + rng.range(-14, 14)),
        angle: rng.range(-0.9, -0.2),
        depth: 1,
      };
    }
    chosen.push({
      item,
      x: pick.x,
      y: pick.y,
      angle: pick.angle,
    });
  }
  return chosen;
}

/** Render one deck's botanical specimen (blossom, leaves, berry bud, or winter bud). */
function renderDeckSpecimen(placement, palette, roughGen) {
  const { item, x, y, angle } = placement;
  const rng = createSeededRandom(item.seed);
  const strokes = [];
  const sizeBoost = clamp(Math.log2((item.total || 4) + 2) / 5, 0.72, 1.32);

  if (item.stage === 'mastered') {
    const petalR = round1((9.5 + (item.mastery / 100) * 4.5) * sizeBoost);
    const orbit = round1(petalR * 0.72);
    const highMastery = item.mastery >= 92;
    const petalColor = highMastery ? palette.accent : palette.ok;
    const coreColor = highMastery ? palette.ok : palette.accent;
    const baseRot = rng.range(0, Math.PI * 2);

    for (const side of [-0.7, 0.75]) {
      const leafPts = leafPolygon(x, y, petalR * 1.9, petalR * 0.45, angle + Math.PI + side);
      const leafPaths = makePolygon(roughGen, leafPts, {
        stroke: palette.ok,
        strokeWidth: 0.9,
        fill: palette.ok,
        fillStyle: 'hachure',
        hachureAngle: round1(((angle + side) * 180) / Math.PI + 30),
        hachureGap: 3.4,
        roughness: 1.0,
        seed: rng.int(1, 99999),
      });
      for (const p of leafPaths) strokes.push({ ...p, opacity: 0.58 });
    }

    for (let i = 0; i < 5; i++) {
      const theta = baseRot + (i * Math.PI * 2) / 5;
      const px = x + Math.cos(theta) * orbit;
      const py = y + Math.sin(theta) * orbit;
      const petalPaths = makeCircle(roughGen, px, py, petalR * 1.24, {
        stroke: petalColor,
        strokeWidth: 1.05,
        fill: petalColor,
        fillStyle: 'hachure',
        fillWeight: 0.85,
        hachureAngle: round1(35 + i * 28),
        hachureGap: 3.2,
        roughness: 1.05,
        seed: rng.int(1, 99999),
      });
      for (const p of petalPaths) strokes.push({ ...p, opacity: 0.86 });
    }

    const corePaths = makeCircle(roughGen, x, y, petalR * 0.72, {
      stroke: coreColor,
      strokeWidth: 1.1,
      fill: coreColor,
      fillStyle: 'solid',
      roughness: 0.9,
      seed: rng.int(1, 99999),
    });
    for (const p of corePaths) strokes.push({ ...p, opacity: 0.92 });

    for (let s = 0; s < 5; s++) {
      const st = baseRot + 0.31 + (s * Math.PI * 2) / 5;
      const [sx, sy] = polar2cart(x, y, petalR * 0.95, st);
      strokes.push({
        d: `M${round1(x)} ${round1(y)} L${round1(sx)} ${round1(sy)}`,
        stroke: palette.ink,
        strokeWidth: 0.8,
        fill: 'none',
        opacity: 0.75,
      });
    }
    return { strokes, hitRadius: Math.max(20, Math.round(petalR * 1.8)) };
  }

  if (item.stage === 'learning') {
    const len = round1((18 + (item.mastery / 100) * 10) * sizeBoost);
    const width = round1(len * 0.36);
    const leafAngles = [angle - 0.55, angle + 0.55];
    for (const la of leafAngles) {
      const pts = leafPolygon(x, y, len, width, la);
      const leafPaths = makePolygon(roughGen, pts, {
        stroke: palette.warn,
        strokeWidth: 1.15,
        fill: palette.warn,
        fillStyle: 'hachure',
        hachureAngle: round1((la * 180) / Math.PI + 50),
        hachureGap: 3.3,
        roughness: 1.15,
        seed: rng.int(1, 99999),
      });
      for (const p of leafPaths) strokes.push({ ...p, opacity: 0.85 });
      const [vx, vy] = polar2cart(x, y, len * 0.82, la);
      strokes.push({
        d: `M${round1(x)} ${round1(y)} L${round1(vx)} ${round1(vy)}`,
        stroke: palette.inkDim,
        strokeWidth: 0.8,
        fill: 'none',
        opacity: 0.65,
      });
    }
    const budPaths = makeCircle(roughGen, x, y, 10 * sizeBoost, {
      stroke: palette.warn,
      strokeWidth: 1.1,
      fill: palette.warn,
      fillStyle: 'solid',
      roughness: 0.9,
      seed: rng.int(1, 99999),
    });
    for (const p of budPaths) strokes.push({ ...p, opacity: 0.9 });
    return { strokes, hitRadius: 20 };
  }

  if (item.stage === 'weak') {
    const diam = round1(14 * sizeBoost);
    const haloPaths = makeCircle(roughGen, x, y, diam * 1.65, {
      stroke: palette.bad,
      strokeWidth: 0.9,
      strokeLineDash: [3, 3],
      roughness: 0.95,
      disableMultiStroke: true,
      seed: rng.int(1, 99999),
    });
    for (const p of haloPaths) strokes.push({ ...p, opacity: 0.58 });

    const budPaths = makeCircle(roughGen, x, y, diam, {
      stroke: palette.bad,
      strokeWidth: 1.2,
      fill: palette.bad,
      fillStyle: 'hachure',
      hachureAngle: 45,
      hachureGap: 3,
      roughness: 1.1,
      seed: rng.int(1, 99999),
    });
    for (const p of budPaths) strokes.push({ ...p, opacity: 0.88 });

    for (const off of [-0.55, 0.55]) {
      const [cx2, cy2] = polar2cart(x, y, diam * 0.72, angle + Math.PI + off);
      strokes.push({
        d: `M${round1(x)} ${round1(y)} L${round1(cx2)} ${round1(cy2)}`,
        stroke: palette.inkDim,
        strokeWidth: 1,
        fill: 'none',
        opacity: 0.7,
      });
    }
    return { strokes, hitRadius: 20 };
  }

  // 'fresh' — quiet graphite winter bud awaiting its first study session
  const budDiam = round1(10.5 * sizeBoost);
  const budPaths = makeCircle(roughGen, x, y, budDiam, {
    stroke: palette.inkMuted,
    strokeWidth: 1.05,
    fill: palette.decorFaint,
    fillStyle: 'hachure',
    hachureGap: 3.4,
    roughness: 1.0,
    seed: rng.int(1, 99999),
  });
  for (const p of budPaths) strokes.push({ ...p, opacity: 0.78 });
  const [tipX, tipY] = polar2cart(x, y, budDiam * 0.85, angle);
  strokes.push({
    d: `M${round1(x)} ${round1(y)} L${round1(tipX)} ${round1(tipY)}`,
    stroke: palette.inkMuted,
    strokeWidth: 0.9,
    fill: 'none',
    opacity: 0.65,
  });
  return { strokes, hitRadius: 18 };
}

/**
 * Sprout non-interactive companion plum blossoms, jade/ochre buds, and drifting petals
 * derived strictly from real study progress signals (totals.mastered, familiar+learning,
 * activeDays) so 1–3 deck libraries look like a lush living scroll without faking decks.
 */
function buildCompanionFlora(garden, anchors, placements, palette, roughGen) {
  if (garden.isEmpty || !anchors.length) return [];
  const rng = createSeededRandom(garden.seed ^ 0x6f2d);
  const strokes = [];
  const sparse = garden.items.length <= 3;

  const masteredCards = Math.max(
    garden.totals.mastered || 0,
    garden.items.reduce((sum, d) => sum + (d.counts?.mastered || 0), 0),
  );
  const progressCards = garden.items.reduce(
    (sum, d) => sum + (d.counts?.familiar || 0) + (d.counts?.learning || 0),
    0,
  );
  const activeDays = garden.totals.activeDays || 0;
  const overallMastery = garden.totals.overallMastery || 0;

  const blossomBudget = sparse
    ? clamp(
      Math.floor(masteredCards / 3) + Math.floor(overallMastery / 20) + (activeDays >= 4 ? 1 : 0),
      overallMastery > 0 || masteredCards > 0 ? 2 : 0,
      7,
    )
    : 0;
  const budBudget = sparse
    ? clamp(
      Math.floor(progressCards / 3) + Math.floor(activeDays / 4) + (garden.totals.attempts > 0 ? 1 : 0),
      garden.totals.attempts > 0 ? 2 : 1,
      6,
    )
    : 0;
  const petalBudget = sparse
    ? clamp(Math.floor((activeDays + masteredCards) / 4) + (overallMastery >= 40 ? 2 : 0), 2, 8)
    : (masteredCards > 0 || activeDays >= 3 ? 4 : 0);

  // Pick free branch anchors staying cleanly clear of interactive deck specimen nodes
  const occupied = placements.map((p) => ({ x: p.x, y: p.y }));
  const pickAnchor = (minDist) => {
    for (let tries = 0; tries < anchors.length; tries++) {
      const a = anchors[(rng.int(0, anchors.length - 1) + tries) % anchors.length];
      if (occupied.every((u) => Math.hypot(u.x - a.x, u.y - a.y) >= minDist)) {
        occupied.push({ x: a.x, y: a.y });
        return a;
      }
    }
    return null;
  };

  // Delicate companion plum blossoms (reflecting mastered cards / high mastery progress)
  for (let b = 0; b < blossomBudget; b++) {
    const a = pickAnchor(44);
    if (!a) break;
    const petalR = round1(rng.range(6.4, 8.6));
    const orbit = round1(petalR * 0.72);
    const useCinnabar = b % 3 === 0 && overallMastery >= 55;
    const petalColor = useCinnabar ? palette.accent : palette.ok;
    const coreColor = useCinnabar ? palette.ok : palette.accent;
    const rot = rng.range(0, Math.PI * 2);

    for (let i = 0; i < 5; i++) {
      const theta = rot + (i * Math.PI * 2) / 5;
      const px = a.x + Math.cos(theta) * orbit;
      const py = a.y + Math.sin(theta) * orbit;
      for (const p of makeCircle(roughGen, px, py, petalR * 1.18, {
        stroke: petalColor,
        strokeWidth: 0.9,
        fill: petalColor,
        fillStyle: 'hachure',
        fillWeight: 0.7,
        hachureAngle: round1(30 + i * 32),
        hachureGap: 3.8,
        roughness: 1.0,
        disableMultiStroke: true,
        seed: rng.int(1, 99999),
      })) {
        strokes.push({ ...p, opacity: 0.66 });
      }
    }
    for (const p of makeCircle(roughGen, a.x, a.y, petalR * 0.56, {
      stroke: coreColor,
      strokeWidth: 0.9,
      fill: coreColor,
      fillStyle: 'solid',
      roughness: 0.75,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.76 });
    }
  }

  // Companion jade buds & ochre young leaves (reflecting familiar/learning & active days)
  for (let l = 0; l < budBudget; l++) {
    const a = pickAnchor(36);
    if (!a) break;
    const isJade = l % 2 === 0;
    const color = isJade ? palette.ok : palette.warn;
    const len = round1(rng.range(13, 19));
    const pts = leafPolygon(a.x, a.y, len, len * 0.34, a.angle + rng.range(-0.6, 0.6));
    for (const p of makePolygon(roughGen, pts, {
      stroke: color,
      strokeWidth: 0.9,
      fill: color,
      fillStyle: 'hachure',
      hachureGap: 3.8,
      roughness: 1.0,
      disableMultiStroke: true,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.56 });
    }
    for (const p of makeCircle(roughGen, a.x, a.y, 6.2, {
      stroke: color,
      strokeWidth: 0.85,
      fill: color,
      fillStyle: 'solid',
      roughness: 0.8,
      seed: rng.int(1, 99999),
    })) {
      strokes.push({ ...p, opacity: 0.68 });
    }
  }

  // Delicate drifting plum petals floating gently across open breathing space
  for (let d = 0; d < petalBudget; d++) {
    const px = round1(rng.range(160, PLATE_WIDTH - 130));
    const py = round1(rng.range(92, PLATE_HEIGHT - 88));
    const ang = rng.range(-0.9, 0.9);
    const len = round1(rng.range(7.5, 11));
    const color = d % 2 === 0 ? palette.accent : palette.ok;
    const pts = leafPolygon(px, py, len, len * 0.42, ang);
    const pathD = `M${pts.map(([x, y]) => `${round1(x)} ${round1(y)}`).join(' L')} Z`;
    strokes.push({
      d: pathD,
      stroke: color,
      strokeWidth: 0.75,
      fill: color,
      fillOpacity: 0.24,
      opacity: 0.52,
    });
  }

  return strokes;
}

/** Build the collector's frame, subtle botanical guides, and carved red plum seal. */
function buildFrameAndSeal(palette, roughGen, seed) {
  const framePaths = [
    ...makeRect(roughGen, MARGIN, MARGIN, PLATE_WIDTH - MARGIN * 2, PLATE_HEIGHT - MARGIN * 2, {
      stroke: palette.lineStrong,
      strokeWidth: 1.2,
      roughness: 0.9,
      disableMultiStroke: true,
      seed: seed + 11,
    }).map((p) => ({ ...p, opacity: 0.75 })),
    ...makeRect(roughGen, INNER, INNER, PLATE_WIDTH - INNER * 2, PLATE_HEIGHT - INNER * 2, {
      stroke: palette.line,
      strokeWidth: 0.75,
      roughness: 0.65,
      disableMultiStroke: true,
      seed: seed + 17,
    }).map((p) => ({ ...p, opacity: 0.55 })),
  ];

  // Quiet botanical collector ruling lines & scale bar
  const guidePaths = [
    ...[132, 240, 348].map((gy) => ({
      d: `M${INNER + 14} ${gy} H${PLATE_WIDTH - INNER - 14}`,
      stroke: palette.lineSoft,
      strokeWidth: 0.75,
      fill: 'none',
      opacity: 0.45,
    })),
    ...makeLine(roughGen, INNER + 14, PLATE_HEIGHT - INNER - 20, INNER + 74, PLATE_HEIGHT - INNER - 20, {
      stroke: palette.decorFaint,
      strokeWidth: 1,
      roughness: 0.7,
      disableMultiStroke: true,
      seed: seed + 23,
    }).map((p) => ({ ...p, opacity: 0.65 })),
  ];

  // Carved cinnabar square seal in bottom-right corner with geometric 5-dot plum crest (Han-free)
  const sx = PLATE_WIDTH - INNER - 46;
  const sy = PLATE_HEIGHT - INNER - 46;
  const sealPaths = [
    ...makeRect(roughGen, sx, sy, 34, 34, {
      stroke: palette.accent,
      strokeWidth: 1.6,
      roughness: 1.2,
      disableMultiStroke: true,
      seed: seed + 29,
    }).map((p) => ({ ...p, opacity: 0.88 })),
    ...makeRect(roughGen, sx + 3.5, sy + 3.5, 27, 27, {
      stroke: palette.accent,
      strokeWidth: 0.7,
      roughness: 0.8,
      disableMultiStroke: true,
      seed: seed + 31,
    }).map((p) => ({ ...p, opacity: 0.55 })),
  ];
  const scx = sx + 17, scy = sy + 17;
  const sealPetals = Array.from({ length: 5 }, (_, i) => {
    const t = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    return { cx: round1(scx + Math.cos(t) * 6.5), cy: round1(scy + Math.sin(t) * 6.5), r: 2.3 };
  });

  return { framePaths, guidePaths, sealPaths, sealPetals, sealCenter: { x: scx, y: scy } };
}

/**
 * Generate the complete Ink Herbarium print scene.
 * Pure & deterministic: identical inputs produce identical geometry.
 */
export function buildHerbariumScene(garden, palette, roughGen = null) {
  const { framePaths, guidePaths, sealPaths, sealPetals, sealCenter } = buildFrameAndSeal(palette, roughGen, garden.seed);
  const { branchPaths, anchors } = growPlumBoughs(garden, palette, roughGen);
  const placements = placeDeckSpecimens(garden.items, anchors, garden.seed);
  const companionStrokes = buildCompanionFlora(garden, anchors, placements, palette, roughGen);

  const nodes = placements.map((placement) => {
    const { strokes, hitRadius } = renderDeckSpecimen(placement, palette, roughGen);
    return {
      id: placement.item.id,
      item: placement.item,
      x: placement.x,
      y: placement.y,
      hitRadius,
      strokes,
    };
  });

  // In empty state, place 3 quiet winter buds on the serene ink branch
  const emptyBuds = [];
  if (garden.isEmpty && anchors.length) {
    const stride = Math.max(1, Math.floor(anchors.length / 3));
    for (let i = 0; i < 3; i++) {
      const a = anchors[Math.min(anchors.length - 1, i * stride + 1)];
      if (!a) continue;
      const bud = makeCircle(roughGen, a.x, a.y, 9, {
        stroke: palette.inkMuted,
        strokeWidth: 1,
        fill: palette.decorFaint,
        fillStyle: 'hachure',
        hachureGap: 3.4,
        roughness: 1.0,
        seed: garden.seed + i * 37,
      });
      for (const p of bud) emptyBuds.push({ ...p, opacity: 0.72 });
    }
  }

  return {
    edition: 'herbarium',
    width: PLATE_WIDTH,
    height: PLATE_HEIGHT,
    framePaths,
    guidePaths,
    branchPaths,
    companionStrokes,
    emptyBuds,
    nodes,
    sealPaths,
    sealPetals,
    sealCenter,
    colophon: formatColophonText(garden),
  };
}
