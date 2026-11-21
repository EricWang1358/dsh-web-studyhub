/* Pure deterministic logic for honest round-seal derivation and procedural
   traditional carved cinnabar seal SVG markup. Flow/leech predicates live in flow-logic.js
   and are re-exported here for callers and tests. */
export { computeFlowStreak, isLeechConquered } from './flow-logic.js';

/** Deterministic 32-bit FNV-1a string hash for reproducible stone carving imperfections. */
export function hashSeed(input) {
  const str = String(input ?? 'studyhub');
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

/** Fast seeded PRNG (Mulberry32) yielding numbers in [0, 1). */
export function mulberry32(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Escape arbitrary text for safe SVG XML insertion. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const SEAL_CATALOG = Object.freeze({
  'clean-sweep': Object.freeze({
    id: 'clean-sweep',
    chars: ['全', '胜'],
    titleKey: '全胜印',
    englishEmblem: 'CLEAN SWEEP',
    defaultStyle: 'yang',
  }),
  'leech-cleared': Object.freeze({
    id: 'leech-cleared',
    chars: ['破', '顽'],
    titleKey: '破顽印',
    englishEmblem: 'LEECH CLEARED',
    defaultStyle: 'yin',
  }),
  'night-study': Object.freeze({
    id: 'night-study',
    chars: ['夜', '读'],
    titleKey: '夜读印',
    englishEmblem: 'NIGHT STUDY',
    defaultStyle: 'yang',
  }),
  'steady-rise': Object.freeze({
    id: 'steady-rise',
    chars: ['精', '进'],
    titleKey: '精进印',
    englishEmblem: 'STEADY RISE',
    defaultStyle: 'yang',
  }),
  'round-done': Object.freeze({
    id: 'round-done',
    chars: ['笃', '行'],
    titleKey: '笃行印',
    englishEmblem: 'ROUND DONE',
    defaultStyle: 'yin',
  }),
  'wrongbook-cleared': Object.freeze({
    id: 'wrongbook-cleared',
    chars: ['错', '题', '清', '零'],
    titleKey: '错题清零印',
    englishEmblem: 'MISTAKES CLEARED',
    defaultStyle: 'yang',
  }),
});

/** The five classic round seals displayed on the Seal Album Gallery specimen shelf. */
export const SPECIMEN_SEALS = Object.freeze([
  Object.freeze({ id: 'clean-sweep', hintKey: '单轮满 3 题全部过关' }),
  Object.freeze({ id: 'leech-cleared', hintKey: '本轮攻克反复出错的顽固题' }),
  Object.freeze({ id: 'night-study', hintKey: '深夜或凌晨完成一轮练习' }),
  Object.freeze({ id: 'steady-rise', hintKey: '单轮正确率达到八成以上' }),
  Object.freeze({ id: 'round-done', hintKey: '稳稳完成任意一轮练习' }),
]);

/** Derive a dignified 4-character clearance seal when the WrongBook active ledger is cleared. */
export function deriveWrongBookClearSeal({ clearedCount = 0, course = '' } = {}) {
  const count = Math.max(1, Math.round(Number(clearedCount) || 0));
  const kind = SEAL_CATALOG['wrongbook-cleared'];
  const scope = String(course || '').trim();
  return {
    id: kind.id,
    chars: [...kind.chars],
    titleKey: kind.titleKey,
    englishEmblem: kind.englishEmblem,
    reasonKey: '已累计攻克并订正 {0} 道待巩固错题，错题本清零',
    reasonArgs: [count],
    defaultStyle: kind.defaultStyle,
    seed: hashSeed(`wrongbook-cleared:${scope || 'all'}:${count}`),
    stats: {
      answered: count,
      total: count,
      correct: count,
      accuracy: 100,
      allCorrect: true,
      masteryDelta: null,
      conqueredLeechCount: count,
    },
  };
}

/**
 * Derive an honest procedural traditional seal from real session facts.
 * Priority: 全胜 (allCorrect & >= 3) -> 破顽 (conquered stubborn card) -> 夜读 (late hour >=22 or <5)
 * -> 精进 (accuracy >= 80% or mastery rose) -> 笃行 (steady round completion).
 */
export function deriveRoundSeal(run, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const hour = Number.isInteger(options.hour) ? options.hour : now.getHours();
  const total = Math.max(0, Number(run?.questions ?? run?.total) || 0);
  const answered = Math.max(0, Number(run?.answered) || 0);
  const correct = Math.max(0, Math.min(total || answered, Number(run?.correct) || 0));
  const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const allCorrect = Boolean(total > 0 && answered >= total && correct === total);
  const beforePct = Number(run?.mastery?.before?.percent);
  const afterPct = Number(run?.mastery?.after?.percent);
  const masteryDelta = Number.isFinite(beforePct) && Number.isFinite(afterPct) ? Math.round(afterPct - beforePct) : null;
  const masteryRose = masteryDelta !== null && masteryDelta > 0;
  const conqueredLeechCount = Math.max(0, Number(options.conqueredLeechCount) || 0);
  const conqueredLeech = conqueredLeechCount > 0
    || Boolean(run?.leechCleared)
    || ((run?.similarWins?.length || 0) > 0 && (run?.leechCards?.length || 0) === 0);

  let kind = SEAL_CATALOG['round-done'];
  let reasonKey = '一步一步做完这一轮，进度已稳稳记下';
  let reasonArgs = [];

  if (allCorrect && total >= 3) {
    kind = SEAL_CATALOG['clean-sweep'];
    reasonKey = '本轮 {0} 题全部过关，一气呵成';
    reasonArgs = [total];
  } else if (conqueredLeech) {
    kind = SEAL_CATALOG['leech-cleared'];
    if (conqueredLeechCount > 0) {
      reasonKey = '本轮攻克了 {0} 道反复出错的顽固题';
      reasonArgs = [conqueredLeechCount];
    } else {
      reasonKey = '本轮攻克了反复出错的顽固题';
      reasonArgs = [];
    }
  } else if (answered > 0 && (hour >= 22 || hour < 5)) {
    kind = SEAL_CATALOG['night-study'];
    reasonKey = '夜深灯下完成 {0} 题，安静走完这一轮';
    reasonArgs = [answered];
  } else if (answered > 0 && (accuracy >= 80 || masteryRose)) {
    kind = SEAL_CATALOG['steady-rise'];
    if (masteryRose) {
      reasonKey = '本组掌握度提升 {0}%，手感正在变稳';
      reasonArgs = [masteryDelta];
    } else {
      reasonKey = '本轮正确率 {0}%，掌握稳步提升';
      reasonArgs = [accuracy];
    }
  } else if (answered > 0) {
    kind = SEAL_CATALOG['round-done'];
    reasonKey = '本轮完成 {0} 题，节奏已记下';
    reasonArgs = [answered];
  }

  const seed = hashSeed(`${run?.id || 'round'}:${kind.id}:${answered}:${correct}:${total}`);
  return {
    id: kind.id,
    chars: [...kind.chars],
    titleKey: kind.titleKey,
    englishEmblem: kind.englishEmblem,
    reasonKey,
    reasonArgs,
    defaultStyle: kind.defaultStyle,
    seed,
    stats: {
      answered,
      total,
      correct,
      accuracy,
      allCorrect,
      masteryDelta,
      conqueredLeechCount,
    },
  };
}

function fmt(n) {
  return Number(n).toFixed(2).replace(/\.00$/, '');
}

/** Build a subtly distressed hand-carved rectangular contour path around (x, y, w, h). */
function carvedBorderPath(x, y, w, h, rng, wobble = 0.9, cornerRadius = 6) {
  const jitter = () => (rng() - 0.5) * 2 * wobble;
  const pts = [];
  const segs = 6;
  // Top edge (left to right)
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const px = x + cornerRadius + (w - 2 * cornerRadius) * t;
    const py = y + (i === 0 || i === segs ? 0 : jitter());
    pts.push([px, py]);
  }
  // Right edge (top to bottom)
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const px = x + w + (i === 0 || i === segs ? 0 : jitter());
    const py = y + cornerRadius + (h - 2 * cornerRadius) * t;
    pts.push([px, py]);
  }
  // Bottom edge (right to left)
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const px = x + w - cornerRadius - (w - 2 * cornerRadius) * t;
    const py = y + h + (i === 0 || i === segs ? 0 : jitter());
    pts.push([px, py]);
  }
  // Left edge (bottom to top)
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const px = x + (i === 0 || i === segs ? 0 : jitter());
    const py = y + h - cornerRadius - (h - 2 * cornerRadius) * t;
    pts.push([px, py]);
  }
  if (!pts.length) return '';
  const cmds = [`M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`];
  for (let i = 1; i < pts.length; i += 1) {
    cmds.push(`L ${fmt(pts[i][0])} ${fmt(pts[i][1])}`);
  }
  cmds.push('Z');
  return cmds.join(' ');
}

/** Generate subtle stone-knife chips and cinnabar ink-paste grain dots (pure crisp vectors). */
function buildDistressElements(rng, { isYin, inkColor, chipColor }) {
  const parts = [];
  // 5 subtle stone-chipped notches along the outer frame (残边刀意)
  const edges = [
    [14 + rng() * 90, 9 + rng() * 3],
    [108 + rng() * 3, 18 + rng() * 82],
    [18 + rng() * 84, 108 + rng() * 3],
    [9 + rng() * 3, 20 + rng() * 80],
    [12 + rng() * 14, 12 + rng() * 10],
  ];
  for (const [cx, cy] of edges) {
    const rx = 1.1 + rng() * 2.1;
    const ry = 0.8 + rng() * 1.5;
    const rot = Math.round(rng() * 180);
    parts.push(
      `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}" transform="rotate(${rot} ${fmt(cx)} ${fmt(cy)})" fill="${escapeXml(chipColor)}" opacity="${fmt(isYin ? 0.72 : 0.84)}" />`,
    );
  }
  // Fine ink-paste stipple speckles for organic pressed-on-paper texture
  const speckleCount = isYin ? 16 : 10;
  for (let i = 0; i < speckleCount; i += 1) {
    const sx = 15 + rng() * 90;
    const sy = 15 + rng() * 90;
    const r = 0.55 + rng() * 1.15;
    const fill = isYin ? chipColor : inkColor;
    const op = isYin ? 0.14 + rng() * 0.16 : 0.1 + rng() * 0.14;
    parts.push(`<circle cx="${fmt(sx)}" cy="${fmt(sy)}" r="${fmt(r)}" fill="${escapeXml(fill)}" opacity="${fmt(op)}" />`);
  }
  return parts.join('');
}

/**
 * Build the inner SVG elements of a 120x120 traditional carved chop (朱砂闲章).
 * Reusable both standalone and embedded inside Ex-Libris postcards.
 */
export function buildSealInnerMarkup(seal, options = {}) {
  const style = options.style === 'yin' || options.style === 'yang'
    ? options.style
    : (seal?.defaultStyle === 'yin' ? 'yin' : 'yang');
  const isYin = style === 'yin';
  const ink = options.ink || '#c93d22';
  const paper = options.paper || '#ece4d6';
  const seed = (Number(seal?.seed) || hashSeed((seal?.chars || ['笃', '行']).join(''))) ^ (isYin ? 0x9e3779b9 : 0x517cc1b7);
  const rng = mulberry32(seed);
  const chars = Array.isArray(seal?.chars) && seal.chars.length >= 2 ? seal.chars : ['笃', '行'];
  const isQuad = chars.length >= 4;
  const firstChar = escapeXml(chars[0]);
  const secondChar = escapeXml(chars[1]);
  const thirdChar = isQuad ? escapeXml(chars[2]) : '';
  const fourthChar = isQuad ? escapeXml(chars[3]) : '';
  const outerPath = carvedBorderPath(9, 9, 102, 102, rng, 1.1, 7);
  const innerPath = carvedBorderPath(16, 16, 88, 88, rng, 0.55, 4);
  const glyphFill = isYin ? paper : ink;
  const lineColor = isYin ? paper : ink;
  const fontStack = "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', 'KaiTi', 'STKaiti', Georgia, serif";

  // Zhuanshu-inspired corner fret marks (四隅回纹角饰)
  const cornerMarks = [
    'M 21 27 L 21 21 L 27 21',
    'M 93 21 L 99 21 L 99 27',
    'M 99 93 L 99 99 L 93 99',
    'M 27 99 L 21 99 L 21 93',
  ].map((d) => `<path d="${d}" fill="none" stroke="${escapeXml(lineColor)}" stroke-width="1.3" stroke-linecap="square" opacity="${isYin ? '0.62' : '0.48'}" />`).join('');

  // Subtle central column hairline (and cross hairline for 4-character square seals)
  const dividerOpacity = isYin ? '0.46' : '0.34';
  const divider = isQuad
    ? [
      `<line x1="60" y1="22" x2="60" y2="98" stroke="${escapeXml(lineColor)}" stroke-width="1.05" stroke-dasharray="3 2.5" opacity="${dividerOpacity}" />`,
      `<line x1="22" y1="60" x2="98" y2="60" stroke="${escapeXml(lineColor)}" stroke-width="1.05" stroke-dasharray="3 2.5" opacity="${dividerOpacity}" />`,
    ].join('')
    : `<line x1="60" y1="22" x2="60" y2="98" stroke="${escapeXml(lineColor)}" stroke-width="1.15" stroke-dasharray="3 2.5" opacity="${dividerOpacity}" />`;

  const body = isYin
    ? [
      `<path d="${outerPath}" fill="${escapeXml(ink)}" />`,
      `<path d="${innerPath}" fill="none" stroke="${escapeXml(paper)}" stroke-width="1.45" opacity="0.72" />`,
      cornerMarks,
      divider,
    ].join('')
    : [
      `<path d="${outerPath}" fill="${escapeXml(paper)}" fill-opacity="0.22" stroke="${escapeXml(ink)}" stroke-width="4.8" stroke-linejoin="round" />`,
      `<path d="${innerPath}" fill="none" stroke="${escapeXml(ink)}" stroke-width="1.25" opacity="0.52" />`,
      cornerMarks,
      divider,
    ].join('');

  // Traditional seal reading order: right column top-to-bottom, then left column top-to-bottom.
  const typography = isQuad
    ? [
      `<g fill="${escapeXml(glyphFill)}" font-family="${escapeXml(fontStack)}" font-weight="700" text-anchor="middle">`,
      `<text x="79" y="51" font-size="27" transform="translate(79 42) scale(0.92 1.08) translate(-79 -42)">${firstChar}</text>`,
      `<text x="79" y="88" font-size="27" transform="translate(79 79) scale(0.92 1.08) translate(-79 -79)">${secondChar}</text>`,
      `<text x="41" y="51" font-size="27" transform="translate(41 42) scale(0.92 1.08) translate(-41 -42)">${thirdChar}</text>`,
      `<text x="41" y="88" font-size="27" transform="translate(41 79) scale(0.92 1.08) translate(-41 -79)">${fourthChar}</text>`,
      '</g>',
    ].join('')
    : [
      `<g fill="${escapeXml(glyphFill)}" font-family="${escapeXml(fontStack)}" font-weight="700" text-anchor="middle">`,
      `<text x="80" y="65" font-size="38" transform="translate(80 60) scale(0.86 1.24) translate(-80 -60)">${firstChar}</text>`,
      `<text x="40" y="65" font-size="38" transform="translate(40 60) scale(0.86 1.24) translate(-40 -60)">${secondChar}</text>`,
      '</g>',
    ].join('');

  const distress = buildDistressElements(rng, { isYin, inkColor: ink, chipColor: paper });

  return `<g data-seal-id="${escapeXml(seal?.id || 'round-done')}" data-seal-style="${style}">${body}${typography}${distress}</g>`;
}

/** Build a complete standalone carved seal SVG string (120x120 viewBox). */
export function buildSealSvg(seal, options = {}) {
  const size = Math.max(24, Math.min(360, Number(options.size) || 96));
  const inner = buildSealInnerMarkup(seal, options);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}" aria-hidden="true">${inner}</svg>`;
}

/** Encode an SVG string as a CSP-safe data: URI (compatible with `img-src 'self' data:`). */
export function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(svg || ''))}`;
}
