import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { Button, Field, SegmentedControl, TextInput } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';
import { CLASSROOM_METHOD, LEVELS, STAGES_MAX, courseMethod } from '../lib/course-method.js';

/* 学法 (#775, 4.5 S1) on the course settings: the stages this course is learned by, in the learner's own words, and the target date they are aimed at. The
   default package 「课堂跟学」 is what every course has until it is changed, and it is today's behaviour said in stages, so a learner who never touches this
   card learns exactly as before. A stage's name and gate are edited here and saved whole through course.save {method}; dragging, deleting a stage and the
   「也可以」 guidance are the next slice (S1b). */

const LEVEL_WORDS = { loose: () => ui('松：练过就算过'), medium: () => ui('中：约三分之二答对'), strict: () => ui('严：全部答对，错的再练一次') };

export default function CourseMethodCard({ course }) {

  const stored = course?.method ? courseMethod(course) : { ...CLASSROOM_METHOD, stages: CLASSROOM_METHOD.stages.map(stage => ({ ...stage })) };
  const { act, busy, call } = useStudy();
  const [draft, setDraft] = useState(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [progress, setProgress] = useState(null);
  // Where the learner is in the method, and how its check stands, read from the library (answers only, no model call), again when the method or the course
  // changes.
  useLiveEffect(live => {
    Promise.all([call('course.method.progress', { course: course.name }), call('course.method.gate', { course: course.name })])
      .then(([readout, gate]) => { if (live()) setProgress({ ...readout, gate }); }).catch(() => {});
  }, [call, course.name, course.method?.updatedAt]);
  const shown = draft || stored, own = !!course?.method;
  // The default package (its name and its stages) is product words, not the learner's data: it is drawn from the catalogue until the card is saved with words
  // of its own. A draft is already the learner's words, so it is drawn as it is.
  const display = own || draft ? shown : { ...shown, name: ui(shown.name), stages: shown.stages.map(stage => ({ ...stage, name: ui(stage.name) })) };
  const displayName = display.name;
  const change = patch => { setDraft({ ...shown, ...patch }); setError(''); };
  const changeStage = (index, patch) => change({ stages: shown.stages.map((stage, at) => (at === index ? { ...stage, ...patch } : stage)) });
  const save = async () => {
    setWorking(true); setError('');
    try {
      await act('course.save', { id: course.id, name: course.name, method: shown }, undefined, { rethrow: true });
      setDraft(null);
    } catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  };
  const reset = async () => {
    setWorking(true); setError('');
    try { await act('course.save', { id: course.id, name: course.name, method: null }, undefined, { rethrow: true }); setDraft(null); }
    catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  };
  const disabled = busy || working;
  return <section className="course-settings__block course-method" aria-labelledby="course-method-title">
    <h3 id="course-method-title">{ui('学法')}</h3>
    {progress?.stage && <p className="course-settings__note">{uiFormat('现在在第 {0} 阶段：{1}', [progress.index + 1,
      own ? progress.stage.name : ui(progress.stage.name)])}</p>}
    {progress?.gate && !progress.gate.total && <p className="course-settings__note">{ui('这一阶段还没有题：先用「出题」做出第一批，检验才有东西可看。')}</p>}
    {progress?.gate?.total > 0 && <p className="course-settings__note">{progress.gate.ready
      ? uiFormat('这一阶段检验过了：{0} 道里答对 {1} 道。够了，可以进下一阶段。', [progress.gate.total, progress.gate.passed])
      : uiFormat('这一阶段检验：{0} 道里答对 {1} 道（过四分之三才建议进下一阶段）。', [progress.gate.total, progress.gate.passed])}</p>}
    <p className="course-settings__note">{own
      ? ui('这门课怎么学：下面每个阶段的名字和过关宽严都可以改，改完点保存。')
      : uiFormat('现在用的是默认学法「{0}」：发布、按批练、到期复习，和以前完全一样；想改就说一声。', [displayName])}</p>
    <Field label={ui('学法名称')} width="full"><TextInput value={displayName} maxLength={40} disabled={disabled} onChange={event => change({ name: event.target.value })} /></Field>
    <Field label={ui('目标日期（可选）')} width="full" hint={ui('填了就在卡上显示每个阶段建议完成的日期；不填也可以。')}>
      <TextInput type="date" value={shown.targetDate || ''} disabled={disabled} onChange={event => change({ targetDate: event.target.value || null })} /></Field>
    <ol className="course-method__stages">
      {display.stages.slice(0, STAGES_MAX).map((stage, index) => <li key={index} className="course-method__stage">
        <Field label={uiFormat('第 {0} 个阶段', [index + 1])} width="full">
          <TextInput value={stage.name} maxLength={40} disabled={disabled} onChange={event => changeStage(index, { name: event.target.value })} /></Field>
        <Field label={ui('过关宽严')} width="full" hint={LEVEL_WORDS[stage.level]()}>
          <SegmentedControl label={uiFormat('第 {0} 个阶段的过关宽严', [index + 1])} size="sm" value={stage.level} disabled={disabled}
            options={LEVELS.map(level => ({ value: level, label: ui({ loose: '松一点', medium: '适中', strict: '严格一点' }[level]) }))}
            onChange={level => changeStage(index, { level })} /></Field>
      </li>)}
    </ol>
    {error && <p className="course-settings__note" role="alert">{error}</p>}
    <div className="course-method__actions">
      <Button variant="secondary" lock={disabled || !draft} onClick={save}>{ui('保存学法')}</Button>
      {own && <Button variant="quiet" lock={disabled} onClick={reset}>{ui('恢复默认学法')}</Button>}
    </div>
  </section>;
}
