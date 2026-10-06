import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { Button, Field, Hint, NumberInput, Select, SettingsSection, TextArea, useToast } from './components/index.js';
import { kinds } from './shared.js';
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_SETTINGS_LIMITS, GENERATION_KINDS, GENERATION_LANGUAGES,
  GENERATION_DIFFICULTIES, GENERATION_NOTATIONS, normalizeGenerationSettings, validateGenerationPatch } from '../lib/generation-settings.js';
import { EFFORT_STAGES, effortKey } from '../lib/stage-effort.js';
import { EffortSelect } from './EffortSelect.jsx';

const labels = { kind: '默认题型', count: '默认题数', language: '默认语言', difficulty: '默认难度', focus: '默认侧重点', notation: '默认公式写法',
  concurrency: '同时生成的批数', batchSize: '每批题数', jobTimeoutMinutes: '每轮运行时限（分钟）', fillRounds: '自动补题轮数',
  effortPlanning: '规划考点与答案设计', effortReview: '独立审阅', effortWriting: '出题与替换题', effortRepair: '修复题目' };
const languages = { auto: '跟随界面语言', 中文: '中文', English: 'English', 中英双语: '中英双语' };
const difficulties = { mixed: '混合难度', foundation: '基础理解', application: '应用迁移', advanced: '深入辨析' };
const notations = { auto: '自动', text: '纯文本', latex: '公式（LaTeX）' };
const numeric = ['count', 'concurrency', 'batchSize', 'jobTimeoutMinutes', 'fillRounds'];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const numbers = values => ({ ...values, ...Object.fromEntries(numeric.map(key =>
  [key, typeof values[key] === 'string' && !values[key].trim() ? NaN : Number(values[key])])) });

/** Preserve unfinished numeric input in the form, but validate the exact shared contract before saving. */
export function generationFormErrors(values) {
  const checked = numbers(values), errors = {};
  for (const key of Object.keys(GENERATION_SETTINGS_DEFAULTS)) {
    try { validateGenerationPatch({ [key]: checked[key] }); }
    catch {
      const limit = GENERATION_SETTINGS_LIMITS[key];
      errors[key] = numeric.includes(key) ? uiFormat('请输入 {0}–{1} 的整数。', [limit.min, limit.max])
        : key === 'focus' ? uiFormat('侧重点最多 {0} 个字符。', [limit.max]) : ui('请选择一个支持的选项。');
    }
  }
  return errors;
}

/** A library switch mounts a fresh editor, so an old save never owns the new library's form. */
export default function GenerationSettings(props) {
  return <GenerationSettingsForm key={props.root} {...props} />;
}

/** `efforts` are the reasoning levels of the model in use ([{ id, name }], null until known): the stage selects offer those, like the audio settings. */
export function GenerationSettingsForm({ root, saved, busy = false, act, efforts = null }) {
  const toast = useToast();
  const savedKey = JSON.stringify(normalizeGenerationSettings(saved));
  const [editor, setEditor] = useState(() => ({ observed: savedKey, baseline: JSON.parse(savedKey), values: JSON.parse(savedKey) }));
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const scope = useRef({ root, live: true }), version = useRef(0), pending = useRef(null);
  useEffect(() => {
    const owner = { root, live: true }; scope.current = owner;
    return () => { owner.live = false; };
  }, [root]);
  useEffect(() => {
    const incoming = JSON.parse(savedKey);
    setEditor(current => current.observed === savedKey ? current : { observed: savedKey, baseline: incoming,
      values: same(numbers(current.values), current.baseline) ? incoming : current.values });
  }, [savedKey]);
  const edit = (key, value) => {
    version.current++; setError('');
    setEditor(current => ({ ...current, values: { ...current.values, [key]: value } }));
  };
  const reset = () => {
    version.current++; setError('');
    setEditor(current => ({ ...current, values: { ...GENERATION_SETTINGS_DEFAULTS } }));
  };
  const errors = generationFormErrors(editor.values), invalid = Object.keys(errors).length > 0;
  const dirty = !same(numbers(editor.values), editor.baseline), disabled = busy || working;
  const save = async event => {
    event.preventDefault();
    if (busy || pending.current || invalid || !dirty || typeof act !== 'function') return;
    const owner = scope.current, revision = version.current, operation = {};
    const generation = validateGenerationPatch(numbers(editor.values));
    pending.current = operation; setWorking(true); setError('');
    const current = () => owner.live && owner.root === root && scope.current === owner && pending.current === operation;
    try {
      await act('settings', { generation }, (result, context) => {
        if (!current() || context?.isCurrent?.() === false) return;
        const next = normalizeGenerationSettings(result.generation);
        setEditor(previous => ({ ...previous, baseline: next, values: version.current === revision ? next : previous.values }));
        toast.success(ui(version.current === revision ? '出题偏好已保存' : '出题偏好已保存；后续修改尚未保存。'));
      }, { rethrow: true });
    } catch (cause) { if (current()) setError(errorMessage(cause)); }
    finally { if (current()) { pending.current = null; setWorking(false); } }
  };
  // The time limit is also a deep link: the 任务 page's 调整时限 opens Settings at this field (ui/tasks/time-limit.js LIMIT_ANCHOR).
  const field = (key, control, note) => <Field key={key} label={ui(labels[key])} hint={note} error={errors[key]} {...(key === 'jobTimeoutMinutes' ? { 'data-tour': 'settings-generation-time' } : {})}>{control}</Field>;
  const propsFor = key => ({ name: key, value: editor.values[key], disabled, onChange: event => edit(key, event.target.value) });
  const numberField = (key, note) => field(key, <NumberInput {...propsFor(key)} required inputMode="numeric" step="1"
    min={GENERATION_SETTINGS_LIMITS[key].min} max={GENERATION_SETTINGS_LIMITS[key].max} />, note);
  const choiceField = (key, choices, label) => field(key, <Select {...propsFor(key)} onChange={value => edit(key, value)} options={choices.map(value => ({ value, label: label(value) }))} />);
  return <form className="settings-form" onSubmit={save}>
    <SettingsSection className="generation-settings" tour="settings-generation" disabled={disabled} title={ui('出题偏好')}
      lead={ui('保存在当前学习库，作为新出题任务的默认值。每次出题时仍可单独调整；已开始的任务不受影响。')}>
      {choiceField('kind', GENERATION_KINDS, value => value === 'mixed' ? ui('测验 + 闪卡') : kinds[value])}
      {numberField('count', ui('没有指定覆盖强度时（例如让助手在对话里出题）一次请求的总题数；创建题组页按「覆盖强度」出题，不用它。与每批题数分别设置。'))}
      {choiceField('language', GENERATION_LANGUAGES, value => ui(languages[value]))}
      {choiceField('difficulty', GENERATION_DIFFICULTIES, value => ui(difficulties[value]))}
      {choiceField('notation', GENERATION_NOTATIONS, value => ui(notations[value]))}
      {field('focus', <TextArea {...propsFor('focus')} rows={3} maxLength={GENERATION_SETTINGS_LIMITS.focus.max}
        placeholder={ui('例如：重点解释成立条件，再比较相似概念。')} />, ui('可留空；这次出题的侧重点可以覆盖这里的默认值。'))}
      <h3 className="settings-subtitle">{ui('生成安排')}</h3>
      {numberField('concurrency', ui('同时处理更多批次通常更快；服务容易限流时可以调低。'))}
      {numberField('batchSize', ui('小批更早保存已核验题目，但会增加调用次数。'))}
      {numberField('jobTimeoutMinutes', ui('从这一轮开始运行计时，不含排队。出题计划的每一轮各自计时，整个计划没有总时限；一轮用时较长（慢模型）可以调到 180 分钟。达到时限会保留已核验题目。'))}
      {numberField('fillRounds', ui('题数不够时自动再补几轮，每轮只补缺的题，并避开已被拒绝的考点；填 0 表示不自动补。'))}
      <h3 className="settings-subtitle">{ui('各阶段的推理程度')}</h3>
      <Hint>{ui('规划和审阅决定题目对不对，值得多想；按答案设计写题、写替换题和改措辞可以少想，更快也更省。按模型实际提供的档位取最接近的一档，没有对应档位时会在生成详情里注明。')}</Hint>
      {EFFORT_STAGES.map(stage => <EffortSelect key={stage} follow name={effortKey(stage)} label={ui(labels[effortKey(stage)])} value={editor.values[effortKey(stage)]}
        efforts={efforts} disabled={disabled} error={errors[effortKey(stage)]} onChange={value => edit(effortKey(stage), value)} />)}
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div className="settings-actions">
        <Button variant="primary" type="submit" busy={working} disabled={busy || !dirty || invalid}>{ui('保存出题偏好')}</Button>
        <Button disabled={disabled} onClick={reset}>{ui('恢复默认值（待保存）')}</Button>
      </div>
      <Hint role="status">{ui(dirty ? '有未保存的修改；保存后用于新的出题任务。' : '更改这些偏好不会自动开始出题。')}</Hint>
    </SettingsSection>
  </form>;
}
