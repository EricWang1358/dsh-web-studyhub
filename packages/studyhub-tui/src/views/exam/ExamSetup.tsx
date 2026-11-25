import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { atomicWriteExportText, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState } from '../../components/Badge.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { truncateDisplay } from '../../render/cjk.js';
import { t, useTuiStore } from '../../state/store.js';
import type {
  ExamMode,
  ExamSetupValue,
  HistoryItem,
  ScopeChoice,
  WrittenKinds,
} from './types.js';
import { buildHistoryItems, buildScopeChoices, formatDurationMs } from './utils.js';

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
const CLAIMED = ['1', '2', '3', 'c', 't', 'k', 'R', 'h', 'l', 'x'];

export interface ExamHistoryExportRecord {
  runId?: string;
  key?: string;
  kind?: 'written' | 'oral' | string;
  mode?: 'written' | 'case' | 'oral' | string;
  examKinds?: string;
  title?: string;
  scope?: string;
  decks?: string[];
  role?: string;
  detail?: string;
  score?: string;
  scorePct?: number;
  answered?: number;
  total?: number;
  correct?: number;
  assessed?: number;
  strong?: number;
  duration?: string;
  durationMs?: number;
  startedAt?: string;
  submittedAt?: string;
}

export interface FormatExamHistoryMarkdownParams {
  history: readonly ExamHistoryExportRecord[];
  selectedAttempt?: ExamHistoryExportRecord | null;
  lang: UiLanguage;
  generatedAt?: Date | string;
}

function formatGeneratedDate(generatedAt?: Date | string): string {
  if (typeof generatedAt === 'string' && generatedAt.trim()) return generatedAt.trim();
  const d = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${todayLocalYmd(d)} ${hh}:${mm}`;
}

function escapeMdCell(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function resolveAttemptMode(rec: ExamHistoryExportRecord): 'written' | 'case' | 'oral' {
  if (rec.mode === 'case' || rec.examKinds === 'case') return 'case';
  if (rec.mode === 'oral' || rec.kind === 'oral') return 'oral';
  if (typeof rec.title === 'string' && (rec.title.includes('[口试]') || rec.title.includes('[Oral]'))) return 'oral';
  if (typeof rec.title === 'string' && (rec.title.includes('[案例卷]') || rec.title.includes('[Case]'))) return 'case';
  return 'written';
}

function formatAttemptMode(mode: 'written' | 'case' | 'oral', lang: UiLanguage): string {
  if (mode === 'case') return t(lang, '案例卷 (case)', 'Case Paper (case)');
  if (mode === 'oral') return t(lang, '口试 (oral)', 'Oral Mock (oral)');
  return t(lang, '选择题卷 (written)', 'Written MCQ (written)');
}

function resolveAttemptScorePct(rec: ExamHistoryExportRecord): number | null {
  if (typeof rec.scorePct === 'number' && Number.isFinite(rec.scorePct)) return Math.round(rec.scorePct);
  if (typeof rec.correct === 'number' && typeof rec.total === 'number' && rec.total > 0) {
    return Math.round((rec.correct / rec.total) * 100);
  }
  if (
    typeof rec.strong === 'number' &&
    typeof rec.total === 'number' &&
    rec.total > 0 &&
    Number(rec.assessed ?? rec.total) > 0
  ) {
    return Math.round((rec.strong / rec.total) * 100);
  }
  if (typeof rec.score === 'string') {
    const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(rec.score);
    if (pctMatch) return Math.round(Number(pctMatch[1]));
    const ratioMatch = /^(\d+)\s*\/\s*(\d+)/.exec(rec.score.trim());
    if (ratioMatch && Number(ratioMatch[2]) > 0) {
      return Math.round((Number(ratioMatch[1]) / Number(ratioMatch[2])) * 100);
    }
  }
  return null;
}

function formatAttemptScore(rec: ExamHistoryExportRecord): string {
  const pct = resolveAttemptScorePct(rec);
  if (rec.score && rec.score.trim()) {
    const clean = rec.score.trim().replace(/★/g, '*');
    if (pct !== null && !clean.includes('%')) return `${clean} (${pct}%)`;
    return clean;
  }
  return pct !== null ? `${pct}%` : '-';
}

function formatAttemptAnsweredTotal(rec: ExamHistoryExportRecord): string {
  const total = typeof rec.total === 'number' && Number.isFinite(rec.total) ? rec.total : null;
  const answered =
    typeof rec.answered === 'number' && Number.isFinite(rec.answered)
      ? rec.answered
      : typeof rec.assessed === 'number' && Number.isFinite(rec.assessed)
        ? rec.assessed
        : null;
  if (answered !== null && total !== null) return `${answered}/${total}`;
  if (total !== null) return `-/${total}`;
  return '-';
}

function formatAttemptDuration(rec: ExamHistoryExportRecord): string {
  if (typeof rec.duration === 'string' && rec.duration.trim()) return rec.duration.trim();
  if (typeof rec.durationMs === 'number' && Number.isFinite(rec.durationMs) && rec.durationMs >= 0) {
    return formatDurationMs(rec.durationMs);
  }
  if (rec.startedAt && rec.submittedAt) {
    const ms = Date.parse(rec.submittedAt) - Date.parse(rec.startedAt);
    if (Number.isFinite(ms) && ms >= 0) return formatDurationMs(ms);
  }
  return '-';
}

function formatAttemptTimestamp(rec: ExamHistoryExportRecord, compact = false): string {
  const raw = String(rec.submittedAt ?? '').trim();
  if (!raw) return '-';
  return compact ? raw.slice(0, 16).replace('T', ' ') : raw;
}

function resolveAttemptTitleScope(rec: ExamHistoryExportRecord): string {
  const scope = rec.scope?.trim();
  const title = rec.title?.trim();
  const decks = Array.isArray(rec.decks) ? rec.decks.map((d) => String(d).trim()).filter(Boolean).join(', ') : '';
  const role = rec.role?.trim();
  if (title && scope && title !== scope && !title.includes(scope)) {
    return `${title} (${scope})`;
  }
  return scope || title || decks || role || '-';
}

/** Pure formatter producing an exam history Markdown report for the selected attempt and summary table. */
export function formatExamHistoryMarkdown({
  history,
  selectedAttempt,
  lang,
  generatedAt,
}: FormatExamHistoryMarkdownParams): string {
  const list = Array.isArray(history) ? history : [];
  const dateStr = formatGeneratedDate(generatedAt);
  const scores = list.map(resolveAttemptScorePct).filter((v): v is number => v !== null);
  const avgStr =
    scores.length > 0
      ? `${Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length)}%`
      : '-';

  const lines: string[] = [
    `# ${t(lang, 'StudyHub 模拟考试历史报告', 'StudyHub Exam History Report')}`,
    '',
    `- **${t(lang, '生成日期', 'Generated')}**: ${dateStr}`,
    `- **${t(lang, '考试记录总数', 'Total Exam Records')}**: ${list.length}`,
    `- **${t(lang, '平均正确率 / 得分', 'Average Accuracy / Score')}**: ${avgStr}`,
    '',
  ];

  if (selectedAttempt) {
    const selMode = formatAttemptMode(resolveAttemptMode(selectedAttempt), lang);
    lines.push(
      `## ${t(lang, '当前选中记录', 'Selected Attempt')}`,
      '',
      `- **${t(lang, '标题 / 范围', 'Title / Scope')}**: ${resolveAttemptTitleScope(selectedAttempt)}`,
      `- **${t(lang, '考试模式', 'Mode')}**: ${selMode}`,
      `- **${t(lang, '成绩 / 正确率', 'Score / Accuracy')}**: ${formatAttemptScore(selectedAttempt)}`,
      `- **${t(lang, '作答 / 总题数', 'Answered / Total')}**: ${formatAttemptAnsweredTotal(selectedAttempt)}`,
      `- **${t(lang, '用时', 'Duration')}**: ${formatAttemptDuration(selectedAttempt)}`,
      `- **${t(lang, '提交时间', 'Timestamp')}**: ${formatAttemptTimestamp(selectedAttempt)}`,
      '',
    );
  }

  lines.push(`## ${t(lang, '考试历史汇总', 'Exam Attempts Summary')}`, '');

  if (list.length === 0) {
    lines.push(t(lang, '_暂无模拟考试记录。_', '_No exam history records._'), '');
    return lines.join('\n');
  }

  lines.push(
    lang === 'en'
      ? '| # | Date | Mode | Scope / Title | Score / Accuracy | Duration |'
      : '| # | 日期 | 模式 | 范围 / 标题 | 成绩 / 正确率 | 用时 |',
    '| --- | --- | --- | --- | --- | --- |',
  );

  list.forEach((rec, idx) => {
    const dateCell = escapeMdCell(formatAttemptTimestamp(rec, true));
    const modeCell = escapeMdCell(formatAttemptMode(resolveAttemptMode(rec), lang));
    const scopeCell = escapeMdCell(resolveAttemptTitleScope(rec));
    const scoreCell = escapeMdCell(formatAttemptScore(rec));
    const durCell = escapeMdCell(formatAttemptDuration(rec));
    lines.push(`| ${idx + 1} | ${dateCell} | ${modeCell} | ${scopeCell} | ${scoreCell} | ${durCell} |`);
  });

  lines.push('');
  return lines.join('\n');
}

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
  const notify = useTuiStore((s) => s.notify);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const footerHints = useTuiStore((s) => s.footerHints);
  const setFooterHints = useTuiStore((s) => s.setFooterHints);
  const ellipsis = asciiMode ? '...' : '…';
  const [pane, setPane] = useState<'setup' | 'history'>('setup');
  const [mode, setMode] = useState<ExamMode>('written');
  const [countIdx, setCountIdx] = useState(0);
  const [oralCountIdx, setOralCountIdx] = useState(1);
  const [limitIdx, setLimitIdx] = useState(1); // default 30 min
  const [kindIdx, setKindIdx] = useState(0);
  const [scopeIdx, setScopeIdx] = useState(0);

  const mountedRef = useRef(true);
  const exportBusyRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scopes = useMemo(() => buildScopeChoices(snapshot, mode, lang), [snapshot, mode, lang]);
  const safeScopeIdx = Math.max(0, Math.min(scopeIdx, Math.max(0, scopes.length - 1)));

  const historyItems = useMemo(() => buildHistoryItems(snapshot, lang), [snapshot, lang]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const safeHistoryIdx = Math.max(0, Math.min(historyIdx, Math.max(0, historyItems.length - 1)));

  const exportRecords = useMemo<ExamHistoryExportRecord[]>(() => {
    const writtenById = new Map<string, Record<string, unknown>>();
    for (const raw of snapshot?.exams ?? []) {
      if (raw.runId) writtenById.set(String(raw.runId), raw);
    }
    const oralById = new Map<string, Record<string, unknown>>();
    for (const raw of snapshot?.oralExams ?? []) {
      if (raw.runId) oralById.set(String(raw.runId), raw);
    }
    return historyItems.map((item) => {
      if (item.kind === 'oral') {
        const raw = oralById.get(item.runId);
        const total = raw && raw.total !== undefined ? Number(raw.total) : undefined;
        const assessed = raw && raw.assessed !== undefined ? Number(raw.assessed) : undefined;
        const strong = raw && raw.strong !== undefined ? Number(raw.strong) : undefined;
        const role = raw ? String(raw.role ?? '').trim() : '';
        return {
          ...item,
          mode: 'oral',
          scope: role || item.title,
          role,
          answered: assessed,
          assessed,
          total,
          strong,
          scorePct: total && assessed ? Math.round(((strong ?? 0) / total) * 100) : undefined,
        };
      }
      const raw = writtenById.get(item.runId);
      const examKinds = raw ? String(raw.examKinds ?? 'all') : 'all';
      const decks = raw && Array.isArray(raw.decks) ? raw.decks.map(String).filter(Boolean) : [];
      return {
        ...item,
        mode: examKinds === 'case' ? 'case' : 'written',
        examKinds,
        scope: decks.join(', ') || item.title,
        decks,
        scorePct: raw && raw.scorePct !== undefined ? Number(raw.scorePct) : undefined,
        answered: raw && raw.answered !== undefined ? Number(raw.answered) : undefined,
        total: raw && raw.total !== undefined ? Number(raw.total) : undefined,
        correct: raw && raw.correct !== undefined ? Number(raw.correct) : undefined,
        durationMs: raw && typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
        startedAt: raw && typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
      };
    });
  }, [historyItems, snapshot?.exams, snapshot?.oralExams]);

  const exportHintLabel = t(lang, '导出记录', 'Export MD');
  const addedHintSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isActive) {
      if (addedHintSigRef.current) {
        const cur = useTuiStore.getState().footerHints;
        if (cur.map((h) => `${h.key}\u0001${h.label}`).join('\u0002') === addedHintSigRef.current) {
          setFooterHints([]);
        }
        addedHintSigRef.current = null;
      }
      return;
    }
    if (footerHints.length === 0 || footerHints.some((h) => h.key === 'x')) return;
    const next = [...footerHints, { key: 'x', label: exportHintLabel }];
    addedHintSigRef.current = next.map((h) => `${h.key}\u0001${h.label}`).join('\u0002');
    setFooterHints(next);
  }, [isActive, footerHints, setFooterHints, exportHintLabel]);

  useEffect(() => () => {
    if (addedHintSigRef.current) {
      const cur = useTuiStore.getState().footerHints;
      if (cur.map((h) => `${h.key}\u0001${h.label}`).join('\u0002') === addedHintSigRef.current) {
        useTuiStore.getState().setFooterHints([]);
      }
      addedHintSigRef.current = null;
    }
  }, []);

  const handleExportHistory = useCallback(async () => {
    if (exportBusyRef.current) return;
    if (exportRecords.length === 0) {
      notify(t(lang, '暂无可导出的模拟考试记录', 'No exam history records to export'), 'info');
      return;
    }
    exportBusyRef.current = true;
    try {
      const rawRoot = bindingRoot?.trim() || (typeof snapshot?.root === 'string' ? snapshot.root.trim() : '') || '';
      const baseDir = rawRoot ? resolve(rawRoot) : process.cwd();
      const selectedAttempt = exportRecords[safeHistoryIdx] ?? exportRecords[0] ?? null;
      const focusCourse = typeof snapshot?.focus?.course === 'string' ? snapshot.focus.course.trim() : '';
      const exportSlug = focusCourse || selectedAttempt?.title || selectedAttempt?.scope || mode || undefined;
      const defaultPath = defaultBackupFilePath(baseDir, 'studyhub-exam', 'md', exportSlug);
      const markdown = formatExamHistoryMarkdown({
        history: exportRecords,
        selectedAttempt,
        lang,
        generatedAt: new Date(),
      });
      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${exportRecords.length} 条模考记录 ${arrow} ${written.path}`,
          `Exported ${exportRecords.length} exam record(s) ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出模考记录失败: ${msg}`, `Failed to export exam history: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [asciiMode, bindingRoot, exportRecords, lang, mode, notify, safeHistoryIdx, snapshot?.focus?.course, snapshot?.root]);

  useClaimKeys(CLAIMED, isActive);

  const count = mode === 'oral' ? ORAL_COUNTS[oralCountIdx] : WRITTEN_COUNTS[countIdx];
  const minutes = TIME_LIMITS[limitIdx];
  const kinds = WRITTEN_KINDS[kindIdx];

  useInput(
    (input, key) => {
      if (busy) return;
      if (input === 'x' && !key.ctrl && !key.meta) {
        void handleExportHistory();
        return;
      }
      if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
        if (input === 'h' || key.leftArrow) setPane('setup');
        else if (input === 'l' || key.rightArrow) setPane('history');
        else setPane((p) => (p === 'setup' ? 'history' : 'setup'));
        return;
      }
      if (input === '1') { setMode('written'); setScopeIdx(0); return; }
      if (input === '2') { setMode('case'); setScopeIdx(0); return; }
      if (input === '3') { setMode('oral'); setScopeIdx(0); return; }
      if (input === 'R' && resumableRun && onResume) {
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
            <Box columnGap={2} flexWrap="wrap">
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
            <Badge label={t(lang, 'R 继续未交卷考试', 'R Resume Open Exam')} tone="warning" />
            <Text color={theme.muted}>{` ${truncateDisplay(String(resumableRun.title || ''), Math.max(8, innerW - 22), ellipsis)}`}</Text>
          </Box>
        ) : null}

        {error ? (
          <Box marginBottom={1}>
            <Text color={theme.error} wrap="wrap">{error}</Text>
          </Box>
        ) : null}

        <Text color={theme.muted} bold>
          {asciiMode
            ? t(lang, '选择范围（Up/Down 选择，Enter 开始考试）:', 'Select Scope (Up/Down move, Enter start):')
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
          vimNavKeys={false}
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
