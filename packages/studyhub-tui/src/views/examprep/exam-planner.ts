/**
 * Exam Countdown Auto-Scheduler & Gap-Fill Planner (Round 91 Track D6).
 *
 * Works backward from `examDate` to partition remaining days into adaptive study phases
 * (Gap-Fill & Weak -> Consolidation -> Mock & Polish), detects missing-card coverage gaps,
 * computes daily card/topic quotas, and produces a rolling 7-day plan — 0 LLM tokens, pure O(n).
 */
import type { UiLanguage } from '../../types/contracts.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import { renderStatTable } from '../../render/charts.js';
import type { FocusTopicProgress } from './types.js';

export type ExamPhaseKind = 'gap_fill' | 'consolidate' | 'mock_polish';

export interface ExamPhaseAllocation {
  kind: ExamPhaseKind;
  label: string;
  days: number;
  startOffset: number;
  endOffset: number;
  focusTopics: string[];
}

export interface ExamDailySlot {
  dayOffset: number;
  dateKey: string;
  phase: ExamPhaseKind;
  phaseLabel: string;
  targetCards: number;
  primaryTopic: string;
  note: string;
}

export interface ExamCountdownPlan {
  examDate: string;
  daysLeft: number;
  status: 'ok' | 'today' | 'past';
  totalTopics: number;
  gapTopics: string[];
  weakTopics: string[];
  pendingTopics: string[];
  dailyCardTarget: number;
  dailyMinutes: number;
  phases: ExamPhaseAllocation[];
  next7Days: ExamDailySlot[];
}

export interface BuildExamCountdownPlanOptions {
  examDate: string | null | undefined;
  topics: readonly Pick<FocusTopicProgress, 'topic' | 'status' | 'cards' | 'mastery' | 'weakCards'>[];
  dailyMinutes?: number;
  lang?: UiLanguage;
  today?: Date;
}

function parseYmdLocal(ymd: string): Date | null {
  const m = String(ymd ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDaysYmd(base: Date, offset: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function phaseLabelFor(kind: ExamPhaseKind, lang: UiLanguage): string {
  if (lang === 'en') {
    return kind === 'gap_fill' ? 'Gap-Fill' : kind === 'consolidate' ? 'Consolidate' : 'Mock & Polish';
  }
  return kind === 'gap_fill' ? '补缺攻坚' : kind === 'consolidate' ? '巩固强化' : '考前模考';
}

export function buildExamCountdownPlan(opts: BuildExamCountdownPlanOptions): ExamCountdownPlan | null {
  const rawDate = String(opts.examDate ?? '').trim();
  const examDt = parseYmdLocal(rawDate);
  if (!examDt) return null;

  const lang = opts.lang ?? 'zh';
  const now = opts.today ?? new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((examDt.getTime() - todayMidnight.getTime()) / 86_400_000);
  const dailyMinutes = Math.max(15, Math.min(240, Math.floor(opts.dailyMinutes ?? 45)));

  const gapTopics: string[] = [];
  const weakTopics: string[] = [];
  const pendingTopics: string[] = [];
  let remainingWorkCards = 0;

  for (const tp of opts.topics) {
    const name = String(tp.topic || '').trim();
    if (!name) continue;
    const cards = Math.max(0, Number(tp.cards) || 0);
    const weakCount = Array.isArray(tp.weakCards) ? tp.weakCards.length : 0;
    if (tp.status === 'none' || cards === 0) {
      gapTopics.push(name);
      remainingWorkCards += 8; // estimated gap-fill batch per missing topic
    } else if (tp.status === 'weak' || weakCount > 0) {
      weakTopics.push(name);
      remainingWorkCards += Math.max(weakCount * 2, Math.ceil(cards * (1 - (tp.mastery || 0))));
    } else if (tp.status !== 'done') {
      pendingTopics.push(name);
      remainingWorkCards += Math.max(4, Math.ceil(cards * (1 - (tp.mastery || 0))));
    }
  }

  if (daysLeft < 0) {
    return {
      examDate: rawDate,
      daysLeft,
      status: 'past',
      totalTopics: opts.topics.length,
      gapTopics,
      weakTopics,
      pendingTopics,
      dailyCardTarget: 0,
      dailyMinutes,
      phases: [],
      next7Days: [],
    };
  }

  if (daysLeft === 0) {
    const todayTopics = [...weakTopics, ...gapTopics, ...pendingTopics].slice(0, 3);
    return {
      examDate: rawDate,
      daysLeft: 0,
      status: 'today',
      totalTopics: opts.topics.length,
      gapTopics,
      weakTopics,
      pendingTopics,
      dailyCardTarget: Math.min(20, Math.max(5, weakTopics.length * 4)),
      dailyMinutes,
      phases: [
        {
          kind: 'mock_polish',
          label: phaseLabelFor('mock_polish', lang),
          days: 1,
          startOffset: 0,
          endOffset: 0,
          focusTopics: todayTopics,
        },
      ],
      next7Days: [
        {
          dayOffset: 0,
          dateKey: addDaysYmd(todayMidnight, 0),
          phase: 'mock_polish',
          phaseLabel: phaseLabelFor('mock_polish', lang),
          targetCards: Math.min(20, Math.max(5, weakTopics.length * 4)),
          primaryTopic: todayTopics[0] ?? (lang === 'en' ? 'Quick Review' : '考前速览'),
          note: lang === 'en' ? 'Exam day — light weak-spot warm-up' : '考试当天：轻度温习易错点',
        },
      ],
    };
  }

  // Backward partition across remaining `daysLeft` days
  const mockDays = daysLeft >= 6 ? Math.max(2, Math.round(daysLeft * 0.2)) : daysLeft >= 3 ? 1 : 0;
  const nonMock = Math.max(1, daysLeft - mockDays);
  const gapAndWeakNeed = gapTopics.length + weakTopics.length;
  const gapDays =
    gapAndWeakNeed > 0
      ? Math.max(1, Math.min(nonMock, Math.round(nonMock * (pendingTopics.length > 0 ? 0.55 : 1))))
      : 0;
  const consolidateDays = Math.max(0, nonMock - gapDays);

  const phases: ExamPhaseAllocation[] = [];
  let cursor = 0;
  if (gapDays > 0) {
    phases.push({
      kind: 'gap_fill',
      label: phaseLabelFor('gap_fill', lang),
      days: gapDays,
      startOffset: cursor,
      endOffset: cursor + gapDays - 1,
      focusTopics: [...gapTopics, ...weakTopics],
    });
    cursor += gapDays;
  }
  if (consolidateDays > 0) {
    phases.push({
      kind: 'consolidate',
      label: phaseLabelFor('consolidate', lang),
      days: consolidateDays,
      startOffset: cursor,
      endOffset: cursor + consolidateDays - 1,
      focusTopics: pendingTopics.length > 0 ? pendingTopics : [...weakTopics, ...gapTopics],
    });
    cursor += consolidateDays;
  }
  if (mockDays > 0) {
    phases.push({
      kind: 'mock_polish',
      label: phaseLabelFor('mock_polish', lang),
      days: mockDays,
      startOffset: cursor,
      endOffset: cursor + mockDays - 1,
      focusTopics: [...weakTopics, ...pendingTopics].slice(0, 5),
    });
  }

  // Daily quota bounded cleanly by time budget (~1.5 min/card) and workload
  const capacityMax = Math.max(10, Math.floor(dailyMinutes / 1.5));
  const rawDaily = Math.ceil(Math.max(remainingWorkCards, daysLeft * 8) / daysLeft);
  const dailyCardTarget = Math.max(8, Math.min(capacityMax * 2, rawDaily));

  const horizon = Math.min(7, daysLeft);
  const next7Days: ExamDailySlot[] = [];
  for (let d = 0; d < horizon; d += 1) {
    const phase = phases.find((p) => d >= p.startOffset && d <= p.endOffset) ?? phases[phases.length - 1];
    const pool = phase?.focusTopics ?? [];
    const primaryTopic =
      pool.length > 0
        ? pool[(d - (phase?.startOffset ?? 0)) % pool.length]
        : lang === 'en'
          ? 'Mixed FSRS Review'
          : '综合间隔复习';
    const isGap = gapTopics.includes(primaryTopic);
    const note =
      phase.kind === 'mock_polish'
        ? lang === 'en'
          ? 'Timed mock + error review'
          : '限时模拟 + 错题清零'
        : isGap
          ? lang === 'en'
            ? 'Auto gap-fill: generate cards [g]'
            : '缺口自动补齐：按 [g] 补题'
          : lang === 'en'
            ? 'Focused drill & FSRS review'
            : '专题巩固 + 间隔复习';

    next7Days.push({
      dayOffset: d,
      dateKey: addDaysYmd(todayMidnight, d),
      phase: phase.kind,
      phaseLabel: phase.label,
      targetCards: dailyCardTarget,
      primaryTopic,
      note,
    });
  }

  return {
    examDate: rawDate,
    daysLeft,
    status: 'ok',
    totalTopics: opts.topics.length,
    gapTopics,
    weakTopics,
    pendingTopics,
    dailyCardTarget,
    dailyMinutes,
    phases,
    next7Days,
  };
}

export function formatExamCountdownSummary(
  plan: ExamCountdownPlan | null,
  lang: UiLanguage,
  asciiMode: boolean,
): string {
  if (!plan || plan.status === 'past') return '';
  const sep = asciiMode ? ' | ' : ' · ';
  const icon = asciiMode ? '*' : '✦';
  if (plan.status === 'today') {
    return lang === 'en'
      ? `${icon} Exam Day (${plan.examDate}): light warm-up (${plan.dailyCardTarget} cards)`
      : `${icon} 今日考试 (${plan.examDate})：建议轻度温习 ${plan.dailyCardTarget} 题易错点`;
  }
  const activePhase = plan.phases[0]?.label ?? '';
  const gapPart =
    plan.gapTopics.length > 0
      ? lang === 'en'
        ? `${sep}${plan.gapTopics.length} gap(s) need [g]`
        : `${sep}缺题 ${plan.gapTopics.length} 项待[g]补齐`
      : '';
  return lang === 'en'
    ? `${icon} Auto Plan (${plan.daysLeft}d left): ${activePhase}${sep}~${plan.dailyCardTarget} cards/day${gapPart}`
    : `${icon} 考期倒推 (${plan.daysLeft}天)：${activePhase}${sep}日均 ${plan.dailyCardTarget} 题${gapPart}`;
}

export interface GapFillWorkflowStep {
  index: number;
  kind: 'generate_gap' | 'drill_weak' | 'mock_exam';
  topic: string;
  requiresConfirm: boolean;
  label: string;
}

/**
 * Build an ordered, P2-guarded gap-fill remediation workflow from an ExamCountdownPlan (Round 94 Track D8).
 * Generation steps always require P2 confirmation; practice steps execute directly.
 */
export function buildGapFillWorkflowSteps(
  plan: ExamCountdownPlan | null,
  lang: UiLanguage,
): GapFillWorkflowStep[] {
  if (!plan || plan.status === 'past') return [];
  const zh = lang !== 'en';
  const steps: GapFillWorkflowStep[] = [];
  for (const topic of plan.gapTopics.slice(0, 3)) {
    steps.push({
      index: steps.length,
      kind: 'generate_gap',
      topic,
      requiresConfirm: true,
      label: zh ? `补齐缺题：「${topic}」（AI 出题，需确认）` : `Gap-fill "${topic}" (AI generate, confirm)`,
    });
  }
  for (const topic of plan.weakTopics.slice(0, 2)) {
    steps.push({
      index: steps.length,
      kind: 'drill_weak',
      topic,
      requiresConfirm: false,
      label: zh ? `专项巩固：「${topic}」（错题重练）` : `Drill weak "${topic}" (practice)`,
    });
  }
  if (plan.daysLeft >= 1 && plan.daysLeft <= 10) {
    steps.push({
      index: steps.length,
      kind: 'mock_exam',
      topic: zh ? '全真限时模拟' : 'Timed Mock Exam',
      requiresConfirm: false,
      label: zh ? `考前检验：限时模拟卷（距考 ${plan.daysLeft} 天）` : `Exam check: Timed mock (${plan.daysLeft}d left)`,
    });
  }
  return steps;
}

/** Render the rolling 7-day exam countdown schedule via borderless CJK-aligned `renderStatTable` (Round 94 Track A12). */
export function renderExamScheduleTable(
  plan: ExamCountdownPlan | null,
  width: number,
  theme: Pick<ThemeTokens, 'primary' | 'track' | 'muted' | 'dim' | 'heat' | 'text'>,
  opts: { lang: UiLanguage; ascii?: boolean },
): string[] {
  if (!plan || plan.next7Days.length === 0) return [];
  const zh = opts.lang !== 'en';
  return renderStatTable(
    [
      { key: 'date', label: zh ? '日期' : 'Date', align: 'left', width: 10 },
      { key: 'phase', label: zh ? '阶段' : 'Phase', align: 'left', minWidth: 8 },
      { key: 'topic', label: zh ? '主攻重点' : 'Focus', align: 'left', minWidth: 8 },
      { key: 'cards', label: zh ? '题量' : 'Qty', align: 'right', width: 4 },
    ],
    plan.next7Days.map((slot) => ({
      date: slot.dateKey,
      phase: slot.phaseLabel,
      topic: slot.primaryTopic,
      cards: slot.targetCards,
    })),
    width,
    theme,
    { ascii: opts.ascii },
  );
}

/**
 * Format an `ExamCountdownPlan` as a structured Markdown section (Round 97 Track D10, 0 LLM tokens).
 * Includes phase breakdown, rolling 7-day schedule table, and gap-fill remediation checklist.
 */
export function formatExamScheduleMarkdown(plan: ExamCountdownPlan | null, lang: UiLanguage = 'zh'): string {
  if (!plan || plan.status === 'past') return '';
  const zh = lang !== 'en';
  const esc = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '-';
  const lines: string[] = [
    `## ${zh ? `考期倒推自动排程（距考 ${plan.daysLeft} 天 · 日均 ${plan.dailyCardTarget} 题）` : `Exam Countdown Auto-Schedule (${plan.daysLeft}d left · ~${plan.dailyCardTarget} cards/day)`}`,
    '',
  ];
  if (plan.phases.length > 0) {
    const phaseSummary = plan.phases
      .map((p) => (zh ? `${p.label} ${p.days}天` : `${p.label} (${p.days}d)`))
      .join(' → ');
    lines.push(`- **${zh ? '阶段拆分' : 'Phases'}**: ${phaseSummary}`);
  }
  if (plan.gapTopics.length > 0) {
    lines.push(`- **${zh ? '缺题待补' : 'Gap Topics'}**: ${plan.gapTopics.map(esc).join(', ')}`);
  }
  if (plan.next7Days.length > 0) {
    lines.push(
      '',
      zh ? '| 日期 | 阶段 | 主攻重点 | 目标题量 | 建议 |' : '| Date | Phase | Primary Focus | Target Cards | Note |',
      '| --- | --- | --- | ---: | --- |',
    );
    for (const slot of plan.next7Days) {
      lines.push(
        `| ${esc(slot.dateKey)} | ${esc(slot.phaseLabel)} | ${esc(slot.primaryTopic)} | ${slot.targetCards} | ${esc(slot.note)} |`,
      );
    }
  }
  const steps = buildGapFillWorkflowSteps(plan, lang);
  if (steps.length > 0) {
    lines.push('', `### ${zh ? '建议行动清单' : 'Recommended Next Actions'}`, '');
    for (const step of steps) {
      lines.push(`- [ ] ${esc(step.label)}`);
    }
  }
  return lines.join('\n');
}
