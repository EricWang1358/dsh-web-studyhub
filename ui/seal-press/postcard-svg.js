/* Three fine-print collectible SVG postcard editions + offline SVG / 2x PNG export:
   1. letterpress   — 活字藏书票 (Letterpress Ex-Libris, 680x440)
   2. risograph     — 孔版撞色卡 (Risograph Print, 680x440)
   3. archival-slip — 宣纸书签   (Archival Slip, 420x620)
   All artwork derives purely from real session facts and live StudyHub theme tokens. */
import { buildSealInnerMarkup, escapeXml, hashSeed, mulberry32, svgToDataUri } from './seal-generator.js';
import { resolveThemePalette } from './palette.js';

export { svgToDataUri };

export const POSTCARD_EDITIONS = Object.freeze([
  { id: 'letterpress', labelKey: '活字藏书票', width: 680, height: 440 },
  { id: 'risograph', labelKey: '孔版撞色卡', width: 680, height: 440 },
  { id: 'archival-slip', labelKey: '宣纸书签', width: 420, height: 620 },
]);

const SERIF_FONT = "'Source Serif 4', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif";
const SANS_FONT = "'StudyHub Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const MONO_FONT = "ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, monospace";

const two = (n) => (n < 10 ? `0${n}` : String(n));

/** Format a Date or ISO timestamp as YYYY.MM.DD. */
export function formatPostcardDate(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())}`;
}

function unitWidth(text) {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 255 ? 2 : 1;
  return units;
}

/** Measure visual width units (CJK = 2, ASCII = 1) and wrap cleanly on word boundaries up to `maxLines`. */
function wrapText(text, maxUnits = 26, maxLines = 2) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Tokenize into spaces, ASCII words, or individual non-ASCII (CJK) characters.
  const tokens = clean.match(/\s+|[A-Za-z0-9_./:&<>+-]+|./gu) || [];
  const lines = [];
  let current = '';
  let units = 0;

  const pushEllipsis = () => {
    let trimmed = current.trimEnd();
    while (trimmed.length > 1 && unitWidth(trimmed) + 2 > maxUnits) {
      trimmed = trimmed.slice(0, -1).trimEnd();
    }
    current = `${trimmed}…`;
  };

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (!current) continue;
      if (units + 1 <= maxUnits) {
        current += ' ';
        units += 1;
      }
      continue;
    }
    const w = unitWidth(token);
    if (current && units + w > maxUnits) {
      if (lines.length + 1 >= maxLines) {
        pushEllipsis();
        break;
      }
      lines.push(current.trim());
      current = token;
      units = w;
    } else if (!current && w > maxUnits) {
      let chunk = '';
      let chunkW = 0;
      for (const ch of token) {
        const cw = ch.charCodeAt(0) > 255 ? 2 : 1;
        if (chunkW + cw > maxUnits - 2) {
          chunk += '…';
          break;
        }
        chunk += ch;
        chunkW += cw;
      }
      current = chunk;
      units = unitWidth(current);
      if (lines.length + 1 >= maxLines) break;
      lines.push(current.trim());
      current = '';
      units = 0;
    } else {
      current += token;
      units += w;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.slice(0, maxLines);
}

function paperGrain(width, height, seed, inkColor) {
  const rng = mulberry32(seed ^ 0x4f1bbcdc);
  const specks = [];
  for (let i = 0; i < 42; i += 1) {
    const x = Math.round(rng() * width);
    const y = Math.round(rng() * height);
    const r = (0.45 + rng() * 0.9).toFixed(2);
    const op = (0.03 + rng() * 0.045).toFixed(3);
    specks.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${escapeXml(inkColor)}" opacity="${op}" />`);
  }
  return specks.join('');
}

function resolveColors(palette) {
  const p = palette || resolveThemePalette();
  return {
    paper: p.paper || '#ece4d6',
    ink: p.paperInk || '#201b15',
    dim: p.paperDim || '#5d5448',
    rule: p.paperRule || '#cfc5b4',
    accent: p.accent || '#c93d22',
    ok: p.ok || '#5fb58a',
    warn: p.warn || '#d9a441',
    info: p.info || '#86a9c6',
  };
}

/** Semantic ink color for postcard accuracy figures: green >= 80%, warm ochre 50-79%, calm neutral ink < 50%. */
export function accuracyInkColor(accuracy, colors = {}) {
  const pct = Number(accuracy);
  if (Number.isFinite(pct) && pct >= 80) return colors.ok || '#5fb58a';
  if (Number.isFinite(pct) && pct >= 50) return colors.warn || '#d9a441';
  return colors.dim || '#5d5448';
}

function buildLetterpressSvg(entry, colors, labels) {
  const W = 680;
  const H = 440;
  const seed = Number(entry.seed) || hashSeed(entry.title || 'letterpress');
  const titleLines = wrapText(entry.title || 'StudyHub', 26, 2);
  const noteLines = entry.note ? wrapText(entry.note, 38, 2) : [];
  const sealMarkup = buildSealInnerMarkup(
    { id: entry.sealId, chars: entry.sealChars, seed, defaultStyle: entry.sealStyle },
    { style: entry.sealStyle, ink: colors.accent, paper: colors.paper },
  );
  const scoreMain = `${entry.correct} / ${entry.answered || entry.total}`;
  const accuracyColor = accuracyInkColor(entry.accuracy, colors);
  const serial = `NO.${String(seed % 10000).padStart(4, '0')}`;
  const masteryTag = Number.isFinite(entry.masteryDelta) && entry.masteryDelta !== 0
    ? `${entry.masteryDelta > 0 ? '+' : ''}${entry.masteryDelta}%`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(labels.ariaLabel)}">`,
    `<rect width="${W}" height="${H}" rx="12" fill="${escapeXml(colors.paper)}" />`,
    paperGrain(W, H, seed, colors.ink),
    // Double letterpress typographical border with corner registration squares
    `<rect x="18" y="18" width="${W - 36}" height="${H - 36}" rx="6" fill="none" stroke="${escapeXml(colors.ink)}" stroke-width="1.4" opacity="0.72" />`,
    `<rect x="25" y="25" width="${W - 50}" height="${H - 50}" rx="3" fill="none" stroke="${escapeXml(colors.ink)}" stroke-width="0.65" opacity="0.34" />`,
    // Corner printer florets
    `<rect x="15" y="15" width="7" height="7" fill="${escapeXml(colors.accent)}" opacity="0.82" />`,
    `<rect x="${W - 22}" y="15" width="7" height="7" fill="${escapeXml(colors.accent)}" opacity="0.82" />`,
    `<rect x="15" y="${H - 22}" width="7" height="7" fill="${escapeXml(colors.accent)}" opacity="0.82" />`,
    `<rect x="${W - 22}" y="${H - 22}" width="7" height="7" fill="${escapeXml(colors.accent)}" opacity="0.82" />`,
    // Top colophon header
    `<text x="46" y="56" font-family="${escapeXml(MONO_FONT)}" font-size="11" letter-spacing="2.4" fill="${escapeXml(colors.accent)}" font-weight="600">EX LIBRIS · STUDYHUB</text>`,
    `<text x="${W - 46}" y="56" font-family="${escapeXml(MONO_FONT)}" font-size="11" letter-spacing="1.4" fill="${escapeXml(colors.dim)}" text-anchor="end">${escapeXml(entry.dateLabel || formatPostcardDate())} · ${serial}</text>`,
    `<line x1="46" y1="68" x2="${W - 46}" y2="68" stroke="${escapeXml(colors.ink)}" stroke-width="0.8" opacity="0.22" />`,
    // Course eyebrow
    entry.course
      ? `<text x="46" y="98" font-family="${escapeXml(SANS_FONT)}" font-size="12" letter-spacing="1.2" fill="${escapeXml(colors.dim)}">${escapeXml(entry.course)}</text>`
      : '',
    // Main title
    ...titleLines.map((line, i) => (
      `<text x="46" y="${(entry.course ? 132 : 122) + i * 36}" font-family="${escapeXml(SERIF_FONT)}" font-size="27" font-weight="700" fill="${escapeXml(colors.ink)}">${escapeXml(line)}</text>`
    )),
    // Fine engraved woodcut book-ornament rule
    `<g transform="translate(46 198)" stroke="${escapeXml(colors.accent)}" fill="none" stroke-width="1.15" opacity="0.65">`,
    '<line x1="0" y1="6" x2="112" y2="6" />',
    '<path d="M 122 10 Q 130 2 138 6 Q 146 2 154 10" />',
    '<circle cx="138" cy="3" r="1.4" fill="currentColor" stroke="none" />',
    '<line x1="164" y1="6" x2="276" y2="6" />',
    '</g>',
    // Optional learner 1-line reflection note
    noteLines.length
      ? [
        `<rect x="46" y="220" width="2.5" height="${noteLines.length * 22 + 6}" fill="${escapeXml(colors.accent)}" opacity="0.55" />`,
        ...noteLines.map((line, i) => (
          `<text x="60" y="${238 + i * 22}" font-family="${escapeXml(SERIF_FONT)}" font-size="14.5" fill="${escapeXml(colors.dim)}">${escapeXml(line)}</text>`
        )),
      ].join('')
      : `<text x="46" y="242" font-family="${escapeXml(SERIF_FONT)}" font-size="14" fill="${escapeXml(colors.dim)}" opacity="0.82">${escapeXml(labels.sealTitle)} · ${escapeXml(labels.sealReason)}</text>`,
    // Bottom horizontal ledger rule
    `<line x1="46" y1="298" x2="${W - 46}" y2="298" stroke="${escapeXml(colors.ink)}" stroke-width="0.8" opacity="0.2" />`,
    // Monumental tabular score & accuracy ledger
    `<text x="46" y="346" font-family="${escapeXml(SERIF_FONT)}" font-size="38" font-weight="700" fill="${escapeXml(colors.ink)}" letter-spacing="-1">${escapeXml(scoreMain)}</text>`,
    `<text x="46" y="374" font-family="${escapeXml(SANS_FONT)}" font-size="12.5" fill="${escapeXml(colors.dim)}">${escapeXml(labels.scoreCaption)}</text>`,
    `<line x1="210" y1="316" x2="210" y2="380" stroke="${escapeXml(colors.ink)}" stroke-width="0.7" opacity="0.2" />`,
    `<text x="232" y="344" font-family="${escapeXml(MONO_FONT)}" font-size="28" font-weight="700" fill="${escapeXml(accuracyColor)}">${entry.accuracy}%</text>`,
    `<text x="232" y="374" font-family="${escapeXml(SANS_FONT)}" font-size="12.5" fill="${escapeXml(colors.dim)}">${escapeXml(labels.accuracyCaption)}${masteryTag ? ` · ${escapeXml(masteryTag)}` : ''}</text>`,
    // Pressed carved cinnabar seal at bottom-right colophon
    `<g transform="translate(524 274) rotate(-2.5 54 54) scale(0.92)">${sealMarkup}</g>`,
    `<text x="578" y="396" font-family="${escapeXml(MONO_FONT)}" font-size="10" letter-spacing="1.6" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(labels.sealEmblem)}</text>`,
    '</svg>',
  ].join('');
}

function buildRisographSvg(entry, colors, labels) {
  const W = 680;
  const H = 440;
  const seed = Number(entry.seed) || hashSeed(entry.title || 'risograph');
  const rng = mulberry32(seed ^ 0x27d4eb2d);
  const titleLines = wrapText(entry.title || 'StudyHub', 20, 2);
  const noteLines = entry.note ? wrapText(entry.note, 28, 2) : [];
  const patternId = `sh-riso-dots-${seed % 99991}`;
  const sealMarkup = buildSealInnerMarkup(
    { id: entry.sealId, chars: entry.sealChars, seed, defaultStyle: entry.sealStyle },
    { style: entry.sealStyle, ink: colors.accent, paper: colors.paper },
  );
  // Seeded mountain-wave silhouette for riso overprint artwork
  const peakY1 = 158 + Math.round(rng() * 24);
  const peakY2 = 132 + Math.round(rng() * 26);
  const ridgeA = `M 426 266 Q 486 ${peakY1} 546 218 T 658 266 L 658 302 L 426 302 Z`;
  const ridgeB = `M 422 272 Q 504 ${peakY2} 574 226 T 658 272 L 658 306 L 422 306 Z`;
  const scoreMain = `${entry.correct}/${entry.answered || entry.total}`;
  const accuracyColor = accuracyInkColor(entry.accuracy, colors);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(labels.ariaLabel)}">`,
    '<defs>',
    `<pattern id="${patternId}" width="8" height="8" patternUnits="userSpaceOnUse">`,
    `<circle cx="3" cy="3" r="1.2" fill="${escapeXml(colors.info)}" opacity="0.28" />`,
    '</pattern>',
    '</defs>',
    `<rect width="${W}" height="${H}" rx="12" fill="${escapeXml(colors.paper)}" />`,
    paperGrain(W, H, seed, colors.ink),
    // Right risograph ink-drum panel with halftone texture
    `<rect x="424" y="22" width="234" height="${H - 44}" rx="8" fill="url(#${patternId})" />`,
    `<rect x="428" y="26" width="226" height="${H - 52}" rx="6" fill="none" stroke="${escapeXml(colors.accent)}" stroke-width="1.2" opacity="0.52" stroke-dasharray="5 3" />`,
    // 2-tone offset risograph sun + layered ridges
    `<circle cx="576" cy="116" r="40" fill="${escapeXml(colors.warn)}" opacity="0.48" />`,
    `<circle cx="582" cy="112" r="40" fill="${escapeXml(colors.accent)}" opacity="0.22" />`,
    `<path d="${ridgeA}" fill="${escapeXml(colors.info)}" opacity="0.34" />`,
    `<path d="${ridgeB}" fill="${escapeXml(colors.ok)}" opacity="0.42" />`,
    // Offset registration marks
    `<line x1="28" y1="28" x2="404" y2="28" stroke="${escapeXml(colors.accent)}" stroke-width="2.4" opacity="0.82" />`,
    `<line x1="31" y1="32" x2="407" y2="32" stroke="${escapeXml(colors.ok)}" stroke-width="1.1" opacity="0.55" />`,
    // Edition header
    `<text x="32" y="60" font-family="${escapeXml(MONO_FONT)}" font-size="11" letter-spacing="2" fill="${escapeXml(colors.accent)}" font-weight="700">RISO PRINT · STUDYHUB</text>`,
    `<text x="404" y="60" font-family="${escapeXml(MONO_FONT)}" font-size="11" fill="${escapeXml(colors.dim)}" text-anchor="end">${escapeXml(entry.dateLabel || formatPostcardDate())}</text>`,
    // Course badge pill (offset dual-ink)
    entry.course
      ? `<text x="32" y="94" font-family="${escapeXml(SANS_FONT)}" font-size="12.5" font-weight="600" fill="${escapeXml(colors.info)}">${escapeXml(entry.course)}</text>`
      : '',
    // Bold editorial title with subtle riso misregistration echo
    ...titleLines.map((line, i) => {
      const y = (entry.course ? 132 : 120) + i * 38;
      return [
        `<text x="34" y="${y + 2}" font-family="${escapeXml(SERIF_FONT)}" font-size="28" font-weight="700" fill="${escapeXml(colors.warn)}" opacity="0.35">${escapeXml(line)}</text>`,
        `<text x="32" y="${y}" font-family="${escapeXml(SERIF_FONT)}" font-size="28" font-weight="700" fill="${escapeXml(colors.ink)}">${escapeXml(line)}</text>`,
      ].join('');
    }),
    // High-contrast riso metrics block
    `<rect x="35" y="218" width="164" height="78" rx="6" fill="${escapeXml(colors.ok)}" opacity="0.22" />`,
    `<rect x="32" y="215" width="164" height="78" rx="6" fill="none" stroke="${escapeXml(colors.ink)}" stroke-width="1.3" opacity="0.72" />`,
    `<text x="48" y="259" font-family="${escapeXml(MONO_FONT)}" font-size="30" font-weight="700" fill="${escapeXml(colors.ink)}">${escapeXml(scoreMain)}</text>`,
    `<text x="48" y="280" font-family="${escapeXml(SANS_FONT)}" font-size="11.5" fill="${escapeXml(colors.dim)}">${escapeXml(labels.scoreCaption)}</text>`,
    `<rect x="217" y="218" width="164" height="78" rx="6" fill="${escapeXml(colors.warn)}" opacity="0.22" />`,
    `<rect x="214" y="215" width="164" height="78" rx="6" fill="none" stroke="${escapeXml(colors.ink)}" stroke-width="1.3" opacity="0.72" />`,
    `<text x="230" y="259" font-family="${escapeXml(MONO_FONT)}" font-size="30" font-weight="700" fill="${escapeXml(accuracyColor)}">${entry.accuracy}%</text>`,
    `<text x="230" y="280" font-family="${escapeXml(SANS_FONT)}" font-size="11.5" fill="${escapeXml(colors.dim)}">${escapeXml(labels.accuracyCaption)}</text>`,
    // Note or seal reason footer on left
    ...(noteLines.length
      ? noteLines.map((line, i) => (
        `<text x="32" y="${336 + i * 22}" font-family="${escapeXml(SERIF_FONT)}" font-size="14" fill="${escapeXml(colors.dim)}">${escapeXml(line)}</text>`
      ))
      : [`<text x="32" y="340" font-family="${escapeXml(SERIF_FONT)}" font-size="14" fill="${escapeXml(colors.dim)}">${escapeXml(labels.sealTitle)} · ${escapeXml(labels.sealReason)}</text>`]),
    `<line x1="32" y1="398" x2="404" y2="398" stroke="${escapeXml(colors.ink)}" stroke-width="0.9" opacity="0.22" />`,
    `<text x="32" y="416" font-family="${escapeXml(MONO_FONT)}" font-size="10" letter-spacing="1.4" fill="${escapeXml(colors.dim)}">EDITION 02 · ${escapeXml(labels.sealEmblem)}</text>`,
    // Carved cinnabar seal centered in right lower chamber
    `<g transform="translate(490 296) rotate(2 50 50) scale(0.86)">${sealMarkup}</g>`,
    '</svg>',
  ].join('');
}

function buildArchivalSlipSvg(entry, colors, labels) {
  const W = 420;
  const H = 620;
  const seed = Number(entry.seed) || hashSeed(entry.title || 'archival-slip');
  const titleLines = wrapText(entry.title || 'StudyHub', 16, 2);
  const noteLines = entry.note ? wrapText(entry.note, 22, 2) : [];
  const sealMarkup = buildSealInnerMarkup(
    { id: entry.sealId, chars: entry.sealChars, seed, defaultStyle: entry.sealStyle },
    { style: entry.sealStyle, ink: colors.accent, paper: colors.paper },
  );
  const scoreMain = `${entry.correct} / ${entry.answered || entry.total}`;
  const accuracyColor = accuracyInkColor(entry.accuracy, colors);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(labels.ariaLabel)}">`,
    `<rect width="${W}" height="${H}" rx="12" fill="${escapeXml(colors.paper)}" />`,
    paperGrain(W, H, seed, colors.ink),
    // Silk-cord bookmark eyelet at top center
    `<circle cx="${W / 2}" cy="34" r="9" fill="none" stroke="${escapeXml(colors.accent)}" stroke-width="1.4" opacity="0.65" />`,
    `<circle cx="${W / 2}" cy="34" r="4.5" fill="${escapeXml(colors.ink)}" opacity="0.16" />`,
    // Traditional Zhu-si-lan (朱丝栏) woodblock vertical ruling frame
    `<rect x="24" y="60" width="${W - 48}" height="${H - 84}" rx="4" fill="none" stroke="${escapeXml(colors.accent)}" stroke-width="1.6" opacity="0.62" />`,
    `<rect x="30" y="66" width="${W - 60}" height="${H - 96}" rx="2" fill="none" stroke="${escapeXml(colors.accent)}" stroke-width="0.65" opacity="0.38" />`,
    // Subtle vertical ledger columns
    `<line x1="78" y1="66" x2="78" y2="${H - 30}" stroke="${escapeXml(colors.accent)}" stroke-width="0.6" opacity="0.22" />`,
    `<line x1="${W - 78}" y1="66" x2="${W - 78}" y2="${H - 30}" stroke="${escapeXml(colors.accent)}" stroke-width="0.6" opacity="0.22" />`,
    // Classic woodblock fishtail bookmark notch (鱼尾)
    `<path d="M ${W / 2 - 18} 96 L ${W / 2} 106 L ${W / 2 + 18} 96" fill="none" stroke="${escapeXml(colors.accent)}" stroke-width="1.2" opacity="0.58" />`,
    // Upper chamber: colophon title & date
    `<text x="${W / 2}" y="88" font-family="${escapeXml(MONO_FONT)}" font-size="10.5" letter-spacing="2.4" fill="${escapeXml(colors.accent)}" text-anchor="middle" font-weight="600">ARCHIVAL SLIP · STUDYHUB</text>`,
    `<text x="${W / 2}" y="128" font-family="${escapeXml(MONO_FONT)}" font-size="11.5" letter-spacing="1.6" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(entry.dateLabel || formatPostcardDate())}</text>`,
    // Course & deck title centered
    entry.course
      ? `<text x="${W / 2}" y="162" font-family="${escapeXml(SANS_FONT)}" font-size="12" letter-spacing="1" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(entry.course)}</text>`
      : '',
    ...titleLines.map((line, i) => (
      `<text x="${W / 2}" y="${(entry.course ? 198 : 188) + i * 36}" font-family="${escapeXml(SERIF_FONT)}" font-size="25" font-weight="700" fill="${escapeXml(colors.ink)}" text-anchor="middle">${escapeXml(line)}</text>`
    )),
    // Horizontal divider before seal chamber
    `<line x1="94" y1="264" x2="${W - 94}" y2="264" stroke="${escapeXml(colors.ink)}" stroke-width="0.7" opacity="0.24" />`,
    // Hero centered carved cinnabar seal
    `<g transform="translate(150 286) rotate(-1.5 60 60) scale(1)">${sealMarkup}</g>`,
    `<text x="${W / 2}" y="426" font-family="${escapeXml(SERIF_FONT)}" font-size="14" font-weight="600" fill="${escapeXml(colors.accent)}" text-anchor="middle">${escapeXml(labels.sealTitle)}</text>`,
    // Learner reflection note or factual seal reason
    ...(noteLines.length
      ? noteLines.map((line, i) => (
        `<text x="${W / 2}" y="${456 + i * 21}" font-family="${escapeXml(SERIF_FONT)}" font-size="13.5" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(line)}</text>`
      ))
      : [`<text x="${W / 2}" y="458" font-family="${escapeXml(SERIF_FONT)}" font-size="13" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(labels.sealReason)}</text>`]),
    // Lower colophon stats chamber
    `<line x1="46" y1="508" x2="${W - 46}" y2="508" stroke="${escapeXml(colors.accent)}" stroke-width="0.8" opacity="0.34" />`,
    `<text x="116" y="546" font-family="${escapeXml(SERIF_FONT)}" font-size="24" font-weight="700" fill="${escapeXml(colors.ink)}" text-anchor="middle">${escapeXml(scoreMain)}</text>`,
    `<text x="116" y="568" font-family="${escapeXml(SANS_FONT)}" font-size="11" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(labels.scoreCaption)}</text>`,
    `<line x1="${W / 2}" y1="522" x2="${W / 2}" y2="574" stroke="${escapeXml(colors.ink)}" stroke-width="0.7" opacity="0.2" />`,
    `<text x="304" y="546" font-family="${escapeXml(MONO_FONT)}" font-size="24" font-weight="700" fill="${escapeXml(accuracyColor)}" text-anchor="middle">${entry.accuracy}%</text>`,
    `<text x="304" y="568" font-family="${escapeXml(SANS_FONT)}" font-size="11" fill="${escapeXml(colors.dim)}" text-anchor="middle">${escapeXml(labels.accuracyCaption)}</text>`,
    '</svg>',
  ].join('');
}

/**
 * Generate a self-contained SVG string for any of the 3 postcard editions.
 * `labels` carries translated captions from the React layer so the SVG reflects the active UI language.
 */
export function buildPostcardSvg(entry, options = {}) {
  const edition = POSTCARD_EDITIONS.find((e) => e.id === entry?.edition) || POSTCARD_EDITIONS[0];
  const colors = resolveColors(options.palette);
  const labels = {
    ariaLabel: options.labels?.ariaLabel || `${entry?.title || 'StudyHub'} (${edition.id})`,
    sealTitle: options.labels?.sealTitle || (entry?.sealChars || ['笃', '行']).join(''),
    sealReason: options.labels?.sealReason || '',
    sealEmblem: options.labels?.sealEmblem || 'STUDYHUB SEAL',
    scoreCaption: options.labels?.scoreCaption || 'Score',
    accuracyCaption: options.labels?.accuracyCaption || 'Accuracy',
  };
  let svg = '';
  if (edition.id === 'risograph') svg = buildRisographSvg(entry, colors, labels);
  else if (edition.id === 'archival-slip') svg = buildArchivalSlipSvg(entry, colors, labels);
  else svg = buildLetterpressSvg(entry, colors, labels);

  const safeTitle = String(entry?.title || 'studyhub')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'studyhub';
  const datePart = String(entry?.dateLabel || formatPostcardDate()).replace(/\./g, '-');
  return {
    svg,
    width: edition.width,
    height: edition.height,
    filenameBase: `studyhub-${edition.id}-${safeTitle}-${datePart}`,
  };
}

function triggerDownload(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }, 1500);
  return true;
}

/** 1-click offline export as vector SVG file. */
export function exportPostcardSvg(entry, options = {}) {
  const { svg, filenameBase } = buildPostcardSvg(entry, options);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  return triggerDownload(blob, `${filenameBase}.svg`);
}

/** 1-click offline export as crisp 2x HiDPI PNG file rendered onto an offscreen canvas. */
export async function exportPostcardPng(entry, options = {}) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return false;
  }
  const scale = Number(options.scale) || 2;
  const { svg, width, height, filenameBase } = buildPostcardSvg(entry, options);
  // Use data: URI (not blob:) so image loading passes strict `img-src 'self' data:` CSP in web-demo.
  const svgDataUri = svgToDataUri(svg);
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = (err) => reject(err);
    image.src = svgDataUri;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!pngBlob) return false;
  return triggerDownload(pngBlob, `${filenameBase}@${scale}x.png`);
}
