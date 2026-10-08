import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Field, Hint, Select } from './components/index.js';
import { STRENGTH_LABEL, chooseEffort, effortChoices, effortNote } from '../lib/model-effort.js';
import { followOption } from './follow-session.js';

/* The one control for a reasoning preference: the audio settings (校正, 翻译, 课堂校正) and the per-stage levels of 出题偏好 are all this select.
   Its options are the levels the model in use offers (its own names) plus "model default" (and, for generation, "follow the session").
   The saved value is a relative strength (lib/model-effort.js). When the model has no level of that strength the select shows the level that
   is really used and the note names the preference the learner chose, so the control never shows a level that is not in force (#227);
   a model that has the level again gets the saved preference back. */

/** The sentence that explains how a saved strength is met by this model, or '' when it is met exactly. */
export function effortNoteText(note) {
  if (!note) return '';
  return note.reason === 'unsupported'
    ? uiFormat('当前模型没有可调的推理强度，「{0}」不起作用，按模型默认运行', [ui(note.wanted)])
    : uiFormat('你之前选的「{0}」，当前模型没有，已用「{1}」', [ui(note.wanted), note.used]);
}

/**
 * What the reasoning setting did for one task or generation step, in plain words, or '' when it did exactly what was asked (or nothing was asked).
 * `reasoning` is the strength asked for; the model may have had no such level (lib/model-effort.js says which one it used instead).
 */
export function reasoningNote(task) {
  const wanted = task.reasoning;
  if (!wanted || wanted === 'default' || wanted === 'follow') return '';
  const asked = ui(STRENGTH_LABEL[wanted] || wanted);
  if (task.reasoningReason === 'nearest' && task.reasoningName) return uiFormat('推理强度：要求「{0}」，当前模型没有，已用「{1}」', [asked, task.reasoningName]);
  if (task.reasoningReason === 'unsupported' || (!task.reasoningReason && task.reasoningEffort === 'default'))
    return uiFormat('推理强度：要求「{0}」，当前模型没有可调档位，按模型默认', [asked]);
  return '';
}

/**
 * What the select of one preference offers and shows (pure; this select and the per-stage levels of the 即时控制 row draw it): `options`, the value
 * `shown` (the level in force) and the `note` when the model cannot meet the preference exactly (effortNote, or null).
 */
export function effortSelectModel({ value, efforts = null, follow = false, session }) {
  const known = Array.isArray(efforts);
  const choices = effortChoices(known ? efforts : []);
  const options = [...(follow ? [followOption(session)] : []),
    ...choices.map(choice => ({ value: choice.value, label: choice.value === 'default' ? ui('模型默认') : choice.name }))];
  const choice = known && value !== 'follow' ? chooseEffort(efforts, value) : null;
  // The level in force, not the one the model lacks: the select shows what will be used.
  const shown = choice && !choice.exact ? choice.applied : value;
  // Before the levels are known the saved strength stays visible as what it is.
  if (!options.some(option => option.value === shown)) options.push({ value: shown, label: ui(STRENGTH_LABEL[shown] || shown) });
  return { options, shown, note: choice ? effortNote(choice) : null };
}

/**
 * A select for one reasoning preference. `efforts` is the model's list ([{ id, name }]) or null while it is not known yet.
 * `description` is the line under the label (the measured timing, for the audio steps). `follow` adds the choice "follow the session"
 * (value 'follow'; generation only): it is a choice of its own and is never mapped onto a level; `session` (snapshot.model.session) says which model and
 * level it follows: the popup names them in full, the closed select says only 「跟随当前会话」 and carries the rest in a tooltip (ui/follow-session.js).
 */
export function EffortSelect({ label, value, efforts = null, disabled = false, onChange, description, className, name, follow = false, session, error }) {
  const { options, shown, note } = effortSelectModel({ value, efforts, follow, session });
  return <div className={['effort-select', className].filter(Boolean).join(' ')}>
    <Field label={label} hint={description} error={error}>
      <Select name={name} value={shown} disabled={disabled} onChange={onChange} options={options} />
    </Field>
    {note && <Hint className="effort-select__note" tone="warning">{effortNoteText(note)}</Hint>}
  </div>;
}
