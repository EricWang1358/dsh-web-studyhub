import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, StudySnapshot } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalChildRows, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { useShellActions } from '../../shell/actions.js';
import { cleanPathInput, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from '../sources/path-complete.js';
import type { FullDeckDetail } from './DeckManageModal.js';

export type DeckOpsTab = 'import' | 'merge' | 'split';

type DeckItem = NonNullable<StudySnapshot['decks']>[number];

interface TopicGroup {
  topic: string;
  count: number;
}

interface ParsedDeckPreview {
  title: string;
  course: string;
  cardCount: number;
}

interface DeckImportResponse {
  files?: number;
  imported?: number;
  failed?: number;
  added?: number;
  skipped?: number;
  results?: Array<{ file?: string; title?: string; deckId?: string | null; added?: number; skipped?: number; error?: string }>;
}

interface DeckMergeResponse {
  targetId: string;
  sourceIds: string[];
  moved: number;
  count: number;
}

interface DeckSplitResponse {
  sourceId: string;
  targetId: string;
  moved: number;
  remaining: number;
}

interface MergeSuggestionProposal {
  targetId: string;
  sourceIds: string[];
  reason: string;
  targetTitle?: string;
  sourceTitles?: string[];
  count?: number;
}

interface DeckMergeSuggestResponse {
  course?: string;
  proposals?: MergeSuggestionProposal[];
  method?: string;
}

interface ImportProposal {
  originalTitle?: string;
  title: string;
  course: string;
  mergeTargetId: string | null;
  method: string;
}

type ConfirmState =
  | {
      kind: 'merge';
      source: DeckItem;
      target: DeckItem;
      sourceCount: number;
      targetCount: number;
    }
  | {
      kind: 'split';
      deck: FullDeckDetail;
      topics: string[];
      title: string;
      movedCount: number;
      remainingCount: number;
    }
  | {
      kind: 'suggest-merge';
    }
  | {
      kind: 'propose-import';
      filePath: string;
      previewTitle: string;
      cardCount: number;
    };

export interface DeckOpsModalProps {
  host: HostClient;
  selectedDeckId?: string | null;
  initialTab?: DeckOpsTab;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: () => void;
}

const TABS: readonly DeckOpsTab[] = ['import', 'merge', 'split'];
const JSON_EXTS = ['.json', '.txt'] as const;
const MAX_LOCAL_JSON_BYTES = 2_000_000;

const TEX_COMMANDS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
  'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'frac', 'dfrac', 'tfrac', 'sqrt', 'sum', 'prod', 'int', 'oint', 'iint', 'lim', 'limsup', 'liminf', 'sup', 'inf', 'max', 'min', 'arg', 'argmax',
  'argmin', 'det', 'dim', 'ker', 'exp', 'log', 'ln', 'lg', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan',
  'binom', 'begin', 'end', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'infty', 'partial', 'nabla', 'cdot', 'cdots', 'ldots', 'dots', 'vdots', 'ddots', 'times', 'div', 'pm', 'mp', 'ast', 'star', 'circ', 'bullet',
  'oplus', 'otimes', 'odot', 'leq', 'geq', 'neq', 'ne', 'le', 'ge', 'approx', 'equiv', 'sim', 'simeq', 'cong', 'propto', 'll', 'gg', 'subset',
  'supset', 'subseteq', 'supseteq', 'in', 'notin', 'ni', 'cup', 'cap', 'emptyset', 'setminus', 'forall', 'exists', 'neg', 'not', 'land', 'lor',
  'wedge', 'vee', 'implies', 'iff', 'mid', 'parallel', 'perp', 'angle', 'triangle', 'prime', 'quad', 'qquad', 'hbar', 'ell', 'Re', 'Im', 'aleph',
  'langle', 'rangle', 'lceil', 'rceil', 'lfloor', 'rfloor',
  'to', 'gets', 'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'mapsto', 'uparrow', 'downarrow',
  'mathbb', 'mathbf', 'mathrm', 'mathcal', 'mathit', 'mathsf', 'mathtt', 'boldsymbol', 'text', 'textbf', 'textit', 'vec', 'hat', 'bar', 'tilde',
  'overline', 'underline', 'overrightarrow', 'operatorname', 'boxed', 'cancel',
  'ce', 'pu', 'si', 'SI', 'unit', 'qty', 'num', 'textdegree', 'degree', 'celsius', 'ohm', 'angstrom',
]);
const TEX_PUNCTUATION = '()[]{},;:!|%&#_^~\'';

/** Mirror lib/tex-text.js repairTexEscapes so single-backslash LaTeX previews cleanly before deck.import. */
function repairTexEscapes(text: string): string {
  let out = '';
  let quoted = false;
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!quoted) {
      out += ch;
      if (ch === '"') quoted = true;
      continue;
    }
    if (ch === '"') {
      quoted = false;
      out += ch;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += ch;
      continue;
    }
    if ('"\\/bfnrt'.includes(next)) {
      out += ch + next;
      i += 1;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}/.test(text.slice(i + 2, i + 6))) {
      out += text.slice(i, i + 6);
      i += 5;
      continue;
    }
    const word = /^[A-Za-z]+/.exec(text.slice(i + 1))?.[0] || '';
    if (TEX_PUNCTUATION.includes(next) || (word && TEX_COMMANDS.has(word))) {
      out += '\\\\';
      changed = true;
      continue;
    }
    out += ch;
  }
  return changed ? out : text;
}

function stripJsonWrapper(raw: string): string {
  return String(raw)
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
    .trim();
}

function validateDeckJsonText(
  rawText: string,
  lang: 'zh' | 'en',
): { ok: true; preview: ParsedDeckPreview } | { ok: false; error: string } {
  const cleaned = stripJsonWrapper(rawText);
  if (!cleaned) {
    return { ok: false, error: t(lang, '文件内容为空', 'File is empty') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const repaired = repairTexEscapes(cleaned);
    if (repaired !== cleaned) {
      try {
        parsed = JSON.parse(repaired);
      } catch {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: t(lang, `JSON 解析失败：${msg}`, `Invalid JSON: ${msg}`) };
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: t(lang, `JSON 解析失败：${msg}`, `Invalid JSON: ${msg}`) };
    }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { ok: false, error: t(lang, '题目数组不能为空', 'Card array cannot be empty') };
    }
    if (parsed.some((item) => !item || Array.isArray(item) || typeof item !== 'object')) {
      return { ok: false, error: t(lang, '题目数组中每一项都必须是对象', 'Each item in card array must be an object') };
    }
    return {
      ok: true,
      preview: { title: '', course: '', cardCount: parsed.length },
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      error: t(
        lang,
        'JSON 顶层必须是包含 cards 数组的对象，或题目对象数组',
        'Top-level JSON must be an object with cards[] or an array of cards',
      ),
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.cards) || obj.cards.length === 0) {
    return { ok: false, error: t(lang, 'cards 必须包含至少一道题', 'cards must contain at least one card') };
  }
  if (obj.cards.some((item) => !item || Array.isArray(item) || typeof item !== 'object')) {
    return { ok: false, error: t(lang, 'cards 中的每一项都必须是对象', 'Each card entry must be an object') };
  }
  return {
    ok: true,
    preview: {
      title: typeof obj.title === 'string' ? obj.title.trim() : '',
      course: typeof obj.course === 'string' ? obj.course.trim() : '',
      cardCount: obj.cards.length,
    },
  };
}

function deckCardCount(deck: DeckItem, progressMap: Record<string, { total?: number }> | undefined): number {
  const p = progressMap?.[deck.id];
  return Number(deck.count ?? p?.total ?? deck.cardCount ?? 0) || 0;
}

function deckLabel(deck: DeckItem): string {
  return String(deck.title ?? deck.name ?? deck.id);
}

/** Rows above each tab's body: the tab bar and its separator line. */
const DECK_OPS_TAB_BAR_ROWS = 2;
/**
 * Body rows the Import tab needs to keep a blank line between its groups: path label + input + completions (3),
 * course label + input (1 + 2), preview or hint (1 + 1), AI banner (1 + 1), error (1 + 1).
 */
const IMPORT_SPACED_MIN_ROWS = 12;

function isOrdinaryActiveDeck(deck: DeckItem): boolean {
  return !deck.archived && !(deck as Record<string, unknown>).systemKind;
}

export const DeckOpsModal = memo(function DeckOpsModal({
  host,
  selectedDeckId,
  initialTab = 'import',
  isActive,
  width,
  height,
  onClose,
  onUpdated,
}: DeckOpsModalProps) {
  const theme = useTheme();
  const actions = useShellActions();
  const { columns, rows } = useStableWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);

  const [tab, setTab] = useState<DeckOpsTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  // Tab 1: Import JSON
  const [importFocus, setImportFocus] = useState<'tabs' | 'path' | 'course'>('path');
  const [filePath, setFilePath] = useState('');
  const [courseOverride, setCourseOverride] = useState('');
  const [matches, setMatches] = useState<string[]>([]);
  const [jsonPreview, setJsonPreview] = useState<ParsedDeckPreview | null>(null);
  const [jsonHintErr, setJsonHintErr] = useState('');
  const [importProposal, setImportProposal] = useState<{
    title: string;
    course: string;
    mergeTargetId: string | null;
    method: string;
  } | null>(null);
  const [proposeBusy, setProposeBusy] = useState(false);
  const proposeBusyRef = useRef(false);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  // Tab 2: Merge
  const [mergeIndex, setMergeIndex] = useState(0);
  const [mergeDirection, setMergeDirection] = useState<'into-other' | 'into-selected'>('into-other');
  const [mergeSuggestions, setMergeSuggestions] = useState<MergeSuggestionProposal[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestNotice, setSuggestNotice] = useState<string | null>(null);
  const suggestBusyRef = useRef(false);

  // Tab 3: Split
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitDeck, setSplitDeck] = useState<FullDeckDetail | null>(null);
  const [splitError, setSplitError] = useState('');
  const [splitFocus, setSplitFocus] = useState<'topics' | 'title'>('topics');
  const [topicIndex, setTopicIndex] = useState(0);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [splitTitle, setSplitTitle] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const progressMap = snapshot?.progress as Record<string, { total?: number }> | undefined;
  const activeFocusCourse = typeof snapshot?.focus?.course === 'string' ? snapshot.focus.course : '';

  const selectedDeck = useMemo(
    () => (selectedDeckId ? (snapshot?.decks ?? []).find((d) => d.id === selectedDeckId) ?? null : null),
    [selectedDeckId, snapshot?.decks],
  );

  const editingDraftDeckIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of snapshot?.drafts ?? []) {
      const editId = (d as Record<string, unknown>).editingDeckId;
      const repairId = ((d as Record<string, unknown>).editorial as Record<string, unknown> | undefined)?.repairOfDeckId;
      if (typeof editId === 'string' && editId) ids.add(editId);
      if (typeof repairId === 'string' && repairId) ids.add(repairId);
    }
    return ids;
  }, [snapshot?.drafts]);

  const switchTab = useCallback((next: DeckOpsTab) => {
    setTab(next);
    setError('');
    if (next === 'import') setImportFocus('path');
    if (next === 'split') setSplitFocus('topics');
  }, []);

  // Reset import filing proposal whenever filePath changes
  useEffect(() => {
    setImportProposal(null);
  }, [filePath]);

  // Pre-fetch Tab path completions & validate existing .json file preview
  useEffect(() => {
    if (!isActive || tab !== 'import') return;
    let cancelled = false;
    const cleaned = cleanPathInput(filePath);
    if (importFocus === 'path') {
      void completeFsPath(cleaned, { extensions: JSON_EXTS }).then((res) => {
        if (cancelled) return;
        cachedCompletionRef.current = { input: filePath, completed: res.completed };
        setMatches(res.matches.slice(0, 5));
      });
    }

    const expanded = expandHomePath(cleaned);
    if (!expanded) {
      setJsonPreview(null);
      setJsonHintErr('');
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(() => {
      void (async () => {
        const resolved = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
        try {
          const info = await stat(resolved);
          if (cancelled) return;
          if (!info.isFile()) {
            setJsonPreview(null);
            setJsonHintErr('');
            return;
          }
          if (info.size > MAX_LOCAL_JSON_BYTES) {
            setJsonPreview(null);
            setJsonHintErr(t(lang, '文件过大，超过 2MB 上限', 'File exceeds 2MB limit'));
            return;
          }
          const content = await readFile(resolved, 'utf8');
          if (cancelled) return;
          const check = validateDeckJsonText(content, lang);
          if (check.ok) {
            setJsonPreview(check.preview);
            setJsonHintErr('');
          } else {
            setJsonPreview(null);
            setJsonHintErr(check.error);
          }
        } catch {
          if (cancelled) return;
          setJsonPreview(null);
          setJsonHintErr('');
        }
      })();
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isActive, tab, importFocus, filePath, lang]);

  const handleTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    const cleaned = cleanPathInput(val);
    void completeFsPath(cleaned, { extensions: JSON_EXTS }).then((res) => {
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setMatches(res.matches.slice(0, 5));
      if (res.completed && res.completed !== val) setFilePath(res.completed);
    });
    return undefined;
  }, []);

  const handleImportSubmit = useCallback(async () => {
    if (busy || proposeBusyRef.current) return;
    setError('');
    const cleaned = cleanPathInput(filePath);
    const expanded = expandHomePath(cleaned);
    if (!expanded) {
      setError(t(lang, '请输入本地 .json 题组文件路径', 'Please enter a local .json deck file path'));
      return;
    }
    const resolvedPath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    setBusy(true);
    try {
      let info;
      try {
        info = await stat(resolvedPath);
      } catch {
        if (!mountedRef.current) return;
        setError(t(lang, `找不到文件：${resolvedPath}`, `File not found: ${resolvedPath}`));
        setBusy(false);
        return;
      }
      if (!info.isFile()) {
        if (!mountedRef.current) return;
        setError(t(lang, '请选择具体的 .json 文件（而非目录）', 'Please choose a .json file (not a directory)'));
        setBusy(false);
        return;
      }
      if (info.size > MAX_LOCAL_JSON_BYTES) {
        if (!mountedRef.current) return;
        setError(t(lang, '文件过大，超过 2MB 上限', 'File is too large (max 2MB)'));
        setBusy(false);
        return;
      }
      const rawContent = await readFile(resolvedPath, 'utf8');
      const check = validateDeckJsonText(rawContent, lang);
      if (!check.ok) {
        if (!mountedRef.current) return;
        setError(check.error);
        setBusy(false);
        return;
      }

      const course = courseOverride.trim();
      const res = await tryAction<DeckImportResponse>(host, 'deck.import', {
        path: resolvedPath,
        ...(course ? { course } : {}),
      });
      if (!mountedRef.current) return;

      if (!res.ok) {
        setError(res.error?.message || t(lang, '导入题组失败', 'Failed to import deck'));
        setBusy(false);
        return;
      }
      const firstErr = res.value?.results?.find((r) => Boolean(r.error))?.error;
      if ((res.value?.failed ?? 0) > 0 || firstErr) {
        setError(firstErr || t(lang, '导入题组失败', 'Failed to import deck'));
        setBusy(false);
        return;
      }

      const added = res.value?.added ?? 0;
      const skipped = res.value?.skipped ?? 0;
      const importedTitle = res.value?.results?.[0]?.title || check.preview.title || resolvedPath;
      await actions.refresh();
      onUpdated?.();
      if (!mountedRef.current) return;
      notify(
        t(
          lang,
          `已导入「${importedTitle}」：新增 ${added} 题${skipped > 0 ? `，跳过重复 ${skipped} 题` : ''}`,
          `Imported "${importedTitle}": +${added} cards${skipped > 0 ? ` (${skipped} skipped)` : ''}`,
        ),
        'success',
      );
      onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, filePath, courseOverride, host, lang, actions, onUpdated, notify, onClose]);

  const importProposalBannerText = useMemo(() => {
    if (!importProposal) return '';
    const sep = asciiMode ? ' - ' : ' · ';
    const prefix = asciiMode ? '* ' : '✦ ';
    const courseStr = importProposal.course || '-';
    const titleStr = importProposal.title || jsonPreview?.title || '-';
    const mergeDeck = importProposal.mergeTargetId
      ? (snapshot?.decks ?? []).find((d) => d.id === importProposal.mergeTargetId)
      : undefined;
    const mergePart = mergeDeck
      ? `${sep}${t(lang, '可合并:', 'Merge:')}${truncateDisplay(deckLabel(mergeDeck), 22, ell)}`
      : '';
    return `${prefix}${t(
      lang,
      `建议归属: 课程 ${courseStr}${sep}标题 ${titleStr}`,
      `Suggested: Course ${courseStr}${sep}Title ${titleStr}`,
    )}${mergePart}`;
  }, [importProposal, asciiMode, jsonPreview?.title, snapshot?.decks, lang, ell]);

  // Tab 2: Merge candidate decks
  const mergeCandidates = useMemo<DeckItem[]>(() => {
    if (!selectedDeck) return [];
    const list = (snapshot?.decks ?? []).filter((d) => d.id !== selectedDeck.id && isOrdinaryActiveDeck(d));
    const selCourse = selectedDeck.course ?? '';
    return [...list].sort((a, b) => {
      const aSame = (a.course ?? '') === selCourse ? 0 : 1;
      const bSame = (b.course ?? '') === selCourse ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return deckLabel(a).localeCompare(deckLabel(b));
    });
  }, [snapshot?.decks, selectedDeck]);

  const topMergeSuggestion = useMemo(() => {
    if (mergeSuggestions.length === 0) return null;
    if (selectedDeck) {
      const match = mergeSuggestions.find(
        (p) => p.targetId === selectedDeck.id || p.sourceIds.includes(selectedDeck.id),
      );
      if (match) return match;
    }
    return mergeSuggestions[0] ?? null;
  }, [mergeSuggestions, selectedDeck]);

  const mergeSuggestionBannerText = useMemo(() => {
    if (!topMergeSuggestion) return '';
    const titleOf = (id: string) => {
      const found = (snapshot?.decks ?? []).find((d) => d.id === id);
      return found ? deckLabel(found) : id;
    };
    const sources =
      Array.isArray(topMergeSuggestion.sourceTitles) && topMergeSuggestion.sourceTitles.length > 0
        ? topMergeSuggestion.sourceTitles
        : topMergeSuggestion.sourceIds.map(titleOf);
    const target = topMergeSuggestion.targetTitle || titleOf(topMergeSuggestion.targetId);
    const pair = [...sources, target].filter(Boolean).join(' + ');
    const reason = topMergeSuggestion.reason ? ` (${topMergeSuggestion.reason})` : '';
    const prefix = asciiMode ? '* ' : '✦ ';
    const applyHint = t(lang, '[a] 应用建议', '[a] Apply');
    const sep = asciiMode ? ' - ' : ' · ';
    return `${prefix}${applyHint}${sep}${t(lang, '建议合并', 'Suggested merge')}: ${pair}${reason}`;
  }, [topMergeSuggestion, snapshot?.decks, asciiMode, lang]);

  useEffect(() => {
    if (mergeIndex >= mergeCandidates.length) {
      setMergeIndex(Math.max(0, mergeCandidates.length - 1));
    }
  }, [mergeCandidates.length, mergeIndex]);

  const handleMergeSelect = useCallback(
    (other: DeckItem) => {
      if (!selectedDeck || busy) return;
      if (!isOrdinaryActiveDeck(selectedDeck)) {
        setError(t(lang, '已归档或系统题组不能合并', 'Archived or system decks cannot be merged'));
        return;
      }
      const source = mergeDirection === 'into-other' ? selectedDeck : other;
      const target = mergeDirection === 'into-other' ? other : selectedDeck;
      setError('');
      setConfirmState({
        kind: 'merge',
        source,
        target,
        sourceCount: deckCardCount(source, progressMap),
        targetCount: deckCardCount(target, progressMap),
      });
    },
    [selectedDeck, busy, lang, mergeDirection, progressMap],
  );

  // Tab 3: Load full deck via deck.get when selectedDeckId changes
  useEffect(() => {
    if (tab !== 'split') return;
    if (!selectedDeckId) {
      setSplitDeck(null);
      setSplitError('');
      setSplitLoading(false);
      return;
    }
    let alive = true;
    setSplitLoading(true);
    setSplitError('');
    setSelectedTopics([]);
    setTopicIndex(0);
    setSplitTitle('');
    void (async () => {
      const res = await tryAction<FullDeckDetail>(host, 'deck.get', { id: selectedDeckId });
      if (!alive) return;
      if (res.ok && res.value) {
        setSplitDeck(res.value);
      } else {
        setSplitDeck(null);
        setSplitError(res.error?.message || t(lang, '读取题组详情失败', 'Failed to load deck'));
      }
      setSplitLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [host, selectedDeckId, tab, lang]);

  const topicGroups = useMemo<TopicGroup[]>(() => {
    if (!splitDeck?.cards) return [];
    const counts = new Map<string, number>();
    for (const card of splitDeck.cards) {
      const key = card.topic || '未分类';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([topic, count]) => ({ topic, count }));
  }, [splitDeck?.cards]);

  useEffect(() => {
    if (topicIndex >= topicGroups.length) {
      setTopicIndex(Math.max(0, topicGroups.length - 1));
    }
  }, [topicGroups.length, topicIndex]);

  const totalSplitCards = splitDeck?.cards?.length ?? 0;
  const selectedSplitCount = useMemo(() => {
    const sel = new Set(selectedTopics);
    return topicGroups.reduce((sum, g) => sum + (sel.has(g.topic) ? g.count : 0), 0);
  }, [topicGroups, selectedTopics]);

  const toggleTopic = useCallback((topic: string) => {
    setError('');
    setSelectedTopics((prev) => (prev.includes(topic) ? prev.filter((x) => x !== topic) : [...prev, topic]));
  }, []);

  const proceedToSplitTitle = useCallback(
    (highlighted?: TopicGroup) => {
      if (!splitDeck) return;
      let nextTopics = selectedTopics;
      if (nextTopics.length === 0 && highlighted) {
        nextTopics = [highlighted.topic];
        setSelectedTopics(nextTopics);
      }
      const nextCount = topicGroups.reduce((sum, g) => sum + (nextTopics.includes(g.topic) ? g.count : 0), 0);
      if (nextCount === 0) {
        setError(t(lang, '请至少选择一个要拆出的主题', 'Select at least one topic to split'));
        return;
      }
      if (nextCount >= totalSplitCards) {
        setError(t(lang, '拆分后原题组至少须保留 1 道题，不能全选', 'Must leave at least 1 card in the source deck'));
        return;
      }
      setError('');
      if (!splitTitle.trim()) {
        setSplitTitle(`${splitDeck.title} - ${nextTopics[0]}`.slice(0, 200));
      }
      setSplitFocus('title');
    },
    [splitDeck, selectedTopics, topicGroups, totalSplitCards, lang, splitTitle],
  );

  const handleSplitTitleSubmit = useCallback(
    (rawTitle: string) => {
      if (!splitDeck || busy) return;
      const title = rawTitle.trim();
      if (!title) {
        setError(t(lang, '请输入新题组名称', 'Please enter a title for the new deck'));
        return;
      }
      if (title.length > 200) {
        setError(t(lang, '新题组名称不能超过 200 字', 'New deck title must be <= 200 chars'));
        return;
      }
      if (selectedTopics.length === 0 || selectedSplitCount === 0 || selectedSplitCount >= totalSplitCards) {
        setError(t(lang, '拆分后两个题组都必须有题目', 'Both decks must have at least 1 card after splitting'));
        setSplitFocus('topics');
        return;
      }
      setError('');
      setConfirmState({
        kind: 'split',
        deck: splitDeck,
        topics: selectedTopics,
        title,
        movedCount: selectedSplitCount,
        remainingCount: totalSplitCards - selectedSplitCount,
      });
    },
    [splitDeck, busy, lang, selectedTopics, selectedSplitCount, totalSplitCards],
  );

  const handleConfirmExecute = useCallback(async () => {
    const req = confirmState;
    setConfirmState(null);
    if (!req || busy || suggestBusyRef.current || proposeBusyRef.current) return;
    if (req.kind === 'propose-import') {
      proposeBusyRef.current = true;
      setProposeBusy(true);
      setError('');
      try {
        const text = await readFile(req.filePath, 'utf8');
        if (!mountedRef.current) return;
        const trimmedCourse = courseOverride.trim();
        const res = await tryAction<ImportProposal>(host, 'draft.import.propose', {
          text,
          ...(trimmedCourse ? { course: trimmedCourse } : {}),
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '生成导入归档建议失败', 'Failed to suggest import filing');
          setError(msg);
          notify(msg, 'error');
          return;
        }
        const proposal = {
          title: String(res.value.title ?? '').trim(),
          course: String(res.value.course ?? '').trim(),
          mergeTargetId: res.value.mergeTargetId ?? null,
          method: String(res.value.method ?? 'rules'),
        };
        setImportProposal(proposal);
        if (proposal.course && !trimmedCourse) {
          setCourseOverride(proposal.course);
        }
        notify(
          t(
            lang,
            `已生成归档建议：${proposal.course || '-'} / ${proposal.title || req.previewTitle}`,
            `Filing proposal: ${proposal.course || '-'} / ${proposal.title || req.previewTitle}`,
          ),
          'success',
        );
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify(msg, 'error');
      } finally {
        proposeBusyRef.current = false;
        if (mountedRef.current) setProposeBusy(false);
      }
      return;
    }
    if (req.kind === 'suggest-merge') {
      suggestBusyRef.current = true;
      setSuggestBusy(true);
      setSuggestNotice(null);
      setError('');
      try {
        const res = await tryAction<DeckMergeSuggestResponse>(host, 'deck.merge.suggest', {});
        if (!mountedRef.current) return;
        if (!res.ok) {
          const msg = res.error?.message || t(lang, '生成合并建议失败', 'Failed to suggest merges');
          setError(msg);
          notify(msg, 'error');
          return;
        }
        const method = res.value?.method;
        if (method === 'too-few-decks') {
          const msg = t(lang, '当前课程至少需要 2 个题组才能分析合并建议', 'Need at least 2 decks in course to suggest merges');
          setMergeSuggestions([]);
          setSuggestNotice(msg);
          notify(msg, 'info');
          return;
        }
        if (method === 'unavailable') {
          const msg = t(lang, '未配置可用模型，无法生成合并建议', 'No model available for merge suggestions');
          setMergeSuggestions([]);
          setSuggestNotice(msg);
          notify(msg, 'warning');
          return;
        }
        const proposals = Array.isArray(res.value?.proposals)
          ? res.value.proposals.filter((p) => p && p.targetId && Array.isArray(p.sourceIds) && p.sourceIds.length > 0)
          : [];
        setMergeSuggestions(proposals);
        if (proposals.length > 0) {
          const msg = t(
            lang,
            `找到 ${proposals.length} 条合并建议（按 [a] 应用首条建议）`,
            `Found ${proposals.length} merge suggestion(s) (press [a] to apply top)`,
          );
          setSuggestNotice(msg);
          notify(msg, 'success');
        } else {
          const msg = t(lang, '当前题组主题区分清晰，暂无推荐合并', 'No duplicate decks detected');
          setSuggestNotice(msg);
          notify(msg, 'info');
        }
      } finally {
        suggestBusyRef.current = false;
        if (mountedRef.current) setSuggestBusy(false);
      }
      return;
    }
    setBusy(true);
    setError('');
    if (req.kind === 'merge') {
      const res = await tryAction<DeckMergeResponse>(host, 'deck.merge', {
        sourceIds: [req.source.id],
        targetId: req.target.id,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok) {
        setError(res.error?.message || t(lang, '合并题组失败', 'Failed to merge decks'));
        return;
      }
      await actions.refresh();
      onUpdated?.();
      if (!mountedRef.current) return;
      notify(
        t(
          lang,
          `已将「${deckLabel(req.source)}」的 ${res.value?.moved ?? req.sourceCount} 题合并入「${deckLabel(req.target)}」`,
          `Merged ${res.value?.moved ?? req.sourceCount} cards from "${deckLabel(req.source)}" into "${deckLabel(req.target)}"`,
        ),
        'success',
      );
      onClose();
      return;
    }

    const res = await tryAction<DeckSplitResponse>(host, 'deck.split', {
      id: req.deck.id,
      title: req.title,
      topics: req.topics,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.message || t(lang, '拆分题组失败', 'Failed to split deck'));
      return;
    }
    await actions.refresh();
    onUpdated?.();
    if (!mountedRef.current) return;
    notify(
      t(
        lang,
        `已拆出 ${res.value?.moved ?? req.movedCount} 题到「${req.title}」（原题组余 ${res.value?.remaining ?? req.remainingCount} 题）`,
        `Split ${res.value?.moved ?? req.movedCount} cards into "${req.title}" (${res.value?.remaining ?? req.remainingCount} remaining)`,
      ),
      'success',
    );
    onClose();
  }, [confirmState, busy, courseOverride, host, lang, actions, onUpdated, notify, onClose]);

  const typingInTextField =
    (tab === 'import' && (importFocus === 'path' || importFocus === 'course')) ||
    (tab === 'split' && splitFocus === 'title');

  // Keyboard routing for tabs & sub-focus
  useInput(
    (input, key) => {
      if (busy || proposeBusyRef.current || confirmState) return;

      // Global modal tab shortcuts when not actively typing inside a TextInput
      if (!typingInTextField) {
        if (input === '1') {
          switchTab('import');
          return;
        }
        if (input === '2') {
          switchTab('merge');
          return;
        }
        if (input === '3') {
          switchTab('split');
          return;
        }
        if (key.tab) {
          const idx = TABS.indexOf(tab);
          switchTab(TABS[(idx + (key.shift ? TABS.length - 1 : 1)) % TABS.length]);
          return;
        }
      }

      if (tab === 'import') {
        if (key.ctrl && input === 'g') {
          if (proposeBusyRef.current || busy || confirmState) return;
          const cleaned = cleanPathInput(filePath);
          const expanded = expandHomePath(cleaned);
          if (!expanded || !jsonPreview || jsonHintErr) {
            notify(
              t(lang, '请先输入有效的 JSON 题组文件路径', 'Enter a valid JSON deck file path first'),
              'info',
            );
            return;
          }
          const resolvedPath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
          setError('');
          setConfirmState({
            kind: 'propose-import',
            filePath: resolvedPath,
            previewTitle: jsonPreview.title || basename(resolvedPath),
            cardCount: jsonPreview.cardCount,
          });
          return;
        }
        if (importFocus === 'tabs') {
          if (key.leftArrow) {
            const idx = TABS.indexOf(tab);
            switchTab(TABS[(idx + TABS.length - 1) % TABS.length]);
          } else if (key.rightArrow) {
            const idx = TABS.indexOf(tab);
            switchTab(TABS[(idx + 1) % TABS.length]);
          } else if (key.downArrow || key.return) {
            setImportFocus('path');
          }
          return;
        }
        if (importFocus === 'path') {
          if (key.upArrow) setImportFocus('tabs');
          else if (key.downArrow) setImportFocus('course');
          return;
        }
        if (importFocus === 'course') {
          if (key.upArrow) setImportFocus('path');
          else if (key.downArrow) setImportFocus('tabs');
          return;
        }
      }

      if (tab === 'merge') {
        if (!selectedDeck || !isOrdinaryActiveDeck(selectedDeck)) return;
        if (input === 's' || input === 'd') {
          setMergeDirection((d) => (d === 'into-other' ? 'into-selected' : 'into-other'));
          return;
        }
        if (input === 'g') {
          if (suggestBusyRef.current || busy || confirmState) return;
          setError('');
          setConfirmState({ kind: 'suggest-merge' });
          return;
        }
        if (input === 'a' && topMergeSuggestion) {
          if (suggestBusyRef.current || busy || confirmState) return;
          const sourceId = topMergeSuggestion.sourceIds[0];
          const targetId = topMergeSuggestion.targetId;
          const decks = snapshot?.decks ?? [];
          const source = decks.find((d) => d.id === sourceId && isOrdinaryActiveDeck(d));
          const target = decks.find((d) => d.id === targetId && isOrdinaryActiveDeck(d));
          if (!source || !target || source.id === target.id) {
            setError(t(lang, '建议中的题组已变更，请按 [g] 重新分析', 'Suggested decks changed; press [g] to re-run'));
            return;
          }
          setError('');
          setConfirmState({
            kind: 'merge',
            source,
            target,
            sourceCount: deckCardCount(source, progressMap),
            targetCount: deckCardCount(target, progressMap),
          });
        }
        return;
      }

      if (tab === 'split') {
        if (splitFocus === 'topics') {
          if (input === ' ') {
            const item = topicGroups[topicIndex];
            if (item) toggleTopic(item.topic);
          }
          return;
        }
        if (splitFocus === 'title') {
          if (key.upArrow) {
            setSplitFocus('topics');
          }
        }
      }
    },
    { isActive: isActive && !busy && !proposeBusy && !confirmState },
  );

  // Responsive Modal Sizing for 80x24, 120x36, 160x44
  const availCols = Math.max(width, Math.max(24, columns - 4));
  const availRows = Math.max(height, Math.max(16, rows - 2));
  const frameW = Math.max(48, Math.min(86, availCols - 4));
  const frameH = Math.max(18, Math.min(30, availRows - 2));
  const innerW = modalContentWidth(frameW);

  const hints = useMemo<KeyHint[]>(() => {
    if (tab === 'import') {
      return [
        { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '切栏/字段', 'Focus') },
        ...(importFocus === 'path' ? [{ key: 'Tab', label: t(lang, '路径补全', 'Complete') }] : []),
        { key: 'Ctrl+G', label: t(lang, 'AI归档建议', 'AI Filing') },
        { key: 'Enter', label: t(lang, '导入', 'Import') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    if (tab === 'merge') {
      return [
        { key: '1-3', label: t(lang, '切页', 'Tabs') },
        { key: 's', label: t(lang, '换向', 'Flip') },
        { key: 'g', label: t(lang, 'AI合并建议', 'AI Suggest') },
        ...(topMergeSuggestion ? [{ key: 'a', label: t(lang, '应用建议', 'Apply') }] : []),
        { key: 'Enter', label: t(lang, '合并', 'Merge') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    if (splitFocus === 'title') {
      return [
        { key: asciiMode ? 'Up/Esc' : '↑/Esc', label: t(lang, '返回主题', 'Topics') },
        { key: 'Enter', label: t(lang, '确认拆分', 'Split') },
      ];
    }
    return [
      { key: '1-3/Tab', label: t(lang, '切页', 'Tabs') },
      { key: 'Space', label: t(lang, '勾选主题', 'Toggle') },
      { key: 'Enter', label: t(lang, '下一步', 'Next') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [tab, importFocus, splitFocus, topMergeSuggestion, lang, asciiMode]);

  // Body rows = what Modal really leaves for its children (it clamps the frame to the terminal) minus the
  // tab bar and its separator (#1748: a fixed 18-row floor overflowed the 60x18 minimum viewport).
  const bodyH = Math.max(1, modalChildRows(frameH, rows, hints.length > 0) - DECK_OPS_TAB_BAR_ROWS);
  // On a short terminal the Import tab drops its blank spacer rows so the hint and error rows still fit.
  const importGap = bodyH >= IMPORT_SPACED_MIN_ROWS ? 1 : 0;
  // Rows the Import error may take (what the rows above it leave): a longer one is cut with an ellipsis, so Yoga
  // never squeezes the preview row out of sight (#1748 follow-up). 4 = path and course label + input.
  const importErrorRows = Math.max(1, bodyH - (4 + (matches.length > 0 && importFocus === 'path' ? 1 : 0) + 2 * importGap +
    [jsonPreview || jsonHintErr, proposeBusy || importProposal, busy].filter(Boolean).length * (1 + importGap)));

  const renderMergeRow = useCallback(
    (item: DeckItem, ctx: VirtualListRenderContext) => {
      const countStr = ` ${deckCardCount(item, progressMap)}${t(lang, '题', 'c')}`;
      const draftTag = editingDraftDeckIds.has(item.id) ? (lang === 'en' ? ' [draft]' : ' [草稿]') : '';
      const courseTag = item.course ? ` [${truncateDisplay(item.course, 12, ell)}]` : '';
      const avail = Math.max(8, ctx.width - displayWidth(courseTag) - displayWidth(draftTag) - displayWidth(countStr));
      const titleText = padDisplay(truncateDisplay(deckLabel(item), avail, ell), avail);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      return (
        <Text color={fg} bold={ctx.selected}>
          {titleText}
          {courseTag ? <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{courseTag}</Text> : null}
          {draftTag ? <Text color={ctx.selected ? theme.selectionFg : theme.warning}>{draftTag}</Text> : null}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{countStr}</Text>
        </Text>
      );
    },
    [progressMap, lang, editingDraftDeckIds, theme, ell],
  );

  const renderTopicRow = useCallback(
    (item: TopicGroup, ctx: VirtualListRenderContext) => {
      const checked = selectedTopics.includes(item.topic);
      const box = checked ? (asciiMode ? '[x] ' : '[✓] ') : '[ ] ';
      const countStr = ` ${item.count}${t(lang, '题', 'c')}`;
      const avail = Math.max(6, ctx.width - box.length - displayWidth(countStr));
      const label = padDisplay(truncateDisplay(item.topic, avail, ell), avail);
      const fg = ctx.selected ? theme.selectionFg : checked ? theme.primary : theme.text;
      return (
        <Text color={fg} bold={ctx.selected || checked}>
          <Text color={ctx.selected ? theme.selectionFg : checked ? theme.success : theme.muted}>{box}</Text>
          {label}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{countStr}</Text>
        </Text>
      );
    },
    [selectedTopics, asciiMode, lang, theme, ell],
  );

  const tabSpecs: Array<{ id: DeckOpsTab; key: string; label: string }> = [
    { id: 'import', key: '1', label: t(lang, '导入 JSON', 'Import JSON') },
    { id: 'merge', key: '2', label: t(lang, '合并题组', 'Merge') },
    { id: 'split', key: '3', label: t(lang, '拆分题组', 'Split') },
  ];

  const mergeListH = Math.max(4, bodyH - (error ? 4 : 3));
  const splitListH = Math.max(4, bodyH - (error ? 6 : 5));
  const arrowGlyph = asciiMode ? '->' : '→';
  const promptGlyph = asciiMode ? '>' : '›';
  const dotSep = asciiMode ? ' - ' : ' · ';
  const sepLine = (asciiMode ? '-' : '─').repeat(innerW);

  return (
    <>
      <Modal
        title={t(lang, '题组操作中心', 'Deck Operations')}
        icon={asciiMode ? '+' : '◈'}
        subtitle={selectedDeck ? truncateDisplay(deckLabel(selectedDeck), 26, ell) : undefined}
        width={frameW}
        height={frameH}
        onClose={onClose}
        isActive={isActive && !confirmState && !busy && !proposeBusy}
        hints={hints}
      >
        {/* Tab Bar */}
        <Box flexDirection="row" height={1} gap={1} flexShrink={0} overflow="hidden">
          {tabSpecs.map((spec) => {
            const active = tab === spec.id;
            const focusedBar = tab === 'import' && importFocus === 'tabs';
            return (
              <Badge
                key={spec.id}
                label={`${spec.key}:${spec.label}`}
                tone={active ? (focusedBar ? 'accent' : 'primary') : 'neutral'}
                variant={active ? 'solid' : 'outline'}
              />
            );
          })}
          <Box flexGrow={1} />
          <Text color={theme.dim}>
            {tab === 'import' && importFocus !== 'tabs'
              ? t(lang, asciiMode ? 'Up切页' : '↑切页', asciiMode ? 'Up:tabs' : '↑tabs')
              : '1-3 / Tab'}
          </Text>
        </Box>
        <Box height={1} flexShrink={0}>
          <Text color={theme.border}>{sepLine}</Text>
        </Box>

        {/* Tab 1: Import JSON */}
        {tab === 'import' ? (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            <Box flexDirection="row" justifyContent="space-between" height={1}>
              <Text color={importFocus === 'path' ? theme.primary : theme.muted} bold={importFocus === 'path'}>
                {t(lang, '本地题组 JSON 路径 (支持 ~ / \\ 及拖拽路径):', 'Local JSON Path (~ / \\ / drag-drop):')}
              </Text>
              {jsonPreview ? (
                <Text color={theme.success}>
                  {asciiMode ? `[OK] ${jsonPreview.cardCount}c` : `✓ ${jsonPreview.cardCount}${t(lang, '题', 'c')}`}
                </Text>
              ) : null}
            </Box>
            <TextInput
              value={filePath}
              onChange={(v) => {
                setFilePath(v);
                if (error) setError('');
              }}
              onTab={handleTabComplete}
              onSubmit={() => {
                void handleImportSubmit();
              }}
              onCancel={onClose}
              placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\deck.json' : '~/Documents/deck.json'}
              width={Math.max(16, innerW - 4)}
              isActive={isActive && !confirmState && !busy && !proposeBusy && importFocus === 'path'}
              prompt={promptGlyph}
            />

            {matches.length > 0 && importFocus === 'path' ? (
              <Box height={1} overflow="hidden">
                <Text color={theme.dim} wrap="truncate-end">
                  {t(lang, '补全:', 'Tab:')} {matches.join('  ')}
                </Text>
              </Box>
            ) : null}

            <Box marginTop={importGap} height={1}>
              <Text color={importFocus === 'course' ? theme.primary : theme.muted} bold={importFocus === 'course'}>
                {t(lang, '覆盖所属课程 (可选，留空沿用文件或当前课程):', 'Course Override (optional):')}
              </Text>
            </Box>
            <TextInput
              value={courseOverride}
              onChange={setCourseOverride}
              onTab={() => {
                switchTab('merge');
              }}
              onSubmit={() => {
                void handleImportSubmit();
              }}
              onCancel={onClose}
              placeholder={
                activeFocusCourse
                  ? t(lang, `留空默认 (${activeFocusCourse})`, `Leave blank (default: ${activeFocusCourse})`)
                  : t(lang, '例如：线性代数', 'e.g. Linear Algebra')
              }
              width={Math.max(16, innerW - 4)}
              isActive={isActive && !confirmState && !busy && !proposeBusy && importFocus === 'course'}
              prompt={promptGlyph}
            />

            {jsonPreview ? (
              <Box marginTop={importGap} height={1} overflow="hidden">
                <Text color={theme.muted} wrap="truncate-end">
                  {t(lang, '预览:', 'Preview:')}{' '}
                  <Text color={theme.text}>{jsonPreview.title || t(lang, '(将用文件名)', '(filename)')}</Text>
                  {jsonPreview.course ? `${dotSep}${jsonPreview.course}` : ''}
                  {dotSep}
                  {jsonPreview.cardCount} {t(lang, '题', 'cards')}
                </Text>
              </Box>
            ) : jsonHintErr ? (
              <Box marginTop={importGap} height={1} overflow="hidden">
                <Text color={theme.warning} wrap="truncate-end">
                  {`${asciiMode ? '[!]' : '▲'} ${jsonHintErr}`}
                </Text>
              </Box>
            ) : null}

            {proposeBusy ? (
              <Box marginTop={importGap} height={1} overflow="hidden">
                <Spinner label={t(lang, `正在分析导入归档建议${ell}`, `Suggesting import filing${ell}`)} active={isActive} />
              </Box>
            ) : importProposal ? (
              <Box marginTop={importGap} height={1} overflow="hidden">
                <Text color={theme.ai} wrap="truncate-end">
                  {truncateDisplay(importProposalBannerText, innerW, ell)}
                </Text>
              </Box>
            ) : null}

            {busy ? (
              <Box marginTop={importGap}>
                <Spinner label={t(lang, `正在导入题组 JSON${ell}`, `Importing deck JSON${ell}`)} active={isActive} />
              </Box>
            ) : null}

            {error ? (
              <Box marginTop={importGap} height={importErrorRows} overflow="hidden">
                <Text color={theme.error} wrap={importErrorRows === 1 ? 'truncate-end' : 'wrap'}>
                  {truncateDisplay(`${asciiMode ? '[X]' : '✕'} ${error}`, importErrorRows * (innerW - 2), ell)}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {/* Tab 2: Merge Decks */}
        {tab === 'merge' ? (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            {!selectedDeck ? (
              <EmptyState
                title={t(lang, '未选中题组', 'No deck selected')}
                hint={t(lang, '请先在学习库选中一个题组，或按 [1] 导入题组 JSON', 'Select a deck in Library first, or press [1] to import JSON')}
                width={innerW}
                height={bodyH}
              />
            ) : !isOrdinaryActiveDeck(selectedDeck) ? (
              <EmptyState
                title={t(lang, '当前题组不可合并', 'Deck cannot be merged')}
                hint={t(lang, '已归档或系统题组无法合并，请先恢复或选择其他题组', 'Archived or system decks cannot be merged')}
                width={innerW}
                height={bodyH}
              />
            ) : (
              <>
                <Box height={1} overflow="hidden">
                  <Text color={theme.muted} wrap="truncate-end">
                    {mergeDirection === 'into-other' ? (
                      <>
                        {t(lang, '将', 'Merge')}{' '}
                        <Text color={theme.accent} bold>
                          {truncateDisplay(deckLabel(selectedDeck), 22, ell)}
                        </Text>{' '}
                        {arrowGlyph} {t(lang, '并入下方所选目标题组 (s 换向)', 'into selected target (s flip)')}
                      </>
                    ) : (
                      <>
                        {t(lang, '将下方所选来源题组', 'Merge selected source')} {arrowGlyph}{' '}
                        <Text color={theme.accent} bold>
                          {truncateDisplay(deckLabel(selectedDeck), 22, ell)}
                        </Text>{' '}
                        {t(lang, '(s 换向)', '(s flip)')}
                      </>
                    )}
                  </Text>
                </Box>
                <Box height={1} flexShrink={0}>
                  <Text color={theme.border}>{sepLine}</Text>
                </Box>
                <Box height={1} overflow="hidden">
                  {suggestBusy ? (
                    <Spinner
                      label={t(lang, `正在分析题组合并建议${ell}`, `Analyzing deck merge suggestions${ell}`)}
                      active={isActive}
                    />
                  ) : topMergeSuggestion ? (
                    <Text color={theme.ai} wrap="truncate-end">
                      {truncateDisplay(mergeSuggestionBannerText, innerW, ell)}
                    </Text>
                  ) : suggestNotice ? (
                    <Text color={theme.muted} wrap="truncate-end">
                      {truncateDisplay(suggestNotice, innerW, ell)}
                    </Text>
                  ) : (
                    <Text color={theme.dim} wrap="truncate-end">
                      {truncateDisplay(
                        t(
                          lang,
                          '按 [g] AI合并建议 (发送题组标题与主题给模型分析)',
                          'Press [g] AI Suggest (analyzes deck titles & topics)',
                        ),
                        innerW,
                        ell,
                      )}
                    </Text>
                  )}
                </Box>
                <VirtualList
                  items={mergeCandidates}
                  height={mergeListH}
                  width={innerW}
                  selectedIndex={mergeIndex}
                  onChange={setMergeIndex}
                  onSelect={handleMergeSelect}
                  isActive={isActive && !confirmState && !busy && tab === 'merge'}
                  keyExtractor={(d) => d.id}
                  renderItem={renderMergeRow}
                  emptyText={t(lang, '没有其他可合并的普通题组', 'No other active decks to merge')}
                  emptyHint={t(lang, '按 [1] 可导入新题组 JSON', 'Press [1] to import a deck JSON')}
                />
                {error ? (
                  <Box height={1} overflow="hidden">
                    <Text color={theme.error} wrap="truncate-end">
                      {`${asciiMode ? '[X]' : '✕'} ${error}`}
                    </Text>
                  </Box>
                ) : null}
              </>
            )}
          </Box>
        ) : null}

        {/* Tab 3: Split Deck */}
        {tab === 'split' ? (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            {!selectedDeckId ? (
              <EmptyState
                title={t(lang, '未选中题组', 'No deck selected')}
                hint={t(lang, '请先在学习库选中一个题组再拆分，或按 [1] 导入 JSON', 'Select a deck in Library first, or press [1] to import JSON')}
                width={innerW}
                height={bodyH}
              />
            ) : splitLoading ? (
              <Box height={bodyH} alignItems="center" justifyContent="center">
                <Spinner label={t(lang, `正在读取题组主题${ell}`, `Loading deck topics${ell}`)} active={isActive} />
              </Box>
            ) : splitError ? (
              <Box height={bodyH} paddingY={1}>
                <Text color={theme.error}>{splitError}</Text>
              </Box>
            ) : !splitDeck ? (
              <EmptyState title={t(lang, '题组不存在', 'Deck not found')} width={innerW} height={bodyH} />
            ) : splitDeck.archived || splitDeck.systemKind ? (
              <EmptyState
                title={t(lang, '当前题组不可拆分', 'Deck cannot be split')}
                hint={t(lang, '已归档或系统题组不能拆分', 'Archived or system decks cannot be split')}
                width={innerW}
                height={bodyH}
              />
            ) : topicGroups.length <= 1 ? (
              <EmptyState
                title={t(lang, '当前题组无法按主题拆分', 'Cannot split by topic')}
                hint={t(
                  lang,
                  `仅检测到 ${topicGroups.length} 个主题，拆分后两个题组均须至少保留 1 道题`,
                  `Only ${topicGroups.length} topic found; splitting requires at least 2 topics`,
                )}
                width={innerW}
                height={bodyH}
              />
            ) : (
              <>
                <Box height={1} overflow="hidden">
                  <Text color={theme.muted} wrap="truncate-end">
                    {t(lang, '已选主题', 'Topics')}: <Text color={theme.primary} bold>{selectedTopics.length}</Text>/
                    {topicGroups.length}
                    {dotSep}
                    {t(lang, '拆出', 'Move')}: <Text color={theme.accent} bold>{selectedSplitCount}</Text>/
                    {totalSplitCards} {t(lang, '题', 'cards')}
                    {dotSep}
                    {t(lang, '保留', 'Keep')}: <Text color={theme.text}>{totalSplitCards - selectedSplitCount}</Text>
                  </Text>
                </Box>
                <VirtualList
                  items={topicGroups}
                  height={splitListH}
                  width={innerW}
                  selectedIndex={topicIndex}
                  onChange={setTopicIndex}
                  onSelect={(item) => proceedToSplitTitle(item)}
                  isActive={isActive && !confirmState && !busy && tab === 'split' && splitFocus === 'topics'}
                  keyExtractor={(g) => g.topic}
                  renderItem={renderTopicRow}
                />
                <Box height={1} flexShrink={0}>
                  <Text color={theme.border}>{sepLine}</Text>
                </Box>
                <Box height={1} overflow="hidden">
                  <Text color={splitFocus === 'title' ? theme.primary : theme.muted} bold={splitFocus === 'title'}>
                    {t(lang, '新题组名称 (Enter 确认拆分):', 'New Deck Title (Enter to split):')}
                  </Text>
                </Box>
                <TextInput
                  value={splitTitle}
                  onChange={(v) => {
                    setSplitTitle(v);
                    if (error) setError('');
                  }}
                  onSubmit={(val) => handleSplitTitleSubmit(val)}
                  onCancel={() => setSplitFocus('topics')}
                  placeholder={t(lang, `输入拆分后的新题组名称${ell}`, `Enter new deck title${ell}`)}
                  width={Math.max(16, innerW - 4)}
                  isActive={isActive && !confirmState && !busy && tab === 'split' && splitFocus === 'title'}
                  prompt={promptGlyph}
                />
                {error ? (
                  <Box height={1} overflow="hidden">
                    <Text color={theme.error} wrap="truncate-end">
                      {`${asciiMode ? '[X]' : '✕'} ${error}`}
                    </Text>
                  </Box>
                ) : null}
              </>
            )}
          </Box>
        ) : null}
      </Modal>

      {confirmState ? (
        <ConfirmDialog
          title={
            confirmState.kind === 'merge'
              ? t(lang, '确认合并题组', 'Confirm Merge Decks')
              : confirmState.kind === 'split'
                ? t(lang, '确认拆分题组', 'Confirm Split Deck')
                : confirmState.kind === 'propose-import'
                  ? t(lang, 'AI 建议导入归档信息', 'AI Suggest Import Filing')
                  : t(lang, 'AI 分析并推荐题组合并', 'AI Suggest Deck Merges')
          }
          message={
            confirmState.kind === 'merge'
              ? t(
                  lang,
                  `将「${deckLabel(confirmState.source)}」(${confirmState.sourceCount} 题) 合并入「${deckLabel(confirmState.target)}」(${confirmState.targetCount} 题)？来源题组将被移除，所有题目与学习记录全部保留。`,
                  `Merge "${deckLabel(confirmState.source)}" (${confirmState.sourceCount} cards) into "${deckLabel(confirmState.target)}" (${confirmState.targetCount} cards)? The source deck will be removed; all cards and history stay.`,
                )
              : confirmState.kind === 'split'
                ? t(
                    lang,
                    `从「${confirmState.deck.title}」拆出 ${confirmState.movedCount} 题到新题组「${confirmState.title}」？原题组将保留 ${confirmState.remainingCount} 题。`,
                    `Split ${confirmState.movedCount} cards from "${confirmState.deck.title}" into new deck "${confirmState.title}"? ${confirmState.remainingCount} cards will stay in source.`,
                  )
                : confirmState.kind === 'propose-import'
                  ? t(
                      lang,
                      `将「${confirmState.previewTitle}」（${basename(confirmState.filePath)}，${confirmState.cardCount} 题）发送给已配置模型（draft.import.propose），用于建议归属课程、标题与合并目标；取消不会发起任何模型调用。`,
                      `Send "${confirmState.previewTitle}" (${basename(confirmState.filePath)}, ${confirmState.cardCount} cards) to the configured model (draft.import.propose) to suggest course, title, and merge target. Cancelling makes no model calls.`,
                    )
                  : t(
                      lang,
                      '将把当前课程的题组标题与主题名称发送给已配置模型（deck.merge.suggest），用于分析相近或重复题组；实际合并前仍需你确认。',
                      'Send current course deck titles and topic names to the configured model (deck.merge.suggest) to suggest near-duplicate merges. You will confirm before any merge runs.',
                    )
          }
          confirmLabel={
            confirmState.kind === 'merge'
              ? t(lang, '确认合并', 'Merge')
              : confirmState.kind === 'split'
                ? t(lang, '确认拆分', 'Split')
                : confirmState.kind === 'propose-import'
                  ? t(lang, '获取建议', 'Suggest')
                  : t(lang, '开始分析', 'Suggest')
          }
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => {
            void handleConfirmExecute();
          }}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}
    </>
  );
});
