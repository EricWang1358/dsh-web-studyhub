import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { computeProseLayout } from '../../components/Layout.js';
import { LAYOUT_BP } from '../../components/layout-tokens.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { ScrollView } from '../../components/ScrollView.js';
import { TextInput } from '../../components/TextInput.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { errorMessage, startReview, tryAction } from '../../host/sample-actions.js';
import { MAX_LAST_READ_PAGES, saveTuiPreferences } from '../../host/tui-prefs.js';
import { wrapDisplay } from '../../render/cjk.js';
import { formatLongformProse, formatReadingTimeLabel } from '../../render/longform.js';
import { readWholePage, readWholeSource, type WholeText } from './page-loader.js';

const ReaderOutlineDrawer = lazy(() =>
  import('./ReaderOutlineDrawer.js').then((m) => ({ default: m.ReaderOutlineDrawer })),
);
const ReaderNotesDrawer = lazy(() =>
  import('./ReaderNotesDrawer.js').then((m) => ({ default: m.ReaderNotesDrawer })),
);
const MarkPassageModal = lazy(() =>
  import('./MarkPassageModal.js').then((m) => ({ default: m.MarkPassageModal })),
);
const TranslationGlossaryModal = lazy(() =>
  import('./TranslationGlossaryModal.js').then((m) => ({ default: m.TranslationGlossaryModal })),
);

export interface DocumentReaderProps {
  host: HostClient;
  sourceId?: string;
  documentId?: string;
  initialPage?: number;
  initialTitle?: string;
  initialFormat?: string;
  initialCourse?: string;
  totalPagesHint?: number;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
}

type ReaderSubMode =
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

interface PageProjection {
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

interface ReadingChapter {
  id: string;
  title: string;
  level: number;
  startPage: number;
  endPage: number;
}

interface RawOutlineDocSource {
  id?: string;
  text?: string;
  document?: {
    page?: number;
    chapter?: { index?: number; title?: string; level?: number };
  };
}

interface RawDocOutlineEntry {
  title?: string;
  level?: number;
  anchor?: { sourceId?: string };
}

const DOC_HEADING_RE = /^ {0,3}(#{1,4})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const DOC_FENCE_RE = /^ {0,3}(?:```|~~~)/;
const MAX_ANCHOR_SLICE_CHARS = 240;

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

function finalizeChapterRanges(
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

function extractChaptersFromDocument(
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
  const chapterGroups = new Map<number, { index: number; title: string; level: number; startPage: number; endPage: number }>();
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

function parsePageRange(pagesStr: unknown, fallbackTotal: number): { first: number; last: number } {
  if (typeof pagesStr === 'string') {
    const m = pagesStr.match(/^(\d+)-(\d+)$/);
    if (m) return { first: Number(m[1]), last: Number(m[2]) };
  }
  return { first: 1, last: Math.max(1, fallbackTotal) };
}

const LAST_READ_DEBOUNCE_MS = 400;
const MAX_LAST_READ_KEY_LENGTH = 160;
const MAX_LAST_READ_PAGE = 50_000;

function buildDocKey(documentId?: string, firstSourceId?: string, title?: string): string {
  const raw = (documentId || firstSourceId || title || '').trim();
  return raw.slice(0, MAX_LAST_READ_KEY_LENGTH);
}

function buildUpdatedLastReadPages(
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

interface TranslationItem {
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

interface TranslationListResponse {
  documentId?: string;
  revision?: string;
  target?: 'zh' | 'en';
  items?: TranslationItem[];
  modelAvailable?: boolean;
}

interface TranslationCounts {
  passages: number;
  translated: number;
  cached: number;
  reused: number;
  skipped: number;
  rejected: number;
  unlocated: number;
  toTranslate: number;
}

interface TranslationEstimate {
  calls?: { low?: number; high?: number } | number;
  inputTokens?: { low?: number; high?: number } | number;
  outputTokens?: { low?: number; high?: number } | number;
  totalTokens?: { low?: number; high?: number } | number;
}

interface TranslationResultEntry {
  key?: string;
  sourceId?: string;
  status?: string;
  outdated?: boolean;
  message?: string;
  item?: TranslationItem;
}

interface TranslationTranslateResponse {
  status?: 'estimate' | 'done' | 'partial' | 'failed' | 'unavailable' | string;
  target?: 'zh' | 'en';
  counts?: Partial<TranslationCounts>;
  modelAvailable?: boolean;
  estimate?: TranslationEstimate;
  results?: TranslationResultEntry[];
  message?: string;
}

interface PendingTranslateConfirm {
  target: 'zh' | 'en';
  retranslate: boolean;
  counts: TranslationCounts;
  estimate: TranslationEstimate | null;
  modelAvailable: boolean;
}

interface TranslateMeta {
  target: 'zh' | 'en';
  source: 'cache' | 'fresh' | 'skipped' | 'empty' | 'unavailable' | 'error';
  cachedCount: number;
  freshCount: number;
  reusedCount: number;
  skippedCount: number;
  rejectedCount: number;
  outdatedCount: number;
}

function normalizeTranslationCounts(raw?: Partial<TranslationCounts> | null): TranslationCounts {
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

function formatEstimateRange(value: unknown): string {
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

function resolveEstimateTokensText(est: TranslationEstimate | null): string {
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

function formatTranslationEntries(
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

export const DocumentReader = memo(function DocumentReader({
  host,
  sourceId,
  documentId,
  initialPage = 1,
  initialTitle = '',
  initialFormat = 'text',
  initialCourse,
  totalPagesHint = 1,
  width,
  height,
  isActive,
  onClose,
}: DocumentReaderProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const setSnapshot = useTuiStore((s) => s.setSnapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const [currentPage, setCurrentPage] = useState(Math.max(1, initialPage));
  // Memory NFR: hold ONLY the currently viewed page window locally, cleared on unmount.
  const [pageData, setPageData] = useState<PageProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [subMode, setSubMode] = useState<ReaderSubMode>('read');
  const [jumpInput, setJumpInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [searchHits, setSearchHits] = useState<Array<{ sourceId: string; page?: number; snippet: string }>>([]);

  const [askQuestion, setAskQuestion] = useState('');
  const {
    text: aiAnswer,
    push: pushAiAnswer,
    set: setAiAnswer,
    finish: finishAiAnswer,
    reset: resetAiAnswer,
  } = useStreamingBuffer();
  const [aiBusy, setAiBusy] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingCard, setSavingCard] = useState(false);
  const [savedCard, setSavedCard] = useState(false);
  const saveCardBusyRef = useRef(false);
  const {
    text: translationText,
    set: setTranslationText,
    finish: finishTranslation,
    reset: resetTranslation,
  } = useStreamingBuffer();
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateTarget, setTranslateTarget] = useState<'zh' | 'en'>(() => (lang === 'en' ? 'en' : 'zh'));
  const [translateMeta, setTranslateMeta] = useState<TranslateMeta | null>(null);
  const [pendingTranslateConfirm, setPendingTranslateConfirm] = useState<PendingTranslateConfirm | null>(null);
  const [pageScrollTop, setPageScrollTop] = useState(0);

  const [chapters, setChapters] = useState<ReadingChapter[]>([]);
  const [readChapterIds, setReadChapterIds] = useState<Set<string>>(() => new Set());
  const [outlineRefreshTick, setOutlineRefreshTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const translateRequestIdRef = useRef<string | null>(null);
  const translateInFlightRef = useRef(false);
  const translateSeqRef = useRef(0);
  const pageKeyRef = useRef('');
  pageKeyRef.current = pageData ? `${pageData.documentId ?? ''}|${pageData.sourceId}|${pageData.page}` : '';
  const mountedRef = useRef(true);
  const readingBusyRef = useRef(false);
  const readingTargetRef = useRef<{ documentId?: string; sourceId?: string; revision?: string }>({});
  const firstSourceIdRef = useRef<string | undefined>(sourceId);
  const resumeCheckedRef = useRef(false);
  const userNavigatedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistRef = useRef<{ docKey: string; page: number } | null>(null);
  const lastPersistedRef = useRef<{ docKey: string; page: number } | null>(null);

  const clearPersistTimer = useCallback(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  const flushPendingPersist = useCallback(() => {
    clearPersistTimer();
    const pending = pendingPersistRef.current;
    if (!pending) return;
    pendingPersistRef.current = null;
    const { docKey, page } = pending;
    if (!docKey || !Number.isSafeInteger(page) || page < 1 || page > MAX_LAST_READ_PAGE) return;
    if (
      lastPersistedRef.current &&
      lastPersistedRef.current.docKey === docKey &&
      lastPersistedRef.current.page === page
    ) {
      return;
    }
    lastPersistedRef.current = { docKey, page };
    const currentPrefs = useTuiStore.getState().preferences;
    const nextLastReadPages = buildUpdatedLastReadPages(currentPrefs.lastReadPages, docKey, page);
    setPreferences({ lastReadPages: nextLastReadPages });
    const dshHome = (host as { dshHome?: string }).dshHome;
    void saveTuiPreferences(
      { lastReadPages: nextLastReadPages },
      dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
    ).catch(() => {});
  }, [clearPersistTimer, host, setPreferences]);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const cancelActiveTranslation = useCallback(() => {
    translateSeqRef.current += 1;
    const reqId = translateRequestIdRef.current;
    translateRequestIdRef.current = null;
    translateInFlightRef.current = false;
    if (reqId) {
      void tryAction(host, 'materials.translation.cancel', { requestId: reqId }).catch(() => {});
    }
  }, [host]);

  // Clear local page/drawer buffers, flush any pending last-read page, and abort any active AI stream on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushPendingPersist();
      cancelActiveTranslation();
      abortInFlight();
      setPageData(null);
      setSearchHits([]);
      setChapters([]);
      setReadChapterIds(new Set());
      setPendingTranslateConfirm(null);
      setTranslateMeta(null);
      setSubMode('read');
      setSavingNote(false);
      setSavingCard(false);
      setSavedCard(false);
    };
  }, [abortInFlight, cancelActiveTranslation, flushPendingPersist]);

  // Reset page and resume tracking when target source/document changes.
  useEffect(() => {
    flushPendingPersist();
    firstSourceIdRef.current = sourceId;
    resumeCheckedRef.current = false;
    userNavigatedRef.current = false;
    lastPersistedRef.current = null;
    setCurrentPage(Math.max(1, initialPage));
  }, [sourceId, documentId, initialPage, flushPendingPersist]);

  // Abort any in-flight AI stream and reset coalesced buffers on page or document change.
  useEffect(() => {
    cancelActiveTranslation();
    abortInFlight();
    setAiBusy(false);
    setSavingCard(false);
    setSavedCard(false);
    setTranslateBusy(false);
    setPendingTranslateConfirm(null);
    setTranslateMeta(null);
    resetAiAnswer();
    resetTranslation();
    setSubMode((m) => (m === 'translate-view' || m === 'ask-view' ? 'read' : m));
  }, [sourceId, documentId, currentPage, abortInFlight, cancelActiveTranslation, resetAiAnswer, resetTranslation]);

  // Load current page window on demand.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPageScrollTop(0);

    const loadPage = async () => {
      let docMeta: {
        documentId?: string;
        firstSourceId?: string;
        revision?: string;
        title?: string;
        format?: string;
        totalPages?: number;
      } = {};

      if (documentId || sourceId) {
        const metaRes = await tryAction<Record<string, unknown>>(host, 'materials.document.get', {
          ...(documentId ? { documentId } : {}),
          ...(sourceId ? { sourceId } : {}),
        });
        if (metaRes.ok && metaRes.value) {
          const metaSources = Array.isArray(metaRes.value.sources)
            ? (metaRes.value.sources as Array<{ id?: unknown }>)
            : [];
          const metaFirstSourceId = typeof metaSources[0]?.id === 'string' ? metaSources[0].id : undefined;
          if (metaFirstSourceId) {
            firstSourceIdRef.current = metaFirstSourceId;
          }
          docMeta = {
            documentId:
              typeof metaRes.value.documentId === 'string'
                ? metaRes.value.documentId
                : typeof metaRes.value.id === 'string'
                  ? metaRes.value.id
                  : documentId,
            firstSourceId: metaFirstSourceId,
            revision:
              typeof metaRes.value.currentRevision === 'string'
                ? metaRes.value.currentRevision
                : typeof metaRes.value.revision === 'string'
                  ? metaRes.value.revision
                  : undefined,
            title: typeof metaRes.value.title === 'string' ? metaRes.value.title : undefined,
            format: typeof metaRes.value.format === 'string' ? metaRes.value.format : undefined,
          };
        }
      }

      const targetFrom = currentPage;
      const pageTarget = {
        ...(docMeta.documentId ? { documentId: docMeta.documentId } : documentId ? { documentId } : {}),
        ...(sourceId && !docMeta.documentId && !documentId ? { sourceId } : {}),
      };
      // #1418: a slice that failed to arrive is said out loud at the end of the page.
      const shownText = (whole: WholeText): string => {
        if (!whole.incomplete) return whole.text;
        const note = whole.hitLimit
          ? t(lang, '（这一页太长，这里只显示了前面的部分。）', '(This page is too long; only the first part is shown.)')
          : t(lang, '（后面的内容没有读出来，重新打开这份资料可以重试。）', '(The rest could not be read. Reopen this material to retry.)');
        return `${whole.text}\n\n${note}`;
      };
      const pagesRes = await tryAction<Record<string, unknown>>(host, 'source.pages', {
        ...pageTarget,
        from: targetFrom,
        to: targetFrom,
      });

      if (cancelled) return;

      if (pagesRes.ok && pagesRes.value) {
        const val = pagesRes.value;
        const shown = Array.isArray(val.shown) ? (val.shown as Array<Record<string, unknown>>) : [];
        const firstShown = shown[0];
        const { first, last } = parsePageRange(val.pages, Math.max(totalPagesHint, targetFrom));
        if (firstShown) {
          const resolvedDocId = docMeta.documentId || (typeof val.documentId === 'string' ? val.documentId : documentId);
          const resolvedFirstSourceId =
            docMeta.firstSourceId || firstSourceIdRef.current || sourceId || String(firstShown.sourceId ?? '');
          const resolvedTitle = docMeta.title || String(val.title || initialTitle || '文档阅读');
          const resolvedDocKey = buildDocKey(resolvedDocId, resolvedFirstSourceId, resolvedTitle);
          const hasExplicitPage = initialPage > 1;
          if (!hasExplicitPage && !resumeCheckedRef.current && !userNavigatedRef.current) {
            resumeCheckedRef.current = true;
            const savedPage = resolvedDocKey
              ? useTuiStore.getState().preferences.lastReadPages?.[resolvedDocKey]
              : undefined;
            if (
              last > 1 &&
              typeof savedPage === 'number' &&
              Number.isSafeInteger(savedPage) &&
              savedPage > 1 &&
              savedPage <= last &&
              savedPage !== targetFrom
            ) {
              lastPersistedRef.current = { docKey: resolvedDocKey, page: savedPage };
              setCurrentPage(savedPage);
              notify(
                t(lang, `已恢复到上次阅读第 ${savedPage} 页`, `Resumed at page ${savedPage}`),
                'info',
              );
              return;
            }
          }
          // #1418: `source.pages` hands out about 6000 characters a call; read the page to its end.
          const wholePage = await readWholePage(
            (sliceArgs) => tryAction<Record<string, unknown>>(host, 'source.pages', { ...pageTarget, ...sliceArgs }),
            val,
            () => cancelled,
          );
          if (cancelled) return;
          setPageData({
            page: Number(firstShown.page ?? targetFrom),
            sourceId: String(firstShown.sourceId ?? sourceId ?? ''),
            text: shownText(wholePage),
            chars: Number(firstShown.chars ?? 0),
            firstPage: first,
            lastPage: last,
            revision: docMeta.revision,
            documentId: resolvedDocId,
            title: resolvedTitle,
            format: docMeta.format || initialFormat,
          });
          setLoading(false);
          return;
        }
      }

      // Fallback to source.get for single-source or non-paged items
      const fallbackId = sourceId;
      if (fallbackId) {
        const getRes = await tryAction<Record<string, unknown>>(host, 'source.get', {
          id: fallbackId,
          offset: 0,
          limit: 20000,
        });
        if (cancelled) return;
        if (getRes.ok && getRes.value) {
          const val = getRes.value;
          const wholeSource = await readWholeSource(
            (sliceArgs) => tryAction<Record<string, unknown>>(host, 'source.get', { id: fallbackId, ...sliceArgs }),
            val,
            () => cancelled,
          );
          if (cancelled) return;
          setPageData({
            page: 1,
            sourceId: String(val.id ?? fallbackId),
            text: shownText(wholeSource),
            chars: Number(val.chars ?? 0),
            firstPage: 1,
            lastPage: 1,
            revision: docMeta.revision,
            documentId: docMeta.documentId || documentId,
            title: docMeta.title || String(val.title || initialTitle || '文档阅读'),
            format: docMeta.format || initialFormat,
          });
          setLoading(false);
          return;
        }
      }

      setLoadError(
        pagesRes.error?.message ||
          t(lang, '无法读取该页内容', 'Unable to load this page'),
      );
      setLoading(false);
    };

    void loadPage();
    return () => {
      cancelled = true;
    };
  }, [host, documentId, sourceId, currentPage, initialPage, initialTitle, initialFormat, totalPagesHint, lang, notify]);

  // Debounce-persist last-read page on user navigation (flushed on close/unmount).
  useEffect(() => {
    if (!userNavigatedRef.current) return;
    const totalPages = Math.max(pageData?.lastPage ?? 1, totalPagesHint);
    if (totalPages <= 1) return;
    const docKey = buildDocKey(
      pageData?.documentId || readingTargetRef.current.documentId || documentId,
      firstSourceIdRef.current || sourceId,
      pageData?.title || initialTitle,
    );
    if (!docKey) return;
    const targetPage = currentPage;
    if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_LAST_READ_PAGE) return;
    if (
      lastPersistedRef.current &&
      lastPersistedRef.current.docKey === docKey &&
      lastPersistedRef.current.page === targetPage
    ) {
      pendingPersistRef.current = null;
      clearPersistTimer();
      return;
    }
    pendingPersistRef.current = { docKey, page: targetPage };
    clearPersistTimer();
    persistTimerRef.current = setTimeout(() => {
      flushPendingPersist();
    }, LAST_READ_DEBOUNCE_MS);
  }, [
    clearPersistTimer,
    currentPage,
    documentId,
    flushPendingPersist,
    initialTitle,
    pageData?.documentId,
    pageData?.lastPage,
    pageData?.title,
    sourceId,
    totalPagesHint,
  ]);

  // Load outline chapters + Web-parity reading progress (fail-soft for legacy or un-outlined sources).
  useEffect(() => {
    let cancelled = false;
    if (!documentId && !sourceId) {
      setChapters([]);
      setReadChapterIds(new Set());
      return;
    }

    const loadOutlineAndReading = async () => {
      try {
        const metaRes = await tryAction<Record<string, unknown>>(host, 'materials.document.get', {
          ...(documentId ? { documentId } : {}),
          ...(sourceId ? { sourceId } : {}),
        });
        if (cancelled || !mountedRef.current) return;
        if (!metaRes.ok || !metaRes.value) {
          setChapters([]);
          setReadChapterIds(new Set());
          return;
        }

        const val = metaRes.value;
        const resolvedDocId =
          typeof val.documentId === 'string'
            ? val.documentId
            : typeof val.id === 'string'
              ? val.id
              : documentId;
        const resolvedRev =
          typeof val.revision === 'string'
            ? val.revision
            : typeof val.currentRevision === 'string'
              ? val.currentRevision
              : undefined;
        const sources = Array.isArray(val.sources) ? (val.sources as RawOutlineDocSource[]) : [];
        const resolvedSrcId = sourceId || (typeof sources[0]?.id === 'string' ? sources[0].id : undefined);

        readingTargetRef.current = {
          documentId: resolvedDocId,
          sourceId: resolvedSrcId,
          revision: resolvedRev,
        };

        const extracted = extractChaptersFromDocument(val, totalPagesHint, lang);
        setChapters(extracted);

        if (extracted.length === 0) {
          setReadChapterIds(new Set());
          return;
        }

        const chapterRefs = extracted.map(({ id, title, startPage, endPage }) => ({
          id,
          title,
          startPage,
          endPage,
        }));
        const readRes = await tryAction<{ read?: unknown[] }>(host, 'materials.reading.get', {
          ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
          ...(resolvedSrcId ? { sourceId: resolvedSrcId } : {}),
          ...(resolvedRev ? { revision: resolvedRev } : {}),
          chapters: chapterRefs,
        });
        if (cancelled || !mountedRef.current) return;
        if (readRes.ok && Array.isArray(readRes.value?.read)) {
          setReadChapterIds(new Set(readRes.value.read.filter((id): id is string => typeof id === 'string')));
        } else {
          setReadChapterIds(new Set());
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setReadChapterIds(new Set());
        }
      }
    };

    void loadOutlineAndReading();
    return () => {
      cancelled = true;
    };
  }, [host, documentId, sourceId, totalPagesHint, outlineRefreshTick, lang]);

  const activePageNum = pageData?.page ?? currentPage;
  const currentChapter = useMemo(() => {
    if (chapters.length === 0) return null;
    let match: ReadingChapter | null = null;
    for (const ch of chapters) {
      if (activePageNum >= ch.startPage && activePageNum <= ch.endPage) {
        match = ch;
      }
    }
    return match;
  }, [chapters, activePageNum]);

  const readCount = useMemo(
    () => chapters.reduce((acc, ch) => (readChapterIds.has(ch.id) ? acc + 1 : acc), 0),
    [chapters, readChapterIds],
  );
  const currentChapterRead = Boolean(currentChapter && readChapterIds.has(currentChapter.id));

  const toggleChapterRead = useCallback(
    async (
      chapter: { id: string; title: string; startPage: number; endPage: number },
      overrideChapters?: Array<{ id: string; title: string; startPage: number; endPage: number }>,
    ) => {
      if (readingBusyRef.current) return;
      const docId = pageData?.documentId || readingTargetRef.current.documentId || documentId;
      const srcId = pageData?.sourceId || readingTargetRef.current.sourceId || sourceId;
      const rev = pageData?.revision || readingTargetRef.current.revision;
      if (!docId && !srcId) {
        notify(t(lang, '缺少文档标识，无法保存阅读进度', 'Missing document identifier'), 'warning');
        return;
      }

      const wasRead = readChapterIds.has(chapter.id);
      const nextRead = !wasRead;
      const prevSet = readChapterIds;

      const optimistic = new Set(prevSet);
      if (nextRead) optimistic.add(chapter.id);
      else optimistic.delete(chapter.id);
      setReadChapterIds(optimistic);
      readingBusyRef.current = true;

      const refPayload = {
        id: chapter.id,
        title: chapter.title,
        startPage: chapter.startPage,
        endPage: chapter.endPage,
      };
      const baseList =
        overrideChapters && overrideChapters.length > 0
          ? overrideChapters
          : chapters.map(({ id, title, startPage, endPage }) => ({ id, title, startPage, endPage }));
      const allRefs = baseList.some((c) => c.id === chapter.id) ? baseList : [...baseList, refPayload];

      try {
        const res = await tryAction<{ read?: unknown[]; saved?: boolean }>(host, 'materials.reading.save', {
          ...(docId ? { documentId: docId } : {}),
          ...(srcId ? { sourceId: srcId } : {}),
          ...(rev ? { revision: rev } : {}),
          chapters: allRefs,
          read: nextRead ? [refPayload] : [],
          unread: nextRead ? [] : [refPayload],
        });
        if (!mountedRef.current) return;
        if (!res.ok || res.value?.saved === false) {
          setReadChapterIds(prevSet);
          notify(
            res.error?.message || t(lang, '保存阅读进度失败', 'Failed to save reading progress'),
            'error',
          );
          return;
        }
        if (Array.isArray(res.value?.read)) {
          setReadChapterIds(new Set(res.value.read.filter((id): id is string => typeof id === 'string')));
        }
        const shortTitle = chapter.title ? ` (${chapter.title.slice(0, 24)})` : '';
        notify(
          nextRead
            ? t(lang, `已标记章节为已读${shortTitle}`, `Marked chapter read${shortTitle}`)
            : t(lang, `已取消章节已读标记${shortTitle}`, `Marked chapter unread${shortTitle}`),
          'success',
        );
      } catch (err) {
        if (mountedRef.current) {
          setReadChapterIds(prevSet);
          notify(errorMessage(err), 'error');
        }
      } finally {
        readingBusyRef.current = false;
      }
    },
    [chapters, documentId, host, lang, notify, pageData, readChapterIds, sourceId],
  );

  const runSearch = useCallback(
    async (query: string) => {
      const q = query.trim();
      setActiveSearch(q);
      setSubMode('read');
      if (!q) {
        setSearchHits([]);
        return;
      }
      const targetIds = pageData?.sourceId ? [pageData.sourceId] : sourceId ? [sourceId] : undefined;
      const res = await tryAction<{ matches?: Array<Record<string, unknown>> }>(host, 'source.search', {
        query: q,
        ...(targetIds && !pageData?.documentId ? { sourceIds: targetIds } : {}),
        limit: 8,
      });
      if (res.ok && res.value && Array.isArray(res.value.matches)) {
        const hits = res.value.matches.map((m) => ({
          sourceId: String(m.id ?? m.sourceId ?? ''),
          page: typeof m.page === 'number' ? m.page : undefined,
          snippet: String(m.snippet ?? m.text ?? '').slice(0, 120),
        }));
        setSearchHits(hits);
        if (hits.length > 0 && hits[0].page && hits[0].page !== currentPage) {
          userNavigatedRef.current = true;
          setCurrentPage(hits[0].page);
        }
      } else {
        setSearchHits([]);
      }
    },
    [host, pageData, sourceId, currentPage],
  );

  const runAskAi = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !pageData) return;
      abortInFlight();
      const ac = new AbortController();
      abortRef.current = ac;
      setSubMode('ask-view');
      setAiBusy(true);
      setSavedCard(false);
      resetAiAnswer();

      try {
        if (typeof host.streamComplete === 'function') {
          const system = t(
            lang,
            '你是 StudyHub 终端助教。请严格基于提供的当前页面内容回答用户问题；如需补充通用背景，请明确标注。使用简洁 Markdown 输出。',
            'You are the StudyHub terminal tutor. Answer based strictly on the provided page text; clearly mark any general background knowledge. Output concise Markdown.',
          );
          const prompt = `Document: ${pageData.title} (Page ${pageData.page}/${pageData.lastPage})\n\n--- PAGE TEXT ---\n${pageData.text.slice(0, 14000)}\n--- END ---\n\nQuestion: ${q}`;
          const final = await host.streamComplete({
            system,
            prompt,
            signal: ac.signal,
            onChunk: (delta) => {
              if (ac.signal.aborted) return;
              pushAiAnswer(delta);
            },
          });
          if (!ac.signal.aborted) {
            if (final) setAiAnswer(final);
            finishAiAnswer();
          }
        } else {
          const res = await tryAction<Record<string, unknown>>(host, 'materials.selection.ask', {
            scope: 'page',
            selection: {
              ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
              ...(pageData.revision ? { revision: pageData.revision } : {}),
              sourceId: pageData.sourceId,
              page: pageData.page,
            },
            question: q,
          });
          if (!ac.signal.aborted) {
            if (res.ok && res.value) {
              setAiAnswer(String(res.value.answer ?? res.value.message ?? ''));
            } else {
              setAiAnswer(`${asciiMode ? 'x' : '✕'} ${res.error?.message || t(lang, 'AI 回答失败', 'AI request failed')}`);
            }
            finishAiAnswer();
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          setAiAnswer(`${asciiMode ? 'x' : '✕'} ${errorMessage(err)}`);
          finishAiAnswer();
        }
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
          finishAiAnswer();
          if (!ac.signal.aborted) setAiBusy(false);
        } else if (ac.signal.aborted && !abortRef.current) {
          finishAiAnswer();
        }
      }
    },
    [abortInFlight, asciiMode, finishAiAnswer, host, lang, pageData, pushAiAnswer, resetAiAnswer, setAiAnswer],
  );

  const applyTranslationResults = useCallback(
    (resVal: TranslationTranslateResponse, target: 'zh' | 'en') => {
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

      resetTranslation();
      if (formatted) {
        setTranslationText(formatted);
        setTranslateMeta({
          target,
          source: counts.translated > 0 ? 'fresh' : 'cache',
          cachedCount: counts.cached,
          freshCount: counts.translated,
          reusedCount: counts.reused,
          skippedCount: counts.skipped,
          rejectedCount: counts.rejected + counts.unlocated,
          outdatedCount,
        });
      } else if (counts.skipped > 0) {
        setTranslationText(
          t(
            lang,
            '本页已是目标语言，无需翻译。',
            'This page is already in the target language; no translation needed.',
          ),
        );
        setTranslateMeta({
          target,
          source: 'skipped',
          cachedCount: 0,
          freshCount: 0,
          reusedCount: 0,
          skippedCount: counts.skipped,
          rejectedCount: 0,
          outdatedCount: 0,
        });
      } else {
        setTranslationText(
          resVal.message || t(lang, '本页暂无可翻译段落。', 'No translatable passages on this page.'),
        );
        setTranslateMeta({
          target,
          source: 'empty',
          cachedCount: 0,
          freshCount: 0,
          reusedCount: 0,
          skippedCount: 0,
          rejectedCount: counts.rejected + counts.unlocated,
          outdatedCount: 0,
        });
      }
      finishTranslation();
    },
    [asciiMode, finishTranslation, lang, resetTranslation, setTranslationText],
  );

  const openTranslatePage = useCallback(
    async (target: 'zh' | 'en', retranslate = false) => {
      if (!pageData || !pageData.sourceId) {
        notify(t(lang, '当前页内容尚未加载完成', 'Page content not loaded yet'), 'info');
        return;
      }
      if (translateInFlightRef.current || translateBusy) return;

      const expectedPageKey = `${pageData.documentId ?? ''}|${pageData.sourceId}|${pageData.page}`;
      const seq = ++translateSeqRef.current;
      translateInFlightRef.current = true;
      setTranslateTarget(target);
      setPendingTranslateConfirm(null);

      const locator = {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
        ...(pageData.revision ? { revision: pageData.revision } : {}),
      };

      try {
        if (!retranslate) {
          const listRes = await tryAction<TranslationListResponse>(host, 'materials.translation.list', {
            ...locator,
            target,
          });
          if (!mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) return;
          if (listRes.ok && listRes.value && Array.isArray(listRes.value.items)) {
            const pageItems = listRes.value.items.filter(
              (item) => item && item.sourceId === pageData.sourceId && typeof item.text === 'string' && item.text.trim(),
            );
            if (pageItems.length > 0) {
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
              resetTranslation();
              setTranslationText(formatted);
              finishTranslation();
              setTranslateMeta({
                target,
                source: 'cache',
                cachedCount: pageItems.length,
                freshCount: 0,
                reusedCount: pageItems.filter((item) => Boolean(item.reused)).length,
                skippedCount: 0,
                rejectedCount: 0,
                outdatedCount: pageItems.filter((item) => Boolean(item.outdated)).length,
              });
              setTranslateBusy(false);
              setSubMode('translate-view');
              return;
            }
          }
        }

        const estRes = await tryAction<TranslationTranslateResponse>(host, 'materials.translation.translate', {
          ...locator,
          scope: { sourceIds: [pageData.sourceId] },
          target,
          estimate: true,
          ...(retranslate ? { retranslate: true } : {}),
        });
        if (!mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) return;

        if (!estRes.ok || !estRes.value) {
          notify(estRes.error?.message || t(lang, '获取翻译估算失败', 'Failed to estimate translation'), 'error');
          return;
        }

        const counts = normalizeTranslationCounts(estRes.value.counts);
        if (counts.toTranslate === 0) {
          if (counts.reused > 0 || counts.cached > 0) {
            const reuseRes = await tryAction<TranslationTranslateResponse>(host, 'materials.translation.translate', {
              ...locator,
              scope: { sourceIds: [pageData.sourceId] },
              target,
              ...(retranslate ? { retranslate: true } : {}),
            });
            if (!mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) return;
            if (reuseRes.ok && reuseRes.value) {
              applyTranslationResults(reuseRes.value, target);
              setSubMode('translate-view');
            } else {
              notify(reuseRes.error?.message || t(lang, '加载译文失败', 'Failed to load translations'), 'error');
            }
            return;
          }

          resetTranslation();
          setTranslationText(
            counts.skipped > 0
              ? t(
                  lang,
                  '本页已是目标语言，无需翻译。',
                  'This page is already in the target language; no translation needed.',
                )
              : t(lang, '本页暂无可翻译段落。', 'No translatable passages on this page.'),
          );
          finishTranslation();
          setTranslateMeta({
            target,
            source: counts.skipped > 0 ? 'skipped' : 'empty',
            cachedCount: 0,
            freshCount: 0,
            reusedCount: 0,
            skippedCount: counts.skipped,
            rejectedCount: 0,
            outdatedCount: 0,
          });
          setTranslateBusy(false);
          setSubMode('translate-view');
          return;
        }

        setPendingTranslateConfirm({
          target,
          retranslate,
          counts,
          estimate: estRes.value.estimate ?? null,
          modelAvailable: estRes.value.modelAvailable !== false,
        });
      } catch (err) {
        if (mountedRef.current && seq === translateSeqRef.current) {
          notify(errorMessage(err), 'error');
        }
      } finally {
        if (seq === translateSeqRef.current) {
          translateInFlightRef.current = false;
        }
      }
    },
    [
      applyTranslationResults,
      asciiMode,
      finishTranslation,
      host,
      lang,
      notify,
      pageData,
      resetTranslation,
      setTranslationText,
      translateBusy,
    ],
  );

  const executeConfirmedTranslate = useCallback(
    async (confirm: PendingTranslateConfirm) => {
      if (!pageData || !pageData.sourceId || translateInFlightRef.current) return;
      const expectedPageKey = `${pageData.documentId ?? ''}|${pageData.sourceId}|${pageData.page}`;
      const seq = ++translateSeqRef.current;
      const requestId = `tui-tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setPendingTranslateConfirm(null);
      abortInFlight();
      const ac = new AbortController();
      abortRef.current = ac;
      translateRequestIdRef.current = requestId;
      translateInFlightRef.current = true;
      setTranslateTarget(confirm.target);
      setTranslateMeta(null);
      setSubMode('translate-view');
      setTranslateBusy(true);
      resetTranslation();

      const locator = {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
        ...(pageData.revision ? { revision: pageData.revision } : {}),
      };

      try {
        const res = await tryAction<TranslationTranslateResponse>(host, 'materials.translation.translate', {
          ...locator,
          scope: { sourceIds: [pageData.sourceId] },
          target: confirm.target,
          ...(confirm.retranslate ? { retranslate: true } : {}),
          requestId,
        });
        if (ac.signal.aborted || !mountedRef.current || seq !== translateSeqRef.current || pageKeyRef.current !== expectedPageKey) {
          return;
        }
        if (res.ok && res.value) {
          if (res.value.status === 'unavailable') {
            setTranslationText(
              res.value.message ||
                t(
                  lang,
                  '未配置可用的翻译模型，请先在设置中配置模型。',
                  'No model available for translation. Please configure a model in Settings.',
                ),
            );
            setTranslateMeta({
              target: confirm.target,
              source: 'unavailable',
              cachedCount: 0,
              freshCount: 0,
              reusedCount: 0,
              skippedCount: 0,
              rejectedCount: 0,
              outdatedCount: 0,
            });
            finishTranslation();
          } else {
            applyTranslationResults(res.value, confirm.target);
          }
        } else {
          setTranslationText(`${asciiMode ? 'x' : '✕'} ${res.error?.message || t(lang, '翻译失败', 'Translation failed')}`);
          setTranslateMeta({
            target: confirm.target,
            source: 'error',
            cachedCount: 0,
            freshCount: 0,
            reusedCount: 0,
            skippedCount: 0,
            rejectedCount: 0,
            outdatedCount: 0,
          });
          finishTranslation();
        }
      } catch (err) {
        if (!ac.signal.aborted && mountedRef.current && seq === translateSeqRef.current) {
          setTranslationText(`${asciiMode ? 'x' : '✕'} ${errorMessage(err)}`);
          setTranslateMeta({
            target: confirm.target,
            source: 'error',
            cachedCount: 0,
            freshCount: 0,
            reusedCount: 0,
            skippedCount: 0,
            rejectedCount: 0,
            outdatedCount: 0,
          });
          finishTranslation();
        }
      } finally {
        if (translateRequestIdRef.current === requestId) {
          translateRequestIdRef.current = null;
        }
        if (seq === translateSeqRef.current) {
          translateInFlightRef.current = false;
        }
        if (abortRef.current === ac) {
          abortRef.current = null;
          finishTranslation();
          if (!ac.signal.aborted && mountedRef.current) {
            setTranslateBusy(false);
          }
        } else if (ac.signal.aborted && !abortRef.current) {
          finishTranslation();
        }
      }
    },
    [abortInFlight, applyTranslationResults, asciiMode, finishTranslation, host, lang, pageData, resetTranslation, setTranslationText],
  );

  const handlePracticeLinkedCards = useCallback(async () => {
    if (!pageData) return;
    const res = await tryAction<{ cards?: Array<{ deckId: string; cardId: string }> }>(
      host,
      'materials.pages.cards',
      {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        sourceId: pageData.sourceId,
      },
    );
    if (!res.ok) {
      notify(res.error?.message || t(lang, '获取关联题目失败', 'Failed to fetch linked cards'), 'error');
      return;
    }
    const cards = (res.value?.cards ?? []).filter((c) => c.deckId && c.cardId);
    if (cards.length === 0) {
      notify(t(lang, '本页暂无关联卡片', 'No cards linked to this page yet'), 'info');
      return;
    }
    try {
      const run = await startReview(host, {
        mode: 'path',
        scope: cards.map((c) => ({ deckId: c.deckId, cardId: c.cardId })),
      });
      navigate('review', { runId: run.id });
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  }, [host, lang, navigate, notify, pageData]);

  const handleSaveAskToNote = useCallback(async () => {
    if (!pageData || aiBusy || savingNote) return;
    setSavingNote(true);
    try {
      let anchorOffset: number | undefined;
      let selectedExcerpt: string | undefined;
      if (pageScrollTop > 0 && pageData.text) {
        const isSide = (subMode === 'ask-view' || subMode === 'translate-view') && width >= LAYOUT_BP.NARROW;
        const readerW = isSide ? Math.max(24, Math.floor(width * 0.56)) : width;
        const textCols = Math.max(11, readerW - 5);
        const wrapped = wrapDisplay(pageData.text, textCols);
        if (wrapped.length > 0) {
          const lineIdx = Math.min(pageScrollTop, wrapped.length - 1);
          let approx = 0;
          for (let i = 0; i < lineIdx; i += 1) approx += wrapped[i].length;
          const ratioOffset = Math.floor((lineIdx / wrapped.length) * pageData.text.length);
          let offset = Math.min(Math.max(0, Math.min(approx, ratioOffset)), Math.max(0, pageData.text.length - 1));
          const probe = wrapped
            .slice(lineIdx, lineIdx + 3)
            .map((l) => l.trim())
            .find((l) => l.length >= 6);
          if (probe) {
            const needle = probe.slice(0, 32);
            const foundAt = pageData.text.indexOf(needle, Math.max(0, offset - 200));
            if (foundAt >= 0) offset = foundAt;
          }
          const relNonWs = pageData.text.slice(offset).search(/\S/);
          anchorOffset = relNonWs >= 0 ? offset + relNonWs : offset;
          selectedExcerpt = pageData.text.slice(anchorOffset, Math.min(pageData.text.length, anchorOffset + 360));
        }
      }
      const { savePageAskToNote } = await import('./ReaderNotesDrawer.js');
      const result = await savePageAskToNote({
        host,
        lang,
        title: pageData.title,
        page: pageData.page,
        sourceId: pageData.sourceId,
        documentId: pageData.documentId || documentId,
        revision: pageData.revision,
        pageText: pageData.text,
        question: askQuestion,
        answer: aiAnswer,
        course: initialCourse,
        ...(anchorOffset !== undefined ? { anchorOffset } : {}),
        ...(selectedExcerpt !== undefined ? { selectedExcerpt } : {}),
      });
      if (!mountedRef.current) return;
      notify(result.message, result.ok ? 'success' : 'warning');
    } catch (err) {
      if (mountedRef.current) notify(errorMessage(err), 'error');
    } finally {
      if (mountedRef.current) setSavingNote(false);
    }
  }, [pageData, aiBusy, savingNote, pageScrollTop, subMode, width, host, lang, documentId, askQuestion, aiAnswer, initialCourse, notify]);

  const handleSaveAskToCard = useCallback(async () => {
    if (!pageData || aiBusy || saveCardBusyRef.current) return;
    const question = askQuestion.trim();
    const answer = aiAnswer.trim();
    if (!question || !answer) {
      notify(t(lang, '当前没有可保存的问答内容', 'No Q&A answer available to save'), 'error');
      return;
    }
    const anchor = extractPageAnchorSlice(pageData.text);
    if (!anchor) {
      notify(t(lang, '当前页没有可用于定位的原文段落', 'No source passage available on this page to link'), 'error');
      return;
    }
    saveCardBusyRef.current = true;
    setSavingCard(true);
    try {
      let selection: Record<string, unknown> = {
        ...(pageData.documentId ? { documentId: pageData.documentId } : {}),
        ...(pageData.revision ? { revision: pageData.revision } : {}),
        sourceId: pageData.sourceId,
        start: anchor.start,
        end: anchor.end,
        quote: anchor.quote,
      };
      if (!pageData.revision || !pageData.documentId) {
        let resolvedDocId = pageData.documentId;
        let resolvedRev = pageData.revision;
        if (!resolvedDocId) {
          const docRes = await tryAction<{ id?: string; documentId?: string; currentRevision?: string; revision?: string }>(
            host,
            'materials.document.get',
            { sourceId: pageData.sourceId },
          );
          if (!mountedRef.current) return;
          if (docRes.ok && docRes.value) {
            resolvedDocId = docRes.value.documentId || docRes.value.id;
            resolvedRev = resolvedRev || docRes.value.currentRevision || docRes.value.revision;
          }
        }
        const resolveRes = await tryAction<{
          status?: string;
          selection?: Record<string, unknown>;
          message?: string;
        }>(host, 'materials.selection.resolve', {
          ...selection,
          ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
          ...(resolvedRev ? { revision: resolvedRev } : {}),
        });
        if (!mountedRef.current) return;
        if (resolveRes.ok && resolveRes.value?.status === 'resolved' && resolveRes.value.selection) {
          selection = Object.fromEntries(
            Object.entries(resolveRes.value.selection).filter(([, v]) => v !== undefined),
          );
        } else {
          notify(
            resolveRes.value?.message ||
              resolveRes.error?.message ||
              t(lang, '无法定位当前页原文版本', 'Unable to resolve current page revision'),
            'error',
          );
          return;
        }
      }
      const operationId = `tui-qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await tryAction<{
        status?: string;
        deckId?: string;
        cardId?: string;
        error?: string;
      }>(host, 'generation.selection.saveAnswer', {
        selection,
        question,
        answer,
        operationId,
        uiLanguage: lang,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(
          res.error?.message || t(lang, '保存闪卡失败', 'Failed to save flashcard'),
          'error',
        );
        return;
      }
      if (res.value.status === 'complete') {
        setSavedCard(true);
        const snapRes = await tryAction(host, 'snapshot');
        if (mountedRef.current && snapRes.ok && snapRes.value && typeof snapRes.value === 'object') {
          setSnapshot(snapRes.value as never);
        }
        if (mountedRef.current) {
          notify(t(lang, '已保存为原文关联闪卡', 'Saved as passage-linked flashcard'), 'success');
        }
      } else if (res.value.status === 'duplicate') {
        setSavedCard(true);
        notify(t(lang, '该问答卡片已存在于题组中', 'This Q&A flashcard already exists'), 'info');
      } else {
        notify(
          res.value.error || t(lang, '保存闪卡时发生冲突，请重试', 'Conflict while saving flashcard, please retry'),
          'error',
        );
      }
    } catch (err) {
      if (mountedRef.current) notify(errorMessage(err, lang), 'error');
    } finally {
      saveCardBusyRef.current = false;
      if (mountedRef.current) setSavingCard(false);
    }
  }, [pageData, aiBusy, askQuestion, aiAnswer, host, lang, notify, setSnapshot]);

  const isTyping = subMode === 'jump' || subMode === 'search' || subMode === 'ask-input';
  const drawerOpen = subMode === 'outline' || subMode === 'notes' || subMode === 'mark' || subMode === 'glossary';
  const readerInputActive = isActive && !drawerOpen && !pendingTranslateConfirm;
  const claimedKeys = useMemo(
    () =>
      subMode === 'ask-view'
        ? ['s', 'f', 'backspace']
        : subMode === 'translate-view'
          ? ['L', 'R', 'backspace']
          : ['[', ']', '/', 'g', 'G', 'm', 'M', 'a', 't', 'Q', 'p', 'O', 'B', 'H', 'backspace'],
    [subMode],
  );
  useClaimKeys(claimedKeys, readerInputActive && !isTyping);
  useInputCapture(isActive && (isTyping || drawerOpen || Boolean(pendingTranslateConfirm)));

  const hints: KeyHint[] = useMemo(() => {
    if (subMode === 'ask-view') {
      return [
        { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
        { key: 's', label: t(lang, '存笔记', 'Save Note') },
        {
          key: 'f',
          label: savedCard
            ? t(lang, '已存闪卡', 'Card saved')
            : t(lang, '存为闪卡', 'Save card'),
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
    const items: KeyHint[] = [
      { key: '[/]', label: t(lang, '翻页', 'Page') },
      { key: 'O', label: t(lang, '目录', 'TOC') },
      { key: 'H', label: t(lang, '标记段落', 'Mark') },
      { key: 'G', label: t(lang, '术语译文', 'Glossary') },
      { key: 'B', label: t(lang, '批注', 'Notes') },
      ...(chapters.length > 0 ? [{ key: 'M', label: t(lang, '已读', 'Read') }] : []),
      { key: 'a', label: t(lang, '问AI', 'Ask') },
      { key: 't', label: t(lang, '翻译', 'Trans') },
      { key: 'g', label: t(lang, '跳页', 'Go') },
      { key: '/', label: t(lang, '搜索', 'Search') },
      { key: 'm', label: t(lang, '公式', 'Math') },
      { key: 'Q', label: t(lang, '出题', 'Gen') },
      { key: 'p', label: t(lang, '练题', 'Quiz') },
      { key: 'Esc', label: t(lang, '返回', 'Back') },
    ];
    return items;
  }, [chapters.length, lang, savedCard, subMode, translateTarget]);
  useFooterHints(hints, readerInputActive);

  useInput(
    (input, key) => {
      if (isTyping || drawerOpen || pendingTranslateConfirm) return;
      if (key.escape || (subMode === 'read' && key.backspace)) {
        if (subMode !== 'read') {
          cancelActiveTranslation();
          abortInFlight();
          finishAiAnswer();
          finishTranslation();
          resetAiAnswer();
          resetTranslation();
          setTranslateMeta(null);
          setAiBusy(false);
          setSavingCard(false);
          setSavedCard(false);
          setTranslateBusy(false);
          setSubMode('read');
        } else {
          flushPendingPersist();
          cancelActiveTranslation();
          abortInFlight();
          resetAiAnswer();
          resetTranslation();
          onClose();
        }
        return;
      }
      if (subMode === 'ask-view') {
        if (input === 's' && !aiBusy) {
          void handleSaveAskToNote();
        } else if (input === 'f' && !aiBusy) {
          void handleSaveAskToCard();
        }
        return;
      }
      if (subMode === 'translate-view') {
        if (input === 'L' && !translateBusy && !translateInFlightRef.current) {
          const nextTarget: 'zh' | 'en' = translateTarget === 'zh' ? 'en' : 'zh';
          void openTranslatePage(nextTarget, false);
        } else if (input === 'R' && !translateBusy && !translateInFlightRef.current) {
          void openTranslatePage(translateTarget, true);
        }
        return;
      }
      if (subMode !== 'read') return;

      if (input === '[') {
        const first = pageData?.firstPage ?? 1;
        userNavigatedRef.current = true;
        setCurrentPage((p) => Math.max(first, p - 1));
      } else if (input === ']') {
        const last = pageData?.lastPage ?? Math.max(1, totalPagesHint);
        userNavigatedRef.current = true;
        setCurrentPage((p) => Math.min(last, p + 1));
      } else if (input === 'g') {
        setJumpInput(String(currentPage));
        setSubMode('jump');
      } else if (input === '/') {
        setSearchInput(activeSearch);
        setSubMode('search');
      } else if (input === 'm') {
        setPreferences({ mathUnicode: !mathUnicode });
      } else if (input === 'M') {
        if (currentChapter) {
          void toggleChapterRead(currentChapter);
        } else {
          notify(t(lang, '当前页暂无可标记的章节', 'No chapter available to mark on this page'), 'info');
        }
      } else if (input === 'a') {
        setAskQuestion('');
        setSavedCard(false);
        setSubMode('ask-input');
      } else if (input === 't') {
        void openTranslatePage(translateTarget, false);
      } else if (input === 'G') {
        setSubMode('glossary');
      } else if (input === 'O') {
        setSubMode('outline');
      } else if (input === 'B') {
        setSubMode('notes');
      } else if (input === 'H') {
        if (!pageData || !pageData.sourceId) {
          notify(t(lang, '当前页内容尚未加载完成', 'Page content not loaded yet'), 'info');
        } else {
          setSubMode('mark');
        }
      } else if (input === 'Q') {
        const sid = pageData?.sourceId || sourceId;
        if (sid) {
          navigate('generate', {
            sourceIds: [sid],
            ...(initialCourse ? { course: initialCourse } : {}),
          });
        }
      } else if (input === 'p') {
        void handlePracticeLinkedCards();
      }
    },
    { isActive: readerInputActive },
  );

  const showSide = (subMode === 'ask-view' || subMode === 'translate-view') && width >= LAYOUT_BP.NARROW;
  const showBottom = (subMode === 'ask-view' || subMode === 'translate-view') && width < LAYOUT_BP.NARROW;
  const barRows = isTyping ? 2 : 0;
  const bodyH = Math.max(4, height - 3 - barRows);
  const readerH = showBottom ? Math.max(3, Math.floor(bodyH * 0.52)) : bodyH;
  const auxH = showBottom ? Math.max(3, bodyH - readerH) : bodyH;
  const mainW = showSide ? Math.max(24, Math.floor(width * 0.56)) : width;
  const auxW = showSide ? Math.max(20, width - mainW - 1) : width;

  const pageLabel = pageData
    ? `${t(lang, '第', 'P.')} ${pageData.page} / ${pageData.lastPage} ${t(lang, '页', '')}`
    : `${t(lang, '第', 'P.')} ${currentPage}`;

  const progressPrefix = `${asciiMode ? 'OK' : '✓'} ${readCount}/${chapters.length}`;
  const chapterStateTag = currentChapter
    ? currentChapterRead
      ? t(lang, '已读', 'Read')
      : t(lang, '未读', 'Unread')
    : '';
  const progressBadgeLabel =
    chapterStateTag && width >= LAYOUT_BP.NARROW ? `${progressPrefix} (${chapterStateTag})` : progressPrefix;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Reader Header */}
      <Box height={1} width={width} paddingX={1}>
        <Badge label={pageData?.format.toUpperCase() || initialFormat.toUpperCase()} tone="primary" />
        <Text> </Text>
        <Text bold color={theme.text} wrap="truncate-end">
          {pageData?.title || initialTitle || t(lang, '资料阅读器', 'Document Reader')}
        </Text>
        <Box flexGrow={1} />
        {chapters.length > 0 ? (
          <>
            <Badge
              label={progressBadgeLabel}
              tone={currentChapterRead ? 'success' : readCount === chapters.length ? 'success' : 'muted'}
              variant="outline"
            />
            <Text> </Text>
          </>
        ) : null}
        <Badge
          label={mathUnicode ? (asciiMode ? 'Unicode' : '∑ Unicode') : 'TeX'}
          tone={mathUnicode ? 'success' : 'muted'}
          variant="outline"
        />
        <Text> </Text>
        <Badge label={pageLabel.trim()} tone="accent" variant="soft" />
      </Box>

      {/* Optional mini input bar for jump / search / ask */}
      {subMode === 'jump' ? (
        <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
          <Text color={theme.primary} bold>
            {t(lang, '跳转到页码: ', 'Go to page: ')}
          </Text>
          <TextInput
            value={jumpInput}
            onChange={setJumpInput}
            onSubmit={(val) => {
              const n = Number.parseInt(val.trim(), 10);
              const lo = pageData?.firstPage ?? 1;
              const hi = pageData?.lastPage ?? Math.max(1, totalPagesHint);
              if (Number.isFinite(n)) {
                userNavigatedRef.current = true;
                setCurrentPage(Math.max(lo, Math.min(hi, n)));
              }
              setSubMode('read');
            }}
            onCancel={() => setSubMode('read')}
            width={16}
            isActive={isActive}
          />
        </Box>
      ) : null}

      {subMode === 'search' ? (
        <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
          <Box flexShrink={0}>
            <Text color={theme.primary} bold>
              {t(lang, '文档内搜索: ', 'Search document: ')}
            </Text>
          </Box>
          <TextInput
            value={searchInput}
            onChange={setSearchInput}
            onSubmit={(val) => void runSearch(val)}
            onCancel={() => setSubMode('read')}
            width={Math.max(16, width - 24)}
            isActive={isActive}
          />
        </Box>
      ) : null}

      {subMode === 'ask-input' ? (
        <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
          <Box flexShrink={0}>
            <Text color={theme.ai} bold>
              {t(lang, '向 AI 提问本页: ', 'Ask AI about this page: ')}
            </Text>
          </Box>
          <TextInput
            value={askQuestion}
            onChange={setAskQuestion}
            onSubmit={(val) => void runAskAi(val)}
            onCancel={() => setSubMode('read')}
            placeholder={t(lang, '例如：用通俗例子解释这一页的核心定理', 'e.g. Explain the main theorem on this page')}
            width={Math.max(20, width - 26)}
            isActive={isActive}
          />
        </Box>
      ) : null}

      {/* Main Content */}
      <Box flexDirection={showSide ? 'row' : 'column'} width={width} height={bodyH} overflow="hidden">
        <Panel
          title={pageLabel.trim()}
          subtitle={
            activeSearch
              ? `${asciiMode ? '?' : '🔍'} ${activeSearch} (${searchHits.length})`
              : pageData?.text
                ? formatReadingTimeLabel(pageData.text, lang)
                : undefined
          }
          width={mainW}
          height={readerH}
          focused={subMode === 'read'}
        >
          {loading ? (
            <Box padding={1}>
              <Spinner label={asciiMode ? t(lang, '正在读取页面内容...', 'Loading page...') : t(lang, '正在读取页面内容…', 'Loading page…')} />
            </Box>
          ) : loadError ? (
            <Box padding={1}>
              <Text color={theme.error}>{loadError}</Text>
            </Box>
          ) : (pageData?.format === 'md' || pageData?.format === 'tex') ? (
            (() => {
              const availW = Math.max(12, mainW - 4);
              const { proseWidth, marginLeft } = computeProseLayout(availW);
              return (
                <Box width={availW} height={Math.max(2, readerH - 2)} paddingLeft={marginLeft} overflow="hidden">
                  <MarkdownView
                    markdown={pageData?.text || t(lang, '（本页暂无可提取文字）', '(No extracted text on this page)')}
                    width={proseWidth}
                    height={Math.max(2, readerH - 2)}
                    isActive={readerInputActive && subMode === 'read'}
                    mathUnicode={mathUnicode}
                    highlight={activeSearch || undefined}
                    scrollTop={pageScrollTop}
                    onScroll={setPageScrollTop}
                  />
                </Box>
              );
            })()
          ) : (
            (() => {
              const availW = Math.max(12, mainW - 4);
              const { proseWidth, marginLeft } = computeProseLayout(availW);
              const rawText = pageData?.text || t(lang, '（本页暂无可提取文字）', '(No extracted text on this page)');
              const proseLines = formatLongformProse(rawText, Math.max(12, proseWidth - 1), {
                relaxed: !useTuiStore.getState().preferences.compactMode,
              });
              return (
                <Box width={availW} height={Math.max(2, readerH - 2)} paddingLeft={marginLeft} overflow="hidden">
                  <ScrollView
                    lines={proseLines}
                    width={proseWidth}
                    height={Math.max(2, readerH - 2)}
                    isActive={readerInputActive && subMode === 'read'}
                    highlight={activeSearch || undefined}
                    scrollTop={pageScrollTop}
                    onScroll={setPageScrollTop}
                  />
                </Box>
              );
            })()
          )}
        </Panel>

        {showSide ? <Box width={1} /> : null}

        {subMode === 'ask-view' ? (
          <Panel
            title={t(lang, 'AI 讲解', 'AI Answer')}
            icon={asciiMode ? '*' : '✦'}
            tone="ai"
            subtitle={
              aiBusy
                ? asciiMode
                  ? t(lang, '生成中... Esc 中止', 'Streaming... Esc abort')
                  : t(lang, '生成中… Esc 中止', 'Streaming… Esc abort')
                : savingNote || savingCard
                  ? asciiMode
                    ? t(lang, '保存中...', 'Saving...')
                    : t(lang, '保存中…', 'Saving…')
                  : 's/f/Esc'
            }
            width={auxW}
            height={auxH}
            focused
          >
            {!aiBusy && aiAnswer.trim() && askQuestion.trim() ? (
              <Box height={1} width={Math.max(12, auxW - 4)} flexShrink={0} overflow="hidden">
                <Text color={savedCard ? theme.success : theme.muted} wrap="truncate-end">
                  {asciiMode
                    ? `[s] ${t(lang, '存笔记', 'Save Note')}  [f] ${
                        savedCard ? t(lang, '已存闪卡', 'Card saved') : t(lang, '存为闪卡', 'Save card')
                      }`
                    : `[s] ${t(lang, '存笔记', 'Save Note')} · [f] ${
                        savedCard ? t(lang, '已存闪卡', 'Card saved') : t(lang, '存为闪卡', 'Save card')
                      }`}
                </Text>
              </Box>
            ) : null}
            <MarkdownView
              markdown={aiAnswer || (aiBusy ? (asciiMode ? t(lang, '_正在思考..._', '_Thinking..._') : t(lang, '_正在思考…_', '_Thinking…_')) : '')}
              width={Math.max(12, auxW - 4)}
              height={Math.max(2, auxH - (!aiBusy && aiAnswer.trim() && askQuestion.trim() ? 3 : 2))}
              isActive={readerInputActive && subMode === 'ask-view'}
              mathUnicode={mathUnicode}
              follow={aiBusy}
            />
          </Panel>
        ) : null}

        {subMode === 'translate-view' ? (
          <Panel
            title={t(lang, '双语对照翻译', 'Bilingual Translation')}
            icon={lang === 'en' ? undefined : '译'}
            tone="info"
            subtitle={
              translateBusy
                ? asciiMode
                  ? t(lang, '翻译中... Esc 中止', 'Translating... Esc abort')
                  : t(lang, '翻译中… Esc 中止', 'Translating… Esc abort')
                : 'L/R/Esc'
            }
            width={auxW}
            height={auxH}
            focused
          >
            {!translateBusy && translateMeta ? (
              <Box height={1} width={Math.max(12, auxW - 4)} flexShrink={0}>
                <Badge
                  label={translateMeta.target === 'en' ? 'EN' : 'ZH'}
                  tone="info"
                  variant="outline"
                />
                <Text> </Text>
                {translateMeta.source === 'cache' && translateMeta.cachedCount > 0 ? (
                  <Badge
                    label={t(
                      lang,
                      `已缓存 ${translateMeta.cachedCount} 段`,
                      `Cached ${translateMeta.cachedCount} passages`,
                    )}
                    tone="success"
                    variant="soft"
                  />
                ) : translateMeta.freshCount + translateMeta.cachedCount + translateMeta.reusedCount > 0 ? (
                  <Badge
                    label={t(
                      lang,
                      `已译 ${translateMeta.freshCount + translateMeta.cachedCount + translateMeta.reusedCount} 段`,
                      `Translated ${translateMeta.freshCount + translateMeta.cachedCount + translateMeta.reusedCount} passages`,
                    )}
                    tone="success"
                    variant="soft"
                  />
                ) : null}
                {translateMeta.outdatedCount > 0 ? (
                  <>
                    <Text> </Text>
                    <Badge
                      label={t(lang, `待更新 ${translateMeta.outdatedCount}`, `Outdated ${translateMeta.outdatedCount}`)}
                      tone="warning"
                      variant="outline"
                    />
                  </>
                ) : null}
              </Box>
            ) : null}
            {translateBusy ? (
              <Box padding={1}>
                <Spinner
                  label={
                    asciiMode
                      ? t(lang, '正在翻译当前页...', 'Translating current page...')
                      : t(lang, '正在翻译当前页…', 'Translating current page…')
                  }
                />
              </Box>
            ) : (
              <MarkdownView
                markdown={translationText}
                width={Math.max(12, auxW - 4)}
                height={Math.max(2, auxH - (translateMeta ? 3 : 2))}
                isActive={readerInputActive && subMode === 'translate-view' && !translateBusy}
                mathUnicode={mathUnicode}
              />
            )}
          </Panel>
        ) : null}
      </Box>

      {pendingTranslateConfirm ? (
        <ConfirmDialog
          title={
            pendingTranslateConfirm.retranslate
              ? t(lang, '确认重新翻译本页', 'Confirm Page Retranslation')
              : t(lang, '确认翻译本页', 'Confirm Page Translation')
          }
          message={renderTranslateConfirmMessage(pendingTranslateConfirm, lang, theme)}
          confirmLabel={t(lang, '开始翻译', 'Translate')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={Math.min(62, Math.max(40, width - 4))}
          onConfirm={() => void executeConfirmedTranslate(pendingTranslateConfirm)}
          onCancel={() => setPendingTranslateConfirm(null)}
          isActive={isActive}
        />
      ) : null}

      <Suspense fallback={null}>
        {subMode === 'outline' ? (
          <ReaderOutlineDrawer
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            currentPage={pageData?.page ?? currentPage}
            currentPageText={pageData?.text}
            readChapterIds={readChapterIds}
            onToggleRead={(chapter, allChapters) => void toggleChapterRead(chapter, allChapters)}
            onOutlineSaved={() => setOutlineRefreshTick((n) => n + 1)}
            width={width}
            height={height}
            isActive={isActive}
            onJumpPage={(pg) => {
              const lo = pageData?.firstPage ?? 1;
              const hi = pageData?.lastPage ?? Math.max(pg, totalPagesHint);
              userNavigatedRef.current = true;
              setCurrentPage(Math.max(lo, Math.min(hi, pg)));
            }}
            onClose={() => setSubMode('read')}
          />
        ) : null}

        {subMode === 'notes' ? (
          <ReaderNotesDrawer
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            currentPage={pageData?.page ?? currentPage}
            width={width}
            height={height}
            isActive={isActive}
            onJumpPage={(pg) => {
              const lo = pageData?.firstPage ?? 1;
              const hi = pageData?.lastPage ?? Math.max(pg, totalPagesHint);
              userNavigatedRef.current = true;
              setCurrentPage(Math.max(lo, Math.min(hi, pg)));
            }}
            onClose={() => setSubMode('read')}
          />
        ) : null}

        {subMode === 'mark' ? (
          <MarkPassageModal
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            currentPage={pageData?.page ?? currentPage}
            pageText={pageData?.text ?? ''}
            isActive={isActive}
            onClose={() => setSubMode('read')}
          />
        ) : null}

        {subMode === 'glossary' ? (
          <TranslationGlossaryModal
            host={host}
            documentId={pageData?.documentId || documentId}
            sourceId={pageData?.sourceId || sourceId}
            revision={pageData?.revision}
            title={pageData?.title || initialTitle}
            isActive={isActive}
            onClose={() => setSubMode('read')}
          />
        ) : null}
      </Suspense>
    </Box>
  );
});

function renderTranslateConfirmMessage(
  confirm: PendingTranslateConfirm,
  lang: 'zh' | 'en',
  theme: ReturnType<typeof useTheme>,
): React.ReactElement {
  const targetNameLabel =
    confirm.target === 'en'
      ? t(lang, '英文 (en)', 'English (en)')
      : t(lang, '中文 (zh)', 'Chinese (zh)');
  const { toTranslate, cached, reused } = confirm.counts;
  const estCalls = formatEstimateRange(confirm.estimate?.calls) || '1';
  const estTokens = resolveEstimateTokensText(confirm.estimate) || '-';
  const reusedParts: string[] = [];
  if (cached > 0) reusedParts.push(t(lang, `已缓存 ${cached}`, `cached ${cached}`));
  if (reused > 0) reusedParts.push(t(lang, `可复用 ${reused}`, `reused ${reused}`));
  const extraNote = reusedParts.length > 0 ? ` (${reusedParts.join(', ')})` : '';
  return (
    <Box flexDirection="column">
      <Text color={theme.text} wrap="wrap">
        {t(
          lang,
          `目标语言: ${targetNameLabel} | 待翻译 ${toTranslate} 段${extraNote}`,
          `Target: ${targetNameLabel} | ${toTranslate} passage(s) to translate${extraNote}`,
        )}
      </Text>
      <Text color={theme.muted} wrap="wrap">
        {t(
          lang,
          `预计调用: ~${estCalls} 次 | 预计用量: ~${estTokens} tokens`,
          `Est. calls: ~${estCalls} | Est. tokens: ~${estTokens}`,
        )}
      </Text>
      {!confirm.modelAvailable ? (
        <Text color={theme.warning} wrap="wrap">
          {t(
            lang,
            '提示: 当前未配置可用模型，执行可能失败。',
            'Note: No model configured; execution may fail.',
          )}
        </Text>
      ) : null}
      <Text color={theme.dim} wrap="wrap">
        {t(
          lang,
          '译文将自动保存至资料库，翻译中按 Esc 可中止。',
          'Translations auto-save to library; Esc aborts in-flight.',
        )}
      </Text>
    </Box>
  );
}
