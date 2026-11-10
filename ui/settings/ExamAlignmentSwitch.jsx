import React, { useCallback, useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, Switch } from '../components/index.js';
import { formatList } from '../format.js';
import { useStudy } from '../study-context.jsx';

/* 考前对齐 (#882): one switch inside 间隔复习 · FSRS-6, shown only when a course has an exam date ahead. Next to it, before the learner
   flips it, what flipping it does to each of the next 14 days (course.examAlignment.preview: the backend runs the very pass the switch
   runs, on a copy). A library whose exam date was set before alignment existed is on but not aligned yet: it says how many questions
   wait and offers to bring them forward now. */

/** 「11/12 +3」: the days whose count would change, as the learner reads them. */
export function changeList(days = []) {
  return days.filter(day => day.after !== day.before)
    .map(day => `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))} ${day.after > day.before ? '+' : '−'}${Math.abs(day.after - day.before)}`);
}

/** The line under the switch: what turning it to `target` (or aligning now) does, as an estimate. */
export function previewLine(preview, target) {
  const changes = changeList(target ? preview.on : preview.off);
  if (!changes.length) return target ? ui('打开后，未来 14 天每天的复习量不变。') : ui('关闭后，未来 14 天每天的复习量不变。');
  return uiFormat(target ? '打开后，未来 14 天每天的复习量（估计）：{0}。之后的作答也会按考试日安排，考前实际会再多一些。' : '关闭后，未来 14 天每天的复习量（估计）：{0}。', [changes.join(' · ')]);
}

/** The switch and its preview for a read `preview`; nothing when no course has an exam ahead. onSet(enabled) switches. */
export function ExamAlignmentView({ preview, busy = false, onSet }) {
  if (!preview?.courses?.length) return null;
  const waiting = preview.enabled && preview.pending > 0;
  return (
    <div className="sm2-exam-align" data-tour="settings-exam-alignment">
      <Switch label={ui('考前对齐')} checked={preview.enabled} disabled={busy} onChange={enabled => onSet?.(enabled)}
        hint={uiFormat('考试日：{0}。有考试日的课，每次作答后下次复习不晚于考试日；已经排到考试之后的题，会分散提前到考试前的几天，最容易忘的先回来。只改复习日期，不改记忆估计和掌握程度。考试当天作答的题只能排到考试之后（当天已没有更早的一天）；考试日过后恢复平常的安排。',
          [formatList(preview.courses.map(course => `${course.name} ${course.date}`))])} />
      {waiting
        ? <Hint>{uiFormat('还有 {0} 道题排在考试之后，现在对齐会把它们提前。', [preview.pending])}{' '}{previewLine(preview, true)}{' '}
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => onSet?.(true)}>{ui('现在对齐')}</Button></Hint>
        : <Hint>{previewLine(preview, !preview.enabled)}</Hint>}
    </div>
  );
}

/** Reads the preview for the open library (again after each switch) and switches through course.examAlignment.set. */
export function ExamAlignmentSwitch({ root }) {
  const { busy, act, call } = useStudy();
  const [preview, setPreview] = useState(null);
  const load = useCallback(async () => {
    try { setPreview(await call('course.examAlignment.preview', {})); } catch { setPreview(null); }
  }, [call]);
  useEffect(() => { setPreview(null); void load(); }, [root, load]);
  return <ExamAlignmentView preview={preview} busy={busy} onSet={enabled => act('course.examAlignment.set', { enabled }, load)} />;
}

export default ExamAlignmentSwitch;
