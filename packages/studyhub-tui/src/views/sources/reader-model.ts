import type { KeyHint, UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { LAYOUT_BP } from '../../layout/index.js';
import { MAX_LAST_READ_PAGES } from '../../host/tui-prefs.js';
import { wrapDisplay } from '../../render/cjk.js';

export type ReaderSubMode =
  | 'read'
  | 'jump'
  | 'search'
  | 'ask-input'
  | 'ask-view'
  | 'translate-view'
  | 'outline'
  | 'notes'
  | 'mark'
  | 'glossary';

export interface PageProjection {
  page: number;
  sourceId: string;
  text: string;
  chars: number;
  firstPage: number;
  lastPage: number;
  revision?: string;
  documentId?: string;
  title: string;
  format: string;
}

export interface ReadingChapter {
  id: string;
  title: string;
  level: number;
  startPage: number;
  endPage: number;
}

export interface RawOutlineDocSource {
  id?: string;
  text?: string;
  document?: {
    page?: number;
    chapter?: { index?: number; title?: string; level?: number };
  };
}

export interface RawDocOutlineEntry {
  title?: string;
  level?: number;
  anchor?: { sourceId?: string };
}

export interface SearchHit {
  sourceId: string;
  page?: number;
  snippet: string;
}

export interface TranslationItem {
  key?: string;
  sourceId?: string;
  quote?: string;
  text?: string;
  target?: 'zh' | 'en' | string;
  version?: number;
  outdated?: boolean;
  reused?: boolean;
  warnings?: string[];
}

export interface TranslationListResponse {
  documentId?: string;
  revision?: string;
  target?: 'zh' | 'en';
  items?: TranslationItem[];
  modelAvailable?: boolean;
}

export interface TranslationCounts {
  passages: number;
  translated: number;
  cached: number;
  reused: number;
  skipped: number;
  rejected: number;
  unlocated: number;
  toTranslate: number;
}

export interface TranslationEstimate {
  calls?: { low?: number; high?: number } | number;
  inputTokens?: { low?: number; high?: number } | number;
  outputTokens?: { low?: number; high?: number } | number;
  totalTokens?: { low?: number; high?: number } | number;
}

export interface TranslationResultEntry {
  key?: string;
  sourceId?: string;
  status?: string;
  outdated?: boolean;
  message?: string;
  item?: TranslationItem;
}

export interface TranslationTranslateResponse {
  status?: 'estimate' | 'done' | 'partial' | 'failed' | 'unavailable' | string;
  target?: 'zh' | 'en';
  counts?: Partial<TranslationCounts>;
  modelAvailable?: boolean;
  estimate?: TranslationEstimate;
  results?: TranslationResultEntry[];
  message?: string;
}

export interface PendingTranslateConfirm {
  target: 'zh' | 'en';
  retranslate: boolean;
  counts: TranslationCounts;
  estimate: TranslationEstimate | null;
  modelAvailable: boolean;
}

export interface TranslateMeta {
  target: 'zh' | 'en';
  source: 'cache' | 'fresh' | 'skipped' | 'empty' | 'unavailable' | 'error';
  cachedCount: number;
  freshCount: number;
  reusedCount: number;
  skippedCount: number;
  rejectedCount: number;
  outdatedCount: number;
}

export interface ReaderLayoutMetrics {
  showSide: boolean;
  showBottom: boolean;
  barRows: number;
  bodyH: number;
  readerH: number;
  auxH: number;
  mainW: number;
  auxW: number;
}

const DOC_HEADING_RE = /^ {0,3}(#{1,4})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const DOC_FENCE_RE = /^ {0,3}(?:```|~~~)/;

export const MAX_ANCHOR_SLICE_CHARS = 240;
export const LAST_READ_DEBOUNCE_MS = 400;
export const MAX_LAST_READ_KEY_LENGTH = 160;
export const MAX_LAST_READ_PAGE = 50_000;

/**
 * Extract the first non-whitespace passage slice (up to 240 chars, stopping at the first
 * blank line when present) while preserving exact UTF-16 `start`/`end` offsets in `text`.
 */
export function extractPageAnchorSlice(
  text: string,
): { start: number; end: number; quote: string } | null {
  if (typeof text !== 'string' || !text) return null;
  const start = text.search(/\S/);
  if (start < 0) return null;

  const maxEnd = Math.min(text.length, start + MAX_ANCHOR_SLICE_CHARS);
  const windowText = text.slice(start, maxEnd);
  const blankLine = /\r?\n[ \t]*\r?\n/.exec(windowText);
  let end = blankLine ? start + blankLine.index : maxEnd;

  if (end === maxEnd && end < text.length && end > start + 1) {
    const prevCode = text.charCodeAt(end - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      end -= 1;
    }
  }

  while (end > start && /\s/.test(text[end - 1] ?? '')) {
    end -= 1;
  }
  if (end <= start) return null;

  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  return { start, end, quote };
}

export function finalizeChapterRanges(
  rawRows: Array<{ id: string; title: string; level: number; page: number }>,
  totalPages: number,
): ReadingChapter[] {
  return rawRows
    .filter((r) => r.id && Number.isFinite(r.page))
    .map((row, idx, arr) => {
      const startPage = Math.max(1, Math.floor(row.page));
      let nextSiblingPage: number | null = null;
      for (let j = idx + 1; j < arr.length; j += 1) {
        if (arr[j].level <= row.level) {
          nextSiblingPage = Math.max(1, Math.floor(arr[j].page));
          break;
        }
      }
      const endPage =
        nextSiblingPage !== null
          ? nextSiblingPage > startPage
            ? nextSiblingPage - 1
            : startPage
          : Math.max(startPage, totalPages);
      return {
        id: row.id,
        title: row.title.trim(),
        level: row.level,
        startPage,
        endPage: Math.max(startPage, endPage),
      };
    });
}

export function extractChaptersFromDocument(
  docVal: Record<string, unknown>,
  totalPagesHint: number,
  lang: 'zh' | 'en',
): ReadingChapter[] {
  const sources = Array.isArray(docVal.sources) ? (docVal.sources as RawOutlineDocSource[]) : [];
  const pageMap = new Map<string, number>();
  let maxPage = Math.max(1, totalPagesHint, sources.length);
  sources.forEach((src, idx) => {
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    if (src.id) pageMap.set(src.id, pg);
    if (pg > maxPage) maxPage = pg;
  });

  const outlineObj = docVal.outline as { entries?: RawDocOutlineEntry[] } | undefined;
  if (outlineObj && Array.isArray(outlineObj.entries) && outlineObj.entries.length > 0) {
    const raw = outlineObj.entries.map((entry, idx) => ({
      id: `ai-${idx}`,
      title: String(entry.title ?? ''),
      level: Number(entry.level) || 1,
      page: entry.anchor?.sourceId ? (pageMap.get(entry.anchor.sourceId) ?? 1) : 1,
    }));
    return finalizeChapterRanges(raw, maxPage);
  }

  // Fallback 1: Markdown headings across sources (matches ReaderOutlineDrawer)
  const mdRows: Array<{ id: string; title: string; level: number; page: number }> = [];
  sources.forEach((src, idx) => {
    if (typeof src.text !== 'string' || !src.text) return;
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    let inFence = false;
    let seq = 0;
    for (const rawLine of src.text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (DOC_FENCE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = DOC_HEADING_RE.exec(line);
      if (!m) continue;
      const heading = m[2].replace(/\s+/g, ' ').trim();
      if (!heading) continue;
      seq += 1;
      mdRows.push({
        id: `md-${pg}-${seq}`,
        title: heading,
        level: Math.min(3, m[1].length),
        page: pg,
      });
    }
  });
  if (mdRows.length > 0) {
    return finalizeChapterRanges(mdRows, maxPage);
  }

  // Fallback 2: Converted book document.chapter stamps across sources
  const chapterGroups = new Map<
    number,
    { index: number; title: string; level: number; startPage: number; endPage: number }
  >();
  sources.forEach((src, idx) => {
    const ch = src.document?.chapter;
    const index = Number.isInteger(ch?.index) ? Number(ch?.index) : -1;
    const pg = Number.isInteger(src.document?.page) ? Number(src.document?.page) : idx + 1;
    if (!chapterGroups.has(index)) {
      chapterGroups.set(index, {
        index,
        title: index < 0 ? t(lang, '卷首', 'Front Matter') : String(ch?.title ?? '').trim() || `Ch.${index}`,
        level: index < 0 ? 1 : Number(ch?.level) || 1,
        startPage: pg,
        endPage: pg,
      });
    } else {
      const g = chapterGroups.get(index)!;
      g.startPage = Math.min(g.startPage, pg);
      g.endPage = Math.max(g.endPage, pg);
    }
  });
  if (chapterGroups.size > 1 || (chapterGroups.size === 1 && !chapterGroups.has(-1))) {
    return [...chapterGroups.values()]
      .sort((a, b) => a.startPage - b.startPage || a.index - b.index)
      .map((g) => ({
        id: g.index < 0 ? 'chapter-front' : `chapter-${g.index}`,
        title: g.title,
        level: g.level,
        startPage: g.startPage,
        endPage: g.endPage,
      }));
  }

  return [];
}

export function findChapterForPage(chapters: readonly ReadingChapter[], pageNum: number): ReadingChapter | null {
  if (chapters.length === 0) return null;
  let match: ReadingChapter | null = null;
  for (const ch of chapters) {
    if (pageNum >= ch.startPage && pageNum <= ch.endPage) {
      match = ch;
    }
  }
  return match;
}

export function parsePageRange(pagesStr: unknown, fallbackTotal: number): { first: number; last: number } {
  if (typeof pagesStr === 'string') {
    const m = pagesStr.match(/^(\d+)-(\d+)$/);
    if (m) return { first: Number(m[1]), last: Number(m[2]) };
  }
  return { first: 1, last: Math.max(1, fallbackTotal) };
}

export function buildDocKey(documentId?: string, firstSourceId?: string, title?: string): string {
  const raw = (documentId || firstSourceId || title || '').trim();
  return raw.slice(0, MAX_LAST_READ_KEY_LENGTH);
}

export function buildUpdatedLastReadPages(
  existing: Record<string, number> | undefined,
  docKey: string,
  page: number,
): Record<string, number> {
  const ordered = new Map<string, number>();
  if (existing && typeof existing === 'object') {
    for (const [rawKey, rawVal] of Object.entries(existing)) {
      const key = rawKey.trim();
      if (!key || key.length > MAX_LAST_READ_KEY_LENGTH || key === docKey) continue;
      if (typeof rawVal !== 'number' || !Number.isSafeInteger(rawVal) || rawVal < 1 || rawVal > MAX_LAST_READ_PAGE) {
        continue;
      }
      ordered.set(key, rawVal);
    }
  }
  if (docKey && Number.isSafeInteger(page) && page >= 1 && page <= MAX_LAST_READ_PAGE) {
    ordered.set(docKey, page);
  }
  const entries = [...ordered.entries()];
  const capped = entries.length > MAX_LAST_READ_PAGES ? entries.slice(-MAX_LAST_READ_PAGES) : entries;
  return Object.fromEntries(capped);
}

export function normalizeTranslationCounts(raw?: Partial<TranslationCounts> | null): TranslationCounts {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    passages: num(raw?.passages),
    translated: num(raw?.translated),
    cached: num(raw?.cached),
    reused: num(raw?.reused),
    skipped: num(raw?.skipped),
    rejected: num(raw?.rejected),
    unlocated: num(raw?.unlocated),
    toTranslate: num(raw?.toTranslate),
  };
}

export function formatEstimateRange(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value)).toLocaleString();
  }
  if (value && typeof value === 'object') {
    const obj = value as { low?: unknown; high?: unknown };
    const low = Number(obj.low);
    const high = Number(obj.high);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      const rLow = Math.max(0, Math.round(low));
      const rHigh = Math.max(rLow, Math.round(high));
      return rHigh > rLow ? `${rLow.toLocaleString()}-${rHigh.toLocaleString()}` : rHigh.toLocaleString();
    }
    if (Number.isFinite(high)) return Math.max(0, Math.round(high)).toLocaleString();
    if (Number.isFinite(low)) return Math.max(0, Math.round(low)).toLocaleString();
  }
  return '';
}

export function resolveEstimateTokensText(est: TranslationEstimate | null): string {
  if (!est) return '';
  if (est.totalTokens !== undefined && est.totalTokens !== null) {
    return formatEstimateRange(est.totalTokens);
  }
  const inp = est.inputTokens as { low?: unknown; high?: unknown } | number | undefined;
  const out = est.outputTokens as { low?: unknown; high?: unknown } | number | undefined;
  if (inp && typeof inp === 'object' && out && typeof out === 'object') {
    return formatEstimateRange({
      low: (Number(inp.low) || 0) + (Number(out.low) || 0),
      high: (Number(inp.high) || 0) + (Number(out.high) || 0),
    });
  }
  const total = (Number(inp) || 0) + (Number(out) || 0);
  return total > 0 ? total.toLocaleString() : '';
}

export function formatTranslationEntries(
  entries: Array<{
    quote?: string;
    text?: string;
    outdated?: boolean;
    reused?: boolean;
    warnings?: string[];
    status?: string;
    message?: string;
  }>,
  lang: UiLanguage,
  asciiMode: boolean,
): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    const translated = typeof entry.text === 'string' ? entry.text.trim() : '';
    const quote = typeof entry.quote === 'string' ? entry.quote.trim() : '';
    if (translated) {
      const tags: string[] = [];
      if (entry.outdated) tags.push(t(lang, '[待更新]', '[outdated]'));
      if (entry.reused) tags.push(t(lang, '[复用]', '[reused]'));
      if (Array.isArray(entry.warnings) && entry.warnings.length > 0) {
        tags.push(`[${asciiMode ? '!' : '⚠'} ${entry.warnings.join(', ')}]`);
      }
      const quoteBlock = quote
        ? quote
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : '';
      const bodyBlock = tags.length > 0 ? `${translated}\n\n_${tags.join(' ')}_` : translated;
      blocks.push(quoteBlock ? `${quoteBlock}\n\n${bodyBlock}` : bodyBlock);
    } else if (entry.status === 'rejected' || entry.status === 'unlocated') {
      const errMsg = entry.message || t(lang, '该段落翻译失败', 'Passage translation failed');
      blocks.push(`> [${entry.status}] ${errMsg}`);
    }
  }
  return blocks.join('\n\n---\n\n');
}

export function buildTranslationResultState(
  resVal: TranslationTranslateResponse,
  target: 'zh' | 'en',
  lang: UiLanguage,
  asciiMode: boolean,
): { text: string; meta: TranslateMeta } {
  const counts = normalizeTranslationCounts(resVal.counts);
  const rawResults = Array.isArray(resVal.results) ? resVal.results : [];
  const mapped = rawResults.map((entry) => ({
    quote: entry.item?.quote,
    text: entry.item?.text,
    outdated: Boolean(entry.outdated || entry.item?.outdated),
    reused: Boolean(entry.item?.reused),
    warnings: entry.item?.warnings,
    status: entry.status,
    message: entry.message,
  }));
  const formatted = formatTranslationEntries(mapped, lang, asciiMode);
  const outdatedCount = mapped.filter((m) => m.outdated && Boolean(m.text)).length;

  if (formatted) {
    return {
      text: formatted,
      meta: {
        target,
        source: counts.translated > 0 ? 'fresh' : 'cache',
        cachedCount: counts.cached,
        freshCount: counts.translated,
        reusedCount: counts.reused,
        skippedCount: counts.skipped,
        rejectedCount: counts.rejected + counts.unlocated,
        outdatedCount,
      },
    };
  }
  if (counts.skipped > 0) {
    return {
      text: t(
        lang,
        '本页已是目标语言，无需翻译。',
        'This page is already in the target language; no translation needed.',
      ),
      meta: {
        target,
        source: 'skipped',
        cachedCount: 0,
        freshCount: 0,
        reusedCount: 0,
        skippedCount: counts.skipped,
        rejectedCount: 0,
        outdatedCount: 0,
      },
    };
  }
  return {
    text: resVal.message || t(lang, '本页暂无可翻译段落。', 'No translatable passages on this page.'),
    meta: {
      target,
      source: 'empty',
      cachedCount: 0,
      freshCount: 0,
      reusedCount: 0,
      skippedCount: 0,
      rejectedCount: counts.rejected + counts.unlocated,
      outdatedCount: 0,
    },
  };
}

export function buildCachedTranslationState(
  items: TranslationItem[],
  sourceId: string,
  target: 'zh' | 'en',
  lang: UiLanguage,
  asciiMode: boolean,
): { text: string; meta: TranslateMeta } | null {
  const pageItems = items.filter(
    (item) => item && item.sourceId === sourceId && typeof item.text === 'string' && item.text.trim(),
  );
  if (pageItems.length === 0) return null;
  const formatted = formatTranslationEntries(
    pageItems.map((item) => ({
      quote: item.quote,
      text: item.text,
      outdated: Boolean(item.outdated),
      reused: Boolean(item.reused),
      warnings: item.warnings,
    })),
    lang,
    asciiMode,
  );
  return {
    text: formatted,
    meta: {
      target,
      source: 'cache',
      cachedCount: pageItems.length,
      freshCount: 0,
      reusedCount: pageItems.filter((item) => Boolean(item.reused)).length,
      skippedCount: 0,
      rejectedCount: 0,
      outdatedCount: pageItems.filter((item) => Boolean(item.outdated)).length,
    },
  };
}

export function computeScrollAnchorExcerpt(
  pageText: string,
  pageScrollTop: number,
  subMode: ReaderSubMode,
  width: number,
): { anchorOffset?: number; selectedExcerpt?: string } {
  if (pageScrollTop <= 0 || !pageText) return {};
  const isSide = (subMode === 'ask-view' || subMode === 'translate-view') && width >= LAYOUT_BP.NARROW;
  const readerW = isSide ? Math.max(24, Math.floor(width * 0.56)) : width;
  const textCols = Math.max(11, readerW - 5);
  const wrapped = wrapDisplay(pageText, textCols);
  if (wrapped.length === 0) return {};

  const lineIdx = Math.min(pageScrollTop, wrapped.length - 1);
  let approx = 0;
  for (let i = 0; i < lineIdx; i += 1) approx += wrapped[i].length;
  const ratioOffset = Math.floor((lineIdx / wrapped.length) * pageText.length);
  let offset = Math.min(Math.max(0, Math.min(approx, ratioOffset)), Math.max(0, pageText.length - 1));
  const probe = wrapped
    .slice(lineIdx, lineIdx + 3)
    .map((l) => l.trim())
    .find((l) => l.length >= 6);
  if (probe) {
    const needle = probe.slice(0, 32);
    const foundAt = pageText.indexOf(needle, Math.max(0, offset - 200));
    if (foundAt >= 0) offset = foundAt;
  }
  const relNonWs = pageText.slice(offset).search(/\S/);
  const anchorOffset = relNonWs >= 0 ? offset + relNonWs : offset;
  const selectedExcerpt = pageText.slice(anchorOffset, Math.min(pageText.length, anchorOffset + 360));
  return { anchorOffset, selectedExcerpt };
}

export function computeReaderLayout({
  width,
  height,
  subMode,
  isTyping,
}: {
  width: number;
  height: number;
  subMode: ReaderSubMode;
  isTyping: boolean;
}): ReaderLayoutMetrics {
  const showSide = (subMode === 'ask-view' || subMode === 'translate-view') && width >= LAYOUT_BP.NARROW;
  const showBottom = (subMode === 'ask-view' || subMode === 'translate-view') && width < LAYOUT_BP.NARROW;
  const barRows = isTyping ? 2 : 0;
  const bodyH = Math.max(4, height - 3 - barRows);
  const readerH = showBottom ? Math.max(3, Math.floor(bodyH * 0.52)) : bodyH;
  const auxH = showBottom ? Math.max(3, bodyH - readerH) : bodyH;
  const mainW = showSide ? Math.max(24, Math.floor(width * 0.56)) : width;
  const auxW = showSide ? Math.max(20, width - mainW - 1) : width;
  return { showSide, showBottom, barRows, bodyH, readerH, auxH, mainW, auxW };
}

export function buildReaderFooterHints({
  subMode,
  lang,
  savedCard,
  translateTarget,
  hasChapters,
}: {
  subMode: ReaderSubMode;
  lang: UiLanguage;
  savedCard: boolean;
  translateTarget: 'zh' | 'en';
  hasChapters: boolean;
}): KeyHint[] {
  if (subMode === 'ask-view') {
    return [
      { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
      { key: 's', label: t(lang, '存笔记', 'Save Note') },
      {
        key: 'f',
        label: savedCard ? t(lang, '已存闪卡', 'Card saved') : t(lang, '存为闪卡', 'Save card'),
      },
      { key: 'Esc', label: t(lang, '返回', 'Back') },
    ];
  }
  if (subMode === 'translate-view') {
    return [
      { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
      { key: 'L', label: translateTarget === 'zh' ? '-> en' : '-> zh' },
      { key: 'R', label: t(lang, '重译', 'Retrans') },
      { key: 'Esc', label: t(lang, '返回', 'Back') },
    ];
  }
  return [
    { key: '[/]', label: t(lang, '翻页', 'Page') },
    { key: 'O', label: t(lang, '目录', 'TOC') },
    { key: 'H', label: t(lang, '标记段落', 'Mark') },
    { key: 'G', label: t(lang, '术语译文', 'Glossary') },
    { key: 'B', label: t(lang, '批注', 'Notes') },
    ...(hasChapters ? [{ key: 'M', label: t(lang, '已读', 'Read') }] : []),
    { key: 'a', label: t(lang, '问AI', 'Ask') },
    { key: 't', label: t(lang, '翻译', 'Trans') },
    { key: 'g', label: t(lang, '跳页', 'Go') },
    { key: '/', label: t(lang, '搜索', 'Search') },
    { key: 'm', label: t(lang, '公式', 'Math') },
    { key: 'Q', label: t(lang, '出题', 'Gen') },
    { key: 'p', label: t(lang, '练题', 'Quiz') },
    { key: 'Esc', label: t(lang, '返回', 'Back') },
  ];
}
