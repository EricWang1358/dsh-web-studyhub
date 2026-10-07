import { ui, uiFormat } from '../i18n.js';
import { STRENGTH_LABEL } from '../../lib/model-effort.js';
import { contractOf, taskKindOf } from './task-model.js';
import { followLabel } from '../follow-session.js';

/* What the 即时控制 row and the header offer for a job, read from its contract: the live settings (with their limits and the value in force) and which
   actions are available, or why not. Pure: the row is ControlRow.jsx. Nothing here knows more than the contract says, so a job kind that gains a
   setting shows it with no UI change beyond its label. */

const GENERATION_EFFORTS = { follow: '跟随当前会话', lowest: '最低', low: '低', medium: '中', default: '模型默认', high: '高', highest: '最高' };

const LABELS = {
  textConcurrency: '校对/翻译并发', transcribeConcurrency: '转写并发', proofreadReasoning: '剩余校对推理', translateReasoning: '剩余翻译推理',
  autoBackoff: '限流时自动降并发', concurrency: '并发', effortPlanning: '规划推理', effortReview: '审阅推理', effortWriting: '出题推理', effortRepair: '修复推理',
  maxBatchesPerDay: '每天最多批数', maxReady: '备好的题上限', reasoning: '备题推理', autoComplete: '自动补到完整',
};
export const controlLabel = (key) => ui(LABELS[key] || key);

const optionLabel = (key, value, session) => key.startsWith('effort') && value === 'follow' ? followLabel(session)
  : ui((key.startsWith('effort') ? GENERATION_EFFORTS : STRENGTH_LABEL)[value] || value);

/** The settings that live in the header, not in the row: the choice between a manual run and a run that goes on by itself. */
const HEADER_KEYS = new Set(['autoComplete']);

/** 自动补到完整 of a coverage run, from its contract: { value } while it can be flipped, else null. */
export function autoToggle(job) {
  const set = contractOf(job).actions.set, item = set.available ? (set.settings || []).find((setting) => setting.key === 'autoComplete') : null;
  return item ? { value: item.value === true } : null;
}

/** The settings of a job in the order the row draws them: [{ key, label, type: 'int' | 'enum' | 'bool', value, min, max, options: [{ value, label }] }].
    `session` (snapshot.model.session) is what 「跟随当前会话」 follows, named in that option; absent, the option says only that. */
export function controlItems(job, session) {
  const set = contractOf(job).actions.set;
  if (!set.available) return [];
  return (set.settings || []).filter((setting) => !HEADER_KEYS.has(setting.key)).map((setting) => ({ key: setting.key, label: controlLabel(setting.key), type: setting.type, value: setting.value, min: setting.min, max: setting.max,
    options: setting.type === 'enum' ? setting.values.map((option) => ({ value: option, label: optionLabel(setting.key, option, session) })) : [] }));
}

/** The value one press of − or + gives, kept inside the limits; the same value when the edge is reached (the button is disabled there). */
export const stepValue = (item, delta) => Math.min(item.max, Math.max(item.min, item.value + delta));

/** Why an action is not offered, in words; '' when it is offered. */
const REASON = {
  'job-ended': '任务已经结束。',
  'not-ended': '任务还在进行。',
  'not-retryable': '这个任务没有可以接着做的进度。',
  'capability-unsupported': '这类任务不支持这个操作。',
  'no-safe-checkpoint': '这类任务一旦开始就没有安全的暂停点。',
  'single-round': '这次只出一轮，没有可以暂停的地方；可以停止，已通过的题会保留。',
  'manual-run': '这次只做一轮，做完就停；勾选「自动补到完整」后，轮与轮之间才可以暂停。',
  'already-paused': '任务已经暂停，或正在暂停。',
  'not-paused': '任务没有暂停。',
  'already-cancelling': '任务正在停止。',
  'no-control-yet': '任务还没有开始。',
  continued: '这次已经接着做了，新的进度在接着做的那个任务里。',
};
export function reasonText(action, name) {
  if (!action || action.available) return '';
  const code = action.reason?.code;
  // Pause is the one action whose absence deserves its own sentence: the learner expects it, and what to do instead is "stop".
  if (name === 'pause' && ['single-round', 'manual-run'].includes(code)) return ui(REASON[code]);
  if (name === 'pause' && ['capability-unsupported', 'no-safe-checkpoint'].includes(code)) return ui('这类任务没有可以安全暂停的地方；可以停止，已完成的部分会保留。');
  return ui(REASON[code] || '这个操作现在不可用。');
}

/** The action buttons of the header, from the contract: only what is available is a button. */
export function headerActions(job) {
  const { actions } = contractOf(job);
  return { pause: actions.pause.available, resume: actions.resume.available, cancel: actions.cancel.available, retry: actions.retry.available };
}

/** The wording of "✓ 已生效 · 校对/翻译并发 → 4" for what a reply says is now in force. */
export function appliedText(applied = {}) {
  const parts = Object.entries(applied).map(([key, value]) => typeof value === 'boolean' ? uiFormat('{0}：{1}', [controlLabel(key), value ? ui('开') : ui('关')])
    : uiFormat('{0} → {1}', [controlLabel(key), typeof value === 'string' ? optionLabel(key, value) : value]));
  return parts.length ? uiFormat('✓ 已生效 · {0}', [parts.join('；')]) : '';
}

/** What a reply to pause / resume / cancel / retry says, in words. */
export const actionText = (action) => ({ pause: ui('已暂停：新的调用不再开始，跑完正在进行的调用就停'), resume: ui('已继续'), cancel: ui('正在停止；已完成的部分会保留'), retry: ui('已接着做') })[action] || '';

/**
 * What 存为默认 writes: the action and its arguments, from the values in force, or null when this kind of job has no saved default
 * (a translation job takes its size from the reader, not from a setting).
 */
export function defaultsPatch(job) {
  const items = Object.fromEntries(controlItems(job).map((item) => [item.key, item.value]));
  const pick = (keys) => Object.fromEntries(keys.filter((key) => items[key] !== undefined).map((key) => [key, items[key]]));
  switch (taskKindOf(job)) {
    case 'audio': return { action: 'audio.settings.set', args: pick(['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning']) };
    case 'generation': case 'supplement': return { action: 'settings', args: { generation: pick(['concurrency', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair']) } };
    default: return null;
  }
}
