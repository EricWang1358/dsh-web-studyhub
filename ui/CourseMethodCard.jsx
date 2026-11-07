import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Field, HelpTip, InlineMessage, SegmentedControl, TextInput } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { LEVELS, NAME_MAX, courseMethod } from '../lib/course-method.js';
import css from './course-method-card.css';

/* 学法 (#775, 4.5 S1) on the course settings: the stages this course is learned by. It reads first — the method's name and its stages in one short list —
   and is changed behind 「改学法」, so the default package 「课堂跟学」 (today's flow said in stages; a learner who never touches it learns exactly as before)
   is a few quiet lines, not a form to fill in. Editing saves the whole method through course.save {method}; a course with its own offers the way back.
   What each gate means is a 「?」, not a paragraph. The stage the learner is on is marked 现在 (from the home snapshot, current course only). Dragging and deleting stages and the 「也可以」 guidance are later slices. */

const LEVEL_LABELS = { loose: '松一点', medium: '适中', strict: '严格一点' };

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

/** The edit form behind 「改学法」: the name, each stage's name and gate, the target date; save, cancel and (for a course's own method) the way back. */
export function MethodForm({ draft, own, disabled, working, onChange, onStage, onSave, onCancel, onReset }) {
  return <div className="course-method__form">
    <Field label={ui('学法名称')} width="full"><TextInput value={draft.name} maxLength={NAME_MAX} disabled={disabled} onChange={event => onChange({ name: event.target.value })} /></Field>
    <ol className="course-method__stages course-method__stages--edit">
      {draft.stages.map((stage, index) => <li key={index} className="course-method__stage-edit">
        <Field label={uiFormat('第 {0} 个阶段', [index + 1])} width="full">
          <TextInput value={stage.name} maxLength={NAME_MAX} disabled={disabled} onChange={event => onStage(index, { name: event.target.value })} /></Field>
        <div className="course-method__gate">
          <SegmentedControl label={uiFormat('第 {0} 个阶段的过关宽严', [index + 1])} size="sm" value={stage.level} disabled={disabled}
            options={LEVELS.map(level => ({ value: level, label: ui(LEVEL_LABELS[level]) }))} onChange={level => onStage(index, { level })} />
          {index === 0 && <HelpTip label={ui('过关宽严是什么')}>{ui('过关宽严：松一点，答过八成就够进下一阶段；适中，要答对八成；严格一点，要全部答对。')}</HelpTip>}
        </div>
      </li>)}
    </ol>
    <Field label={ui('目标日期（可选）')} width="full" hint={ui('没有考试日期的自学课，可以填想学完的日子。')}>
      <TextInput type="date" value={draft.targetDate || ''} disabled={disabled} onChange={event => onChange({ targetDate: event.target.value || null })} /></Field>
    <div className="course-method__actions">
      <Button variant="secondary" size="sm" lock={disabled} busy={working} onClick={onSave}>{ui('保存学法')}</Button>
      <Button variant="quiet" size="sm" lock={working} onClick={onCancel}>{ui('取消')}</Button>
      {own && <Button variant="quiet" size="sm" lock={disabled} onClick={onReset}>{ui('恢复默认学法')}</Button>}
    </div>
  </div>;
}

export default function CourseMethodCard({ course, readout = null }) {
  useInjectCss(css, 'study-course-method');
  const { act, busy } = useStudy();
  const [draft, setDraft] = useState(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  if (!course) return null;
  const own = !!course.method, shown = shownMethod(course), disabled = busy || working;
  // The stage the learner is on (#775 S1b): the home snapshot reads it for the current course only, so another course's card shows its stages without it.
  const current = Number.isInteger(readout?.index) && readout.total === shown.stages.length ? readout.index : -1;
  const write = async method => {
    setWorking(true); setError('');
    try { await act('course.save', { id: course.id, name: course.name, method }, undefined, { rethrow: true }); setDraft(null); }
    catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  };
  const change = patch => { setDraft(current => ({ ...current, ...patch })); setError(''); };
  const changeStage = (index, patch) => change({ stages: draft.stages.map((stage, at) => (at === index ? { ...stage, ...patch } : stage)) });
  return <section className="course-settings__block course-method" aria-labelledby="course-method-title">
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
        {index === current && <Badge size="sm" tone="accent">{ui('现在')}</Badge>}
      </li>)}
    </ol>}
    {!draft && current >= 0 && checkLine(readout.gate) && <p className="course-settings__note course-method__check">{checkLine(readout.gate)}</p>}
    {!draft && shown.targetDate && <p className="course-settings__note">{uiFormat('目标日期：{0}', [shown.targetDate])}</p>}
    {draft && <MethodForm draft={draft} own={own} disabled={disabled} working={working} onChange={change} onStage={changeStage} onSave={() => write(draft)}
      onCancel={() => { setDraft(null); setError(''); }} onReset={() => write(null)} />}
    {error && <InlineMessage role="alert">{error}</InlineMessage>}
  </section>;
}
