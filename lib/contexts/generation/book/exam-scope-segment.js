import { ZH_SINGLE_FUNC_CHARS, ZH_STOPWORDS } from './messages.js';

const CJK = /[\u3400-\u9fff]/u;
const CJK_ONLY = /^[\u3400-\u9fff]+$/u;
const ASCII_WORD = /^[a-z0-9][a-z0-9_+-]*$/i;
const ZH_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'about', 'that', 'this', 'these', 'those', 'their', 'what', 'when',
  'where', 'which', 'how', 'why', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'not', 'but', 'can',
  'will', 'may', 'might', 'should', 'could', 'chapter', 'chapters', 'section', 'sections', 'part', 'parts', 'unit',
  'lecture', 'week', 'topic', 'topics', 'exam', 'final', 'midterm', 'review', 'scope', 'focus', 'syllabus', 'note',
  'notes', 'overview', 'introduction', 'summary', 'basics', 'concepts', 'theory', 'methods', 'study', ...ZH_STOPWORDS,
]);

const BUILT_WHITELISTS = new WeakSet();

/** Normalize course glossary / notation-ledger terms into a longest-first whitelist that prevents domain terms from being split. */
export function buildTermWhitelist(entries, { normLower, aliasForms }) {
  if (!entries) return [];
  if (Array.isArray(entries) && BUILT_WHITELISTS.has(entries)) return entries;
  const seen = new Set();
  const add = value => {
    const cleaned = normLower(value);
    if (!cleaned || cleaned.length < 2 || STOPWORDS.has(cleaned)) return;
    if (CJK.test(cleaned) || cleaned.length >= 3) seen.add(cleaned);
  };
  for (const entry of entries) {
    if (typeof entry === 'string') {
      for (const form of aliasForms(entry)) add(form);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.canonical === 'string') for (const form of aliasForms(entry.canonical)) add(form);
    if (typeof entry.name === 'string') for (const form of aliasForms(entry.name)) add(form);
    if (typeof entry.symbol === 'string') add(entry.symbol);
    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (typeof alias === 'string') for (const form of aliasForms(alias)) add(form);
      }
    }
  }
  const built = [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
  BUILT_WHITELISTS.add(built);
  return built;
}

export function extractWhitelistedTerms(text, whitelist, out) {
  if (!whitelist.length || !text) return text;
  const taken = new Uint8Array(text.length);
  for (const term of whitelist) {
    if (term.length > text.length) continue;
    const isAscii = ASCII_WORD.test(term);
    let from = 0;
    while (from <= text.length - term.length) {
      const idx = text.indexOf(term, from);
      if (idx < 0) break;
      const end = idx + term.length;
      from = idx + 1;
      if (isAscii) {
        const prev = idx > 0 ? text[idx - 1] : '';
        const next = end < text.length ? text[end] : '';
        if (/[a-z0-9]/i.test(prev) || /[a-z0-9]/i.test(next)) continue;
      }
      let overlaps = false;
      for (let i = idx; i < end; i++) if (taken[i]) { overlaps = true; break; }
      if (overlaps) continue;
      for (let i = idx; i < end; i++) taken[i] = 1;
      out.add(term);
      from = end;
    }
  }
  let residual = '';
  for (let i = 0; i < text.length; i++) residual += taken[i] ? ' ' : text[i];
  return residual;
}

/** Segment Chinese text with Node 22 native Intl.Segmenter('zh') while preserving unknown CJK compounds and whitelisted terms. */
export function segmentZhWith(raw, { whitelist, normLower, aliasForms }) {
  const text = normLower(raw);
  if (!text) return [];
  const terms = buildTermWhitelist(whitelist, { normLower, aliasForms });
  const out = new Set();
  const residual = extractWhitelistedTerms(text, terms, out);

  const emitCjkRun = seq => {
    if (!seq || seq.length < 2) return;
    if (!ZH_SEGMENTER) {
      if (!STOPWORDS.has(seq)) out.add(seq);
      return;
    }
    const rawSegs = [];
    for (const part of ZH_SEGMENTER.segment(seq)) {
      if (part.isWordLike && CJK_ONLY.test(part.segment)) rawSegs.push(part.segment);
    }
    let singleRun = '';
    let prevMulti = '';
    const flushSingleRun = () => {
      if (singleRun.length >= 2) {
        if (!STOPWORDS.has(singleRun)) out.add(singleRun);
      } else if (singleRun.length === 1 && prevMulti) {
        const glued = `${prevMulti}${singleRun}`;
        if (!STOPWORDS.has(glued)) out.add(glued);
      }
      singleRun = '';
    };
    for (const seg of rawSegs) {
      if (seg.length === 1) {
        if (ZH_SINGLE_FUNC_CHARS.has(seg)) {
          flushSingleRun();
          prevMulti = '';
        } else {
          singleRun += seg;
        }
        continue;
      }
      flushSingleRun();
      if (!STOPWORDS.has(seg)) out.add(seg);
      prevMulti = seg;
    }
    flushSingleRun();
  };

  for (const match of residual.matchAll(/[\u3400-\u9fff]{2,}/gu)) emitCjkRun(match[0]);
  return [...out];
}
