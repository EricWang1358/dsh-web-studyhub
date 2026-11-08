import React, { useContext, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Chip, Field, HelpTip, Icon, IconButton, InlineMessage, SegmentedControl, Select, TextInput, Tooltip } from './components/index.js';
import { cx } from './components/css.js';
import { useStudy } from './study-context.jsx';
import { AppContext } from './app/app-context.js';
import { HandOff } from './hand-off/HandOff.jsx';
import { ACTIVITIES, ALTERNATIVES_MAX, LEVELS, NAME_MAX, STAGES_MAX, courseMethod } from '../lib/course-method.js';
import { ACTIVITY_LABELS, currentMethodStage, stageAlternatives, useMethodAlternativeOpen } from './method-alternatives.js';
import css from './course-method-card.css';

/* 学法 (#775, 4.5 S1) on the course settings: the stages this course is learned by. It reads first — the method's name and its stages in one short list —
   and is changed behind 「改学法」 or 「和主会话改学法」, so the default package 「课堂跟学」 (today's flow said in stages; a learner who never touches it learns
   exactly as before) stays a few quiet lines, not a form to fill in. Editing saves the whole method through course.save {method}; a course with its own offers
   the way back. Current stage shows 「现在」 (from the home snapshot) and its 「也可以」 guidance. */

const LEVEL_LABELS = { loose: '松一点', medium: '适中', strict: '严格一点' };

/** Reorder `stages` by moving the item at `from` to `to` (pure; out-of-range indices return `stages`). */
export function moveStage(stages, from, to) {
  if (!Array.isArray(stages) || from === to || from < 0 || to < 0 || from >= stages.length || to >= stages.length) return stages;
  const next = [...stages];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Append an editable stage up to `STAGES_MAX` (pure). */
export function addStage(stages, name = '') {
  if (!Array.isArray(stages) || stages.length >= STAGES_MAX) return stages;
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, NAME_MAX) : uiFormat('阶段 {0}', [stages.length + 1]);
  return [...stages, { name: label, activity: 'practice', alternatives: [], level: 'medium' }];
}

/** Remove stage at `index`, keeping at least 1 stage (pure). */
export function removeStage(stages, index) {
  if (!Array.isArray(stages) || stages.length <= 1 || index < 0 || index >= stages.length) return stages;
  return stages.filter((_, at) => at !== index);
}

/** Toggle an optional `alternatives` activity on `stage` (capped at `ALTERNATIVES_MAX`, never equal to `stage.activity`). */
export function toggleStageAlternative(stage, activity) {
  if (!stage || !ACTIVITIES.includes(activity) || activity === stage.activity) return stage;
  const list = Array.isArray(stage.alternatives) ? stage.alternatives : [];
  if (list.includes(activity)) return { ...stage, alternatives: list.filter(item => item !== activity) };
  if (list.length >= ALTERNATIVES_MAX) return stage;
  return { ...stage, alternatives: [...list, activity] };
}

/** Patch stage at `index`; if `activity` changes, keep `alternatives` distinct from the new main `activity`. */
export function patchStage(stages, index, patch) {
  if (!Array.isArray(stages) || index < 0 || index >= stages.length || !patch) return stages;
  return stages.map((stage, at) => {
    if (at !== index) return stage;
    const next = { ...stage, ...patch };
    const alts = Array.isArray(next.alternatives) ? next.alternatives : [];
    next.alternatives = alts.filter(item => ACTIVITIES.includes(item) && item !== next.activity).slice(0, ALTERNATIVES_MAX);
    return next;
  });
}

/** How the current stage's check stands (#777 S3a, lib/course-method-gate.js), in one sentence with one count; nothing for a stage that imports material. */
export function checkLine(gate) {
  if (!gate || gate.stage?.activity === 'publish') return '';
  if (!gate.total) return ui('这一阶段还没有题，出了题才有检验。');
  const answered = gate.counts === 'answered', counts = [gate.total, gate.passed, gate.toReady];
  if (gate.last) return uiFormat(answered ? '这一阶段：{0} 道里答过 {1} 道。' : '这一阶段：{0} 道里答对 {1} 道。', counts);
  if (gate.ready) return uiFormat(answered ? '这一阶段：{0} 道里答过 {1} 道，够进下一阶段了。' : '这一阶段：{0} 道里答对 {1} 道，够进下一阶段了。', counts);
  return uiFormat(answered ? '这一阶段：{0} 道里答过 {1} 道，再答 {2} 道就够进下一阶段。' : '这一阶段：{0} 道里答对 {1} 道，再答对 {2} 道就够进下一阶段。', counts);
}

/** The method as the learner reads it: a course's own words exactly as written, the default package's from the catalogue (a draft started from it is then
    in the learner's language, not in the source words). */
export function shownMethod(course) {
  const method = courseMethod(course);
  if (course?.method) return method;
  return { ...method, name: ui(method.name), stages: method.stages.map(stage => ({ ...stage, name: ui(stage.name) })) };
}

/** The edit form behind 「改学法」: lightweight direct editing of name, stage order, stage count (1..12), activities, alternatives (0..2), gates, and target date. */
export function MethodForm({ draft, own, disabled, working, onChange, onStage, onMove, onAdd, onRemove, onSave, onCancel, onReset }) {
  const [dragIndex, setDragIndex] = useState(-1), [overIndex, setOverIndex] = useState(-1);
  const move = onMove || ((from, to) => onChange({ stages: moveStage(draft.stages, from, to) }));
  const add = onAdd || (() => onChange({ stages: addStage(draft.stages) }));
  const remove = onRemove || (index => onChange({ stages: removeStage(draft.stages, index) }));
  const activityOptions = ACTIVITIES.map(activity => ({ value: activity, label: ui(ACTIVITY_LABELS[activity]) }));
  return <div className="course-method__form">
    <Field label={ui('学法名称')} width="full"><TextInput value={draft.name} maxLength={NAME_MAX} disabled={disabled} onChange={event => onChange({ name: event.target.value })} /></Field>
    <ol className="course-method__stages course-method__stages--edit">
      {draft.stages.map((stage, index) => <li key={index}
        className={cx('course-method__stage-edit', dragIndex === index && 'is-dragging', overIndex === index && dragIndex !== index && 'is-drop-target')}
        onDragOver={event => {
          if (disabled || dragIndex < 0) return;
          event.preventDefault();
          if (overIndex !== index) setOverIndex(index);
        }}
        onDrop={event => {
          if (disabled) return;
          event.preventDefault();
          const raw = event.dataTransfer?.getData?.('text/plain');
          const from = dragIndex >= 0 ? dragIndex : Number.parseInt(raw, 10);
          setDragIndex(-1); setOverIndex(-1);
          if (Number.isInteger(from) && from !== index) move(from, index);
        }}>
        <div className="course-method__stage-top">
          <Field className="course-method__stage-field" label={uiFormat('第 {0} 个阶段', [index + 1])} width="full">
            <TextInput value={stage.name} maxLength={NAME_MAX} disabled={disabled} placeholder={ui('例如：课前预习、案例拆解、口述复盘')}
              onChange={event => onStage(index, { name: event.target.value })} />
          </Field>
          <div className="course-method__stage-tools">
            {draft.stages.length > 1 && <Tooltip layer content={ui('拖动这个手柄排序')}>
              <span className="course-method__drag" draggable={!disabled}
                onDragStart={event => {
                  if (disabled) { event.preventDefault(); return; }
                  setDragIndex(index);
                  event.dataTransfer?.setData?.('text/plain', String(index));
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => { setDragIndex(-1); setOverIndex(-1); }}
                aria-hidden="true"><Icon name="list" size={16} /></span>
            </Tooltip>}
            <IconButton size="sm" icon="arrow-up" label={uiFormat('上移第 {0} 个阶段', [index + 1])} lock={disabled} disabled={index === 0}
              onClick={() => move(index, index - 1)} />
            <IconButton size="sm" icon="arrow-down" label={uiFormat('下移第 {0} 个阶段', [index + 1])} lock={disabled} disabled={index === draft.stages.length - 1}
              onClick={() => move(index, index + 1)} />
            <IconButton size="sm" icon="trash" label={uiFormat('删除第 {0} 个阶段', [index + 1])} lock={disabled} disabled={draft.stages.length <= 1}
              onClick={() => remove(index)} />
          </div>
        </div>
        <div className="course-method__stage-meta">
          <Field className="course-method__activity" label={ui('主要怎么学')} width="sm">
            <Select value={stage.activity} disabled={disabled} options={activityOptions} onChange={activity => onStage(index, { activity })} />
          </Field>
          <div className="course-method__gate">
            <Field group label={ui('过关宽严')} width="full">
              <SegmentedControl label={uiFormat('第 {0} 个阶段的过关宽严', [index + 1])} size="sm" value={stage.level} disabled={disabled}
                options={LEVELS.map(level => ({ value: level, label: ui(LEVEL_LABELS[level]) }))} onChange={level => onStage(index, { level })} />
            </Field>
            {index === 0 && <HelpTip label={ui('过关宽严是什么')}>{ui('过关宽严：松一点，答过八成就够进下一阶段；适中，要答对八成；严格一点，要全部答对。')}</HelpTip>}
          </div>
        </div>
        <div className="course-method__alts-edit" role="group" aria-label={uiFormat('第 {0} 个阶段的也可以', [index + 1])}>
          <span className="course-method__alts-label">{ui('也可以（最多 2 项）')}</span>
          <div className="course-method__alts-chips">
            {ACTIVITIES.filter(activity => activity !== stage.activity).map(activity => {
              const selected = (stage.alternatives || []).includes(activity);
              const full = !selected && (stage.alternatives || []).length >= ALTERNATIVES_MAX;
              return <Chip key={activity} size="sm" selected={selected} icon={selected ? 'check' : undefined} disabled={disabled || full}
                onClick={() => onStage(index, { alternatives: toggleStageAlternative(stage, activity).alternatives })}>{ui(ACTIVITY_LABELS[activity])}</Chip>;
            })}
          </div>
        </div>
      </li>)}
    </ol>
    <div className="course-method__add-row">
      <Button variant="quiet" size="sm" icon="plus" lock={disabled} disabled={draft.stages.length >= STAGES_MAX} onClick={add}>{ui('添加阶段')}</Button>
      <span className="course-method__count">{uiFormat('共 {0} / {1} 个阶段', [draft.stages.length, STAGES_MAX])}</span>
    </div>
    <Field label={ui('目标日期（可选）')} width="full" hint={ui('没有考试日期的自学课，可以填想学完的日子。')}>
      <TextInput type="date" value={draft.targetDate || ''} disabled={disabled} onChange={event => onChange({ targetDate: event.target.value || null })} /></Field>
    <div className="course-method__actions">
      <Button variant="secondary" size="sm" lock={disabled} busy={working} onClick={onSave}>{ui('保存学法')}</Button>
      <Button variant="quiet" size="sm" lock={working} onClick={onCancel}>{ui('取消')}</Button>
      {own && <Button variant="quiet" size="sm" lock={disabled} onClick={onReset}>{ui('恢复默认学法')}</Button>}
    </div>
  </div>;
}

export default function CourseMethodCard({ course, readout = null, data = null, onClose }) {
  useInjectCss(css, 'study-course-method');
  const { act, busy } = useStudy();
  const app = useContext(AppContext);
  const openAlt = useMethodAlternativeOpen({ data, onClose });
  const [draft, setDraft] = useState(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false), [note, setNote] = useState('');
  if (!course) return null;
  const own = !!course.method, shown = shownMethod(course), disabled = busy || working;
  // The stage the learner is on (#775 S1b): the home snapshot reads it for the current course only, so another course's card shows its stages without it.
  const current = Number.isInteger(readout?.index) && readout.total === shown.stages.length ? readout.index : -1;
  const activeStage = current >= 0 ? shown.stages[current] : (data ? currentMethodStage(data, course)?.stage : null);
  const altItems = !draft && data && activeStage ? stageAlternatives(data, course, activeStage, { guidedSession: app?.lib?.guidedSession }) : [];
  const write = async method => {
    setWorking(true); setError('');
    try { await act('course.save', { id: course.id, name: course.name, method }, undefined, { rethrow: true }); setDraft(null); }
    catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  };
  const change = patch => { setDraft(prev => ({ ...prev, ...patch })); setError(''); };
  const changeStage = (index, patch) => change({ stages: patchStage(draft.stages, index, patch) });
  return <section className="course-settings__block course-method" data-tour="course-method" aria-labelledby="course-method-title">
    <div className="course-method__head">
      <h3 id="course-method-title">{ui('学法')}</h3>
      {!draft && <span className="course-method__name">{shown.name}</span>}
      {!draft && !own && <Badge size="sm">{ui('默认')}</Badge>}
      <HelpTip label={ui('学法是什么')}>{own
        ? ui('这门课自己的学法：主会话带学时照着它走。随时可以改，也可以恢复默认。')
        : ui('默认学法就是现在的流程：导入资料、出题按批练、到期复习。不改也照常学；想按自己的阶段学，点「改学法」，或在主会话里说。')}</HelpTip>
      {!draft && <Button variant="quiet" size="sm" className="course-method__edit" lock={disabled} onClick={() => { setDraft(shown); setError(''); }}>{ui('改学法')}</Button>}
    </div>
    {!draft && <ol className="course-method__stages">
      {shown.stages.map((stage, index) => <li key={index} className="course-method__stage" aria-current={index === current ? 'step' : undefined}>
        <span className="course-method__stage-name">{stage.name}</span>
        <small className="course-method__level">{ui(LEVEL_LABELS[stage.level])}</small>
        {index === current && <Badge size="sm" tone="accent" className="course-method__now">{ui('现在')}</Badge>}
      </li>)}
    </ol>}
    {!draft && current >= 0 && checkLine(readout.gate) && <p className="course-settings__note course-method__note course-method__check">{checkLine(readout.gate)}</p>}
    {!draft && altItems.length > 0 && <div className="course-method__also" aria-label={ui('也可以')}>
      <span className="course-method__also-lead">{ui('也可以：')}</span>
      {altItems.map(item => item.blocked
        ? <span key={item.activity} className="course-method__also-blocked" aria-disabled="true">
            <span>{item.title}</span><small className="course-method__also-why">{uiFormat('（{0}）', [item.blocked])}</small>
          </span>
        : <span key={item.activity} className="course-method__also-item">
            <Tooltip layer content={item.detail}>
              <Button variant="link" size="sm" lock={disabled} onClick={() => openAlt(item, { course, stage: activeStage })}>{item.title}</Button>
            </Tooltip>
            {item.used && <Badge size="sm">{ui('已用过')}</Badge>}
          </span>)}
    </div>}
    {!draft && shown.targetDate && <p className="course-settings__note course-method__note">{uiFormat('目标日期：{0}', [shown.targetDate])}</p>}
    {!draft && <div className="course-method__chat">
      <div className="course-method__chat-row">
        <HandOff id="method.edit" shape="quiet" label="和主会话改学法"
          what="把当前学法发给主会话，按你的目标和习惯一起调整；确认之前不会保存"
          input={{ course: course.name, method: shown, note: note.trim() }} disabled={disabled}
          onSent={outcome => { if (outcome === 'filled') onClose?.('method-edit'); }} />
        <Button variant="link" size="sm" aria-expanded={noteOpen} lock={disabled} onClick={() => setNoteOpen(open => !open)}>
          {noteOpen ? ui('收起补充') : ui('补充想法')}
        </Button>
      </div>
      {noteOpen && <Field className="course-method__note-field" label={ui('想怎么学（可选）')} width="full"
        hint={ui('写下你的目标、习惯或特殊学法想法，点「和主会话改学法」时会一起带上。')}>
        <TextInput value={note} maxLength={300} disabled={disabled}
          placeholder={ui('例如：每周只有周末有空，考前两周想多做口头抽查')}
          onChange={event => setNote(event.target.value)} />
      </Field>}
    </div>}
    {draft && <MethodForm draft={draft} own={own} disabled={disabled} working={working} onChange={change} onStage={changeStage}
      onMove={(from, to) => change({ stages: moveStage(draft.stages, from, to) })}
      onAdd={() => change({ stages: addStage(draft.stages) })}
      onRemove={index => change({ stages: removeStage(draft.stages, index) })}
      onSave={() => write(draft)} onCancel={() => { setDraft(null); setError(''); }} onReset={() => write(null)} />}
    {error && <InlineMessage role="alert">{error}</InlineMessage>}
  </section>;
}
