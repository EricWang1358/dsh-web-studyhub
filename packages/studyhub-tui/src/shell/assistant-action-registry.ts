/**
 * Single typed AI & Study Assistant Action Registry (#1354 D8 P3).
 *
 * Every action callable through the Assistant, Command Palette, or Card Tools declares:
 * - `effect`: `'readonly' | 'write' | 'destructive'`
 * - `requiresConfirm`: mandatory `true` for every `'write'` and `'destructive'` action
 * - `label`: learner-facing bilingual display name (never raw dotted backend action IDs)
 * - `undoHint`: concise reversal guidance when the action is reversible
 *
 * Zero React dependencies so intent parsers, palettes, and modals can all share it cleanly.
 */
import type { UiLanguage } from '../types/contracts.js';
import { SET_ERROR_REASON_ACTION } from './error-reason-intent.js';

export type ActionEffectLevel = 'readonly' | 'write' | 'destructive';

/**
 * Write / quota / export actions: the only names `executeAssistantWriteAction` accepts, each a
 * `write` or `destructive` registry entry that requires confirmation. `AssistantWriteActionName`
 * is derived from this list, so the list exists once.
 */
export const ASSISTANT_WRITE_ACTIONS = Object.freeze([
  SET_ERROR_REASON_ACTION,
  'export.wrongbook',
  'card.followup.add',
  'assist.start',
  'note.qa.add',
  'card.flag',
  'review.grade.adjust',
  'review.correction.ack',
  'coach.practice',
  'review.start',
  'card.slay',
  'card.suspend',
  'card.focus',
  'review.undo',
  /** Spends model quota and writes a cache, so the learner confirms it (#1447). */
  'card.terms',
  'card.translate',
] as const);

export type AssistantWriteActionName = (typeof ASSISTANT_WRITE_ACTIONS)[number];

/** Read-only / navigation / reversible in-round actions. */
export const ASSISTANT_READONLY_ACTIONS = Object.freeze([
  'review.similar',
  'review.skip',
  'review.queue.edit',
  'navigate',
  'preferences.set',
  'assistant.guided',
  'snapshot',
  'assistant.explain',
  'review.get',
  'assistant.clarify',
  'assistant.chat',
  'boundary',
] as const);

export type RegisteredActionName = AssistantWriteActionName | (typeof ASSISTANT_READONLY_ACTIONS)[number];

export interface AssistantActionDescriptor {
  readonly actionName: RegisteredActionName;
  readonly effect: ActionEffectLevel;
  readonly requiresConfirm: boolean;
  readonly label: Readonly<{ zh: string; en: string }>;
  readonly undoHint: Readonly<{ zh: string; en: string }> | null;
}

const UNDO_Z = Object.freeze({ zh: '按 [z] 可撤销', en: 'Press [z] to undo' });

export const ASSISTANT_ACTION_REGISTRY: Readonly<Record<RegisteredActionName, AssistantActionDescriptor>> = Object.freeze({
  [SET_ERROR_REASON_ACTION]: {
    actionName: SET_ERROR_REASON_ACTION,
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '标记错题原因', en: 'Mark mistake reason' },
    undoHint: { zh: '可在错题本中重新修改错因', en: 'Can be changed again in Mistakes' },
  },
  'export.wrongbook': {
    actionName: 'export.wrongbook',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '导出错题本 Markdown', en: 'Export wrongbook Markdown' },
    undoHint: null,
  },
  'card.followup.add': {
    actionName: 'card.followup.add',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '生成并保存通俗讲解', en: 'Generate & save plain explanation' },
    undoHint: { zh: '可在题目讲解列表中重新覆盖', en: 'Can be overwritten in question explanations' },
  },
  'assist.start': {
    actionName: 'assist.start',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '发起后台助教任务', en: 'Start background assist task' },
    undoHint: { zh: '可在后台任务页查看或取消', en: 'View or manage in Tasks' },
  },
  'note.qa.add': {
    actionName: 'note.qa.add',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '保存到学习笔记', en: 'Save Q&A to study notes' },
    undoHint: { zh: '可在学习笔记页编辑或移除', en: 'Edit or remove in Study Notes' },
  },
  'card.flag': {
    actionName: 'card.flag',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '标记题目有问题', en: 'Flag question issue' },
    undoHint: UNDO_Z,
  },
  'review.grade.adjust': {
    actionName: 'review.grade.adjust',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '改判题目评分', en: 'Adjust question grade' },
    undoHint: { zh: '可再次改判或撤销上一题评分', en: 'Can be adjusted again or undone' },
  },
  'review.correction.ack': {
    actionName: 'review.correction.ack',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '确认订正并加入重练', en: 'Acknowledge correction' },
    undoHint: null,
  },
  'coach.practice': {
    actionName: 'coach.practice',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '开始错题变式练习', en: 'Start wrong-card variants practice' },
    undoHint: null,
  },
  'review.start': {
    actionName: 'review.start',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '开启错题重练轮次', en: 'Start wrong-cards practice round' },
    undoHint: null,
  },
  'card.slay': {
    actionName: 'card.slay',
    effect: 'destructive',
    requiresConfirm: true,
    label: { zh: '斩掉本题（移入斩题组）', en: 'Slay mastered question' },
    undoHint: { zh: '按 [z] 可撤销恢复', en: 'Press [z] to restore' },
  },
  'card.suspend': {
    actionName: 'card.suspend',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '暂停或恢复本题', en: 'Suspend or resume question' },
    undoHint: UNDO_Z,
  },
  'card.focus': {
    actionName: 'card.focus',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '收藏或取消考纲重点', en: 'Toggle focus priority' },
    undoHint: UNDO_Z,
  },
  'review.undo': {
    actionName: 'review.undo',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '撤销上一题评分', en: 'Undo last review rating' },
    undoHint: null,
  },
  'card.terms': {
    actionName: 'card.terms',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '提取核心术语', en: 'Extract key terms' },
    undoHint: null,
  },
  'card.translate': {
    actionName: 'card.translate',
    effect: 'write',
    requiresConfirm: true,
    label: { zh: '翻译本题', en: 'Translate current question' },
    undoHint: null,
  },
  'review.similar': {
    actionName: 'review.similar',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '查找同类题', en: 'Find similar questions' },
    undoHint: null,
  },
  'review.skip': {
    actionName: 'review.skip',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '跳过本题', en: 'Skip to next question' },
    undoHint: null,
  },
  'review.queue.edit': {
    actionName: 'review.queue.edit',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '把本题挪到本轮最后', en: 'Move question to end of queue' },
    undoHint: null,
  },
  navigate: {
    actionName: 'navigate',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '切换页面', en: 'Navigate page' },
    undoHint: null,
  },
  'preferences.set': {
    actionName: 'preferences.set',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '调整界面显示偏好', en: 'Adjust display preference' },
    undoHint: null,
  },
  'assistant.guided': {
    actionName: 'assistant.guided',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '进入苏格拉底带学', en: 'Enter guided study' },
    undoHint: null,
  },
  snapshot: {
    actionName: 'snapshot',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '查看学习统计', en: 'View study stats' },
    undoHint: null,
  },
  'assistant.explain': {
    actionName: 'assistant.explain',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '讲解当前题目', en: 'Explain current question' },
    undoHint: null,
  },
  'review.get': {
    actionName: 'review.get',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '查看当前判分结果', en: 'Check current grade verdict' },
    undoHint: null,
  },
  'assistant.clarify': {
    actionName: 'assistant.clarify',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '补充确认信息', en: 'Clarify parameters' },
    undoHint: null,
  },
  'assistant.chat': {
    actionName: 'assistant.chat',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '自由提问对话', en: 'AI tutor chat' },
    undoHint: null,
  },
  boundary: {
    actionName: 'boundary',
    effect: 'readonly',
    requiresConfirm: false,
    label: { zh: '能力边界说明', en: 'Capability boundary guidance' },
    undoHint: null,
  },
});

function normalizeActionKey(actionName: string): RegisteredActionName | null {
  if (actionName.startsWith('navigate(')) return 'navigate';
  return Object.prototype.hasOwnProperty.call(ASSISTANT_ACTION_REGISTRY, actionName)
    ? (actionName as RegisteredActionName)
    : null;
}

/** Look up a registered action descriptor by exact action name or `navigate(...)`. */
export function getAssistantActionMeta(actionName: string): AssistantActionDescriptor | null {
  const key = normalizeActionKey(actionName);
  return key ? ASSISTANT_ACTION_REGISTRY[key] : null;
}

/** Return the learner-facing bilingual label for a registered action. */
export function formatAssistantActionLabel(actionName: string, lang: UiLanguage): string {
  const meta = getAssistantActionMeta(actionName);
  if (!meta) return actionName;
  return lang === 'en' ? meta.label.en : meta.label.zh;
}

/** Single confirmation-gate lookup: every `write` and `destructive` action requires confirm. */
export function requiresActionConfirm(actionName: string): boolean {
  const meta = getAssistantActionMeta(actionName);
  if (!meta) return true;
  return meta.effect !== 'readonly' || meta.requiresConfirm;
}

/** List registered actions, optionally filtered by effect level. */
export function listAssistantActions(filter?: {
  effect?: ActionEffectLevel;
}): AssistantActionDescriptor[] {
  const all = Object.values(ASSISTANT_ACTION_REGISTRY);
  if (!filter?.effect) return all;
  return all.filter((entry) => entry.effect === filter.effect);
}

/**
 * Runtime contract validator ensuring every parsed intent obeys the action registry's
 * effect-level & confirmation invariants (D8 P3).
 */
export function validateIntentAgainstRegistry(intent: {
  kind: string;
  actionName: string;
  requiresConfirm: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const meta = getAssistantActionMeta(intent.actionName);
  if (!meta) {
    return { ok: false, reason: `Unregistered assistant action: ${intent.actionName}` };
  }
  // `pick_error_reason` only renders an inline picker; the actual write fires through `write_confirm`.
  if (intent.kind === 'pick_error_reason') {
    return { ok: true };
  }
  if (meta.effect !== 'readonly' && !intent.requiresConfirm) {
    return {
      ok: false,
      reason: `Action ${intent.actionName} (${meta.effect}) must set requiresConfirm=true`,
    };
  }
  if (meta.requiresConfirm && !intent.requiresConfirm) {
    return {
      ok: false,
      reason: `Action ${intent.actionName} requires confirmation according to ASSISTANT_ACTION_REGISTRY`,
    };
  }
  return { ok: true };
}
