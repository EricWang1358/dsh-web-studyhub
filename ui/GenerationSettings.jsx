import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { Button, Checkbox, Disclosure, Field, Hint, NumberInput, Select, SettingsSection, TextArea, Tooltip, useToast } from './components/index.js';
import KindPicker from './KindPicker.jsx';
import { COVERAGE_LEVELS, difficultyNote, kindNote, kindsPatch, levelNote, notationNote } from './generate-form.js';
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_SETTINGS_LIMITS, GENERATION_LANGUAGES,
  GENERATION_DIFFICULTIES, GENERATION_NOTATIONS, UNLIMITED_TIMEOUT_KEYS, clampConcurrency, effectiveConcurrencyLimit, normalizeGenerationSettings, validateGenerationPatch } from '../lib/generation-settings.js';
import { lightModelOf, modelKey } from '../lib/job-model.js';
import { writesInOnePass } from '../lib/one-pass/route.js';
import { DEPTHS, depthOf, performanceOfDepth } from '../lib/contexts/generation/presets.js';
import { depthHint, depthOption, depthTip } from './presets/depth-copy.js';
import { EFFORT_STAGES, effortKey } from '../lib/stage-effort.js';
import { EffortSelect } from './EffortSelect.jsx';
import { useStudy } from './study-context.jsx';
import { drawnScale } from './drawn-scale.js';

const labels = { kinds: '默认题型', coverageLevel: '默认覆盖强度', selectionCount: '选段补题默认题数', count: '主会话里出题的默认题数', language: '默认语言', difficulty: '默认难度', focus: '默认侧重点', notation: '默认公式写法',
  concurrency: '同时生成的批数', batchSize: '每批题数', jobTimeoutMinutes: '每轮运行时限（分钟）', bookCallTimeoutMinutes: '总纲与全书单次调用时限（分钟）', fillRounds: '自动补题轮数',
  effortPlanning: '规划考点与答案设计', effortReview: '独立审阅', effortWriting: '出题与替换题', effortRepair: '修复题目',
  lightModel: '机械步骤轻量模型', applySuggestions: '采纳审阅建议', depth: '出题深度' };
const languages = { auto: '跟随界面语言', 中文: '中文', English: 'English', 中英双语: '中英双语' };
const difficulties = { mixed: '混合难度', foundation: '基础理解', application: '应用迁移', advanced: '深入辨析' };
const notations = { auto: '自动', text: '纯文本', latex: '公式（LaTeX）' };
const numeric = ['selectionCount', 'count', 'concurrency', 'batchSize', 'jobTimeoutMinutes', 'bookCallTimeoutMinutes', 'fillRounds'];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const numbers = values => ({ ...values, ...Object.fromEntries(numeric.map(key =>
  [key, typeof values[key] === 'string' && !values[key].trim() ? NaN : Number(values[key])])) });

function lightModelOptions(value, groups) {
  const lists = (Array.isArray(groups) ? groups : []).filter(group => group?.id && Array.isArray(group.models) && group.models.length);
  const chosen = lightModelOf(value);
  const listed = chosen && lists.some(group => group.id === chosen.provider && group.models.some(model => model.id === chosen.model));
  return [
    { value: '', label: ui('跟随出题模型（低推理）') },
    ...lists.map(group => ({ group: group.name || group.id,
      options: group.models.map(model => ({ value: modelKey({ provider: group.id, model: model.id }), label: model.name || model.id })) })),
    ...(chosen && !listed ? [{ value: modelKey(chosen), label: `${chosen.provider} / ${chosen.model}` }] : []),
  ];
}

/** Preserve unfinished numeric input in the form, but validate the exact shared contract before saving. */
export function generationFormErrors(values, options) {
  const checked = numbers(values), errors = {};
  for (const key of Object.keys(GENERATION_SETTINGS_DEFAULTS)) {
    try { validateGenerationPatch({ [key]: checked[key] }, options); }
    catch {
      const limit = key === 'concurrency' ? effectiveConcurrencyLimit(options) : GENERATION_SETTINGS_LIMITS[key];
      errors[key] = UNLIMITED_TIMEOUT_KEYS.includes(key) ? uiFormat('请输入 {0}–{1} 的整数，或填 0 表示无上限。', [limit.min, limit.max])
        : numeric.includes(key) ? uiFormat('请输入 {0}–{1} 的整数。', [limit.min, limit.max])
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
export function GenerationSettingsForm({ root, saved, efforts = null, session, modelGroups }) {
  const { busy, act, host } = useStudy();
  const toast = useToast();
  const capOptions = host?.maxConcurrency !== undefined ? { maxConcurrency: host.maxConcurrency, defaultConcurrency: host.defaultConcurrency } : undefined;
  const savedKey = JSON.stringify(normalizeGenerationSettings(saved, capOptions));
  const [editor, setEditor] = useState(() => ({ observed: savedKey, baseline: JSON.parse(savedKey), values: JSON.parse(savedKey) }));
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const scope = useRef({ root, live: true }), version = useRef(0), pending = useRef(null), formRef = useRef(null), saveRef = useRef(null);
  useEffect(() => {
    const owner = { root, live: true }; scope.current = owner;
    return () => { owner.live = false; };
  }, [root]);
  useEffect(() => {
    const incoming = JSON.parse(savedKey);
    setEditor(current => current.observed === savedKey ? current : { observed: savedKey, baseline: incoming,
      values: same(numbers(current.values), current.baseline) ? incoming : current.values });
  }, [savedKey]);
  const edit = (key, value, also = {}) => {
    version.current++; setError('');
    setEditor(current => ({ ...current, values: { ...current.values, [key]: value, ...also } }));
  };
  const reset = () => {
    version.current++; setError('');
    setEditor(current => ({ ...current, values: { ...GENERATION_SETTINGS_DEFAULTS, concurrency: clampConcurrency(undefined, capOptions) } }));
  };
  const errors = generationFormErrors(editor.values, capOptions), invalid = Object.keys(errors).length > 0;
  const dirty = !same(numbers(editor.values), editor.baseline), disabled = busy || working;
  const advancedKeys = ['concurrency', 'batchSize', 'jobTimeoutMinutes', 'bookCallTimeoutMinutes', 'fillRounds', 'lightModel', ...EFFORT_STAGES.map(effortKey)];
  const advancedHasError = advancedKeys.some(key => Boolean(errors[key]));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => { if (advancedHasError) setAdvancedOpen(true); }, [advancedHasError]);
  useEffect(() => {
    if (!dirty || typeof document === 'undefined') return;
    const active = document.activeElement, bar = saveRef.current;
    if (!active || !bar || !formRef.current?.contains(active)) return;
    const fieldBox = (active.closest?.('.sh-field') || active).getBoundingClientRect(), barBox = bar.getBoundingClientRect();
    if (barBox.height > 0 && fieldBox.bottom > barBox.top - 12) {
      let node = formRef.current.parentElement;
      while (node && !(node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
      (node || document.scrollingElement)?.scrollBy?.({ top: (fieldBox.bottom - barBox.top) / drawnScale(bar, barBox) + 16 });
    }
  }, [dirty]);
  const save = async event => {
    event.preventDefault();
    if (busy || pending.current || invalid || !dirty || typeof act !== 'function') return;
    const owner = scope.current, revision = version.current, operation = {};
    const generation = validateGenerationPatch(numbers(editor.values), capOptions);
    pending.current = operation; setWorking(true); setError('');
    const current = () => owner.live && owner.root === root && scope.current === owner && pending.current === operation;
    try {
      await act('settings', { generation }, (result, context) => {
        if (!current() || context?.isCurrent?.() === false) return;
        const next = normalizeGenerationSettings(result.generation, capOptions);
        setEditor(previous => ({ ...previous, baseline: next, values: version.current === revision ? next : previous.values }));
        toast.success(ui(version.current === revision ? '出题偏好已保存' : '出题偏好已保存；后续修改尚未保存。'));
      }, { rethrow: true });
    } catch (cause) { if (current()) setError(errorMessage(cause)); }
    finally { if (current()) { pending.current = null; setWorking(false); } }
  };
  // The time limit is also a deep link: the 任务 page's 调整时限 opens Settings at this field (ui/tasks/time-limit.js LIMIT_ANCHOR).
  const field = (key, control, note, group = false) => <Field key={key} label={ui(labels[key])} hint={note} error={errors[key]} group={group} {...(key === 'jobTimeoutMinutes' ? { 'data-tour': 'settings-generation-time' } : {})}>{control}</Field>;
  const propsFor = key => ({ name: key, value: editor.values[key], disabled, onChange: event => edit(key, event.target.value) });
  const numberField = (key, note) => {
    const limit = key === 'concurrency' ? effectiveConcurrencyLimit(capOptions) : GENERATION_SETTINGS_LIMITS[key];
    const min = UNLIMITED_TIMEOUT_KEYS.includes(key) ? 0 : limit.min;
    return field(key, <NumberInput {...propsFor(key)} required inputMode="numeric" step="1" min={min} max={limit.max} />, note);
  };
  const timeoutField = (key, note) => {
    const isUnlimited = Number(editor.values[key]) === 0 && String(editor.values[key]).trim() !== '';
    return numberField(key, <><span>{note}</span>{' '}<Button variant="link" size="sm" disabled={disabled || isUnlimited} onClick={() => edit(key, 0)}>{ui(isUnlimited ? '当前：无上限' : '设为无上限')}</Button></>);
  };
  const choiceField = (key, choices, label, note) => field(key, <Select {...propsFor(key)} onChange={value => edit(key, value)} options={choices.map(value => ({ value, label: label(value) }))} />, note);
  const availableGroups = modelGroups ?? host?.modelGroups;
  const hasModelGroups = Array.isArray(availableGroups) && availableGroups.some(group => group?.id && Array.isArray(group.models) && group.models.length > 0);
  const showLightModel = hasModelGroups || Boolean(lightModelOf(editor.values.lightModel));
  const canChat = host?.capabilities?.chat !== false;
  const showStageEfforts = canChat || (Array.isArray(efforts) && efforts.length > 0);
  const concurrencyLimit = effectiveConcurrencyLimit(capOptions);
  const concurrencyDefault = clampConcurrency(undefined, capOptions);
  const concurrencyCapped = concurrencyLimit.max < GENERATION_SETTINGS_LIMITS.concurrency.max;
  const withRange = (min, max, fallback, note) => uiFormat('范围 {0}–{1}（默认 {2}）。{3}', [min, max, fallback, note]);
  const concurrencyHint = concurrencyCapped
    ? uiFormat('范围 {0}–{1}（默认 {2}）。当前本机 CLI 接入将并发上限限制为 {1}，避免并发过高导致限流或排队超时。', [concurrencyLimit.min, concurrencyLimit.max, concurrencyDefault])
    : withRange(concurrencyLimit.min, concurrencyLimit.max, concurrencyDefault, ui('同时处理更多批次通常更快；服务容易限流时可以调低。'));
  return <form ref={formRef} className="settings-form" onSubmit={save}>
    <SettingsSection className="generation-settings" tour="settings-generation" disabled={disabled} title={ui('出题偏好')}
      lead={ui('保存在当前学习库，作为新出题任务的默认值。每次出题时仍可单独调整；已开始的任务不受影响。')}>
      {field('kinds', <KindPicker name="kinds" value={editor.values.kinds} disabled={disabled} onChange={list => edit('kinds', list, kindsPatch(list))} />,
        kindNote(editor.values.kinds, undefined, undefined, { canChat }), true)}
      {/* The one default the 创建题组 page plans by (it also decides whether the rounds go on by themselves); selectionCount is for reader passage supplements, and count below is for main-chat requests without a level. */}
      {field('coverageLevel', <Select {...propsFor('coverageLevel')} onChange={value => edit('coverageLevel', value)} options={COVERAGE_LEVELS.map(({ value, label }) => ({ value, label }))} />,
        levelNote(editor.values.coverageLevel, { onePass: writesInOnePass({ kinds: editor.values.kinds, performance: editor.values }) }))}
      {numberField('selectionCount', ui('在资料阅读器里选中一段文字「补充到现有题组」时的默认题数；每次补题仍可在「更多设置」里临时调整。'))}
      {choiceField('language', GENERATION_LANGUAGES, value => ui(languages[value]))}
      {choiceField('difficulty', GENERATION_DIFFICULTIES, value => ui(difficulties[value]), difficultyNote(editor.values.difficulty))}
      {choiceField('notation', GENERATION_NOTATIONS, value => ui(notations[value]), notationNote())}
      {field('focus', <TextArea {...propsFor('focus')} rows={3} maxLength={GENERATION_SETTINGS_LIMITS.focus.max}
        placeholder={ui('例如：重点解释成立条件，再比较相似概念。')} />, ui('可留空；这次出题的侧重点可以覆盖这里的默认值。'))}
      {canChat && numberField('count', ui('只在让助手在主会话里出题、又没说题数时用；创建题组页按「覆盖强度」出题，不用它。与每批题数分别设置。'))}
      <Disclosure className="settings-disclosure" summaryClassName="settings-disclosure__summary" bodyClassName="settings-disclosure__body"
        summary={ui('高级生成控制')} meta={ui('并发、批次、推理程度与审阅')} open={advancedOpen} onToggle={setAdvancedOpen}>
        <h3 className="settings-subtitle">{ui('生成安排')}</h3>
        {/* 出题深度 (lib/contexts/generation/presets.js): ONE control for the saved strategy and write style (快问 / 情境题 / 逐题精出); a saved strategy reads as its depth. */}
        <Field key="depth" label={ui(labels.depth)} hint={depthHint()} error={errors.strategy || errors.writeStyle}>
          {({ id, describedBy }) => <Tooltip layer content={depthTip()}>
            <Select id={id} aria-describedby={describedBy} name="depth" value={depthOf(editor.values)} disabled={disabled}
              onChange={value => { const { strategy, writeStyle } = performanceOfDepth(value); edit('strategy', strategy, { writeStyle }); }}
              options={DEPTHS.map(value => ({ value, label: depthOption(value) }))} />
          </Tooltip>}
        </Field>
        {numberField('concurrency', concurrencyHint)}
        {numberField('batchSize', withRange(GENERATION_SETTINGS_LIMITS.batchSize.min, GENERATION_SETTINGS_LIMITS.batchSize.max, GENERATION_SETTINGS_DEFAULTS.batchSize, ui('小批更早保存已核验题目，但会增加调用次数。')))}
        {timeoutField('jobTimeoutMinutes', withRange(GENERATION_SETTINGS_LIMITS.jobTimeoutMinutes.min, GENERATION_SETTINGS_LIMITS.jobTimeoutMinutes.max, GENERATION_SETTINGS_DEFAULTS.jobTimeoutMinutes, ui('从这一轮开始运行计时，不含排队；填 0 表示无上限。出题计划的每一轮各自计时，整个计划没有总时限；一轮用时较长（慢模型）可以调到 180 分钟或设为无上限。达到时限会保留已核验题目。')))}
        {timeoutField('bookCallTimeoutMinutes', ui('整理总纲、清点资料与生成复习全书时，单次模型调用的时长上限；默认 0（无上限，只要模型持续输出就不截断，连续 3 分钟完全没有输出仍会自动截断）。需要限制单次耗时可设为 3–180 分钟。'))}
        {numberField('fillRounds', withRange(GENERATION_SETTINGS_LIMITS.fillRounds.min, GENERATION_SETTINGS_LIMITS.fillRounds.max, GENERATION_SETTINGS_DEFAULTS.fillRounds, ui('题数不够时自动再补几轮，每轮只补缺的题，并避开已被拒绝的考点；填 0 表示不自动补。')))}
        <h3 className="settings-subtitle">{ui('各阶段的推理程度')}</h3>
        {showStageEfforts ? <>
          <Hint>{ui('规划和审阅决定题目对不对，值得多想；按答案设计写题、写替换题和改措辞可以少想，更快也更省。按模型实际提供的档位取最接近的一档，没有对应档位时会在生成详情里注明。')}</Hint>
          {EFFORT_STAGES.map(stage => <EffortSelect key={stage} follow={canChat ? true : 'model'} session={session} name={effortKey(stage)} label={ui(labels[effortKey(stage)])} value={editor.values[effortKey(stage)]}
            efforts={efforts} disabled={disabled} error={errors[effortKey(stage)]} onChange={value => edit(effortKey(stage), value)} />)}
        </> : <Hint>{ui('当前模型暂不支持按出题阶段单独调整推理强度；如使用本机 CLI 模型，可在「学习库与模型」里统一设置推理强度。')}</Hint>}
        {showLightModel && field('lightModel', <Select {...propsFor('lightModel')} onChange={value => edit('lightModel', value)}
          options={lightModelOptions(editor.values.lightModel, availableGroups)} />,
          ui('可选：给评估小节权重、修补措辞等简单步骤单独换更快更省的模型；规划、出题和审阅仍用主出题模型以保证质量。'))}
        <h3 className="settings-subtitle">{ui('审阅建议')}</h3>
        <Checkbox name="applySuggestions" label={ui(labels.applySuggestions)} checked={editor.values.applySuggestions === true} disabled={disabled}
          hint={ui('审阅已通过、但附了优化建议的题，多花一次改写和一次复核来采纳建议；复核不过就保持原题。会多用 token 和时间，默认关闭；任务运行中也可以在「即时控制」里随时开关。')}
          onChange={value => edit('applySuggestions', value === true)} />
      </Disclosure>
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div ref={saveRef} className="generation-settings__save" data-dirty={dirty ? 'true' : undefined}>
        <div className="settings-actions">
          <Button variant="primary" type="submit" busy={working} disabled={busy || !dirty || invalid}>{ui('保存出题偏好')}</Button>
          <Button disabled={disabled} onClick={reset}>{ui('恢复默认值（待保存）')}</Button>
        </div>
        <Hint role="status">{ui(dirty ? '有未保存的修改；保存后用于新的出题任务。' : '更改这些偏好不会自动开始出题。')}</Hint>
      </div>
    </SettingsSection>
  </form>;
}
