import { SOURCE_PRIORITY_HINTS } from './messages.js';
import {
  NOTATION_LEDGER_MAX,
  NOTATION_LIMITS,
  NOTATION_PRIORITY_SOURCES,
  bareNotationName,
  clipNotation,
  foldNotationKey,
  formatNotationFence,
  formulaNotationKey,
  mergeNotationLedger,
  normalizeNotationEntry,
  normalizeNotationLedger,
  resolveCourseNotationLedger,
  splitNotationForms,
} from './notation-merge.js';

export {
  NOTATION_LEDGER_MAX,
  NOTATION_LIMITS,
  NOTATION_PRIORITY_SOURCES,
  formatNotationFence,
  mergeNotationLedger,
  normalizeNotationEntry,
  normalizeNotationLedger,
  resolveCourseNotationLedger,
};

/* Course Notation Ledger builder (StudyHub 5.0.0 Evolution 2 #6): 0-token merge of inventory
   term/definition/formula items with priority `slides/exam > textbook > live`. Pure, zero Node builtins. */

const PRIORITY_RANK = Object.freeze({ live: 1, textbook: 2, slides: 3, exam: 3, override: 4 });
const LEDGER_KINDS = new Set(['formula', 'term', 'definition']);
const INLINE_MATH_RE = /\$([^$]{1,44})\$/;
const SYMBOL_TOKEN_RE = /([α-ωΑ-ΩλμσΣΔΩθφψπρτβγδενξζ]|[A-Za-z](?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+|['′]+|\([A-Za-z0-9,|]+\)|\[[A-Za-z0-9,|]+\]))/;

function extractSymbol(item) {
  const name = clipNotation(item?.name, NOTATION_LIMITS.canonicalChars);
  const gist = clipNotation(item?.gist, NOTATION_LIMITS.meaningChars);
  const math = INLINE_MATH_RE.exec(name) || INLINE_MATH_RE.exec(gist);
  if (math) return clipNotation(math[1], NOTATION_LIMITS.symbolChars);
  if (item?.kind === 'formula') return clipNotation(bareNotationName(name), NOTATION_LIMITS.symbolChars);
  const sym = SYMBOL_TOKEN_RE.exec(name);
  return sym ? clipNotation(sym[1], NOTATION_LIMITS.symbolChars) : '';
}

/** Classify a source/document into `'exam' | 'slides' | 'textbook' | 'live'`. */
export function classifyPrioritySource(meta = {}) {
  if (!meta || typeof meta !== 'object') return 'textbook';
  if (meta.role === 'past-paper' || meta.reason === 'paper' || meta.isPaper === true) return 'exam';
  const title = String(meta.title || meta.name || meta.doc || '');
  if (SOURCE_PRIORITY_HINTS.exam.test(title)) return 'exam';
  if (meta.hasAudio || meta.audio || meta.origin === 'live' || meta.liveSessionId || SOURCE_PRIORITY_HINTS.live.test(title)) {
    return 'live';
  }
  if (meta.format === 'pptx' || SOURCE_PRIORITY_HINTS.slides.test(title)) return 'slides';
  return 'textbook';
}

function sourceTierOf(place, bySourceId, byDocKey) {
  const src = place?.sourceId ? bySourceId.get(place.sourceId) : null;
  if (src) return classifyPrioritySource(src);
  const doc = place?.doc ? byDocKey.get(place.doc) : null;
  return classifyPrioritySource(doc || { doc: place?.doc });
}

function bestTierOf(places, bySourceId, byDocKey) {
  let best = 'textbook';
  let rank = 0;
  for (const place of Array.isArray(places) ? places : []) {
    const tier = sourceTierOf(place, bySourceId, byDocKey);
    if (PRIORITY_RANK[tier] > rank) { rank = PRIORITY_RANK[tier]; best = tier; }
  }
  return rank ? best : 'textbook';
}

/** 0-token merge of inventory term/definition/formula items into `courseOutline.notationLedger` (max 40). */
export function buildNotationLedger(inventory, { sources = [], documents = [], max = NOTATION_LEDGER_MAX } = {}) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  if (!items.length) return [];
  const bySourceId = new Map((Array.isArray(sources) ? sources : []).filter(s => s?.id).map(s => [s.id, s]));
  const docList = [...(Array.isArray(documents) ? documents : []), ...(Array.isArray(inventory?.documents) ? inventory.documents : [])];
  const byDocKey = new Map(docList.filter(d => d?.key).map(d => [d.key, d]));

  const groups = [];
  const keyToGroup = new Map();
  for (let order = 0; order < items.length; order++) {
    const item = items[order];
    if (!item || !LEDGER_KINDS.has(item.kind)) continue;
    const name = clipNotation(item.name, NOTATION_LIMITS.canonicalChars);
    if (!name) continue;
    const forms = splitNotationForms(name);
    const symbol = extractSymbol(item);
    const keys = [...new Set([
      ...forms.map(foldNotationKey),
      ...(item.kind === 'formula' ? forms.map(formulaNotationKey) : []),
      ...(symbol ? [formulaNotationKey(symbol)] : []),
    ].filter(Boolean))];
    let group = null;
    for (const key of keys) if (keyToGroup.has(key)) { group = keyToGroup.get(key); break; }
    const tier = bestTierOf(item.places, bySourceId, byDocKey);
    const rank = PRIORITY_RANK[tier] || 2;
    const gist = clipNotation(item.gist, NOTATION_LIMITS.meaningChars);
    const placesCount = Array.isArray(item.places) ? item.places.length : 1;
    if (!group) {
      group = {
        canonical: name, symbol, meaning: gist, prioritySource: tier, rank,
        aliases: new Set(forms), keyFlag: item.key === true, kind: item.kind, hits: placesCount, order,
      };
      groups.push(group);
    } else {
      for (const form of forms) group.aliases.add(form);
      group.hits += placesCount;
      if (item.key === true) group.keyFlag = true;
      if (rank > group.rank) {
        group.aliases.add(group.canonical);
        group.canonical = name;
        group.prioritySource = tier;
        group.rank = rank;
        if (symbol) group.symbol = symbol;
        if (gist) group.meaning = gist;
      } else {
        if (!group.symbol && symbol) group.symbol = symbol;
        if (!group.meaning && gist) group.meaning = gist;
      }
    }
    for (const key of keys) keyToGroup.set(key, group);
  }

  groups.sort((a, b) =>
    Number(b.keyFlag) - Number(a.keyFlag)
    || b.rank - a.rank
    || b.hits - a.hits
    || Number(b.kind === 'formula') - Number(a.kind === 'formula')
    || a.order - b.order);

  return normalizeNotationLedger(groups.map(group => ({
    canonical: group.canonical,
    ...(group.symbol ? { symbol: group.symbol } : {}),
    aliases: [...group.aliases],
    meaning: group.meaning,
    prioritySource: group.prioritySource,
  })), { max });
}
