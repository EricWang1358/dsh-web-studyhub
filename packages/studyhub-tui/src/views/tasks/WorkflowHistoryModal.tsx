import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import {
  Badge,
  EmptyState,
  Spinner,
  StatusPill,
  normalizeAsciiChrome,
  type PillStatus,
} from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { ScrollView } from '../../components/ScrollView.js';
import { VirtualList } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay, wrapDisplay } from '../../render/cjk.js';
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

interface WorkflowTemplateSummary {
  id?: string;
  title?: string;
  description?: string;
  steps?: WorkflowTemplateStep[];
  version?: number;
  updatedAt?: string;
}

interface WorkflowComponentSummary {
  kind?: string;
  title?: string;
  description?: string;
  prompt?: string;
}

interface WorkflowSkeletonSummary {
  id: string;
  title?: string;
  scope?: unknown[];
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
  readings?: Array<{
    cardId?: string;
    prompt?: string;
    deckTitle?: string;
    sourceTitle?: string;
    page?: number | string;
    excerpt?: string;
  }>;
  rescope?: { allowed?: boolean; reason?: string };
  hint?: string | null;
  modelReady?: boolean;
  teachingActive?: boolean;
  skeletonActive?: boolean;
}

interface WorkflowListResponse {
  retired?: boolean;
  limit?: number;
  components?: WorkflowComponentSummary[];
  suggested?: WorkflowTemplateSummary;
  templates?: WorkflowTemplateSummary[];
  sessions?: WorkflowSessionSummary[];
  topics?: string[];
  groups?: unknown[];
  skeletons?: WorkflowSkeletonSummary[];
}

interface WorkflowSessionGetResponse {
  retired?: boolean;
  session?: WorkflowSessionDetail;
  resources?: WorkflowSessionResources;
}

interface WorkflowContextResponse extends WorkflowListResponse {
  contract?: string;
  api?: {
    read?: string;
    retired?: string;
  };
  session?: WorkflowSessionDetail | null;
  resources?: WorkflowSessionResources;
}

type WorkflowListItem =
  | {
      kind: 'session';
      id: string;
      title: string;
      status?: string;
      updatedAt?: string;
      stepInfo: string;
      session: WorkflowSessionSummary;
    }
  | {
      kind: 'template';
      id: string;
      title: string;
      status: string;
      updatedAt?: string;
      stepInfo: string;
      template: WorkflowTemplateSummary;
    };

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
  if (s === 'template') return t(lang, '模板', 'Flow');
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

function pushWrapped(lines: string[], text: string, width: number, indent = '', asciiMode = false): void {
  const safeW = Math.max(8, width - displayWidth(indent));
  const clean = normalizeAsciiChrome(text, asciiMode);
  const rawParagraphs = clean.split(/\r?\n/);
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

function appendSessionDetailLines(
  lines: string[],
  session: WorkflowSessionDetail,
  resources: WorkflowSessionResources | undefined,
  summary: WorkflowSessionSummary | undefined,
  width: number,
  lang: UiLanguage,
  asciiMode: boolean,
): void {
  const sep = (asciiMode ? '-' : '─').repeat(Math.max(8, Math.min(width, 48)));
  const bullet = asciiMode ? '*' : '•';

  const topic = session.topic || summary?.topic || session.template?.title || session.id;
  pushWrapped(lines, `${t(lang, '主题', 'Topic')}: ${topic}`, width, '', asciiMode);
  if (session.template?.title) {
    pushWrapped(lines, `${t(lang, '流程', 'Flow')}: ${session.template.title}`, width, '', asciiMode);
  }
  const courseLabel = session.course?.label || session.course?.name;
  if (courseLabel) {
    pushWrapped(lines, `${t(lang, '课程', 'Course')}: ${courseLabel}`, width, '', asciiMode);
  }

  const times: string[] = [];
  if (session.createdAt) times.push(`${t(lang, '开始', 'Started')}: ${formatTimestamp(session.createdAt)}`);
  if (session.updatedAt) times.push(`${t(lang, '更新', 'Updated')}: ${formatTimestamp(session.updatedAt)}`);
  if (session.completedAt) times.push(`${t(lang, '完成', 'Completed')}: ${formatTimestamp(session.completedAt)}`);
  if (times.length > 0) {
    pushWrapped(lines, times.join('  '), width, '', asciiMode);
  }

  if (session.goal) {
    lines.push('');
    pushWrapped(lines, `${t(lang, '学习目标', 'Goal')}: ${session.goal}`, width, '', asciiMode);
  }

  if (resources) {
    const scopeParts: string[] = [];
    if (resources.skeleton?.title) scopeParts.push(`${t(lang, '骨架', 'Skeleton')}: ${resources.skeleton.title}`);
    if (resources.scopeDecks?.length) scopeParts.push(`${t(lang, '题组', 'Decks')}: ${resources.scopeDecks.join(', ')}`);
    if (resources.scopeTopics?.length) {
      scopeParts.push(`${t(lang, '知识点', 'Topics')}: ${resources.scopeTopics.slice(0, 6).join(', ')}`);
    }
    if (typeof resources.cardCount === 'number' && resources.cardCount > 0) {
      scopeParts.push(`${t(lang, '关联题数', 'Cards')}: ${resources.cardCount}`);
    }
    if (resources.practice && typeof resources.practice.total === 'number') {
      scopeParts.push(
        `${t(lang, '练习', 'Practice')}: ${resources.practice.answered ?? 0}/${resources.practice.total} (${t(lang, '正确', 'Correct')} ${resources.practice.correct ?? 0})`,
      );
    }
    if (resources.sources?.length) {
      const srcTitles = resources.sources
        .map((s) => s.title || s.id || '')
        .filter(Boolean)
        .slice(0, 6);
      if (srcTitles.length > 0) {
        scopeParts.push(`${t(lang, '关联资料', 'Sources')}: ${srcTitles.join(', ')}`);
      }
    }
    if (scopeParts.length > 0) {
      lines.push('');
      for (const part of scopeParts) pushWrapped(lines, part, width, '', asciiMode);
    }
    if (Array.isArray(resources.readings) && resources.readings.length > 0) {
      lines.push('');
      pushWrapped(lines, `${t(lang, '证据摘录', 'Evidence Excerpts')} (${resources.readings.length}):`, width, '', asciiMode);
      for (const rd of resources.readings.slice(0, 4)) {
        const loc = [rd.sourceTitle, rd.page !== undefined ? `p.${rd.page}` : ''].filter(Boolean).join(' ');
        const head = [rd.deckTitle, loc].filter(Boolean).join(' | ');
        if (head) pushWrapped(lines, `${bullet} ${head}`, width, '  ', asciiMode);
        if (rd.excerpt) {
          const clippedExcerpt = rd.excerpt.length > 180 ? `${rd.excerpt.slice(0, 180)}...` : rd.excerpt;
          pushWrapped(lines, clippedExcerpt, width, '    ', asciiMode);
        }
      }
    }
  }

  const steps = session.template?.steps ?? [];
  const records = session.records ?? {};
  lines.push('');
  lines.push(sep);
  pushWrapped(lines, `${t(lang, '步骤时间线', 'Step Timeline')} (${steps.length})`, width, '', asciiMode);

  if (steps.length === 0) {
    pushWrapped(lines, t(lang, '（无步骤定义）', '(No steps recorded)'), width, '  ', asciiMode);
  } else {
    steps.forEach((step, idx) => {
      const rec = records[step.id];
      const isCurrent = session.currentStepId === step.id;
      const marker = outcomeMarker(rec?.outcome, isCurrent, asciiMode);
      const stLabel = outcomeLabel(rec?.outcome, isCurrent, lang);
      const kindTag = step.kind ? ` [${step.kind}]` : '';
      const timeTag = rec?.updatedAt ? ` ${asciiMode ? '-' : '·'} ${formatTimestamp(rec.updatedAt)}` : '';

      lines.push('');
      pushWrapped(lines, `${marker} ${idx + 1}. ${step.title || step.id}${kindTag} (${stLabel}${timeTag})`, width, '', asciiMode);

      if (step.instructions) {
        pushWrapped(lines, `${t(lang, '要求', 'Prompt')}: ${step.instructions}`, width, '    ', asciiMode);
      }
      if (rec?.output) {
        pushWrapped(lines, `${t(lang, '笔记/作答', 'Notes')}: ${rec.output}`, width, '    ', asciiMode);
      }
      const material = rec?.content ?? step.content;
      if (material) {
        const clipped = material.length > 1200 ? `${material.slice(0, 1200)}\n...` : material;
        pushWrapped(lines, `${t(lang, '材料/讲解', 'Material')}:`, width, '    ', asciiMode);
        pushWrapped(lines, clipped, width, '      ', asciiMode);
      }
      if (Array.isArray(rec?.help) && rec.help.length > 0) {
        for (const h of rec.help) {
          const hTitle = h.title || h.kind || t(lang, '补充讲解', 'Help');
          const hReq = h.request ? ` (${h.request})` : '';
          pushWrapped(lines, `${bullet} ${hTitle}${hReq}:`, width, '    ', asciiMode);
          if (h.content) {
            const clippedHelp = h.content.length > 800 ? `${h.content.slice(0, 800)}\n...` : h.content;
            pushWrapped(lines, clippedHelp, width, '      ', asciiMode);
          }
        }
      }
    });
  }

  const history = session.history ?? [];
  if (history.length > 0) {
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, `${t(lang, '学习足迹', 'Activity Log')} (${history.length})`, width, '', asciiMode);
    const stepTitles = new Map(steps.map((s) => [s.id, s.title || s.id]));
    for (const ev of history) {
      const when = formatTimestamp(ev.at);
      const sName = (ev.stepId && stepTitles.get(ev.stepId)) || ev.stepId || ev.kind || 'step';
      const outText = outcomeLabel(ev.outcome, false, lang);
      pushWrapped(lines, `${bullet} [${when}] ${sName} ${asciiMode ? '->' : '→'} ${outText}`, width, '  ', asciiMode);
      if (ev.output) {
        const snippet = ev.output.length > 240 ? `${ev.output.slice(0, 240)}...` : ev.output;
        pushWrapped(lines, snippet, width, '    ', asciiMode);
      }
    }
  }
}

function buildDetailLines(
  detail: WorkflowSessionGetResponse | null,
  item: WorkflowListItem | undefined,
  width: number,
  lang: UiLanguage,
  asciiMode: boolean,
): string[] {
  if (!item) return [];
  const lines: string[] = [];
  if (item.kind === 'template') {
    const tpl = item.template;
    pushWrapped(lines, `${t(lang, '流程模板', 'Template')}: ${tpl.title || item.id}`, width, '', asciiMode);
    if (tpl.description) {
      pushWrapped(lines, `${t(lang, '说明', 'Description')}: ${tpl.description}`, width, '', asciiMode);
    }
    if (tpl.updatedAt) {
      pushWrapped(lines, `${t(lang, '更新', 'Updated')}: ${formatTimestamp(tpl.updatedAt)}`, width, '', asciiMode);
    }
    const steps = tpl.steps ?? [];
    lines.push('');
    pushWrapped(lines, `${t(lang, '步骤列表', 'Steps')} (${steps.length})`, width, '', asciiMode);
    steps.forEach((step, idx) => {
      const kindTag = step.kind ? ` [${step.kind}]` : '';
      pushWrapped(lines, `${idx + 1}. ${step.title || step.id}${kindTag}`, width, '  ', asciiMode);
      if (step.instructions) {
        pushWrapped(lines, `${t(lang, '要求', 'Prompt')}: ${step.instructions}`, width, '    ', asciiMode);
      }
    });
    return lines;
  }

  const session = detail?.session;
  if (!session) {
    pushWrapped(lines, item.session.topic || item.session.title || item.id, width, '', asciiMode);
    return lines;
  }
  appendSessionDetailLines(lines, session, detail?.resources, item.session, width, lang, asciiMode);
  return lines;
}

function buildContextLines(
  ctx: WorkflowContextResponse | null,
  sessionDetail: WorkflowSessionGetResponse | null,
  target: WorkflowListItem | null,
  width: number,
  lang: UiLanguage,
  asciiMode: boolean,
): string[] {
  if (!ctx) return [];
  const lines: string[] = [];
  const sep = (asciiMode ? '-' : '─').repeat(Math.max(8, Math.min(width, 60)));
  const bullet = asciiMode ? '*' : '•';

  const activeSession = ctx.session ?? sessionDetail?.session ?? null;
  const activeResources = ctx.resources ?? sessionDetail?.resources;

  if (activeSession) {
    appendSessionDetailLines(
      lines,
      activeSession,
      activeResources,
      target?.kind === 'session' ? target.session : undefined,
      width,
      lang,
      asciiMode,
    );
  } else if (target?.kind === 'template') {
    const matchedTemplate =
      ctx.templates?.find((tpl) => tpl.id === target.id) ?? target.template;
    pushWrapped(lines, `${t(lang, '流程模板', 'Workflow Template')}: ${matchedTemplate.title || target.id}`, width, '', asciiMode);
    if (matchedTemplate.description) {
      pushWrapped(lines, `${t(lang, '说明', 'Description')}: ${matchedTemplate.description}`, width, '', asciiMode);
    }
    if (matchedTemplate.updatedAt) {
      pushWrapped(lines, `${t(lang, '更新', 'Updated')}: ${formatTimestamp(matchedTemplate.updatedAt)}`, width, '', asciiMode);
    }
    const steps = matchedTemplate.steps ?? [];
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, `${t(lang, '模板步骤', 'Template Steps')} (${steps.length})`, width, '', asciiMode);
    steps.forEach((step, idx) => {
      const kindTag = step.kind ? ` [${step.kind}]` : '';
      lines.push('');
      pushWrapped(lines, `${idx + 1}. ${step.title || step.id}${kindTag}`, width, '', asciiMode);
      if (step.instructions) {
        pushWrapped(lines, `${t(lang, '提示语', 'Prompt')}: ${step.instructions}`, width, '  ', asciiMode);
      }
      if (step.content) {
        const clipped = step.content.length > 800 ? `${step.content.slice(0, 800)}\n...` : step.content;
        pushWrapped(lines, `${t(lang, '预设材料', 'Content')}: ${clipped}`, width, '  ', asciiMode);
      }
    });
  } else {
    const sessionCount = ctx.sessions?.length ?? 0;
    const templateCount = ctx.templates?.length ?? 0;
    const topicCount = ctx.topics?.length ?? 0;
    const skeletonCount = ctx.skeletons?.length ?? 0;
    pushWrapped(
      lines,
      `${t(lang, '工作流上下文总览', 'Workflow Context Overview')}: ${t(lang, '会话', 'Sessions')} ${sessionCount} | ${t(lang, '模板', 'Templates')} ${templateCount} | ${t(lang, '主题', 'Topics')} ${topicCount} | ${t(lang, '骨架', 'Skeletons')} ${skeletonCount}`,
      width,
      '',
      asciiMode,
    );

    const suggested = ctx.suggested;
    if (suggested?.steps?.length) {
      lines.push('');
      lines.push(sep);
      pushWrapped(
        lines,
        `${t(lang, '参考学习流程', 'Reference Flow')}: ${suggested.title || t(lang, '默认流程', 'Default Flow')}`,
        width,
        '',
        asciiMode,
      );
      if (suggested.description) {
        pushWrapped(lines, suggested.description, width, '  ', asciiMode);
      }
      suggested.steps.forEach((step, idx) => {
        const kindTag = step.kind ? ` [${step.kind}]` : '';
        pushWrapped(lines, `${idx + 1}. ${step.title || step.id}${kindTag}`, width, '  ', asciiMode);
        if (step.instructions) {
          pushWrapped(lines, `${t(lang, '要求', 'Prompt')}: ${step.instructions}`, width, '    ', asciiMode);
        }
      });
    }
  }

  // Library materials/scope & workflow metadata
  const templates = ctx.templates ?? [];
  if (templates.length > 0 && target?.kind !== 'template') {
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, `${t(lang, '已保存模板', 'Saved Templates')} (${templates.length})`, width, '', asciiMode);
    for (const tpl of templates.slice(0, 8)) {
      const stepN = tpl.steps?.length ?? 0;
      pushWrapped(
        lines,
        `${bullet} ${tpl.title || tpl.id || '-'} (${stepN} ${t(lang, '步', 'steps')})`,
        width,
        '  ',
        asciiMode,
      );
    }
  }

  const components = ctx.components ?? [];
  if (components.length > 0) {
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, `${t(lang, '学习组件', 'Workflow Components')} (${components.length})`, width, '', asciiMode);
    for (const comp of components) {
      const tag = comp.kind ? `[${comp.kind}] ` : '';
      const desc = comp.description ? ` - ${comp.description}` : '';
      pushWrapped(lines, `${bullet} ${tag}${comp.title || ''}${desc}`, width, '  ', asciiMode);
    }
  }

  const skeletons = ctx.skeletons ?? [];
  const topics = ctx.topics ?? [];
  if (skeletons.length > 0 || topics.length > 0) {
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, t(lang, '关联范围与知识骨架', 'Scope & Skeletons'), width, '', asciiMode);
    if (skeletons.length > 0) {
      pushWrapped(
        lines,
        `${t(lang, '知识骨架', 'Skeletons')} (${skeletons.length}): ${skeletons.slice(0, 8).map((s) => s.title || s.id).join(', ')}`,
        width,
        '  ',
        asciiMode,
      );
    }
    if (topics.length > 0) {
      pushWrapped(
        lines,
        `${t(lang, '知识点', 'Topics')} (${topics.length}): ${topics.slice(0, 12).join(', ')}`,
        width,
        '  ',
        asciiMode,
      );
    }
  }

  if (ctx.contract || ctx.api?.read || ctx.api?.retired) {
    lines.push('');
    lines.push(sep);
    pushWrapped(lines, t(lang, '只读契约说明', 'Read-Only Contract'), width, '', asciiMode);
    if (ctx.contract) pushWrapped(lines, ctx.contract, width, '  ', asciiMode);
    if (ctx.api?.read) pushWrapped(lines, `${t(lang, '只读接口', 'Read API')}: ${ctx.api.read}`, width, '  ', asciiMode);
    if (ctx.api?.retired) pushWrapped(lines, `${t(lang, '已退役写操作', 'Retired')}: ${ctx.api.retired}`, width, '  ', asciiMode);
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
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focusPane, setFocusPane] = useState<'list' | 'detail'>('list');
  const [subView, setSubView] = useState<'list' | 'context'>('list');

  const [detailCache, setDetailCache] = useState<Record<string, WorkflowSessionGetResponse>>({});
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string>('');

  const [contextTarget, setContextTarget] = useState<WorkflowListItem | null>(null);
  const [contextData, setContextData] = useState<WorkflowContextResponse | null>(null);
  const [contextSessionDetail, setContextSessionDetail] = useState<WorkflowSessionGetResponse | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [contextError, setContextError] = useState('');

  const [reloadTick, setReloadTick] = useState(0);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const seqRef = useRef(0);
  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      seqRef.current += 1;
      listSeqRef.current += 1;
      detailSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!isActive) {
      busyRef.current = false;
      seqRef.current += 1;
      setSubView('list');
      setFocusPane('list');
    }
  }, [isActive]);

  const items: WorkflowListItem[] = useMemo(() => {
    const out: WorkflowListItem[] = [];
    for (const s of sessions) {
      const stepInfo =
        typeof s.stepCount === 'number' && s.stepCount > 0
          ? `${Math.max(1, (s.stepIndex ?? 0) + 1)}/${s.stepCount}`
          : '';
      out.push({
        kind: 'session',
        id: s.id,
        title: s.topic || s.title || s.id,
        status: s.status,
        updatedAt: s.updatedAt,
        stepInfo,
        session: s,
      });
    }
    for (const tpl of templates) {
      if (!tpl.id) continue;
      const stepInfo = Array.isArray(tpl.steps) && tpl.steps.length > 0 ? `${tpl.steps.length}s` : '';
      out.push({
        kind: 'template',
        id: tpl.id,
        title: tpl.title || tpl.id,
        status: 'template',
        updatedAt: tpl.updatedAt,
        stepInfo,
        template: tpl,
      });
    }
    return out;
  }, [sessions, templates]);

  const loadList = useCallback(async () => {
    const seq = ++listSeqRef.current;
    setLoadingList(true);
    setListError('');
    const res = await tryAction<WorkflowListResponse>(host, 'workflow.list', {});
    if (!mountedRef.current || listSeqRef.current !== seq) return;
    if (!res.ok) {
      setSessions([]);
      setTemplates([]);
      setListError(res.error?.message || t(lang, '加载历史学习流失败', 'Failed to load workflow history'));
      setLoadingList(false);
      return;
    }
    const rawSessions = Array.isArray(res.value?.sessions) ? res.value.sessions : [];
    const sortedSessions = [...rawSessions].sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    const rawTemplates = Array.isArray(res.value?.templates) ? res.value.templates : [];
    const sortedTemplates = [...rawTemplates].sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    const total = sortedSessions.length + sortedTemplates.length;
    setSessions(sortedSessions);
    setTemplates(sortedTemplates);
    setSelectedIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, total - 1))));
    setLoadingList(false);
  }, [host, lang]);

  useEffect(() => {
    if (!isActive) return;
    void loadList();
  }, [isActive, loadList, reloadTick]);

  const selectedItem = items[selectedIndex];
  const selectedSession = selectedItem?.kind === 'session' ? selectedItem.session : undefined;

  const loadSessionDetail = useCallback(
    async (sessionId: string, force = false) => {
      if (!sessionId) return;
      if (!force && detailCache[sessionId]) {
        setDetailError('');
        return;
      }
      const seq = ++detailSeqRef.current;
      setLoadingDetailId(sessionId);
      setDetailError('');
      const res = await tryAction<WorkflowSessionGetResponse>(host, 'workflow.session.get', { id: sessionId });
      if (!mountedRef.current || detailSeqRef.current !== seq) return;
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
    if (!isActive || subView !== 'list' || !selectedSession?.id) return;
    void loadSessionDetail(selectedSession.id);
  }, [isActive, subView, selectedSession?.id, loadSessionDetail]);

  const inspectContext = useCallback(
    async (target?: WorkflowListItem | null) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const seq = ++seqRef.current;
      const item = target ?? null;

      setContextTarget(item);
      setContextError('');
      setContextData(null);
      setContextSessionDetail(null);
      setLoadingContext(true);
      setSubView('context');

      try {
        const ctxPayload =
          item?.kind === 'session'
            ? { id: item.id, sessionId: item.id }
            : item?.kind === 'template'
              ? { id: item.id }
              : {};

        const ctxPromise = tryAction<WorkflowContextResponse>(host, 'workflow.context', ctxPayload);
        const sessionPromise =
          item?.kind === 'session'
            ? tryAction<WorkflowSessionGetResponse>(host, 'workflow.session.get', { id: item.id })
            : Promise.resolve(null);

        const [ctxRes, sesRes] = await Promise.all([ctxPromise, sessionPromise]);
        if (!mountedRef.current || seqRef.current !== seq) return;

        if (!ctxRes.ok) {
          setContextError(ctxRes.error?.message || t(lang, '无法读取工作流上下文', 'Unable to load workflow context'));
          return;
        }
        setContextData(ctxRes.value ?? null);
        if (sesRes?.ok && sesRes.value?.session) {
          setContextSessionDetail(sesRes.value);
          if (item?.kind === 'session') {
            setDetailCache((prev) => ({ ...prev, [item.id]: sesRes.value as WorkflowSessionGetResponse }));
          }
        }
      } finally {
        if (seqRef.current === seq) busyRef.current = false;
        if (mountedRef.current && seqRef.current === seq) setLoadingContext(false);
      }
    },
    [host, lang],
  );

  const frameW = Math.min(112, Math.max(46, columns - 4));
  const frameH = Math.min(34, Math.max(15, rows - 2));
  const innerW = modalContentWidth(frameW);
  // Modal chrome budget: 5 rows (top border, title, divider, hints, bottom border).
  const innerH = Math.max(8, Math.min(frameH, rows - 2) - 5);
  const sideBySide = innerW >= 74;

  const handleBackOrClose = useCallback(() => {
    if (subView === 'context') {
      seqRef.current += 1;
      busyRef.current = false;
      setLoadingContext(false);
      setSubView('list');
      setFocusPane('list');
      return;
    }
    if (!sideBySide && focusPane === 'detail') {
      setFocusPane('list');
      return;
    }
    onClose();
  }, [focusPane, onClose, sideBySide, subView]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (subView === 'context') {
        if (input === 'b' || key.backspace) {
          handleBackOrClose();
          return;
        }
        if (input === 'r') {
          void inspectContext(contextTarget);
          notify(t(lang, `正在刷新工作流上下文${ell}`, `Refreshing workflow context${ell}`), 'info');
        }
        return;
      }

      if (key.tab) {
        if (items.length > 0) {
          setFocusPane((p) => (p === 'list' ? 'detail' : 'list'));
        }
        return;
      }
      if (input === 'c' && !loadingList) {
        void inspectContext(selectedItem ?? null);
        return;
      }
      if (key.return && !loadingList && (items.length === 0 || focusPane === 'detail')) {
        void inspectContext(selectedItem ?? null);
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
    if (subView === 'context') {
      return [
        { key: asciiMode ? 'Up/Dn/Pg' : '↑↓/Pg', label: t(lang, '滚动', 'Scroll') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
        { key: 'b/Esc', label: t(lang, '返回列表', 'Back') },
      ];
    }
    if (!sideBySide && focusPane === 'detail') {
      return [
        { key: asciiMode ? 'Up/Dn/Pg' : '↑↓/Pg', label: t(lang, '滚动', 'Scroll') },
        { key: 'c', label: t(lang, '查看上下文', 'Inspect Context') },
        { key: 'b/Esc', label: t(lang, '返回列表', 'Back') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
      ];
    }
    const base: KeyHint[] = [
      { key: asciiMode ? 'Up/Dn' : '↑↓', label: t(lang, '选择', 'Select') },
      { key: 'Enter/c', label: t(lang, '查看上下文', 'Inspect Context') },
    ];
    if (sideBySide && items.length > 0) {
      base.push({ key: 'Tab', label: t(lang, '切焦', 'Focus') });
    }
    base.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    base.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return base;
  }, [asciiMode, focusPane, items.length, lang, sideBySide, subView]);

  const headerRows = 2; // status banner + divider
  const bodyH = Math.max(4, innerH - headerRows);
  const listW = sideBySide ? Math.floor(innerW * 0.42) : innerW;
  const detailW = sideBySide ? Math.max(20, innerW - listW - 1) : innerW;

  const activeDetail = selectedSession ? detailCache[selectedSession.id] ?? null : null;
  const detailLines = useMemo(
    () => buildDetailLines(activeDetail, selectedItem, Math.max(12, detailW - 1), lang, asciiMode),
    [activeDetail, selectedItem, detailW, lang, asciiMode],
  );

  const contextLines = useMemo(
    () => buildContextLines(contextData, contextSessionDetail, contextTarget, Math.max(12, innerW - 2), lang, asciiMode),
    [contextData, contextSessionDetail, contextTarget, innerW, lang, asciiMode],
  );

  const showList = sideBySide || focusPane === 'list';
  const showDetail = sideBySide || focusPane === 'detail';
  const subtitle =
    subView === 'context'
      ? truncateDisplay(
          contextTarget?.title || t(lang, '工作流上下文', 'Workflow Context'),
          Math.max(12, Math.floor(innerW * 0.4)),
          ell,
        )
      : items.length > 0
        ? `${items.length} ${t(lang, '条记录', 'items')}`
        : undefined;

  return (
    <Modal
      title={t(lang, '历史学习流记录 (只读)', 'Workflow History (Read-Only)')}
      icon={asciiMode ? '#' : '◷'}
      tone="info"
      subtitle={subtitle}
      width={frameW}
      height={frameH}
      onClose={handleBackOrClose}
      isActive={isActive}
      hints={hints}
    >
      {/* Top retired read-only banner */}
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <Badge
          label={subView === 'context' ? t(lang, '上下文视图', 'Context View') : t(lang, '只读存档', 'Read-Only')}
          tone="info"
          variant="soft"
        />
        <Text> </Text>
        <Text color={theme.dim} wrap="truncate-end">
          {subView === 'context'
            ? t(
                lang,
                'workflow.context 只读上下文详情（0 模型调用）；按 [Esc] 或 [b] 返回列表',
                'Read-only workflow.context inspector (0 LLM calls); press [Esc] or [b] for list',
              )
            : t(
                lang,
                '学习流已退役，历史记录仅保留只读查阅；按 [Enter]/[c] 查看完整上下文',
                'Legacy flows are retired (read-only); press [Enter]/[c] to inspect full context',
              )}
        </Text>
      </Box>
      <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
        <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>
      </Box>

      {/* Main Content */}
      {subView === 'context' ? (
        <Box width={innerW} height={bodyH} flexDirection="column" overflow="hidden">
          {loadingContext ? (
            <Box width={innerW} height={bodyH} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, `正在读取工作流上下文${ell}`, `Loading workflow context${ell}`)} active={isActive} />
            </Box>
          ) : contextError ? (
            <EmptyState
              title={t(lang, '无法读取工作流上下文', 'Could not load workflow context')}
              hint={contextError}
              icon={asciiMode ? '!' : '⚠'}
              width={innerW}
              height={bodyH}
            />
          ) : contextLines.length === 0 ? (
            <EmptyState
              title={t(lang, '暂无上下文内容', 'No context available')}
              hint={t(lang, '按 [r] 刷新或 [Esc]/[b] 返回列表', 'Press [r] to refresh or [Esc]/[b] to go back')}
              width={innerW}
              height={bodyH}
            />
          ) : (
            <>
              <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
                <StatusPill
                  label={
                    contextTarget
                      ? statusShortLabel(contextTarget.status, lang)
                      : t(lang, '只读', 'Read-Only')
                  }
                  status={contextTarget ? statusPillFor(contextTarget.status) : 'idle'}
                />
                <Text> </Text>
                <Text color={theme.primary} bold wrap="truncate-end">
                  {truncateDisplay(
                    contextTarget?.title || t(lang, '工作流全局上下文 (workflow.context)', 'Global Workflow Context (workflow.context)'),
                    Math.max(12, innerW - 16),
                    ell,
                  )}
                </Text>
              </Box>
              <Box height={Math.max(2, bodyH - 1)} width={innerW} overflow="hidden">
                <ScrollView
                  key={contextTarget?.id || 'global-ctx'}
                  lines={contextLines}
                  width={innerW}
                  height={Math.max(2, bodyH - 1)}
                  isActive={isActive && subView === 'context'}
                  ascii={asciiMode}
                />
              </Box>
            </>
          )}
        </Box>
      ) : loadingList ? (
        <Box width={innerW} height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取历史学习流${ell}`, `Loading workflow history${ell}`)} active={isActive} />
        </Box>
      ) : listError ? (
        <Box width={innerW} height={bodyH} flexDirection="column" alignItems="center" justifyContent="center">
          <EmptyState
            title={t(lang, '无法读取历史学习流', 'Could not load workflow history')}
            hint={listError}
            icon={asciiMode ? '!' : '⚠'}
            width={innerW}
            height={bodyH}
          />
        </Box>
      ) : items.length === 0 ? (
        <EmptyState
          title={t(lang, '暂无历史学习流记录', 'No historical workflow runs yet')}
          hint={t(
            lang,
            '旧版学习流已退役；按 [c]/[Enter] 查看参考工作流上下文，或在课程中使用「AI 带学」',
            'Legacy workflows are retired; press [c]/[Enter] to inspect reference workflow context',
          )}
          actions={[
            { key: 'c', label: t(lang, '查看上下文', 'Inspect Context') },
            { key: 'r', label: t(lang, '刷新', 'Refresh') },
          ]}
          width={innerW}
          height={bodyH}
        />
      ) : (
        <Box flexDirection="row" width={innerW} height={bodyH} overflow="hidden">
          {showList ? (
            <Box width={listW} height={bodyH} flexDirection="column" overflow="hidden" flexShrink={0}>
              <VirtualList
                items={items}
                width={listW}
                height={bodyH}
                selectedIndex={selectedIndex}
                onChange={(idx) => setSelectedIndex(idx)}
                onSelect={(item) => {
                  void inspectContext(item);
                }}
                isActive={isActive && subView === 'list' && focusPane === 'list'}
                keyExtractor={(item) => `${item.kind}:${item.id}`}
                renderItem={(item, ctx) => {
                  const st = statusShortLabel(item.status, lang);
                  const dt = formatCompactDate(item.updatedAt);
                  const rightMeta = [item.stepInfo, dt].filter(Boolean).join(' ');
                  const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                  const stTag = `[${st}] `;
                  const fixedW = 2 + displayWidth(stTag) + (rightMeta ? displayWidth(rightMeta) + 1 : 0);
                  const titleMax = Math.max(6, ctx.width - fixedW);
                  const cleanTitle = normalizeAsciiChrome(item.title, asciiMode).replace(/\s+/g, ' ');
                  const title = padDisplay(truncateDisplay(cleanTitle, titleMax, ell), titleMax);
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
              {selectedItem ? (
                <>
                  <Box height={1} width={detailW} overflow="hidden" flexShrink={0}>
                    <StatusPill
                      label={statusShortLabel(selectedItem.status, lang)}
                      status={statusPillFor(selectedItem.status)}
                    />
                    <Text> </Text>
                    <Text color={theme.primary} bold wrap="truncate-end">
                      {truncateDisplay(
                        normalizeAsciiChrome(selectedItem.title, asciiMode),
                        Math.max(8, detailW - 14),
                        ell,
                      )}
                    </Text>
                  </Box>
                  <Box height={1} width={detailW} overflow="hidden" flexShrink={0}>
                    <Text color={theme.dim} wrap="truncate-end">
                      {truncateDisplay(
                        normalizeAsciiChrome(
                          [
                            selectedSession?.title ?? (selectedItem.kind === 'template' ? selectedItem.template.description : ''),
                            selectedSession?.stepTitle
                              ? `${t(lang, '当前步骤', 'Step')}: ${selectedSession.stepTitle}`
                              : '',
                            formatTimestamp(selectedItem.updatedAt),
                          ]
                            .filter(Boolean)
                            .join(` ${asciiMode ? '-' : '·'} `),
                          asciiMode,
                        ),
                        detailW,
                        ell,
                      )}
                    </Text>
                  </Box>
                  <Box height={Math.max(2, bodyH - 2)} width={detailW} overflow="hidden">
                    {selectedSession && loadingDetailId === selectedSession.id && !activeDetail ? (
                      <Box width={detailW} height={Math.max(2, bodyH - 2)} alignItems="center" justifyContent="center">
                        <Spinner label={t(lang, `加载步骤详情${ell}`, `Loading steps${ell}`)} active={isActive} />
                      </Box>
                    ) : selectedSession && detailError && !activeDetail ? (
                      <EmptyState
                        title={t(lang, '无法读取步骤详情', 'Unable to load session details')}
                        hint={detailError}
                        width={detailW}
                        height={Math.max(2, bodyH - 2)}
                      />
                    ) : (
                      <ScrollView
                        key={`${selectedItem.kind}:${selectedItem.id}`}
                        lines={detailLines}
                        width={detailW}
                        height={Math.max(2, bodyH - 2)}
                        isActive={isActive && subView === 'list' && focusPane === 'detail'}
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
