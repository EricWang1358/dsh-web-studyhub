import { ui, uiFormat } from '../i18n.js';
import { STRENGTH_LABEL } from '../../lib/model-effort.js';
import { isActiveJob } from '../../lib/job-status.js';
import { taskKindOf } from './task-model.js';

/* What the 即时控制 row offers for a job, read from `job.control` (what the backend says can be adjusted, its limits and the value in force).
   Pure: the row is ControlRow.jsx. Nothing here knows more than the job record says, so a job kind that gains a control shows it with no UI change
   beyond its label. */

const GENERATION_EFFORTS = { follow: '跟随当前会话', lowest: '最低', low: '低', default: '模型默认', high: '高', highest: '最高' };

const LABELS = {
  textConcurrency: '校对/翻译并发', transcribeConcurrency: '转写并发', proofreadReasoning: '剩余校对推理', translateReasoning: '剩余翻译推理',
  autoBackoff: '限流时自动降并发', concurrency: '并发', effortPlanning: '规划推理', effortReview: '审阅推理', effortWriting: '出题推理', effortRepair: '修复推理',
};
const ORDER = {
  audio: ['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning', 'autoBackoff'],
  generation: ['concurrency', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'],
  translation: ['concurrency'],
};
export const controlLabel = (key) => ui(LABELS[key] || key);

const optionLabel = (key, value) => ui((key.startsWith('effort') ? GENERATION_EFFORTS : STRENGTH_LABEL)[value] || value);

/** The controls of a job in the order the row draws them: [{ key, label, type: 'int' | 'enum' | 'bool', value, min, max, options: [{ value, label }] }]. Empty when the job has none. */
export function controlItems(job) {
  const control = job?.control;
  if (!control || !isActiveJob(job)) return [];
  const kind = taskKindOf(job), keys = ORDER[kind === 'supplement' ? 'generation' : kind] || [];
  return keys.filter((key) => control.limits?.[key] && key in (control.values || {})).map((key) => {
    const rule = control.limits[key], value = control.values[key];
    return { key, label: controlLabel(key), type: rule.type, value, min: rule.min, max: rule.max,
      options: rule.type === 'enum' ? rule.values.map((option) => ({ value: option, label: optionLabel(key, option) })) : [] };
  });
}

/** The value one press of − or + gives, kept inside the limits; the same value when the edge is reached (the button is disabled there). */
export const stepValue = (item, delta) => Math.min(item.max, Math.max(item.min, item.value + delta));

export const isPaused = (job) => job?.paused === true || job?.control?.values?.paused === true;
/** Pause is offered to every adjustable job whose control has it. */
export const canPause = (job) => isActiveJob(job) && typeof job?.control?.values?.paused === 'boolean';

/** The wording of "✓ 已生效 · 校对/翻译并发 → 4" for what a reply says is now in force. */
export function appliedText(applied = {}) {
  const parts = Object.entries(applied).map(([key, value]) => key === 'paused' ? (value ? ui('已暂停：跑完正在进行的调用就停') : ui('已继续'))
    : typeof value === 'boolean' ? uiFormat('{0}：{1}', [controlLabel(key), value ? ui('开') : ui('关')])
      : uiFormat('{0} → {1}', [controlLabel(key), typeof value === 'string' ? optionLabel(key, value) : value]));
  return parts.length ? uiFormat('✓ 已生效 · {0}', [parts.join('；')]) : '';
}

/**
 * What 存为默认 writes: the action and its arguments, from the values in force, or null when this kind of job has no saved default
 * (a translation job takes its size from the reader, not from a setting).
 */
export function defaultsPatch(job) {
  const values = job?.control?.values;
  if (!values) return null;
  const pick = (keys) => Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  switch (taskKindOf(job)) {
    case 'audio': return { action: 'audio.settings.set', args: pick(['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning']) };
    case 'generation': case 'supplement': return { action: 'settings', args: { generation: pick(['concurrency', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair']) } };
    default: return null;
  }
}
