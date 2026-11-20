/* Course manual notation overrides (`course.notationOverrides`, StudyHub 5.0.0 Evolution 2 #6):
   stored optionally on a course record via `course.save` (never breaks v5 stores), always taking
   highest priority when merged with `courseOutline.notationLedger`. Pure, browser-safe. */

export const NOTATION_OVERRIDE_LIMITS = Object.freeze({
  max: 40,
  canonicalChars: 80,
  symbolChars: 48,
  aliases: 8,
  aliasChars: 80,
  meaningChars: 200,
});

const fail = message => { throw new Error(message); };
const cleanLine = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const foldKey = value => cleanLine(value).normalize('NFKC').toLowerCase().replace(/[\s\-_·•‧]+/g, '');

function normalizeAliases(raw, canonicalKey, symbolKey) {
  if (raw === undefined || raw === null) return [];
  const items = typeof raw === 'string' ? raw.split(/[,，;；、\n]/) : Array.isArray(raw) ? raw : null;
  if (!items) fail('符号口径别名格式无效');
  const seen = new Set([canonicalKey, symbolKey].filter(Boolean));
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') fail('符号口径别名必须为文字');
    const text = cleanLine(item);
    if (!text) continue;
    if (text.length > NOTATION_OVERRIDE_LIMITS.aliasChars) fail(`符号口径别名过长（最多 ${NOTATION_OVERRIDE_LIMITS.aliasChars} 字）`);
    const key = foldKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= NOTATION_OVERRIDE_LIMITS.aliases) break;
  }
  return out;
}

/** Validate and normalize one manual notation override entry. */
export function normalizeNotationOverride(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('符号口径条目格式无效');
  const canonical = cleanLine(raw.canonical);
  if (!canonical) fail('符号口径条目需要规范名称（canonical）');
  if (canonical.length > NOTATION_OVERRIDE_LIMITS.canonicalChars) {
    fail(`符号口径名称过长（最多 ${NOTATION_OVERRIDE_LIMITS.canonicalChars} 字）`);
  }
  const symbol = cleanLine(raw.symbol);
  if (symbol.length > NOTATION_OVERRIDE_LIMITS.symbolChars) {
    fail(`符号过长（最多 ${NOTATION_OVERRIDE_LIMITS.symbolChars} 字）`);
  }
  const meaning = cleanLine(raw.meaning);
  if (meaning.length > NOTATION_OVERRIDE_LIMITS.meaningChars) {
    fail(`符号含义说明过长（最多 ${NOTATION_OVERRIDE_LIMITS.meaningChars} 字）`);
  }
  const aliases = normalizeAliases(raw.aliases, foldKey(canonical), foldKey(symbol));
  return {
    canonical,
    ...(symbol ? { symbol } : {}),
    aliases,
    meaning,
  };
}

/** Validate `course.notationOverrides` for `course.save`: undefined = untouched, null/[] = clear. */
export function checkedNotationOverrides(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) fail('课程符号口径覆写格式无效');
  if (raw.length > NOTATION_OVERRIDE_LIMITS.max) fail(`课程符号口径覆写最多 ${NOTATION_OVERRIDE_LIMITS.max} 条`);
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') fail('符号口径条目格式无效');
    if (!cleanLine(entry.canonical) && !cleanLine(entry.symbol) && !cleanLine(entry.meaning)) continue;
    const clean = normalizeNotationOverride(entry);
    const key = foldKey(clean.canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.length ? out : null;
}

/** Merge two courses' manual notation overrides during `course.merge`, keeping target entries first. */
export function mergeNotationOverrides(intoList = [], fromList = []) {
  const seen = new Set();
  const out = [];
  for (const raw of [...(Array.isArray(intoList) ? intoList : []), ...(Array.isArray(fromList) ? fromList : [])]) {
    if (out.length >= NOTATION_OVERRIDE_LIMITS.max) break;
    if (!raw || typeof raw !== 'object' || !cleanLine(raw.canonical)) continue;
    const clean = normalizeNotationOverride(raw);
    const key = foldKey(clean.canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}
