import { ui, uiFormat } from '../i18n.js';
import { STRENGTH_LABEL } from '../../lib/model-effort.js';
import { FOLLOW_MODEL, modelKey, modelOfKey } from '../../lib/job-model.js';
import { contractOf, taskKindOf } from './task-model.js';
import { followOption } from '../follow-session.js';
import { effortNoteText, effortSelectModel } from '../EffortSelect.jsx';

/* What the 即时控制 row and the header offer for a job, read from its contract: the live settings (with their limits and the value in force) and which
   actions are available, or why not. Pure: the row is ControlRow.jsx. Nothing here knows more than the contract says, so a job kind that gains a
   setting shows it with no UI change beyond its label. */

const GENERATION_EFFORTS = { follow: '跟随当前会话', lowest: '最低', low: '低', medium: '中', default: '模型默认', high: '高', highest: '最高' };

const LABELS = {
  textConcurrency: '校对/翻译并发', transcribeConcurrency: '转写并发', proofreadReasoning: '剩余校对推理', translateReasoning: '剩余翻译推理',
  autoBackoff: '限流时自动降并发', concurrency: '并发', effortPlanning: '规划推理', effortReview: '审阅推理', effortWriting: '出题推理', effortRepair: '修复推理',
  applySuggestions: '采纳审阅建议', maxBatchesPerDay: '每天最多批数', maxReady: '备好的题上限', reasoning: '备题推理', autoComplete: '自动补到完整', model: '模型',
};
export const controlLabel = (key) => ui(LABELS[key] || key);

// The model of a run is named by its id where only the value is known (the log); the row names it as the host's catalog does.
const optionLabel = (key, value) => key === 'model' ? (modelOfKey(value)?.model || ui('跟随设置'))
  : ui((key.startsWith('effort') ? GENERATION_EFFORTS : STRENGTH_LABEL)[value] || value);
const optionOf = (key, value, session) => key.startsWith('effort') && value === 'follow' ? followOption(session) : { value, label: optionLabel(key, value) };

/* The model of THIS run (lib/job-model.js): the models the host lists (host.modelGroups, the catalog Settings' 生成模型 lists, by display name and grouped
   by provider), and first 「跟随设置」, the generation model Settings resolves (`generation`: snapshot.model, named in the popup and the tooltip). Nothing
   to offer (a host that lists no models, and the run follows) draws no select. */
const ONLY_THIS_TASK = '只用于这个任务：设置里的生成模型和其他任务不变。';
function followModelOption(generation) {
  const name = typeof generation?.label === 'string' && generation.label.trim() ? generation.label : '';
  return { value: FOLLOW_MODEL, label: name ? uiFormat('跟随设置 · {0}', [name]) : ui('跟随设置'), triggerLabel: ui('跟随设置'),
    tip: name ? uiFormat('用「设置 › 学习库与模型」里的生成模型：现在是 {0}。', [name]) : '', wrap: true };
}
function modelOptions(value, groups) {
  const chosen = modelOfKey(value), lists = (Array.isArray(groups) ? groups : []).filter((group) => group?.id && Array.isArray(group.models) && group.models.length);
  if (!lists.length && !chosen) return null;
  const listed = lists.some((group) => group.id === chosen?.provider && group.models.some((model) => model.id === chosen?.model));
  return [...lists.map((group) => ({ group: group.name || group.id, options: group.models.map((model) => ({ value: modelKey({ provider: group.id, model: model.id }), label: model.name || model.id, tip: ui(ONLY_THIS_TASK) })) })),
    ...(chosen && !listed ? [{ value, label: chosen.model, tip: ui(ONLY_THIS_TASK) }] : [])];
}

/* The level of one stage among the levels of the model in force (`efforts`: [{ id, name }], [] for a model without levels, null while unknown), through
   the one mapping of 出题偏好 (ui/EffortSelect.jsx effortSelectModel): the select shows the level really used and its tooltip says why when that is not
   the one asked for. Unknown levels keep the relative choices of the contract. */
function effortItem(item, efforts, session) {
  if (!Array.isArray(efforts)) return item;
  const { options, shown, note } = effortSelectModel({ value: item.value, efforts, follow: true, session });
  const tip = note ? effortNoteText(note) : '';
  return { ...item, value: shown, options: tip ? options.map((option) => (option.value === shown ? { ...option, tip } : option)) : options };
}

/** The settings that live in the header, not in the row: the choice between a manual run and a run that goes on by itself. */
const HEADER_KEYS = new Set(['autoComplete']);

/** 自动补到完整 of a coverage run, from its contract: { value } while it can be flipped, else null. */
export function autoToggle(job) {
  const set = contractOf(job).actions.set, item = set.available ? (set.settings || []).find((setting) => setting.key === 'autoComplete') : null;
  return item ? { value: item.value === true } : null;
}

/** The settings of a job in the order the row draws them: [{ key, label, type: 'int' | 'enum' | 'bool', value, min, max, options: [{ value, label }] }].
    `session` (snapshot.model.session) is what 「跟随当前会话」 follows (ui/follow-session.js: the option in the popup names it,
    the closed select says the short words); absent, the option says only that. `env` (the row's, all optional): `groups` (host.modelGroups) and
    `generation` (snapshot.model) for the 模型 of a run, `efforts` (the levels of the model in force) for the levels of its stages. */
export function controlItems(job, session, env = {}) {
  const set = contractOf(job).actions.set;
  if (!set.available) return [];
  return (set.settings || []).filter((setting) => !HEADER_KEYS.has(setting.key)).flatMap((setting) => {
    if (setting.type === 'model') {
      const choices = modelOptions(setting.value, env.groups);
      return choices ? [{ key: setting.key, label: controlLabel(setting.key), type: 'enum', value: setting.value, options: [followModelOption(env.generation), ...choices] }] : [];
    }
    const item = { key: setting.key, label: controlLabel(setting.key), type: setting.type, value: setting.value, min: setting.min, max: setting.max,
      options: setting.type === 'enum' ? setting.values.map((option) => optionOf(setting.key, option, session)) : [] };
    return [setting.key.startsWith('effort') ? effortItem(item, env.efforts, session) : item];
  });
}

/** The model a run's next calls use, as { provider, model }: its own choice, else the generation model in force (`generation`: snapshot.model); null when unknown. */
export function modelInForce(job, generation) {
  const own = modelOfKey((contractOf(job).actions.set.settings || []).find((setting) => setting.key === 'model')?.value);
  return own || (generation?.provider && generation?.model ? { provider: generation.provider, model: generation.model } : null);
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
  if (name === 'pause' && code === 'single-round') return ui(REASON[code]);
  if (name === 'pause' && ['capability-unsupported', 'no-safe-checkpoint'].includes(code)) return ui('这类任务没有可以安全暂停的地方；可以停止，已完成的部分会保留。');
  return ui(REASON[code] || '这个操作现在不可用。');
}

/** The action buttons of the header, from the contract: only what is available is a button. */
export function headerActions(job) {
  const { actions } = contractOf(job);
  return { pause: actions.pause.available, resume: actions.resume.available, cancel: actions.cancel.available, retry: actions.retry.available };
}

/** The wording of "✓ 已生效 · 校对/翻译并发 → 4" for what a reply says is now in force. `items` (the row's controlItems) names a choice as its select does. */
export function appliedText(applied = {}, items = []) {
  const shown = (key, value) => {
    const options = items.find((item) => item.key === key)?.options.flatMap((option) => option.options || [option]) || [];
    const option = options.find((item) => item.value === value);
    return option?.triggerLabel || option?.label || optionLabel(key, value);
  };
  const parts = Object.entries(applied).map(([key, value]) => typeof value === 'boolean' ? uiFormat('{0}：{1}', [controlLabel(key), value ? ui('开') : ui('关')])
    : uiFormat('{0} → {1}', [controlLabel(key), typeof value === 'string' ? shown(key, value) : value]));
  return parts.length ? uiFormat('✓ 已生效 · {0}', [parts.join('；')]) : '';
}

/** What a retry ('retry') or a stop ('cancel') keeps of the work done so far, from the contract: 'completed' (the finished part; also when the contract does not say) or 'nothing' (a job that saves only when it is whole). */
export const keepsOf = (job, name) => (contractOf(job).actions?.[name]?.keeps === 'nothing' ? 'nothing' : 'completed');

/** What a reply to pause / resume / cancel / retry says, in words. `job` (optional) is the job the reply is about: a stop says what it keeps by the job's contract. */
export const actionText = (action, job) => ({ pause: ui('已暂停：新的调用不再开始，跑完正在进行的调用就停'), resume: ui('已继续'),
  cancel: job && keepsOf(job, 'cancel') === 'nothing' ? ui('正在停止；这次不会保存任何结果') : ui('正在停止；已完成的部分会保留'), retry: ui('已接着做') })[action] || '';

/** The words under 接着做: what pressing it does with the work already done (the title of the button), and what an ended job left (the note of 即时控制). */
export const retryTitle = (job) => (keepsOf(job, 'retry') === 'nothing' ? ui('重新开始：会从头读取，已用的模型调用会再次计费') : ui('已完成的部分会直接复用，不会重复付费'));
export const endedNote = (job, interrupted) => (keepsOf(job, 'retry') === 'nothing' ? ui('没有保存任何结果，点「接着做」会从头开始')
  : interrupted ? ui('任务被中断了，已完成的部分都保留着；点「接着做」继续。') : ui('任务没有做完，已出的题都保留着；点「接着做」继续。'));

/**
 * What 存为默认 writes: the action and its arguments, from the values in force, or null when this kind of job has no saved default
 * (a translation job takes its size from the reader, not from a setting).
 */
export function defaultsPatch(job) {
  const items = Object.fromEntries(controlItems(job).map((item) => [item.key, item.value]));
  const pick = (keys) => Object.fromEntries(keys.filter((key) => items[key] !== undefined).map((key) => [key, items[key]]));
  switch (taskKindOf(job)) {
    case 'audio': return { action: 'audio.settings.set', args: pick(['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning']) };
    case 'generation': case 'supplement': return { action: 'settings', args: { generation: pick(['concurrency', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair', 'applySuggestions']) } };
    default: return null;
  }
}
