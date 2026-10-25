import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Dialog, Field, IconButton, TextArea, TextInput } from '../components/index.js';
import { PAGE_INTENTS } from './QuickIntents.jsx';
import { addCustomPreset, PRESET_NAME_MAX, PRESET_PROMPT_MAX, presetShown, removeCustomPreset, setPresetShown, updateCustomPreset, validatePreset } from './reader/page-presets.js';

/*
 * The presets of 按页提问 (issue #485): the four built-ins, which keep their exact wording and can only be hidden, and the learner's own,
 * which are added, edited, hidden and deleted here. A row is a checkbox with the question it sends under the name; what is checked
 * appears under the question box, and a click asks with that prompt exactly as written. Kept in this browser only (reader/page-presets.js).
 */

/** What a validation code says, in the language of the interface. */
function reasonOf(found, code) {
  if (code === 'name-required') return ui('请给这个预设起个名字。');
  if (code === 'name-long') return uiFormat('名称最多 {0} 个字。', [PRESET_NAME_MAX]);
  if (code === 'name-duplicate') return uiFormat('已经有一个叫「{0}」的预设：换个名字，或者先改那一个。', [found.duplicate || '']);
  if (code === 'prompt-required') return ui('提示词不能为空。');
  if (code === 'prompt-long') return uiFormat('提示词最多 {0} 个字。', [PRESET_PROMPT_MAX]);
  return undefined;
}

/** presets: as reader/page-presets.js keeps them; onChange(next) keeps them with the panel; onClose() unmounts the dialog. */
export default function PagePresets({ presets, onChange, onClose }) {
  // The preset being added (no id yet) or edited, and what the last save found wrong with it.
  const [draft, setDraft] = useState(null), [found, setFound] = useState({});
  const begin = item => { setFound({}); setDraft(item || { id: '', name: '', prompt: '' }); };
  const cancel = () => { setFound({}); setDraft(null); };
  const change = patch => { setFound({}); setDraft(current => ({ ...current, ...patch })); };
  const save = event => {
    event.preventDefault();
    const problems = validatePreset(draft, presets.custom, draft.id);
    setFound(problems);
    if (problems.name || problems.prompt) return;
    onChange(draft.id ? updateCustomPreset(presets, draft.id, draft) : addCustomPreset(presets, draft));
    cancel();
  };
  const remove = id => { setFound({}); if (draft?.id === id) cancel(); onChange(removeCustomPreset(presets, id)); };
  const row = ({ id, label, question, own, onEdit, onDelete }) => <li key={id} className="study-page-presets__row">
    <Checkbox className="study-page-presets__choice" label={label} hint={question} checked={presetShown(presets, id)}
      onChange={shown => onChange(setPresetShown(presets, id, shown))} />
    {own && <span className="study-page-presets__actions">
      <IconButton icon="edit" size="sm" label={uiFormat('编辑「{0}」', [label])} onClick={onEdit} />
      <IconButton icon="trash" size="sm" label={uiFormat('删除「{0}」', [label])} onClick={onDelete} />
    </span>}
  </li>;
  return <Dialog title={ui('按页提问的预设')} size="md" onClose={onClose}
    description={ui('勾选的预设出现在问题框下面，点一下就直接发出它的提示词。内置的四个不能改、不能删，只能隐藏；你自己的预设只保存在这个浏览器里。')}
    footer={<Button variant="primary" onClick={onClose}>{ui('完成')}</Button>}>
    <div className="study-page-presets">
      <section className="study-page-presets__group" aria-label={ui('内置预设')}>
        <h3 className="study-page-presets__title">{ui('内置预设')}</h3>
        <ul className="study-page-presets__list">{PAGE_INTENTS.map(chip => row({ id: chip.intent, label: ui(chip.label), question: ui(chip.question) }))}</ul>
      </section>
      <section className="study-page-presets__group" aria-label={ui('我的预设')}>
        <h3 className="study-page-presets__title">{ui('我的预设')}</h3>
        {presets.custom.length > 0 && <ul className="study-page-presets__list">{presets.custom.map(item => row({ id: item.id, label: item.name, question: item.prompt, own: true,
          onEdit: () => begin(item), onDelete: () => remove(item.id) }))}</ul>}
        {!presets.custom.length && !draft && <p className="muted">{ui('还没有自己的预设。')}</p>}
        {draft ? <form className="study-page-presets__form" onSubmit={save}>
          <Field label={ui('名称')} hint={uiFormat('最多 {0} 个字。', [PRESET_NAME_MAX])} error={reasonOf(found, found.name)}>
            <TextInput value={draft.name} maxLength={PRESET_NAME_MAX} autoFocus onChange={event => change({ name: event.target.value })} />
          </Field>
          <Field label={ui('提示词')} hint={uiFormat('点这个预设时原样发出，最多 {0} 个字。', [PRESET_PROMPT_MAX])} error={reasonOf(found, found.prompt)}>
            <TextArea rows={3} value={draft.prompt} maxLength={PRESET_PROMPT_MAX} onChange={event => change({ prompt: event.target.value })} />
          </Field>
          <span className="study-page-presets__actions">
            <Button type="submit" variant="primary" size="sm">{draft.id ? ui('保存') : ui('添加')}</Button>
            <Button variant="quiet" size="sm" onClick={cancel}>{ui('取消')}</Button>
          </span>
        </form> : <span className="study-page-presets__actions"><Button size="sm" variant="quiet" icon="plus" onClick={() => begin()}>{ui('添加预设')}</Button></span>}
      </section>
    </div>
  </Dialog>;
}
