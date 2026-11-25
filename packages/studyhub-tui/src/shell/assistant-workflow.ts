/**
 * Multi-step Assistant Workflow Skeleton (#1315 Phase 3 — Round 88 Track D4).
 *
 * Parses compound natural-language instructions ("先 X 再 Y" / "X then Y" / "X；Y") exclusively
 * through the existing `parseAssistantIntent` action registry — never inventing backend actions —
 * and drives step-by-step execution with mandatory P2 confirmation on every write/export step.
 */
import type { UiLanguage } from '../types/contracts.js';
import { parseAssistantIntent, type AssistantIntent, type ParseIntentContext } from './assistant-intent.js';

export type WorkflowStepStatus = 'pending' | 'awaiting_confirm' | 'done' | 'skipped' | 'failed';

export interface AssistantWorkflowStep {
  index: number;
  rawClause: string;
  intent: AssistantIntent;
  status: WorkflowStepStatus;
  result?: string;
}

export interface AssistantWorkflowPlan {
  id: string;
  steps: readonly AssistantWorkflowStep[];
  activeIndex: number;
  cancelled: boolean;
}

const MAX_WORKFLOW_STEPS = 5;

/**
 * Split a compound instruction into 2..5 ordered clauses.
 * Returns `null` for ordinary single-step instructions so the single-step path stays untouched.
 */
export function splitCompoundInstruction(input: string): string[] | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Pattern 1: explicit Chinese "先 ... 再/然后/接着 ..."
  const xianZai = raw.match(/^先\s*(.+?)(?:[，,\s]*(?:再|然后|接着|最后)\s*)(.+)$/);
  const parts: string[] = [];
  if (xianZai) {
    parts.push(xianZai[1].trim());
    // Recursively split remaining tail on connectors
    const tailParts = xianZai[2]
      .split(/(?:[，,；;]\s*|\s+)(?:再|然后|接着|最后|and then|then)\s*|[；;]\s*|\s*->\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
    parts.push(...tailParts);
  } else {
    // Pattern 2: connector-delimited multi-step ("A，然后 B", "A -> B", "A; B", "A and then B")
    const split = raw
      .split(/\s*(?:[，,]\s*(?:然后|接着|再)|[；;]|\s+and\s+then\s+|\s+then\s+|\s*->\s*)\s*/i)
      .map((s) => s.replace(/^先\s*/, '').trim())
      .filter(Boolean);
    if (split.length >= 2) parts.push(...split);
  }

  if (parts.length < 2) return null;
  return parts.slice(0, MAX_WORKFLOW_STEPS);
}

/** Build a multi-step workflow plan reusing `parseAssistantIntent` for every step. */
export function planAssistantWorkflow(
  input: string,
  ctx: ParseIntentContext,
): AssistantWorkflowPlan | null {
  const clauses = splitCompoundInstruction(input);
  if (!clauses || clauses.length < 2) return null;

  const steps: AssistantWorkflowStep[] = clauses.map((clause, index) => {
    const intent = parseAssistantIntent(clause, ctx);
    return {
      index,
      rawClause: clause,
      intent,
      status: index === 0 && intent.requiresConfirm ? 'awaiting_confirm' : 'pending',
    };
  });

  // #1339: Only treat input as a multi-step workflow when at least one clause is an executable action.
  // Ordinary questions containing semicolons or "然后"/"再" stay a single prompt for the model.
  const hasExecutableAction = steps.some(
    (s) => s.intent.kind !== 'chat' && s.intent.kind !== 'boundary',
  );
  if (!hasExecutableAction) return null;

  return {
    id: `wf-${Date.now()}`,
    steps,
    activeIndex: 0,
    cancelled: false,
  };
}

export function currentWorkflowStep(plan: AssistantWorkflowPlan | null): AssistantWorkflowStep | null {
  if (!plan || plan.cancelled) return null;
  if (plan.activeIndex < 0 || plan.activeIndex >= plan.steps.length) return null;
  return plan.steps[plan.activeIndex] ?? null;
}

export function isWorkflowComplete(plan: AssistantWorkflowPlan | null): boolean {
  if (!plan) return true;
  return plan.cancelled || plan.activeIndex >= plan.steps.length;
}

export function markWorkflowStepResult(
  plan: AssistantWorkflowPlan,
  status: 'done' | 'skipped' | 'failed',
  result?: string,
): AssistantWorkflowPlan {
  const nextIndex = plan.activeIndex + 1;
  const steps = plan.steps.map((s, idx) => {
    if (idx === plan.activeIndex) return { ...s, status, result };
    if (idx === nextIndex && s.intent.requiresConfirm && s.status === 'pending') {
      return { ...s, status: 'awaiting_confirm' as const };
    }
    return s;
  });
  return { ...plan, steps, activeIndex: nextIndex };
}

export function cancelWorkflowPlan(plan: AssistantWorkflowPlan): AssistantWorkflowPlan {
  return { ...plan, cancelled: true };
}

export function formatWorkflowOutcomeSummary(
  plan: AssistantWorkflowPlan,
  lang: UiLanguage,
): string {
  const doneCount = plan.steps.filter((s) => s.status === 'done').length;
  const skippedCount = plan.steps.filter((s) => s.status === 'skipped').length;
  const failedCount = plan.steps.filter((s) => s.status === 'failed').length;
  if (skippedCount === 0 && failedCount === 0) {
    return lang === 'en'
      ? `Completed ${doneCount}-step plan`
      : `多步任务已完成（${doneCount} 步）`;
  }
  if (lang === 'en') {
    const parts = [`${doneCount} done`];
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    return `Multi-step plan partially completed (${parts.join(', ')})`;
  }
  const parts = [`已执行 ${doneCount} 步`];
  if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 步`);
  if (failedCount > 0) parts.push(`失败 ${failedCount} 步`);
  return `多步任务部分完成（${parts.join('，')}）`;
}

export function formatWorkflowChecklist(
  plan: AssistantWorkflowPlan,
  lang: UiLanguage,
  asciiMode: boolean,
): string {
  const doneCount = plan.steps.filter((s) => s.status === 'done').length;
  const header =
    lang === 'en'
      ? `Multi-step plan (${doneCount}/${plan.steps.length} done):`
      : `多步任务计划（已执行 ${doneCount}/${plan.steps.length}）：`;
  const lines = [header];
  for (const s of plan.steps) {
    const icon =
      s.status === 'done'
        ? asciiMode ? '[+]' : '✓'
        : s.status === 'skipped'
          ? asciiMode ? '[-]' : '↷'
          : s.status === 'failed'
            ? asciiMode ? '[x]' : '✕'
            : s.status === 'awaiting_confirm'
              ? asciiMode ? '[?]' : '⚠'
              : asciiMode ? '[ ]' : '○';
    const confirmTag = s.intent.requiresConfirm
      ? lang === 'en' ? ' (confirm)' : '（需确认）'
      : '';
    const suffix = s.result ? ` — ${s.result}` : '';
    const label = s.intent.kind === 'chat' ? s.rawClause : (s.intent.paramsSummary || s.rawClause);
    lines.push(`${icon} ${s.index + 1}. ${label}${confirmTag}${suffix}`);
  }
  return lines.join('\n');
}
