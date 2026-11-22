import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  ScrollView,
  Spinner,
  StatusPill,
  VirtualList,
  modalContentWidth,
  useTheme,
  type PillStatus,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay, wrapDisplay } from '../../render/index.js';
import { tryAction } from '../../host/sample-actions.js';

export interface WorkflowSessionSummary {
  id: string;
  title?: string;
  topic?: string;
  currentStepId?: string;
  stepTitle?: string;
  stepIndex?: number;
  stepCount?: number;
  status?: string;
  updatedAt?: string;
  version?: number;
}

interface WorkflowTemplateStep {
  id: string;
  kind?: string;
  title?: string;
  instructions?: string;
  content?: string;
}

interface WorkflowHelpEntry {
  id?: string;
  kind?: string;
  title?: string;
  request?: string;
  content?: string;
  at?: string;
}

interface WorkflowStepRecord {
  content?: string;
  output?: string;
  outcome?: string;
  updatedAt?: string;
  materialBy?: string;
  materialAt?: string;
  runId?: string;
  help?: WorkflowHelpEntry[];
}

interface WorkflowHistoryEvent {
  requestId?: string;
  kind?: string;
  stepId?: string;
  outcome?: string;
  output?: string;
  at?: string;
  evidence?: string;
  practiceRunId?: string;
}

interface WorkflowSessionDetail {
  id: string;
  topic?: string;
  goal?: string;
  course?: { name?: string; label?: string } | null;
  currentStepId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  template?: {
    id?: string;
    title?: string;
    description?: string;
    steps?: WorkflowTemplateStep[];
  };
  records?: Record<string, WorkflowStepRecord>;
  history?: WorkflowHistoryEvent[];
}

interface WorkflowSessionResources {
  skeleton?: { id?: string; title?: string } | null;
  cardCount?: number;
  scopeTopics?: string[];
  scopeDecks?: string[];
  practice?: {
    runId?: string;
    total?: number;
    answered?: number;
    correct?: number;
    complete?: boolean;
    ended?: boolean;
  } | null;
  sources?: Array<{ id?: string; title?: string }>;
}

interface WorkflowListResponse {
  retired?: boolean;
  sessions?: WorkflowSessionSummary[];
}

interface WorkflowSessionGetResponse {
  retired?: boolean;
  session?: WorkflowSessionDetail;
  resources?: WorkflowSessionResources;
}

export interface WorkflowHistoryModalProps {
  host: HostClient;
  isActive: boolean;
  onClose: () => void;
}

function statusPillFor(status: string | undefined): PillStatus {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'done') return 'ok';
  if (s === 'active' || s === 'running') return 'busy';
  if (s === 'paused') return 'warn';
  return 'idle';
}

function statusShortLabel(status: string | undefined, lang: UiLanguage): string {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'done') return t(lang, '已完成', 'Done');
  if (s === 'active' || s === 'running') return t(lang, '进行中', 'Active');
  if (s === 'paused') return t(lang, '已暂停', 'Paused');
  return s || t(lang, '历史', 'Past');
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso || typeof iso !== 'string') return '';
  if (iso.length >= 16 && iso.includes('T')) {
    return iso.slice(0, 16).replace('T', ' ');
  }
  return iso.slice(0, 19);
}

function formatCompactDate(iso: string | undefined): string {
  if (!iso || typeof iso !== 'string') return '';
  return iso.slice(0, 10);
}

function outcomeMarker(outcome: string | undefined, isCurrent: boolean, asciiMode: boolean): string {
  if (outcome === 'done') return asciiMode ? '[x]' : '[✓]';
  if (outcome === 'needs_work') return '[!]';
  if (outcome === 'skipped') return asciiMode ? '[>]' : '[»]';
  if (isCurrent) return asciiMode ? '[*]' : '[▶]';
  return '[ ]';
}

function outcomeLabel(outcome: string | undefined, isCurrent: boolean, lang: UiLanguage): string {
  if (outcome === 'done') return t(lang, '已完成', 'Done');
  if (outcome === 'needs_work') return t(lang, '待巩固', 'Needs work');
  if (outcome === 'skipped') return t(lang, '已跳过', 'Skipped');
  if (outcome === 'note') return t(lang, '记录', 'Note');
  if (isCurrent) return t(lang, '停留步骤', 'Current step');
  return t(lang, '未开始', 'Pending');
}

function pushWrapped(lines: string[], text: string, width: number, indent = ''): void {
  const safeW = Math.max(8, width - displayWidth(indent));
  const rawParagraphs = text.split(/\r?\n/);
  for (const para of rawParagraphs) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    const wrapped = wrapDisplay(para, safeW);
    for (const w of wrapped) {
      lines.push(`${indent}${w}`);
    }
  }
}

function buildDetailLines(
  detail: WorkflowSessionGetResponse | null,
  summary: WorkflowSessionSummary | undefined,
  width: number,
  lang: UiLanguage,
  asciiMode: boolean,
): string[] {
  const session = detail?.session;
  if (!session) {
    if (!summary) return [];
    const lines: string[] = [];
    pushWrapped(lines, summary.topic || summary.title || summary.id, width);
    return lines;
  }

  const lines: string[] = [];
  const sep = (asciiMode ? '-' : '─').repeat(Math.max(8, Math.min(width, 48)));
  const bullet = asciiMode ? '*' : '•';

  const topic = session.topic || summary?.topic || session.template?.title || session.id;
  pushWrapped(lines, `${t(lang, '主题', 'Topic')}: ${topic}`, width);
  if (session.template?.title) {
    pushWrapped(lines, `${t(lang, '流程', 'Flow')}: ${session.template.title}`, width);
  }
  const courseLabel = session.course?.label || session.course?.name;
  if (courseLabel) {
    pushWrapped(lines, `${t(lang, '课程', 'Course')}: ${courseLabel}`, width);
  }

  const times: string[] = [];
  if (session.createdAt) times.push(`${t(lang, '开始', 'Started')}: ${formatTimestamp(session.createdAt)}`);
  if (session.updatedAt) times.push(`${t(lang, '更新', 'Updated')}: ${formatTimestamp(session.updatedAt)}`);
  if (session.completedAt) times.push(`${t(lang, '完成', 'Completed')}: ${formatTimestamp(session.completedAt)}`);
  if (times.length > 0) {
    pushWrapped(lines, times.join('  '), width);
  }

  if (session.goal) {
    lines.push('');
    pushWrapped(lines, `${t(lang, '学习目标', 'Goal')}: ${session.goal}`, width);
  }

  const res = detail?.resources;
  if (res) {
    const scopeParts: string[] = [];
    if (res.scopeDecks?.length) scopeParts.push(`${t(lang, '题组', 'Decks')}: ${res.scopeDecks.join(', ')}`);
    if (res.scopeTopics?.length) scopeParts.push(`${t(lang, '知识点', 'Topics')}: ${res.scopeTopics.slice(0, 6).join(', ')}`);
    if (typeof res.cardCount === 'number' && res.cardCount > 0) {
      scopeParts.push(`${t(lang, '关联题数', 'Cards')}: ${res.cardCount}`);
    }
    if (res.practice && typeof res.practice.total === 'number') {
      scopeParts.push(
        `${t(lang, '练习', 'Practice')}: ${res.practice.answered ?? 0}/${res.practice.total} (${t(lang, '正确', 'Correct')} ${res.practice.correct ?? 0})`,
      );
    }
    if (scopeParts.length > 0) {
      lines.push('');
      for (const part of scopeParts) pushWrapped(lines, part, width);
    }
  }

  const steps = session.template?.steps ?? [];
  const records = session.records ?? {};
  lines.push('');
  lines.push(sep);
  pushWrapped(lines, `${t(lang, '步骤时间线', 'Step Timeline')} (${steps.length})`, width);

  if (steps.length === 0) {
    pushWrapped(lines, t(lang, '（无步骤定义）', '(No steps recorded)'), width, '  ');
  } else {
    steps.forEach((step, idx) => {
      const rec = records[step.id];
      const isCurrent = session.currentStepId === step.id;
      const marker = outcomeMarker(rec?.outcome, isCurrent, asciiMode);
      const stLabel = outcomeLabel(rec?.outcome, isCurrent, lang);
      const kindTag = step.kind ? ` [${step.kind}]` : '';
      const timeTag = rec?.updatedAt ? ` ${asciiMode ? '-' : '·'} ${formatTimestamp(rec.updatedAt)}` : '';

      lines.push('');
      pushWrapped(lines, `${marker} ${idx + 1}. ${step.title || step.id}${kindTag} (${stLabel}${timeTag})`, width);

      if (step.instructions) {
        pushWrapped(lines, `${t(lang, '要求', 'Prompt')}: ${step.instructions}`, width, '    ');
      }
      if (rec?.output) {
        pushWrapped(lines, `${t(lang, '笔记/作答', 'Notes')}: ${rec.output}`, width, '    ');
      }
      const material = rec?.content ?? step.content;
      if (material) {
        const clipped = material.length > 1200 ? `${material.slice(0, 1200)}\n...` : material;
        pushWrapped(lines, `${t(lang, '材料/讲解', 'Material')}:`, width, '    ');
        pushWrapped(lines, clipped, width, '      ');
      }
      if (Array.isArray(rec?.help) && rec.help.length > 0) {
        for (const h of rec.help) {
          const hTitle = h.title || h.kind || t(lang, '补充讲解', 'Help');
          const hReq = h.request ? ` (${h.request})` : '';
          pushWrapped(lines, `${bullet} ${hTitle}${hReq}:`, width, '    ');
          if (h.content) {
            const clippedHelp = h.content.length > 800 ? `${h.content.slice(0, 800)}\n...` : h.content;
            pushWrapped(lines, clippedHelp, width, '      ');
          }
        }
      }
    });
  }

  const history = session.history ?? [];
  if (history.length > 0) {
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, `${t(lang, '学习足迹', 'Activity Log')} (${history.length})`, width);
    const stepTitles = new Map(steps.map((s) => [s.id, s.title || s.id]));
    for (const ev of history) {
      const when = formatTimestamp(ev.at);
      const sName = (ev.stepId && stepTitles.get(ev.stepId)) || ev.stepId || ev.kind || 'step';
      const outText = outcomeLabel(ev.outcome, false, lang);
      pushWrapped(lines, `${bullet} [${when}] ${sName} -> ${outText}`, width, '  ');
      if (ev.output) {
        const snippet = ev.output.length > 240 ? `${ev.output.slice(0, 240)}...` : ev.output;
        pushWrapped(lines, snippet, width, '    ');
      }
    }
  }

  return lines;
}

export const WorkflowHistoryModal = memo(function WorkflowHistoryModal({
  host,
  isActive,
  onClose,
}: WorkflowHistoryModalProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState('');
  const [sessions, setSessions] = useState<WorkflowSessionSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusPane, setFocusPane] = useState<'list' | 'detail'>('list');

  const [detailCache, setDetailCache] = useState<Record<string, WorkflowSessionGetResponse>>({});
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string>('');
  const [reloadTick, setReloadTick] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError('');
    const res = await tryAction<WorkflowListResponse>(host, 'workflow.list', {});
    if (!mountedRef.current) return;
    if (!res.ok) {
      setSessions([]);
      setListError(res.error?.message || t(lang, '加载历史学习流失败', 'Failed to load workflow history'));
      setLoadingList(false);
      return;
    }
    const raw = Array.isArray(res.value?.sessions) ? res.value.sessions : [];
    const sorted = [...raw].sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    setSessions(sorted);
    setSelectedIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, sorted.length - 1))));
    setLoadingList(false);
  }, [host, lang]);

  useEffect(() => {
    if (!isActive) return;
    void loadList();
  }, [isActive, loadList, reloadTick]);

  const selectedSession = sessions[selectedIndex];

  const loadSessionDetail = useCallback(
    async (sessionId: string, force = false) => {
      if (!sessionId) return;
      if (!force && detailCache[sessionId]) {
        setDetailError('');
        return;
      }
      setLoadingDetailId(sessionId);
      setDetailError('');
      const res = await tryAction<WorkflowSessionGetResponse>(host, 'workflow.session.get', { id: sessionId });
      if (!mountedRef.current) return;
      setLoadingDetailId((cur) => (cur === sessionId ? null : cur));
      if (!res.ok || !res.value?.session) {
        setDetailError(res.error?.message || t(lang, '无法读取该记录详情', 'Unable to load session details'));
        return;
      }
      setDetailCache((prev) => ({ ...prev, [sessionId]: res.value as WorkflowSessionGetResponse }));
    },
    [detailCache, host, lang],
  );

  useEffect(() => {
    if (!isActive || !selectedSession?.id) return;
    void loadSessionDetail(selectedSession.id);
  }, [isActive, selectedSession?.id, loadSessionDetail]);

  const frameW = Math.min(112, Math.max(46, columns - 4));
  const frameH = Math.min(34, Math.max(15, rows - 2));
  const innerW = modalContentWidth(frameW);
  // Modal chrome budget: 5 rows (top border, title, divider, hints, bottom border).
  const innerH = Math.max(8, Math.min(frameH, rows - 2) - 5);
  const sideBySide = innerW >= 74;

  const handleBackOrClose = useCallback(() => {
    if (!sideBySide && focusPane === 'detail') {
      setFocusPane('list');
      return;
    }
    onClose();
  }, [focusPane, onClose, sideBySide]);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (key.tab) {
        if (sessions.length > 0) {
          setFocusPane((p) => (p === 'list' ? 'detail' : 'list'));
        }
        return;
      }
      if (input === 'r') {
        setDetailCache({});
        setReloadTick((n) => n + 1);
        notify(t(lang, `正在刷新历史学习流${ell}`, `Refreshing workflow history${ell}`), 'info');
        return;
      }
      if ((input === 'b' || key.backspace) && focusPane === 'detail') {
        setFocusPane('list');
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (!sideBySide && focusPane === 'detail') {
      return [
        { key: asciiMode ? 'Up/Dn/Pg' : '↑↓/Pg', label: t(lang, '滚动', 'Scroll') },
        { key: 'b/Esc', label: t(lang, '返回列表', 'Back') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
      ];
    }
    return [
      { key: asciiMode ? 'Up/Dn' : '↑↓', label: t(lang, '选择', 'Select') },
      { key: sideBySide ? 'Tab' : 'Enter', label: sideBySide ? t(lang, '切焦', 'Focus') : t(lang, '查看详情', 'Inspect') },
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [asciiMode, focusPane, lang, sideBySide]);

  const headerRows = 2; // status banner + divider
  const bodyH = Math.max(4, innerH - headerRows);
  const listW = sideBySide ? Math.floor(innerW * 0.42) : innerW;
  const detailW = sideBySide ? Math.max(20, innerW - listW - 1) : innerW;

  const activeDetail = selectedSession ? detailCache[selectedSession.id] ?? null : null;
  const detailLines = useMemo(
    () => buildDetailLines(activeDetail, selectedSession, Math.max(12, detailW - 1), lang, asciiMode),
    [activeDetail, selectedSession, detailW, lang, asciiMode],
  );

  const showList = sideBySide || focusPane === 'list';
  const showDetail = sideBySide || focusPane === 'detail';

  return (
    <Modal
      title={t(lang, '历史学习流记录 (只读)', 'Workflow History (Read-Only)')}
      icon={asciiMode ? '#' : '◷'}
      tone="info"
      subtitle={sessions.length > 0 ? `${sessions.length} ${t(lang, '条记录', 'sessions')}` : undefined}
      width={frameW}
      height={frameH}
      onClose={handleBackOrClose}
      isActive={isActive}
      hints={hints}
    >
      {/* Top retired read-only banner */}
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <Badge label={t(lang, '只读存档', 'Read-Only')} tone="info" variant="soft" />
        <Text> </Text>
        <Text color={theme.dim} wrap="truncate-end">
          {t(
            lang,
            '学习流已退役，历史记录仅保留只读查阅；新学习请用课程学法与带学',
            'Legacy flows are retired (read-only); use Course Method & Guided Study for new runs',
          )}
        </Text>
      </Box>
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>
      </Box>

      {/* Main Content */}
      {loadingList ? (
        <Box width={innerW} height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取历史学习流${ell}`, `Loading workflow history${ell}`)} active={isActive} />
        </Box>
      ) : listError ? (
        <Box width={innerW} height={bodyH} flexDirection="column" alignItems="center" justifyContent="center">
          <EmptyState
            title={t(lang, '无法读取历史学习流', 'Could not load workflow history')}
            hint={truncateDisplay(listError, Math.max(20, innerW - 4), ell)}
            icon={asciiMode ? '!' : '⚠'}
            width={innerW}
            height={bodyH}
          />
        </Box>
      ) : sessions.length === 0 ? (
        <EmptyState
          title={t(lang, '暂无历史学习流记录', 'No historical workflow runs yet')}
          hint={t(lang, '旧版学习流已退役；可在课程中使用「AI 带学」开始新的学习会话', 'Legacy workflows are retired; start new study sessions from Library')}
          width={innerW}
          height={bodyH}
        />
      ) : (
        <Box flexDirection="row" width={innerW} height={bodyH} overflow="hidden">
          {showList ? (
            <Box width={listW} height={bodyH} flexDirection="column" overflow="hidden" flexShrink={0}>
              <VirtualList
                items={sessions}
                width={listW}
                height={bodyH}
                selectedIndex={selectedIndex}
                onChange={(idx) => setSelectedIndex(idx)}
                onSelect={(item) => {
                  setFocusPane('detail');
                  void loadSessionDetail(item.id, true);
                }}
                isActive={isActive && focusPane === 'list'}
                keyExtractor={(s) => s.id}
                renderItem={(item, ctx) => {
                  const st = statusShortLabel(item.status, lang);
                  const stepInfo =
                    typeof item.stepCount === 'number' && item.stepCount > 0
                      ? `${Math.max(1, (item.stepIndex ?? 0) + 1)}/${item.stepCount}`
                      : '';
                  const dt = formatCompactDate(item.updatedAt);
                  const rightMeta = [stepInfo, dt].filter(Boolean).join(' ');
                  const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                  const stTag = `[${st}] `;
                  const fixedW = 2 + displayWidth(stTag) + (rightMeta ? displayWidth(rightMeta) + 1 : 0);
                  const titleMax = Math.max(6, ctx.width - fixedW);
                  const rawLabel = item.topic || item.title || item.id;
                  const title = padDisplay(truncateDisplay(rawLabel.replace(/\s+/g, ' '), titleMax, ell), titleMax);
                  const stColor =
                    item.status === 'completed'
                      ? theme.success
                      : item.status === 'active'
                        ? theme.accent
                        : theme.muted;

                  return (
                    <Box width={ctx.width} height={1} overflow="hidden">
                      <Text color={ctx.selected ? theme.primary : theme.muted}>{pointer}</Text>
                      <Text color={stColor} bold={ctx.selected}>
                        {stTag}
                      </Text>
                      <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                        {title}
                      </Text>
                      {rightMeta ? <Text color={theme.dim}>{` ${rightMeta}`}</Text> : null}
                    </Box>
                  );
                }}
              />
            </Box>
          ) : null}

          {sideBySide ? (
            <Box width={1} height={bodyH} flexDirection="column" flexShrink={0}>
              {Array.from({ length: bodyH }, (_, i) => (
                <Text key={i} color={theme.border}>
                  {asciiMode ? '|' : '│'}
                </Text>
              ))}
            </Box>
          ) : null}

          {showDetail ? (
            <Box width={detailW} height={bodyH} flexDirection="column" overflow="hidden" flexShrink={0}>
              {selectedSession ? (
                <>
                  <Box height={1} width={detailW} overflow="hidden" flexShrink={0}>
                    <StatusPill
                      label={statusShortLabel(selectedSession.status, lang)}
                      status={statusPillFor(selectedSession.status)}
                    />
                    <Text> </Text>
                    <Text color={theme.primary} bold wrap="truncate-end">
                      {truncateDisplay(
                        selectedSession.topic || selectedSession.title || selectedSession.id,
                        Math.max(8, detailW - 14),
                        ell,
                      )}
                    </Text>
                  </Box>
                  <Box height={1} width={detailW} overflow="hidden" flexShrink={0}>
                    <Text color={theme.dim} wrap="truncate-end">
                      {truncateDisplay(
                        [
                          selectedSession.title,
                          selectedSession.stepTitle
                            ? `${t(lang, '当前步骤', 'Step')}: ${selectedSession.stepTitle}`
                            : '',
                          formatTimestamp(selectedSession.updatedAt),
                        ]
                          .filter(Boolean)
                          .join(` ${asciiMode ? '-' : '·'} `),
                        detailW,
                        ell,
                      )}
                    </Text>
                  </Box>
                  <Box height={Math.max(2, bodyH - 2)} width={detailW} overflow="hidden">
                    {loadingDetailId === selectedSession.id && !activeDetail ? (
                      <Box width={detailW} height={Math.max(2, bodyH - 2)} alignItems="center" justifyContent="center">
                        <Spinner label={t(lang, `加载步骤详情${ell}`, `Loading steps${ell}`)} active={isActive} />
                      </Box>
                    ) : detailError && !activeDetail ? (
                      <EmptyState
                        title={t(lang, '无法读取步骤详情', 'Unable to load session details')}
                        hint={truncateDisplay(detailError, Math.max(16, detailW - 2), ell)}
                        width={detailW}
                        height={Math.max(2, bodyH - 2)}
                      />
                    ) : (
                      <ScrollView
                        key={selectedSession.id}
                        lines={detailLines}
                        width={detailW}
                        height={Math.max(2, bodyH - 2)}
                        isActive={isActive && focusPane === 'detail'}
                        ascii={asciiMode}
                      />
                    )}
                  </Box>
                </>
              ) : (
                <EmptyState
                  title={t(lang, '选择一条历史学习记录', 'Select a workflow session')}
                  width={detailW}
                  height={bodyH}
                />
              )}
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
