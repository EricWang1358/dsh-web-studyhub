import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { Button, Hint } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';
import { daysUntilExam } from '../lib/courses.js';

/* Under a course's exam date (#882 review B4): while 考前对齐 is on and some of this course's questions are still due after its exam
   (an exam date set before alignment existed, or a deck filed under the course since), one line says how many and leads to the
   switch in Settings, where 现在对齐 brings them forward. Reads only; nothing is moved from here. CourseSettings mounts it only
   for a course whose saved exam date is ahead (`examPointerShown`), so a course without one runs no preview. */

/** Whether a course's saved `exam` can have questions to bring forward: its date is after today. */
export const examPointerShown = (exam, now = Date.now()) => (daysUntilExam(exam, new Date(now)) ?? 0) > 0;

/** The line for a read `preview` and a course name: null unless questions of that course wait. */
export function ExamAlignmentPointerView({ preview, course, onOpen }) {
  const waiting = preview?.enabled ? preview.courses?.find(item => item.name === course)?.pending || 0 : 0;
  if (!waiting) return null;
  return <Hint className="exam-align-pointer">{uiFormat('{0} 道题仍排在考试之后', [waiting])}{' → '}
    <Button variant="link" size="sm" onClick={() => onOpen?.()}>{ui('设置 · 考前对齐')}</Button></Hint>;
}

/** Reads the preview for the course (again when its saved exam date changes) and opens Settings at the switch, closing the course
    panel first through `onLeave`. */
export function ExamAlignmentPointer({ course, examDate, onLeave }) {
  const { call, openSettings } = useStudy();
  const [preview, setPreview] = useState(null);
  useLiveEffect(live => {
    call('course.examAlignment.preview', {}).then(result => { if (live()) setPreview(result); }, () => { if (live()) setPreview(null); });
  }, [call, course, examDate]);
  return <ExamAlignmentPointerView preview={preview} course={course} onOpen={() => { onLeave?.(); openSettings('settings-exam-alignment'); }} />;
}

export default ExamAlignmentPointer;
