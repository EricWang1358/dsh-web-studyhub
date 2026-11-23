/* Normalization, override merge, state resolution, and prompt formatting for Course Notation Ledger.
   Pure, zero Node builtins, browser-safe (StudyHub 5.0.0 Evolution 2 #6). */
import { courseAncestors, coursePath } from '../../../course-tree.js';

export const NOTATION_LEDGER_MAX = 40;
export const NOTATION_PRIORITY_SOURCES = Object.freeze(['slides', 'exam', 'textbook', 'live']);
export const NOTATION_LIMITS = Object.freeze({
  max: NOTATION_LEDGER_MAX,
  canonicalChars: 80,
  symbolChars: 48,
  aliases: 8,
  aliasChars: 80,
  meaningChars: 200,
});

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const TRAILING_GLOSS_RE = /^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/;

export const clipNotation = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
};

export const bareNotationName = name => {
  const text = String(name ?? '').normalize('NFKC').trim();
  const match = TRAILING_GLOSS_RE.exec(text);
  return match && match[1].trim() && CJK_RE.test(match[1]) !== CJK_RE.test(match[2]) ? match[1].trim() : text;
};

export const foldNotationKey = value => bareNotationName(value).toLowerCase().replace(/[\s\-_·•‧]+/g, '').replace(/[.:：;；,，。、]+$/u, '');
export const formulaNotationKey = value => bareNotationName(value).toLowerCase().replace(/\s+/g, '');

export function splitNotationForms(name) {
  const text = clipNotation(name, NOTATION_LIMITS.canonicalChars);
  if (!text) return [];
  const forms = new Set([text]);
  const bare = bareNotationName(text);
  if (bare) forms.add(bare);
  const prose = bare.replace(/\$[^$]+\$/g, ' ').replace(/\s+/g, ' ').trim();
  if (prose && prose.length >= 2) forms.add(prose);
  const match = TRAILING_GLOSS_RE.exec(text);
  if (match && match[1].trim() && CJK_RE.test(match[1]) !== CJK_RE.test(match[2])) {
    forms.add(match[2].trim());
  }
  return [...forms].filter(Boolean);
}

/** Normalize one ledger entry (strictly bounded, optional symbol and prioritySource). */
export function normalizeNotationEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const canonical = clipNotation(raw.canonical, NOTATION_LIMITS.canonicalChars);
  if (!canonical) return null;
  const symbol = clipNotation(raw.symbol, NOTATION_LIMITS.symbolChars);
  const meaning = clipNotation(raw.meaning, NOTATION_LIMITS.meaningChars);
  const prioritySource = NOTATION_PRIORITY_SOURCES.includes(raw.prioritySource) ? raw.prioritySource : undefined;
  const seen = new Set([foldNotationKey(canonical), symbol ? formulaNotationKey(symbol) : ''].filter(Boolean));
  const aliases = [];
  for (const alias of Array.isArray(raw.aliases) ? raw.aliases : []) {
    const clean = clipNotation(alias, NOTATION_LIMITS.aliasChars);
    const key = foldNotationKey(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(clean);
    if (aliases.length >= NOTATION_LIMITS.aliases) break;
  }
  return {
    canonical,
    ...(symbol ? { symbol } : {}),
    aliases,
    meaning,
    ...(prioritySource ? { prioritySource } : {}),
  };
}

/** Normalize and deduplicate a notation ledger array (max 40). */
export function normalizeNotationLedger(raw, { max = NOTATION_LEDGER_MAX } = {}) {
  const cap = Math.max(0, Math.min(NOTATION_LEDGER_MAX, Number(max) || NOTATION_LEDGER_MAX));
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= cap) break;
    const clean = normalizeNotationEntry(entry);
    if (!clean) continue;
    const key = foldNotationKey(clean.canonical);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Merge auto-extracted `outlineLedger` with manual `overrides` (overrides always take highest priority). */
export function mergeNotationLedger(outlineLedger = [], overrides = [], { max = NOTATION_LEDGER_MAX } = {}) {
  const base = normalizeNotationLedger(outlineLedger, { max });
  const manual = normalizeNotationLedger(overrides, { max });
  if (!manual.length) return base;
  const matchedBase = new Set();
  const entryKeys = entry => new Set([
    foldNotationKey(entry.canonical),
    ...(entry.symbol ? [formulaNotationKey(entry.symbol)] : []),
    ...(entry.aliases || []).map(foldNotationKey),
  ].filter(Boolean));
  const baseKeys = base.map(entryKeys);
  const out = [];
  for (const ov of manual) {
    const ovKeys = entryKeys(ov);
    const mergedAliases = [...(ov.aliases || [])];
    let symbol = ov.symbol || '';
    let meaning = ov.meaning || '';
    base.forEach((item, idx) => {
      if (matchedBase.has(idx)) return;
      if ([...ovKeys].some(key => baseKeys[idx].has(key))) {
        matchedBase.add(idx);
        mergedAliases.push(item.canonical, ...(item.aliases || []));
        if (!symbol && item.symbol) symbol = item.symbol;
        if (!meaning && item.meaning) meaning = item.meaning;
      }
    });
    const clean = normalizeNotationEntry({ canonical: ov.canonical, symbol, aliases: mergedAliases, meaning });
    if (clean) out.push(clean);
  }
  base.forEach((item, idx) => { if (!matchedBase.has(idx)) out.push(item); });
  return normalizeNotationLedger(out, { max });
}

/** Resolve merged notation ledger for `course` from full library `state` (0-token; [] when absent).
 *  Walks `courseAncestors` top-down so priority is strictly:
 *  child manual > parent manual > child outline > parent outline, while preserving alias merging. */
export function resolveCourseNotationLedger(state, course, { max = NOTATION_LEDGER_MAX } = {}) {
  if (!state || typeof course !== 'string' || !course.trim() || course === '*') return [];
  const normName = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const courses = (Array.isArray(state.courses) ? state.courses : []).filter(item => item && typeof item.name === 'string' && item.name.trim());
  const outlineSources = (Array.isArray(state.sources) ? state.sources : []).filter(src =>
    src && !src.archived && src.provenance === 'course-outline' && src.courseOutline?.version === 1);
  const targetLow = normName(course);
  const directRec = courses.find(item =>
    [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].some(n => typeof n === 'string' && normName(n) === targetLow)) || null;
  const targetName = directRec?.name || course;
  const known = [...new Set([
    targetName,
    ...courses.map(item => item.name),
    ...outlineSources.flatMap(src => Array.isArray(src.courses) ? src.courses.filter(n => typeof n === 'string') : []),
  ])];
  const ancestorPaths = courseAncestors(targetName, known);
  const layers = ancestorPaths.map((path, idx) => {
    const isTarget = idx === ancestorPaths.length - 1;
    const rec = (isTarget && directRec) || courses.find(item => coursePath(item.name, known) === path)
      || courses.find(item => [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].some(n => typeof n === 'string' && normName(n) === normName(path)))
      || null;
    const matchLows = new Set([normName(path), ...(rec ? [rec.name, ...(Array.isArray(rec.aliases) ? rec.aliases : [])].filter(n => typeof n === 'string').map(normName) : [])]);
    const outlines = outlineSources.filter(src => (src.courses || []).some(n => typeof n === 'string' && (coursePath(n, known) === path || matchLows.has(normName(n)))));
    outlines.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(b.id).localeCompare(String(a.id)));
    return {
      outlineLedger: outlines[0]?.courseOutline?.notationLedger || [],
      overrides: rec?.notationOverrides || [],
    };
  });
  let ledger = [];
  for (const layer of layers) {
    if (layer.outlineLedger.length) ledger = mergeNotationLedger(ledger, layer.outlineLedger, { max: NOTATION_LEDGER_MAX });
  }
  for (const layer of layers) {
    if (layer.overrides.length) ledger = mergeNotationLedger(ledger, layer.overrides, { max: NOTATION_LEDGER_MAX });
  }
  return normalizeNotationLedger(ledger, { max });
}

/** Compact bounded data-fence representation of a notation ledger for prompt injection. */
export function formatNotationFence(entries, { max = 24 } = {}) {
  return normalizeNotationLedger(entries, { max }).map(entry => ({
    canonical: entry.canonical,
    ...(entry.symbol ? { symbol: entry.symbol } : {}),
    ...(entry.aliases.length ? { aliases: entry.aliases.slice(0, 4) } : {}),
    ...(entry.meaning ? { meaning: entry.meaning } : {}),
    ...(entry.prioritySource ? { prioritySource: entry.prioritySource } : {}),
  }));
}
