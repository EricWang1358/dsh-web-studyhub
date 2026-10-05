import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Field, Hint, Select } from './components/index.js';
import { STRENGTH_LABEL, chooseEffort, effortChoices, effortNote } from '../lib/model-effort.js';

/* Reasoning strength of the audio text steps. One control per setting: a select whose options are the levels the model in use
   offers (its own names) plus "model default". The saved value is a relative strength (lib/model-effort.js); when the model has
   no level of that strength the nearest one is used and the card says so here, never silently. */

/** The sentence that explains how a saved strength is met by this model, or '' when it is met exactly. */
export function effortNoteText(note) {
  if (!note) return '';
  return note.reason === 'unsupported'
    ? uiFormat('当前模型没有可调的推理强度，「{0}」不起作用，按模型默认运行', [ui(note.wanted)])
    : uiFormat('当前模型没有「{0}」，已用「{1}」', [ui(note.wanted), note.used]);
}

/**
 * A select for one reasoning preference. `efforts` is the model's list ([{ id, name }]) or null while it is not known yet.
 * `description` is the line under the label (the measured timing, for the audio steps).
 */
export function EffortSelect({ label, value, efforts = null, busy = false, onChange, description, className }) {
  const known = Array.isArray(efforts);
  const choices = effortChoices(known ? efforts : []);
  const options = choices.map(choice => ({ value: choice.value, label: choice.value === 'default' ? ui('模型默认') : choice.name }));
  // A saved strength this model does not offer stays visible as what it is, so the select never shows a level that is not the one in force.
  if (!choices.some(choice => choice.value === value)) options.push({ value, label: ui(STRENGTH_LABEL[value] || value) });
  const note = known ? effortNote(chooseEffort(efforts, value)) : null;
  return <div className={className}>
    <Field label={label} hint={description}>
      <Select value={value} disabled={busy} onChange={event => onChange(event.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    </Field>
    {note && <Hint className="audio-effort-note" tone="warning">{effortNoteText(note)}</Hint>}
  </div>;
}

export default function AudioReasoning({ settings, busy, onSave, timings = [], efforts = null, modelName = '' }) {
  const proof = settings.proofreadReasoning || 'default', translation = settings.translateReasoning || 'low';
  const sample = (stage, level) => {
    const summary = timings.find(item => item.stage === stage);
    const value = summary?.byReasoning?.[level] || summary;
    return value?.averageMs == null ? ui('等待耗时样本') : uiFormat('{0}s · {1} 次近七日样本', [(value.averageMs / 1000).toFixed(1), value.count]);
  };
  return <section className="audio-reasoning" aria-labelledby="audio-reasoning-title">
    <div className="audio-section-title"><div><small>{ui('时间 × 精度倾向')}</small><h3 id="audio-reasoning-title">{ui('校对与翻译的推理强度')}</h3></div><span>{ui('用于下一次处理')}</span></div>
    <div className="audio-reasoning-fields">
      <EffortSelect label={ui('校正')} value={proof} efforts={efforts} busy={busy} description={sample('proofread', proof)} onChange={value => onSave({ proofreadReasoning: value })} />
      <EffortSelect label={ui('翻译')} value={translation} efforts={efforts} busy={busy} description={sample('translate', translation)} onChange={value => onSave({ translateReasoning: value })} />
      <Hint>{modelName ? uiFormat('档位来自当前模型 {0}。高推理通常花更长时间；换模型后，同样的倾向会对应到新模型最接近的档位，并在这里说明。', [modelName])
        : ui('档位来自当前模型。高推理通常花更长时间；换模型后，同样的倾向会对应到新模型最接近的档位，并在这里说明。')}</Hint>
    </div>
  </section>;
}
