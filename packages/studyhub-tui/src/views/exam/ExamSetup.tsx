import React, { memo, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { StudySnapshot, UiLanguage } from '../../types/contracts.js';
import {
  Badge,
  EmptyState,
  Panel,
  SplitPane,
  VirtualList,
  useClaimKeys,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { t, useTuiStore } from '../../state/store.js';
import type {
  ExamMode,
  ExamSetupValue,
  HistoryItem,
  ScopeChoice,
  WrittenKinds,
} from './types.js';
import { buildHistoryItems, buildScopeChoices } from './utils.js';

export interface ExamSetupProps {
  snapshot: StudySnapshot | null;
  width: number;
  height: number;
  lang: UiLanguage;
  isActive: boolean;
  busy: boolean;
  error: string | null;
  resumableRun?: { id: string; title?: string; mode?: string } | null;
  onStart: (value: ExamSetupValue, scopeChoice: ScopeChoice) => void;
  onResume?: () => void;
  onOpenHistory: (item: HistoryItem) => void;
}

const MODES: readonly ExamMode[] = ['written', 'case', 'oral'];
const WRITTEN_COUNTS = [10, 20, 30] as const;
const ORAL_COUNTS = [3, 5, 8, 10] as const;
const TIME_LIMITS = [15, 30, 60] as const;
const WRITTEN_KINDS: readonly WrittenKinds[] = ['all', 'balanced', 'quiz', 'multi'];
const CLAIMED = ['1', '2', '3', 'c', 't', 'k', 'r', 'h', 'l'];

export const ExamSetup = memo(function ExamSetup({
  snapshot,
  width,
  height,
  lang,
  isActive,
  busy,
  error,
  resumableRun,
  onStart,
  onResume,
  onOpenHistory,
}: ExamSetupProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ellipsis = asciiMode ? '...' : '…';
  const [pane, setPane] = useState<'setup' | 'history'>('setup');
  const [mode, setMode] = useState<ExamMode>('written');
  const [countIdx, setCountIdx] = useState(0);
  const [oralCountIdx, setOralCountIdx] = useState(1);
  const [limitIdx, setLimitIdx] = useState(1); // default 30 min
  const [kindIdx, setKindIdx] = useState(0);
  const [scopeIdx, setScopeIdx] = useState(0);

  const scopes = useMemo(() => buildScopeChoices(snapshot, mode, lang), [snapshot, mode, lang]);
  const safeScopeIdx = Math.max(0, Math.min(scopeIdx, Math.max(0, scopes.length - 1)));
  const selectedScope = scopes[safeScopeIdx] ?? null;

  const historyItems = useMemo(() => buildHistoryItems(snapshot, lang), [snapshot, lang]);
  const [historyIdx, setHistoryIdx] = useState(0);

  useClaimKeys(CLAIMED, isActive);

  const count = mode === 'oral' ? ORAL_COUNTS[oralCountIdx] : WRITTEN_COUNTS[countIdx];
  const minutes = TIME_LIMITS[limitIdx];
  const kinds = WRITTEN_KINDS[kindIdx];

  useInput(
    (input, key) => {
      if (busy) return;
      if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
        if (input === 'h' || key.leftArrow) setPane('setup');
        else if (input === 'l' || key.rightArrow) setPane('history');
        else setPane((p) => (p === 'setup' ? 'history' : 'setup'));
        return;
      }
      if (input === '1') { setMode('written'); setScopeIdx(0); return; }
      if (input === '2') { setMode('case'); setScopeIdx(0); return; }
      if (input === '3') { setMode('oral'); setScopeIdx(0); return; }
      if (input === 'r' && resumableRun && onResume) {
        onResume();
        return;
      }
      if (pane === 'setup') {
        if (input === 'c') {
          if (mode === 'oral') setOralCountIdx((i) => (i + 1) % ORAL_COUNTS.length);
          else if (mode === 'written') setCountIdx((i) => (i + 1) % WRITTEN_COUNTS.length);
          return;
        }
        if (input === 't' && mode === 'written') {
          setLimitIdx((i) => (i + 1) % TIME_LIMITS.length);
          return;
        }
        if (input === 'k' && mode === 'written') {
          setKindIdx((i) => (i + 1) % WRITTEN_KINDS.length);
          return;
        }
      }
    },
    { isActive },
  );

  const modeLabel = (m: ExamMode) =>
    m === 'written'
      ? t(lang, '选择题卷', 'Written MCQ')
      : m === 'case'
        ? t(lang, '案例卷', 'Case Paper')
        : t(lang, '口试', 'Oral Mock');

  const kindsLabel = (k: WrittenKinds) =>
    k === 'all'
      ? t(lang, '全部题型', 'All')
      : k === 'balanced'
        ? t(lang, '单双均衡', 'Balanced')
        : k === 'quiz'
          ? t(lang, '仅单选', 'Single')
          : t(lang, '仅多选', 'Multi');

  const renderSetupPane = (paneW: number, paneH: number) => {
    const innerW = Math.max(20, paneW - 4);
    const listH = Math.max(3, paneH - 12 - (resumableRun ? 2 : 0) - (error ? 2 : 0));
    return (
      <Panel
        title={t(lang, '组卷设置', 'Exam Setup')}
        icon={asciiMode ? '@' : '◷'}
        focused={pane === 'setup'}
        width={paneW}
        height={paneH}
      >
        <Box flexDirection="row" gap={1} marginBottom={1}>
          {MODES.map((m, idx) => {
            const active = mode === m;
            return (
              <Text
                key={m}
                backgroundColor={active ? theme.primary : theme.surface}
                color={active ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                bold={active}
              >
                {` ${idx + 1}:${modeLabel(m)} `}
              </Text>
            );
          })}
        </Box>

        {mode === 'written' ? (
          <Box flexDirection="column" marginBottom={1}>
            <Box gap={2} flexWrap="wrap">
              <Text>
                <Text color={theme.muted}>{t(lang, '[c] 题数: ', '[c] Count: ')}</Text>
                {WRITTEN_COUNTS.map((n) => (
                  <Text key={n} color={n === count ? theme.primary : theme.dim} bold={n === count}>
                    {` ${n} `}
                  </Text>
                ))}
              </Text>
              <Text>
                <Text color={theme.muted}>{t(lang, '[t] 时长: ', '[t] Time: ')}</Text>
                {TIME_LIMITS.map((m) => (
                  <Text key={m} color={m === minutes ? theme.primary : theme.dim} bold={m === minutes}>
                    {` ${m}m `}
                  </Text>
                ))}
              </Text>
            </Box>
            <Box>
              <Text color={theme.muted}>{t(lang, '[k] 题型: ', '[k] Kinds: ')}</Text>
              <Badge label={kindsLabel(kinds)} tone="accent" variant="soft" />
            </Box>
          </Box>
        ) : mode === 'case' ? (
          <Box marginBottom={1}>
            <Text color={theme.muted}>
              {t(lang, '案例卷按题组全卷作答，计时由试卷分数自动规划', 'Case papers include all open rubric questions with auto-planned timing.')}
            </Text>
          </Box>
        ) : (
          <Box marginBottom={1} gap={2}>
            <Text color={theme.muted}>{t(lang, '[c] 口试题数: ', '[c] Questions: ')}</Text>
            {ORAL_COUNTS.map((n) => (
              <Text key={n} color={n === count ? theme.primary : theme.dim} bold={n === count}>
                {` ${n} `}
              </Text>
            ))}
          </Box>
        )}

        {resumableRun ? (
          <Box marginBottom={1}>
            <Badge label={t(lang, 'r 继续未交卷考试', 'r Resume Open Exam')} tone="warning" />
            <Text color={theme.muted}>{` ${truncateDisplay(String(resumableRun.title || ''), Math.max(8, innerW - 22), ellipsis)}`}</Text>
          </Box>
        ) : null}

        {error ? (
          <Box marginBottom={1}>
            <Text color={theme.error}>{truncateDisplay(error, innerW, ellipsis)}</Text>
          </Box>
        ) : null}

        <Text color={theme.muted} bold>
          {asciiMode
            ? t(lang, '选择范围（j/k 选择，Enter 开始考试）:', 'Select Scope (j/k move, Enter start):')
            : t(lang, '选择范围（↑/↓ 选择，Enter 开始考试）:', 'Select Scope (↑/↓ move, Enter start):')}
        </Text>
        <VirtualList
          items={scopes}
          width={innerW}
          height={listH}
          selectedIndex={safeScopeIdx}
          onChange={(idx) => setScopeIdx(idx)}
          onSelect={(item) => onStart({ mode, scopeId: item.id, count, minutes, kinds }, item)}
          isActive={isActive && pane === 'setup' && !busy}
          emptyText={
            mode === 'case'
              ? t(lang, '暂无案例分析题组', 'No case-study decks found')
              : t(lang, '当前课程暂无可用考题', 'No eligible exam questions in current scope')
          }
          emptyHint={t(lang, '按 1/2/3 切换考试模式，或先在题组中生成题目', 'Switch mode with 1/2/3 or generate questions first')}
          renderItem={(item, ctx) => {
            const hint = item.hint ? ` (${item.hint})` : '';
            const cursor = ctx.selected ? (asciiMode ? '> ' : '❯ ') : '  ';
            const label = truncateDisplay(`${cursor}${item.label}${hint}`, ctx.width, ellipsis);
            return (
              <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                {label}
              </Text>
            );
          }}
        />
      </Panel>
    );
  };

  const renderHistoryPane = (paneW: number, paneH: number) => {
    const innerW = Math.max(18, paneW - 4);
    const listH = Math.max(3, paneH - 4);
    return (
      <Panel
        title={t(lang, '历史考卷', 'Past Exams')}
        badge={historyItems.length}
        badgeTone="accent"
        focused={pane === 'history'}
        width={paneW}
        height={paneH}
      >
        {historyItems.length === 0 ? (
          <EmptyState
            icon={asciiMode ? 'o' : '◷'}
            title={t(lang, '暂无考试记录', 'No past exams yet')}
            hint={t(lang, '交卷后可在此查看详细成绩单与错题分析', 'Submitted exams & oral reports appear here')}
            height={listH}
          />
        ) : (
          <VirtualList
            items={historyItems}
            width={innerW}
            height={listH}
            selectedIndex={historyIdx}
            onChange={(idx) => setHistoryIdx(idx)}
            onSelect={(item) => onOpenHistory(item)}
            isActive={isActive && pane === 'history' && !busy}
            keyExtractor={(item) => item.key}
            renderItem={(item, ctx) => {
              const scoreDisplay = asciiMode ? item.score.replace(/★/g, '*') : item.score;
              const scoreW = Math.min(8, scoreDisplay.length + 1);
              const mainW = Math.max(6, ctx.width - scoreW - 2);
              const cursor = ctx.selected ? (asciiMode ? '> ' : '❯ ') : '  ';
              const text = truncateDisplay(`${cursor}${item.title} · ${item.detail}`, mainW, ellipsis);
              const scoreColor =
                item.tone === 'success'
                  ? theme.success
                  : item.tone === 'warning'
                    ? theme.warning
                    : item.tone === 'error'
                      ? theme.error
                      : theme.muted;
              return (
                <Box width={ctx.width}>
                  <Box flexGrow={1} overflow="hidden">
                    <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                      {text}
                    </Text>
                  </Box>
                  <Text color={scoreColor} bold>
                    {scoreDisplay}
                  </Text>
                </Box>
              );
            }}
          />
        )}
      </Panel>
    );
  };

  return (
    <SplitPane
      width={width}
      height={height}
      leftWidth={0.56}
      minLeft={36}
      minRight={28}
      breakpoint={88}
      activePane={pane === 'setup' ? 'left' : 'right'}
      leftLabel={t(lang, '组卷', 'Setup')}
      rightLabel={t(lang, '历史考卷', 'History')}
      left={(size) => renderSetupPane(size.width, size.height)}
      right={(size) => renderHistoryPane(size.width, size.height)}
    />
  );
});
