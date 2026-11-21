import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, type ReviewRun } from '../../host/index.js';
import {
  Badge,
  EmptyState,
  MarkdownView,
  Panel,
  ProgressBar,
  Spinner,
  SplitPane,
  VirtualList,
  useFooterHints,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';

interface LookBackRow {
  number?: number;
  deckId?: string;
  cardId?: string;
  kind?: string;
  status: 'right' | 'wrong' | 'self' | 'grading' | 'unanswered';
  errorReason?: string;
  prompt?: string;
  card?: { prompt?: string; topic?: string; [k: string]: unknown };
  feedback?: { correct?: boolean; grade?: number; [k: string]: unknown };
  solution?: { answer?: string; explanation?: string; [k: string]: unknown };
  sourceTitle?: string;
  page?: number;
}

interface DailyStatusGroup {
  courseId?: string;
  course?: string;
  day?: string;
  timeZone?: string;
  eligible?: boolean;
  answeredCount?: number;
  hasContent?: boolean;
  noteId?: string | null;
  generation?: { status?: string; message?: string };
}

export interface RoundSummaryProps {
  host: HostClient;
  run: ReviewRun;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  onPracticeWeak: () => void;
  onNewRound: () => void;
  onGoLibrary: () => void;
}

function cleanPromptSnippet(text: string): string {
  return String(text || '')
    .replace(/\{\{[^{}]+\}\}/g, '＿＿')
    .replace(/[#*_`>$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const RoundSummary = memo(function RoundSummary({
  host,
  run,
  width,
  height,
  isActive,
  mathUnicode,
  onPracticeWeak,
  onNewRound,
  onGoLibrary,
}: RoundSummaryProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const notify = useTuiStore((s) => s.notify);
  const navigate = useTuiStore((s) => s.navigate);

  const [rows, setRows] = useState<LookBackRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loadingLookBack, setLoadingLookBack] = useState(true);
  const [dailyGroup, setDailyGroup] = useState<DailyStatusGroup | null>(null);
  const [generatingRecap, setGeneratingRecap] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingLookBack(true);
    void tryAction<{ rows?: LookBackRow[] }>(host, 'review.lookBack', { runId: run.id }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      setLoadingLookBack(false);
      if (res.ok && Array.isArray(res.value?.rows)) {
        setRows(res.value.rows);
        const firstWeak = res.value.rows.findIndex((r) => r.status === 'wrong');
        setSelectedIdx(firstWeak >= 0 ? firstWeak : 0);
      }
    });

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    void tryAction<{ groups?: DailyStatusGroup[] }>(host, 'note.daily.status', { runId: run.id, timeZone }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      if (res.ok && Array.isArray(res.value?.groups) && res.value.groups.length > 0) {
        setDailyGroup(res.value.groups[0]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [host, run.id]);

  const triggerDailyRecap = useCallback(async () => {
    if (generatingRecap) return;
    if (!dailyGroup) {
      notify(t(lang, '暂无每日复盘状态数据', 'Daily recap status unavailable'), 'warning');
      return;
    }
    if (!dailyGroup.eligible) {
      notify(
        t(
          lang,
          `当天同一课程累计完成 10 道不同题目后可生成每日复盘（当前 ${dailyGroup.answeredCount ?? 0} 题）`,
          `Complete 10 distinct questions in one course today to generate a daily recap (${dailyGroup.answeredCount ?? 0} so far)`,
        ),
        'info',
      );
      return;
    }
    if (dailyGroup.noteId && dailyGroup.hasContent) {
      navigate('notes', { noteId: dailyGroup.noteId });
      return;
    }
    setGeneratingRecap(true);
    const timeZone = dailyGroup.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const res = await tryAction<{ id?: string; status?: string }>(host, 'note.daily.generate', {
      course: dailyGroup.courseId || dailyGroup.course,
      day: dailyGroup.day,
      timeZone,
    });
    if (!mountedRef.current) return;
    setGeneratingRecap(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '生成每日复盘失败', 'Failed to generate daily recap'), 'error');
      return;
    }
    notify(t(lang, '已触发每日复盘生成，前往学习笔记查看', 'Daily recap generation started'), 'success');
    if (res.value?.id) {
      setDailyGroup((prev) => (prev ? { ...prev, noteId: res.value?.id, generation: { status: res.value?.status } } : prev));
    }
  }, [generatingRecap, dailyGroup, host, lang, notify, navigate]);

  const totalQuestions = Number((run as { questions?: number }).questions ?? run.total ?? rows.length) || 0;
  const answered = Number(run.answered ?? 0) || 0;
  const correct = Number((run as { correct?: number }).correct ?? 0) || 0;
  const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const rawWeakTopics = (run as Record<string, unknown>).weakTopics;
  const weakTopics = Array.isArray(rawWeakTopics) ? (rawWeakTopics as string[]) : [];
  const rawMissed = (run as Record<string, unknown>).missedCards;
  const hasMissed =
    rows.some((r) => r.status === 'wrong') ||
    (Array.isArray(rawMissed) && rawMissed.length > 0);

  const hints: KeyHint[] = useMemo(
    () => [
      ...(hasMissed ? [{ key: 'w', label: t(lang, '重练错题', 'Retry Weak') }] : []),
      { key: 'g', label: dailyGroup?.hasContent ? t(lang, '看复盘', 'View Recap') : t(lang, '每日复盘', 'Daily Recap') },
      { key: 'r', label: t(lang, '再来一轮', 'New Round') },
      { key: 'Esc / b', label: t(lang, '学习库', 'Library') },
    ],
    [hasMissed, dailyGroup?.hasContent, lang],
  );
  useFooterHints(hints, isActive);

  useInput(
    (input, key) => {
      if (input === 'w' && hasMissed) {
        onPracticeWeak();
        return;
      }
      if (input === 'g') {
        void triggerDailyRecap();
        return;
      }
      if (input === 'r') {
        onNewRound();
        return;
      }
      if (input === 'b' || key.escape) {
        onGoLibrary();
      }
    },
    { isActive },
  );

  const selectedRow = rows[selectedIdx] ?? null;
  const summaryMarkdown = useMemo(() => {
    if (!selectedRow) return '';
    const prompt = String(selectedRow.card?.prompt ?? selectedRow.prompt ?? '');
    const parts: string[] = [];
    if (selectedRow.card?.topic) parts.push(`**${t(lang, '知识点', 'Topic')}**: ${selectedRow.card.topic}`);
    parts.push(prompt);
    if (selectedRow.solution?.answer) {
      parts.push(`**${t(lang, '参考答案', 'Answer')}**: ${selectedRow.solution.answer}`);
    }
    if (selectedRow.solution?.explanation) {
      parts.push(`**${t(lang, '解析', 'Explanation')}**:\n${selectedRow.solution.explanation}`);
    }
    return parts.join('\n\n');
  }, [selectedRow, lang]);

  const headerH = 5;
  const bodyH = Math.max(6, height - headerH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Panel
        title={t(lang, '本轮练习总结', 'Round Summary')}
        icon="★"
        badge={answered > 0 ? `${accuracy}%` : t(lang, '已结束', 'Ended')}
        badgeTone={accuracy >= 70 ? 'success' : answered > 0 ? 'warning' : 'neutral'}
        width={width}
        height={headerH}
      >
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Text color={theme.text} bold>
            {`${t(lang, '已答', 'Answered')} ${answered}/${totalQuestions}`}
          </Text>
          <Text color={theme.success}>{`${t(lang, '答对', 'Correct')} ${correct}`}</Text>
          <ProgressBar
            ratio={answered > 0 ? correct / answered : 0}
            width={Math.min(24, Math.max(10, Math.floor(width * 0.2)))}
            showPercent
          />
          {weakTopics.length > 0 ? (
            <Text color={theme.warning}>
              {truncateDisplay(
                `${t(lang, '薄弱', 'Weak')}: ${weakTopics.join(' · ')}`,
                Math.max(12, width - 56),
              )}
            </Text>
          ) : null}
          {generatingRecap ? <Spinner label={t(lang, '生成复盘中…', 'Generating…')} tone="ai" active={isActive} /> : null}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Text color={theme.muted}>
            {dailyGroup?.eligible
              ? dailyGroup.hasContent
                ? t(lang, '[g] 查看今日每日复盘笔记', '[g] Open today’s daily recap')
                : t(lang, '[g] 生成今日每日复盘 (Daily Recap)', '[g] Generate Daily Recap')
              : t(
                  lang,
                  `今日累计满 10 题可生成每日复盘 (${dailyGroup?.answeredCount ?? answered}/10)`,
                  `10 questions/day unlocks Daily Recap (${dailyGroup?.answeredCount ?? answered}/10)`,
                )}
          </Text>
        </Box>
      </Panel>

      <SplitPane
        width={width}
        height={bodyH}
        breakpoint={84}
        leftLabel={t(lang, '题目回顾', 'Items')}
        rightLabel={t(lang, '解析详情', 'Detail')}
        left={(size) => (
          <Panel
            title={t(lang, '本轮题目回顾', 'Round Look-Back')}
            badge={rows.length}
            width={size.width}
            height={size.height}
            focused={isActive}
          >
            {loadingLookBack ? (
              <Spinner label={t(lang, '加载本轮回顾…', 'Loading look-back…')} active={isActive} />
            ) : rows.length === 0 ? (
              <EmptyState
                title={t(lang, '本轮暂无答题记录', 'No questions recorded in this round')}
                width={size.width - 4}
                height={size.height - 3}
              />
            ) : (
              <VirtualList
                items={rows}
                width={Math.max(10, size.width - 4)}
                height={Math.max(3, size.height - 3)}
                selectedIndex={selectedIdx}
                onChange={(idx) => setSelectedIdx(idx)}
                isActive={isActive}
                keyExtractor={(r, i) => `${r.cardId || 'row'}-${i}`}
                renderItem={(row, ctx) => {
                  const statusColor =
                    row.status === 'right'
                      ? theme.success
                      : row.status === 'wrong'
                        ? theme.error
                        : theme.muted;
                  const icon = row.status === 'right' ? '✓' : row.status === 'wrong' ? '✕' : '○';
                  const snippet = cleanPromptSnippet(String(row.card?.prompt ?? row.prompt ?? ''));
                  return (
                    <Box flexDirection="row" width={ctx.width}>
                      <Text color={statusColor} bold>{`${icon} `}</Text>
                      <Text color={ctx.selected ? theme.selectionFg : theme.text}>
                        {truncateDisplay(`#${row.number ?? ctx.index + 1} ${snippet}`, Math.max(6, ctx.width - 3))}
                      </Text>
                    </Box>
                  );
                }}
              />
            )}
          </Panel>
        )}
        right={(size) => (
          <Panel
            title={selectedRow ? `#${selectedRow.number ?? selectedIdx + 1}` : t(lang, '题目详情', 'Question Detail')}
            subtitle={selectedRow?.sourceTitle ? `${selectedRow.sourceTitle}${selectedRow.page ? ` p.${selectedRow.page}` : ''}` : undefined}
            width={size.width}
            height={size.height}
          >
            {selectedRow ? (
              <Box flexDirection="column" gap={0}>
                <Box flexDirection="row" gap={1} marginBottom={1}>
                  <Badge
                    label={
                      selectedRow.status === 'right'
                        ? t(lang, '答对', 'Correct')
                        : selectedRow.status === 'wrong'
                          ? t(lang, '需巩固', 'Missed')
                          : t(lang, '未答', 'Unanswered')
                    }
                    tone={selectedRow.status === 'right' ? 'success' : selectedRow.status === 'wrong' ? 'error' : 'neutral'}
                  />
                  {selectedRow.errorReason ? <Badge label={selectedRow.errorReason} tone="warning" variant="outline" /> : null}
                </Box>
                <MarkdownView
                  markdown={summaryMarkdown}
                  width={Math.max(12, size.width - 4)}
                  height={Math.max(4, size.height - 5)}
                  mathUnicode={mathUnicode}
                />
              </Box>
            ) : (
              <EmptyState title={t(lang, '选择左侧题目查看解析', 'Select a question on the left')} />
            )}
          </Panel>
        )}
      />
    </Box>
  );
});
