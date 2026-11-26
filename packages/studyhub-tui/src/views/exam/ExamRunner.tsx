import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { UiLanguage } from '../../types/contracts.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ChromeLabel } from '../../components/Layout.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { ScrollArea } from '../../components/ScrollArea.js';
import { TextInput } from '../../components/TextInput.js';
import { LAYOUT_BP } from '../../layout/breakpoints.js';
import { truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import { buildExamWindowTitle, writeTerminalTitle } from '../../render/terminal-title.js';
import { t, useTuiStore } from '../../state/store.js';
import { getColorLevel, makeChalk, useTheme } from '../../theme/tokens.js';
import type { CaseHighlight, ExamCard, OralView, RunView } from './types.js';
import { computeRemainingMs, formatDurationMs } from './utils.js';

export interface ExamRunnerProps {
  kind: 'written' | 'case' | 'oral';
  run: RunView | null;
  oral: OralView | null;
  width: number;
  height: number;
  lang: UiLanguage;
  isActive: boolean;
  busy: boolean;
  error: string | null;
  onSelectPick: (cardId: string, selected: string[]) => void;
  onSaveCaseResponse: (cardId: string, text: string) => void;
  onSaveHighlights?: (highlights: CaseHighlight[]) => void;
  onLoadSourceText?: (sourceId: string) => Promise<string | null>;
  onJumpWritten: (index: number) => void;
  onSubmitWritten: (caseResponses?: Record<string, string>) => void;
  onSaveOralAnswer: (cardId: string, answer: string, field: 'main' | 'followup') => void;
  onOralFollowup: (cardId: string) => void;
  onOralNext: () => void;
  onSubmitOral: () => void;
  onAbortBack: () => void;
}

const BASE_CLAIMED = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'n', 'a', 'b'];
const CASE_CLAIMED = [...BASE_CLAIMED, 's', 'H', 'j', 'k', '[', ']'];
const WIDE_CASE_BREAKPOINT = LAYOUT_BP.AI_DRAWER_SIDE;

export const ExamRunner = memo(function ExamRunner({
  kind,
  run,
  oral,
  width,
  height,
  lang,
  isActive,
  busy,
  error,
  onSelectPick,
  onSaveCaseResponse,
  onSaveHighlights,
  onLoadSourceText,
  onJumpWritten,
  onSubmitWritten,
  onSaveOralAnswer,
  onOralFollowup,
  onOralNext,
  onSubmitOral,
  onAbortBack,
}: ExamRunnerProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const ellipsis = asciiMode ? '...' : '…';

  const [now, setNow] = useState(() => Date.now());
  const [flagged, setFlagged] = useState<Set<string>>(() => new Set());
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [editingField, setEditingField] = useState<'none' | 'case' | 'oral-main' | 'oral-followup'>('none');
  const [draftText, setDraftText] = useState('');
  const [caseIdx, setCaseIdx] = useState(0);
  const [caseDrafts, setCaseDrafts] = useState<Record<string, string>>({});
  const [scenarioOpenNarrow, setScenarioOpenNarrow] = useState(false);
  const [scenarioOpenWide, setScenarioOpenWide] = useState(true);
  const [scenarioScrollTop, setScenarioScrollTop] = useState(0);
  const [selectedParaIdx, setSelectedParaIdx] = useState(0);
  const [localHighlights, setLocalHighlights] = useState<CaseHighlight[]>([]);
  const [fallbackScenarioText, setFallbackScenarioText] = useState<string | null>(null);
  const autoSubmittedRef = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;

  // Sync case drafts & highlights when run opens / changes
  useEffect(() => {
    const currentRun = runRef.current;
    autoSubmittedRef.current = false;
    setFlagged(new Set());
    setConfirmSubmit(false);
    setEditingField('none');
    setCaseIdx(0);
    setScenarioOpenNarrow(false);
    setScenarioOpenWide(true);
    setScenarioScrollTop(0);
    setSelectedParaIdx(0);
    setFallbackScenarioText(null);
    if (currentRun?.examKinds === 'case' && Array.isArray(currentRun.responses)) {
      const map: Record<string, string> = {};
      for (const r of currentRun.responses) map[r.cardId] = r.response || '';
      setCaseDrafts(map);
    } else {
      setCaseDrafts({});
    }
    setLocalHighlights(Array.isArray(currentRun?.highlights) ? currentRun.highlights : []);
  }, [run?.id, oral?.id]);

  // Keep local highlights synchronized with server run updates
  useEffect(() => {
    if (Array.isArray(run?.highlights)) {
      setLocalHighlights(run.highlights);
    }
  }, [run?.highlights]);

  const hasActiveExam = Boolean(run || oral);
  useEffect(() => {
    if (!hasActiveExam) return undefined;
    return useTuiStore.getState().registerQuitGuard(() => {
      useTuiStore.getState().setQuitConfirmOpen(true);
      return true;
    });
  }, [hasActiveExam]);

  // Sync oral text buffer when question changes
  useEffect(() => {
    if (kind !== 'oral' || !oral?.entry) return;
    if (editingField === 'none') {
      setDraftText(oral.entry.answer || '');
    }
  }, [kind, oral?.index, oral?.entry?.cardId, editingField, oral?.entry]);

  // Countdown / elapsed timer — cleanly cleared on unmount!
  useEffect(() => {
    if (!isActive) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const remainingMs = useMemo(
    () => (kind === 'oral' ? null : computeRemainingMs(run, now)),
    [kind, run, now],
  );
  const elapsedMs = useMemo(() => {
    const started = kind === 'oral' ? oral?.startedAt : run?.startedAt;
    const ms = started ? Date.parse(started) : NaN;
    return Number.isFinite(ms) ? Math.max(0, now - ms) : 0;
  }, [kind, oral?.startedAt, run?.startedAt, now]);

  // Auto-submit when written/case timer expires
  useEffect(() => {
    if (kind === 'oral' || !run || busy || autoSubmittedRef.current) return;
    if (remainingMs !== null && remainingMs <= 0) {
      autoSubmittedRef.current = true;
      onSubmitWritten(kind === 'case' ? caseDrafts : undefined);
    }
  }, [kind, run, remainingMs, busy, caseDrafts, onSubmitWritten]);

  // Round 96 Track C9: Live OSC 2 terminal window title during mock exam (minute-granularity to avoid spam)
  const oscAt = kind === 'oral' ? (oral?.index ?? 0) + 1 : kind === 'case' ? caseIdx + 1 : (run?.index ?? 0) + 1;
  const oscTotal = kind === 'oral' ? (oral?.total ?? 1) : kind === 'case' ? Math.max(1, run?.paperCards?.length ?? 1) : Math.max(1, run?.total ?? 1);
  const oscMinuteBucket = Math.floor((remainingMs ?? elapsedMs) / 60_000);
  const oscTimerRef = useRef({ remainingMs, elapsedMs });
  oscTimerRef.current = { remainingMs, elapsedMs };
  useEffect(() => {
    if (!hasActiveExam || !isActive) return undefined;
    const { remainingMs: rem, elapsedMs: el } = oscTimerRef.current;
    const timerText = rem !== null ? formatDurationMs(rem) : formatDurationMs(el);
    writeTerminalTitle(
      buildExamWindowTitle({ kind, at: oscAt, total: oscTotal, timerText, lang }),
      { asciiMode },
    );
    return undefined;
    // Intentionally keyed on minute bucket + question index to keep terminal title writes low-frequency.
  }, [hasActiveExam, isActive, kind, oscAt, oscTotal, oscMinuteBucket, lang, asciiMode]);

  useEffect(() => {
    if (!hasActiveExam) return undefined;
    return () => {
      writeTerminalTitle('StudyHub', { asciiMode });
    };
  }, [hasActiveExam, asciiMode]);

  const caseCards: ExamCard[] = useMemo(
    () => (kind === 'case' ? (run?.paperCards ?? (run?.card ? [run.card] : [])) : []),
    [kind, run?.paperCards, run?.card],
  );
  const safeCaseIdx = Math.max(0, Math.min(caseIdx, Math.max(0, caseCards.length - 1)));
  const currentCaseCard = caseCards[safeCaseIdx] ?? null;

  // Resolve case scenario source & paragraphs
  const caseDeckId = run?.paper?.deckId ?? currentCaseCard?.deckId;
  const caseDeck = useMemo(
    () => (kind === 'case' && caseDeckId ? snapshot?.decks?.find((d) => d.id === caseDeckId) : undefined),
    [kind, caseDeckId, snapshot?.decks],
  );
  const caseSourceId = (caseDeck as { caseSourceId?: string } | undefined)?.caseSourceId;
  const caseSource = useMemo(
    () => (caseSourceId ? snapshot?.sources?.find((s) => s.id === caseSourceId) : undefined),
    [caseSourceId, snapshot?.sources],
  );
  const snapshotScenarioText = (caseSource as { text?: string } | undefined)?.text;

  useEffect(() => {
    if (kind !== 'case' || !caseSourceId || snapshotScenarioText || !onLoadSourceText) return;
    let active = true;
    void onLoadSourceText(caseSourceId).then((loaded) => {
      if (active && typeof loaded === 'string') setFallbackScenarioText(loaded);
    });
    return () => {
      active = false;
    };
  }, [kind, caseSourceId, snapshotScenarioText, onLoadSourceText]);

  const scenarioText = snapshotScenarioText ?? fallbackScenarioText ?? '';
  const scenarioTitle = String(
    caseSource?.title || caseDeck?.title || run?.title || t(lang, '案例背景材料', 'Case Scenario'),
  );
  const scenarioParagraphs = useMemo(
    () =>
      String(scenarioText)
        .replace(/\r\n?/g, '\n')
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean),
    [scenarioText],
  );

  const isWideCase = width >= WIDE_CASE_BREAKPOINT;
  const hasScenario = kind === 'case' && scenarioParagraphs.length > 0;
  const showScenarioSideBySide = hasScenario && isWideCase && scenarioOpenWide;
  const showScenarioOverlay = hasScenario && !isWideCase && scenarioOpenNarrow;
  const scenarioVisible = showScenarioSideBySide || showScenarioOverlay;

  const scenarioPaneW = showScenarioSideBySide
    ? Math.max(36, Math.floor(width * 0.44))
    : width;
  const questionPaneW = showScenarioSideBySide
    ? Math.max(36, width - scenarioPaneW - 1)
    : width;
  const scenarioScrollW = Math.max(16, scenarioPaneW - 4);
  const scenarioScrollH = Math.max(3, height - 4);

  const safeParaIdx = Math.max(0, Math.min(selectedParaIdx, Math.max(0, scenarioParagraphs.length - 1)));
  const colorLevel = getColorLevel();

  const { scenarioLines, paragraphStarts } = useMemo(() => {
    const chalk = makeChalk(colorLevel);
    const lines: string[] = [];
    const starts: number[] = [];
    const hlSet = new Set(localHighlights.map((h) => h.paragraph));
    const wrapW = Math.max(12, scenarioScrollW - 1);
    scenarioParagraphs.forEach((para, idx) => {
      const pNum = idx + 1;
      const isHl = hlSet.has(pNum);
      const isCursor = idx === safeParaIdx;
      starts.push(lines.length);
      const marker = isCursor ? '>' : ' ';
      const star = isHl ? (asciiMode ? ' *' : ' ★') : '';
      const tag = `${marker} [P${pNum}${star}]`;
      lines.push(
        isHl
          ? chalk.hex(theme.warning).bold(tag)
          : isCursor
            ? chalk.hex(theme.primary).bold(tag)
            : chalk.hex(theme.info).bold(tag),
      );
      const wrapped = wrapDisplay(para, wrapW);
      for (const wLine of wrapped) {
        lines.push(isHl ? chalk.hex(theme.warning)(wLine) : chalk.hex(theme.text)(wLine));
      }
      if (idx < scenarioParagraphs.length - 1) lines.push('');
    });
    return { scenarioLines: lines, paragraphStarts: starts };
  }, [colorLevel, scenarioParagraphs, localHighlights, scenarioScrollW, safeParaIdx, asciiMode, theme.warning, theme.primary, theme.info, theme.text]);

  const handleScenarioScroll = useCallback(
    (nextTop: number) => {
      setScenarioScrollTop(nextTop);
      if (paragraphStarts.length === 0) return;
      let matched = 0;
      for (let i = 0; i < paragraphStarts.length; i += 1) {
        if (paragraphStarts[i] <= nextTop + 1) matched = i;
        else break;
      }
      setSelectedParaIdx(matched);
    },
    [paragraphStarts],
  );

  const toggleParagraphHighlight = useCallback(() => {
    if (!hasScenario) return;
    const pNum = safeParaIdx + 1;
    const paraText = scenarioParagraphs[safeParaIdx];
    if (!paraText) return;
    const exists = localHighlights.some((h) => h.paragraph === pNum);
    const next: CaseHighlight[] = exists
      ? localHighlights.filter((h) => h.paragraph !== pNum)
      : [
          ...localHighlights,
          {
            id: `tui-p${pNum}`,
            paragraph: pNum,
            start: 0,
            end: paraText.length,
            color: 'yellow',
          },
        ];
    setLocalHighlights(next);
    onSaveHighlights?.(next);
  }, [hasScenario, safeParaIdx, scenarioParagraphs, localHighlights, onSaveHighlights]);

  const stepParagraph = useCallback(
    (delta: number) => {
      if (scenarioParagraphs.length === 0) return;
      const nextIdx = (safeParaIdx + delta + scenarioParagraphs.length) % scenarioParagraphs.length;
      setSelectedParaIdx(nextIdx);
      const targetLine = paragraphStarts[nextIdx] ?? 0;
      const maxTop = Math.max(0, scenarioLines.length - scenarioScrollH);
      setScenarioScrollTop(Math.min(maxTop, Math.max(0, targetLine)));
    },
    [scenarioParagraphs.length, safeParaIdx, paragraphStarts, scenarioLines.length, scenarioScrollH],
  );

  const currentWrittenCard = kind === 'written' ? run?.card ?? null : null;
  const totalCount =
    kind === 'oral'
      ? (oral?.total ?? 0)
      : kind === 'case'
        ? caseCards.length
        : (run?.total ?? run?.picks?.length ?? 0);
  const currentIdx =
    kind === 'oral' ? (oral?.index ?? 0) : kind === 'case' ? safeCaseIdx : (run?.index ?? 0);

  // Selected picks map for written MCQ
  const picksMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of run?.picks ?? []) {
      if (p.cardId && Array.isArray(p.selected) && p.selected.length > 0) {
        map.set(p.cardId, p.selected);
      }
    }
    return map;
  }, [run?.picks]);

  const currentSelected = currentWrittenCard ? (picksMap.get(currentWrittenCard.id) ?? []) : [];

  const pageActive = useKeyScope({
    id: 'ExamRunner:main',
    active: isActive,
    keys: kind === 'case' ? CASE_CLAIMED : BASE_CLAIMED,
    onKey: (input, key) => {
      if (key.ctrl && input === 's') {
        setConfirmSubmit(true);
        return true;
      }
      if (busy) return false;

      if (kind === 'written' && run && currentWrittenCard) {
        const opts = currentWrittenCard.options ?? [];
        const isMulti = Boolean(currentWrittenCard.multiple || currentWrittenCard.kind === 'multi');
        // Digit keys 1..9 toggle/select options
        if (/^[1-9]$/.test(input)) {
          const idx = Number(input) - 1;
          const opt = opts[idx];
          if (!opt) return true;
          if (isMulti) {
            const exists = currentSelected.includes(opt.id);
            const next = exists
              ? currentSelected.filter((x) => x !== opt.id)
              : [...currentSelected, opt.id];
            onSelectPick(currentWrittenCard.id, next);
          } else {
            const next = currentSelected.includes(opt.id) ? [] : [opt.id];
            onSelectPick(currentWrittenCard.id, next);
          }
          return true;
        }
        if (input === 'f') {
          setFlagged((prev) => {
            const next = new Set(prev);
            if (next.has(currentWrittenCard.id)) next.delete(currentWrittenCard.id);
            else next.add(currentWrittenCard.id);
            return next;
          });
          return true;
        }
        if (input === 'n' || key.rightArrow || (key.tab && !key.shift)) {
          const nextIdx = (run.index + 1) % Math.max(1, totalCount);
          onJumpWritten(nextIdx);
          return true;
        }
        if (input === 'p' || key.leftArrow || (key.tab && key.shift)) {
          const prevIdx = (run.index - 1 + Math.max(1, totalCount)) % Math.max(1, totalCount);
          onJumpWritten(prevIdx);
          return true;
        }
        if (key.escape) {
          onAbortBack();
          return true;
        }
        return false;
      }

      if (kind === 'case' && currentCaseCard) {
        if (input === 's' && hasScenario) {
          if (isWideCase) setScenarioOpenWide((v) => !v);
          else setScenarioOpenNarrow((v) => !v);
          return true;
        }
        if (input === 'H' && hasScenario) {
          if (!isWideCase && !scenarioOpenNarrow) {
            setScenarioOpenNarrow(true);
          }
          toggleParagraphHighlight();
          return true;
        }
        if (input === '[' && scenarioVisible) {
          stepParagraph(-1);
          return true;
        }
        if (input === ']' && scenarioVisible) {
          stepParagraph(1);
          return true;
        }
        if (showScenarioOverlay) {
          if (key.escape) {
            setScenarioOpenNarrow(false);
            return true;
          }
          return false;
        }
        if (input === 'e' || key.return) {
          setDraftText(caseDrafts[currentCaseCard.id] ?? '');
          setEditingField('case');
          return true;
        }
        if (input === 'f') {
          setFlagged((prev) => {
            const next = new Set(prev);
            if (next.has(currentCaseCard.id)) next.delete(currentCaseCard.id);
            else next.add(currentCaseCard.id);
            return next;
          });
          return true;
        }
        if (input === 'n' || key.rightArrow || (key.tab && !key.shift)) {
          setCaseIdx((i) => (i + 1) % Math.max(1, caseCards.length));
          return true;
        }
        if (input === 'p' || key.leftArrow || (key.tab && key.shift)) {
          setCaseIdx((i) => (i - 1 + Math.max(1, caseCards.length)) % Math.max(1, caseCards.length));
          return true;
        }
        if (key.escape) {
          onAbortBack();
          return true;
        }
        return false;
      }

      if (kind === 'oral' && oral?.entry) {
        if (input === 'e' || key.return) {
          setDraftText(oral.entry.answer || '');
          setEditingField('oral-main');
          return true;
        }
        if (input === 'u' && oral.entry.followup) {
          setDraftText(oral.entry.followupAnswer || '');
          setEditingField('oral-followup');
          return true;
        }
        if (input === 'a' && !oral.entry.followup && oral.entry.answer.trim()) {
          onOralFollowup(oral.entry.cardId);
          return true;
        }
        if (input === 'n' && oral.index < oral.total - 1) {
          onOralNext();
          return true;
        }
        if (key.escape) {
          onAbortBack();
          return true;
        }
      }
      return false;
    },
  });

  // Header status
  const answeredCount =
    kind === 'oral'
      ? (oral?.answered ?? 0)
      : kind === 'case'
        ? caseCards.filter((c) => (caseDrafts[c.id] ?? '').trim().length > 0).length
        : (run?.picks ?? []).filter((p) => Array.isArray(p.selected) && p.selected.length > 0).length;

  const timerText =
    remainingMs !== null
      ? `${t(lang, '剩余', 'Left')} ${formatDurationMs(remainingMs)}`
      : `${t(lang, '用时', 'Elapsed')} ${formatDurationMs(elapsedMs)}`;
  const timerTone =
    remainingMs === null
      ? 'info'
      : remainingMs <= 60_000
        ? 'error'
        : remainingMs <= 300_000
          ? 'warning'
          : 'accent';

  const modeBadge =
    kind === 'oral'
      ? t(lang, '口试模拟', 'Oral Mock')
      : kind === 'case'
        ? t(lang, '案例卷', 'Case Paper')
        : t(lang, '选择题卷', 'Written MCQ');

  const innerW = Math.max(24, questionPaneW - 4);

  // Navigator strip 1..N
  const navTokens = useMemo(() => {
    const items: Array<{ n: number; current: boolean; answered: boolean; flag: boolean }> = [];
    if (kind === 'written') {
      const picks = run?.picks ?? [];
      const count = picks.length || totalCount;
      for (let i = 0; i < count; i++) {
        const p = picks[i];
        items.push({
          n: i + 1,
          current: i === currentIdx,
          answered: Boolean(p && Array.isArray(p.selected) && p.selected.length > 0),
          flag: Boolean(p && flagged.has(p.cardId)),
        });
      }
    } else if (kind === 'case') {
      caseCards.forEach((c, i) => {
        items.push({
          n: i + 1,
          current: i === currentIdx,
          answered: Boolean((caseDrafts[c.id] ?? '').trim()),
          flag: flagged.has(c.id),
        });
      });
    } else if (oral) {
      for (let i = 0; i < oral.total; i++) {
        items.push({
          n: i + 1,
          current: i === oral.index,
          answered: i < oral.index || (i === oral.index && Boolean(oral.entry?.answer?.trim())),
          flag: false,
        });
      }
    }
    return items;
  }, [kind, run?.picks, totalCount, currentIdx, flagged, caseCards, caseDrafts, oral]);

  const bodyH = Math.max(6, height - 6);
  const hlCount = new Set(localHighlights.map((h) => h.paragraph)).size;
  const flagGlyph = asciiMode ? '!' : '⚑';
  const hlGlyph = asciiMode ? '*' : '★';

  const renderScenarioPanel = (paneW: number, paneH: number) => {
    const paneInnerW = Math.max(16, paneW - 4);
    const scrollH = Math.max(3, paneH - 4);
    const paraLabel = `P${safeParaIdx + 1}/${scenarioParagraphs.length}`;
    return (
      <Panel
        title={truncateDisplay(scenarioTitle, Math.max(10, paneInnerW - 14), ellipsis)}
        badge={hlCount > 0 ? `${hlCount}${hlGlyph}` : paraLabel}
        badgeTone={hlCount > 0 ? 'warning' : 'info'}
        subtitle={
          showScenarioOverlay
            ? t(lang, 's 返回 · H 标亮', 's Question · H Highlight')
            : `${paraLabel} · ${t(lang, 'H 标亮', 'H Highlight')}`
        }
        focused={showScenarioOverlay}
        width={paneW}
        height={paneH}
        ascii={asciiMode}
      >
        <Box justifyContent="space-between" width={paneInnerW} marginBottom={0}>
          <ChromeLabel
            text={
              showScenarioOverlay
                ? t(lang, 'j/k/Ctrl+D 滚动 · [/] 段落 · H 标亮 · s 返回作答', 'j/k/Ctrl+D scroll · [/] para · H highlight · s back')
                : t(lang, 'j/k/Ctrl+D 滚动 · [/] 选段 · H 标亮 · s 隐显', 'j/k/Ctrl+D scroll · [/] para · H highlight · s hide')
            }
            maxWidth={paneInnerW}
            color={theme.muted}
            ascii={asciiMode}
          />
        </Box>
        <ScrollArea
          lines={scenarioLines}
          width={paneInnerW}
          height={scrollH}
          scrollTop={scenarioScrollTop}
          onScroll={handleScenarioScroll}
          isActive={pageActive && scenarioVisible}
          ascii={asciiMode}
        />
      </Panel>
    );
  };

  const hintText =
    kind === 'oral'
      ? t(lang, 'e 作答 · a 追问 · n 下一题 · Ctrl+S 交卷', 'e Answer · a Follow-up · n Next · Ctrl+S Submit')
      : kind === 'case'
        ? hasScenario
          ? t(
              lang,
              `s ${isWideCase ? '案例面板' : '看案例'} · H 标亮 · e 作答 · f 标记 · Ctrl+S 交卷`,
              `s Scenario · H Highlight · e Answer · f Flag · Ctrl+S Submit`,
            )
          : t(lang, 'e 作答 · f 标记 · n/p 切题 · Ctrl+S 交卷', 'e Answer · f Flag · n/p Move · Ctrl+S Submit')
        : t(lang, '1-9 选项 · f 标记 · n/p 切题 · Ctrl+S 交卷', '1-9 Pick · f Flag · n/p Move · Ctrl+S Submit');

  const questionPanel = (
    <Panel
      title={`${modeBadge} · ${currentIdx + 1}/${Math.max(1, totalCount)}`}
      subtitle={`${t(lang, '已答', 'Ans')} ${answeredCount}/${totalCount}${flagged.size ? ` · ${flagGlyph} ${flagged.size}` : ''}`}
      focused={!confirmSubmit && !showScenarioOverlay}
      width={questionPaneW}
      height={height}
      ascii={asciiMode}
    >
      <Box justifyContent="space-between" marginBottom={1} width={innerW}>
        <Box gap={1} flexShrink={0}>
          <Badge label={timerText} tone={timerTone} />
          {busy ? <Spinner label={t(lang, '正在处理…', 'Working…')} active={isActive} /> : null}
        </Box>
        <Box overflow="hidden" flexShrink={1}>
          <Text color={theme.muted}>
            {truncateDisplay(hintText, Math.max(8, innerW - 18), ellipsis)}
          </Text>
        </Box>
      </Box>

      {/* Navigator strip */}
      <Box flexWrap="wrap" columnGap={1} marginBottom={1}>
        {navTokens.slice(0, 30).map((tok) => {
          const sym = asciiMode ? (tok.flag ? '!' : tok.answered ? '*' : 'o') : tok.flag ? '⚑' : tok.answered ? '●' : '○';
          return (
            <Text
              key={tok.n}
              backgroundColor={tok.current ? theme.primary : theme.surface}
              color={
                tok.current
                  ? theme.dark
                    ? theme.bg
                    : '#ffffff'
                  : tok.flag
                    ? theme.warning
                    : tok.answered
                      ? theme.success
                      : theme.dim
              }
              bold={tok.current}
            >
              {` ${tok.n}${sym} `}
            </Text>
          );
        })}
      </Box>

      {error ? (
        <Box marginBottom={1}>
          <Text color={theme.error} wrap="wrap">{error}</Text>
        </Box>
      ) : null}

      {/* Written Question Body */}
      {kind === 'written' && currentWrittenCard ? (
        <Box flexDirection="column" height={bodyH} overflow="hidden">
          <Box gap={1} marginBottom={1}>
            <Badge
              label={
                currentWrittenCard.multiple || currentWrittenCard.kind === 'multi'
                  ? t(lang, '多选', 'Multi')
                  : currentWrittenCard.kind === 'truefalse'
                    ? t(lang, '判断', 'T/F')
                    : t(lang, '单选', 'Single')
              }
              tone="info"
              variant="soft"
            />
            {currentWrittenCard.topic ? (
              <Badge label={currentWrittenCard.topic} tone="accent" variant="soft" />
            ) : null}
            {flagged.has(currentWrittenCard.id) ? (
              <Badge label={t(lang, '已标记', 'Flagged')} tone="warning" />
            ) : null}
          </Box>

          <MarkdownView
            markdown={currentWrittenCard.prompt || ''}
            width={innerW}
            height={Math.max(4, Math.floor(bodyH * 0.45))}
            isActive={pageActive}
            vimNavKeys={false}
            spacePageDown={false}
          />

          <Box flexDirection="column" marginTop={1}>
            {(currentWrittenCard.options ?? []).map((opt, idx) => {
              const picked = currentSelected.includes(opt.id);
              const keyNum = idx + 1;
              return (
                <Box key={opt.id} marginBottom={0}>
                  <Text
                    backgroundColor={picked ? theme.selectionBg : undefined}
                    color={picked ? theme.primary : theme.text}
                    bold={picked}
                    wrap="wrap"
                  >
                    {` [${keyNum}] ${picked ? (asciiMode ? '*' : '◉') : (asciiMode ? 'o' : '○')} ${opt.text}`}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}

      {/* Case Paper Body */}
      {kind === 'case' && currentCaseCard ? (
        <Box flexDirection="column" height={bodyH} overflow="hidden">
          <Box columnGap={1} marginBottom={1} flexWrap="wrap">
            <Badge
              label={`${currentCaseCard.marks ?? 0} ${t(lang, '分', 'pts')}`}
              tone="accent"
            />
            {currentCaseCard.topic ? (
              <Badge label={currentCaseCard.topic} tone="info" variant="soft" />
            ) : null}
            {hasScenario ? (
              <Badge
                label={
                  hlCount > 0
                    ? t(lang, `s 案例(${scenarioParagraphs.length}段 · ${hlCount}${hlGlyph})`, `s Case(${scenarioParagraphs.length}p · ${hlCount}${hlGlyph})`)
                    : t(lang, `s 案例(${scenarioParagraphs.length}段)`, `s Case(${scenarioParagraphs.length}p)`)
                }
                tone="primary"
                variant="soft"
              />
            ) : null}
            {flagged.has(currentCaseCard.id) ? (
              <Badge label={t(lang, '已标记', 'Flagged')} tone="warning" />
            ) : null}
          </Box>

          <MarkdownView
            markdown={currentCaseCard.prompt || ''}
            width={innerW}
            height={Math.max(4, Math.floor(bodyH * 0.42))}
            isActive={pageActive && !showScenarioOverlay}
            vimNavKeys={false}
            spacePageDown={false}
          />

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              {editingField === 'case'
                ? t(lang, '编辑作答 (Ctrl+S 保存，Esc 取消):', 'Editing answer (Ctrl+S save, Esc cancel):')
                : t(lang, '你的作答 (按 e 编辑):', 'Your response (press e to edit):')}
            </Text>
            {editingField === 'case' ? (
              <KeyScope id="exam-runner:case-editor" opaque>
                <TextInput
                  value={draftText}
                  onChange={setDraftText}
                  multiline
                  height={Math.max(4, Math.floor(bodyH * 0.35))}
                  width={innerW}
                  isActive={isActive}
                  onSubmit={(val) => {
                    setCaseDrafts((prev) => ({ ...prev, [currentCaseCard.id]: val }));
                    onSaveCaseResponse(currentCaseCard.id, val);
                    setEditingField('none');
                  }}
                  onCancel={() => setEditingField('none')}
                />
              </KeyScope>
            ) : (
              <Text color={(caseDrafts[currentCaseCard.id] ?? '').trim() ? theme.text : theme.dim}>
                {(caseDrafts[currentCaseCard.id] ?? '').trim() ||
                  t(lang, '（尚未填写，按 e 开始作答）', '(Empty — press e to type response)')}
              </Text>
            )}
          </Box>
        </Box>
      ) : null}

      {/* Oral Mock Body */}
      {kind === 'oral' && oral?.entry ? (
        <Box flexDirection="column" height={bodyH} overflow="hidden">
          <Box gap={1} marginBottom={1}>
            {oral.role ? <Badge label={oral.role} tone="ai" /> : null}
            {oral.entry.topic ? (
              <Badge label={oral.entry.topic} tone="info" variant="soft" />
            ) : null}
          </Box>

          <MarkdownView
            markdown={oral.entry.prompt || ''}
            width={innerW}
            height={Math.max(3, Math.floor(bodyH * 0.32))}
            isActive={pageActive}
            vimNavKeys={false}
            spacePageDown={false}
          />

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              {editingField === 'oral-main'
                ? t(lang, '口述作答 (Ctrl+S 保存，Esc 取消):', 'Editing answer (Ctrl+S save, Esc cancel):')
                : t(lang, '你的回答 (按 e 编辑):', 'Your answer (press e to edit):')}
            </Text>
            {editingField === 'oral-main' ? (
              <KeyScope id="exam-runner:oral-main-editor" opaque>
                <TextInput
                  value={draftText}
                  onChange={setDraftText}
                  multiline
                  height={Math.max(3, Math.floor(bodyH * 0.25))}
                  width={innerW}
                  isActive={isActive}
                  onSubmit={(val) => {
                    onSaveOralAnswer(oral.entry!.cardId, val, 'main');
                    setEditingField('none');
                  }}
                  onCancel={() => setEditingField('none')}
                />
              </KeyScope>
            ) : (
              <Text color={oral.entry.answer.trim() ? theme.text : theme.dim}>
                {oral.entry.answer.trim() ||
                  t(lang, '（按 e 录入回答，保存后可按 a 触发考官追问）', '(Press e to answer; press a after saving for AI follow-up)')}
              </Text>
            )}
          </Box>

          {oral.entry.followup ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.ai} bold>
                {t(lang, `考官追问: ${oral.entry.followup}`, `Follow-up: ${oral.entry.followup}`)}
              </Text>
              {editingField === 'oral-followup' ? (
                <KeyScope id="exam-runner:oral-followup-editor" opaque>
                  <TextInput
                    value={draftText}
                    onChange={setDraftText}
                    multiline
                    height={3}
                    width={innerW}
                    isActive={isActive}
                    onSubmit={(val) => {
                      onSaveOralAnswer(oral.entry!.cardId, val, 'followup');
                      setEditingField('none');
                    }}
                    onCancel={() => setEditingField('none')}
                  />
                </KeyScope>
              ) : (
                <Text color={oral.entry.followupAnswer.trim() ? theme.text : theme.dim}>
                  {oral.entry.followupAnswer.trim() ||
                    t(lang, '（按 u 回答追问）', '(Press u to answer follow-up)')}
                </Text>
              )}
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Panel>
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {showScenarioOverlay ? (
        renderScenarioPanel(width, height)
      ) : showScenarioSideBySide ? (
        <Box flexDirection="row" width={width} height={height}>
          {renderScenarioPanel(scenarioPaneW, height)}
          <Box width={1} />
          {questionPanel}
        </Box>
      ) : (
        questionPanel
      )}

      {confirmSubmit ? (
        <KeyScope id="exam-runner:confirm-submit" opaque>
          <ConfirmDialog
            title={t(lang, '确认交卷', 'Submit Exam')}
            message={
              kind === 'oral'
                ? t(
                    lang,
                    `已回答 ${answeredCount}/${totalCount} 题。提交后将由 AI 考官统一评分并计入复习计划。`,
                    `Answered ${answeredCount}/${totalCount}. Submit for AI assessment and scheduling?`,
                  )
                : t(
                    lang,
                    `已作答 ${answeredCount}/${totalCount} 题。确认交卷并生成考试报告吗？`,
                    `Answered ${answeredCount}/${totalCount}. Submit paper and grade now?`,
                  )
            }
            confirmLabel={t(lang, '确认交卷', 'Submit')}
            cancelLabel={t(lang, '继续作答', 'Cancel')}
            isActive={isActive}
            onConfirm={() => {
              setConfirmSubmit(false);
              if (kind === 'oral') onSubmitOral();
              else onSubmitWritten(kind === 'case' ? caseDrafts : undefined);
            }}
            onCancel={() => setConfirmSubmit(false)}
          />
        </KeyScope>
      ) : null}
    </Box>
  );
});
