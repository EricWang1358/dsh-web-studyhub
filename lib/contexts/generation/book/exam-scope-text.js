import { cleanFocusTopics, parseFocusText } from '../../../focus-points.js';
import { nameForms } from '../../../course-book-inventory.js';
import {
  CHAPTER_LIST_SEP_RE, CHAPTER_RANGE_RE, GUIDANCE_BULLET_RE, ZH_CH_REF, ZH_CUE_HEAD_RE,
  ZH_DIGITS, ZH_HUNDRED, ZH_NUM_RE, ZH_ONLY_HEAD_RE, ZH_PREFIX_CH_RE, ZH_SCOPE_HEAD_RE,
  ZH_STOPWORDS, ZH_TEN, ZH_TITLE_CH_RE, formatChapterRefLabel,
} from './messages.js';

const CJK = /[\u3400-\u9fff]/u;
const CJK_ONLY = /^[\u3400-\u9fff]+$/u;
const ASCII_WORD = /^[a-z0-9][a-z0-9_+-]*$/i;
const ZH_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;
const ZH_SINGLE_FUNC_CHARS = new Set([
  '的', '与', '和', '及', '在', '中', '对', '于', '是', '了', '为', '或', '等', '把', '将',
  '由', '从', '到', '之', '其', '按', '以', '被', '所', '并', '而', '但', '若', '则', '各',
  '每', '某', '该', '此', '这', '那', '有', '无', '不', '非', '可', '能', '要', '应', '需',
  '用', '做', '作', '给', '向', '往', '里', '上', '下', '前', '后', '内', '外', '间', '过',
  '着', '得', '地', '也', '都', '就', '再', '又', '还', '更', '最', '很', '太', '已', '曾',
]);
const MAX_CHAPTER_NUM = 200;
const ROMAN_NUM = Object.freeze({
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
});
const EN_NUM = '(?:[0-9]+|[ivx]{1,5})';
const EN_TAIL = `(?:\\s*[-–—~]\\s*${EN_NUM})?(?:\\s*(?:,|and|&)\\s*${EN_NUM}(?:\\s*[-–—~]\\s*${EN_NUM})?)*`;
const EN_LIST = `(?:\\s*(?:[0-9]+${EN_TAIL})|\\s+(?:[ivx]{1,5}${EN_TAIL}))`;
const EN_CH_REF = new RegExp(`\\b(?:chapters?|ch\\.?|lectures?|lec\\.?)${EN_LIST}\\b`, 'gi');
const EN_PREFIX_CH_RE = new RegExp(`^(?:chapters?|ch\\.?|lectures?|lec\\.?)${EN_LIST}\\b\\s*[:\\uFF1A\\-—,\\uFF0C\\u3001]?\\s*`, 'i');

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'about', 'that', 'this', 'these', 'those', 'their', 'what', 'when',
  'where', 'which', 'how', 'why', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'not', 'but', 'can',
  'will', 'may', 'might', 'should', 'could', 'chapter', 'chapters', 'section', 'sections', 'part', 'parts', 'unit',
  'lecture', 'week', 'topic', 'topics', 'exam', 'final', 'midterm', 'review', 'scope', 'focus', 'syllabus', 'note',
  'notes', 'overview', 'introduction', 'summary', 'basics', 'concepts', 'theory', 'methods', 'study', ...ZH_STOPWORDS,
]);

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const normSpace = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
export const normLower = value => normSpace(value).toLowerCase();
export const compactKey = value => normLower(value).replace(/[\s\-_·•‧/]+/g, '').replace(/[.:：;；,，。、]+$/u, '');

function parseChapterNum(raw) {
  const text = normSpace(raw);
  if (!text) return null;
  if (/^\d+$/.test(text)) { const n = Number(text); return n >= 1 && n <= MAX_CHAPTER_NUM ? n : null; }
  const lower = text.toLowerCase();
  if (Object.hasOwn(ROMAN_NUM, lower)) return ROMAN_NUM[lower];
  if (!ZH_NUM_RE.test(text)) return null;
  let total = 0, current = 0;
  for (const ch of text) {
    if (ch === ZH_HUNDRED) { total += (current || 1) * 100; current = 0; }
    else if (ch === ZH_TEN) { total += (current || 1) * 10; current = 0; }
    else if (Object.hasOwn(ZH_DIGITS, ch)) current = ZH_DIGITS[ch];
    else return null;
  }
  const n = total + current;
  return n >= 1 && n <= MAX_CHAPTER_NUM ? n : null;
}

function expandChapterList(raw) {
  const nums = [];
  for (const piece of String(raw ?? '').split(CHAPTER_LIST_SEP_RE).map(p => p.trim()).filter(Boolean)) {
    const range = CHAPTER_RANGE_RE.exec(piece);
    if (range) {
      const from = parseChapterNum(range[1]), to = parseChapterNum(range[2]);
      if (from && to && to >= from && to - from <= 40) for (let n = from; n <= to; n++) nums.push(n);
      continue;
    }
    const single = parseChapterNum(piece);
    if (single) nums.push(single);
  }
  return [...new Set(nums)];
}

export function extractChapterRefs(text, language = 'zh') {
  const source = normSpace(text);
  if (!source) return [];
  const byNum = new Map();
  const add = (nums, zh) => { for (const num of nums) if (!byNum.has(num)) byNum.set(num, formatChapterRefLabel(num, zh)); };
  for (const match of source.matchAll(EN_CH_REF)) add(expandChapterList(match[1] || match[0].replace(/^(?:chapters?|ch\.?|lectures?|lec\.?)\s*/i, '')), false);
  for (const match of source.matchAll(ZH_CH_REF)) add(expandChapterList(match[1]), true);
  return [...byNum.entries()].map(([num, label]) => ({ num, label: language === 'en' ? formatChapterRefLabel(num, false) : label }));
}

function stripChapterRefPrefix(raw) {
  let text = normSpace(raw);
  for (let pass = 0; pass < 4; pass++) {
    const before = text;
    text = text.replace(/^[,，、;；:：\-—]+\s*/u, '').replace(EN_PREFIX_CH_RE, '')
      .replace(ZH_PREFIX_CH_RE, '').replace(ZH_SCOPE_HEAD_RE, '').replace(ZH_CUE_HEAD_RE, '').trim();
    if (text === before) break;
  }
  return text;
}

export function isChapterRefOnly(raw) {
  return !normSpace(raw).replace(EN_CH_REF, ' ').replace(ZH_CH_REF, ' ').replace(ZH_ONLY_HEAD_RE, ' ')
    .replace(/[\s,，、;；:：.。()（）[\]【】\-—]+/g, '').trim();
}

function splitOutside(text, sepPattern) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('(（[【{'.includes(ch)) depth++;
    else if (')）]】}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && sepPattern.test(ch)) {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function parseNoteTopics(note) {
  const source = typeof note === 'string' ? note.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n').trim() : '';
  if (!source) return [];
  const rawPieces = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || isChapterRefOnly(line)) continue;
    const stripped = stripChapterRefPrefix(line);
    if (!stripped || isChapterRefOnly(stripped)) continue;
    const parts = splitOutside(stripped, /[;；｜|、,，]/);
    if (parts.length >= 2 && parts.every(part => part.length >= 2 && part.length <= 64)) {
      for (const part of parts) { const cleaned = stripChapterRefPrefix(part); if (cleaned && !isChapterRefOnly(cleaned)) rawPieces.push(cleaned); }
    } else rawPieces.push(stripped);
  }
  return cleanFocusTopics(rawPieces, { limit: 100 });
}

export function parseGuidanceTopics(guidanceSources, { allowShortLines = false, textCap = 8_000 } = {}) {
  const candidates = [];
  for (const source of guidanceSources) {
    const text = typeof source?.text === 'string' ? source.text.slice(0, textCap) : '';
    if (!text) continue;
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.length > 80 || /^```|^---+$/.test(line)) continue;
      const take = GUIDANCE_BULLET_RE.test(line)
        || (allowShortLines && !line.startsWith('#') && line.length >= 2 && line.length <= 60 && !/[。！？!?]$/.test(line));
      if (!take) continue;
      for (const item of parseFocusText(line, { limit: 20 }).topics) if (item.length <= 60 && !isChapterRefOnly(item)) candidates.push(item);
    }
  }
  return cleanFocusTopics(candidates, { limit: 60 });
}

export function aliasForms(raw) {
  const forms = new Set();
  const push = value => { const cleaned = normSpace(value); if (cleaned && (cleaned.length >= 2 || CJK.test(cleaned))) forms.add(cleaned); };
  for (const form of nameForms(raw)) {
    push(form);
    if (form.includes('/')) for (const piece of splitOutside(form, /\//)) if (piece.length >= 2) push(piece);
  }
  return [...forms];
}

const BUILT_WHITELISTS = new WeakSet();

/** Normalize course glossary / notation-ledger terms into a longest-first whitelist that prevents domain terms from being split. */
export function buildTermWhitelist(entries) {
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
    if (Array.isArray(entry.aliases)) for (const alias of entry.aliases) if (typeof alias === 'string') for (const form of aliasForms(alias)) add(form);
  }
  const built = [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
  BUILT_WHITELISTS.add(built);
  return built;
}

function extractWhitelistedTerms(text, whitelist, out) {
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
export function segmentZhText(raw, { whitelist } = {}) {
  const text = normLower(raw);
  if (!text) return [];
  const terms = buildTermWhitelist(whitelist);
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

export function meaningfulTokens(raw, options = {}) {
  const text = normLower(raw);
  if (!text) return [];
  const terms = buildTermWhitelist(options?.whitelist);
  const out = new Set();
  const residual = extractWhitelistedTerms(text, terms, out);
  for (const match of residual.matchAll(/[a-z][a-z0-9_+-]{2,}/g)) if (!STOPWORDS.has(match[0])) out.add(match[0]);
  for (const token of segmentZhText(residual)) out.add(token);
  return [...out];
}

export function formMatchesText(form, haystackLower, haystackCompact) {
  const needle = normLower(form);
  if (!needle) return false;
  if (ASCII_WORD.test(needle)) return new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'i').test(haystackLower);
  if (haystackLower.includes(needle)) {
    if (/^[a-z0-9]/i.test(needle) && /[a-z0-9]$/i.test(needle)) {
      if (new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'i').test(haystackLower)) return true;
    } else return true;
  }
  const compact = compactKey(needle);
  return compact.length >= 4 && !ASCII_WORD.test(needle) && Boolean(haystackCompact) && haystackCompact.includes(compact);
}

export function titleChapterNum(title) {
  const text = normSpace(title);
  if (!text) return null;
  const en = /^(?:chapters?|ch\.?|lectures?|lec\.?)(?:\s*([0-9]+)|\s+([ivx]{1,5}))\b/i.exec(text);
  if (en) return parseChapterNum(en[1] || en[2]);
  const zh = ZH_TITLE_CH_RE.exec(text);
  if (zh) return parseChapterNum(zh[1]);
  const leading = /^(\d{1,3})\s*[.:：、\s\-—]/.exec(text);
  return leading ? parseChapterNum(leading[1]) : null;
}
