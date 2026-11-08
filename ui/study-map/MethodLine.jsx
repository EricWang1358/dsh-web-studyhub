import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useStudy } from '../study-context.jsx';

/* 学法 on the home, under the course progress (#775 S1c): which stage of the course's own method the learner is on, in the learner's own words, as a quiet
   button that opens the course settings where the whole method is (like the 重点 line beside it). Read from what the library holds
   (lib/course-method-progress.js); no model call, nothing stored. A course on the default package gets no line: that package is today's flow, and the home of
   a course nobody customised stays exactly as it was — its 学法 is on the course settings. */
export default function MethodLine({ method, courseId, onCourseSettings, onAdvanceStage }) {
  const { act, busy } = useStudy();
  if (!method?.stage || !method.own) return null;
  const advance = () => {
    const nextIndex = method.index + 1;
    if (onAdvanceStage) { onAdvanceStage(nextIndex); return; }
    void act('course.method.save', {
      ...(courseId ? { id: courseId } : {}),
      ...(method.course ? { course: method.course } : {}),
      stageIndex: nextIndex,
    });
  };
  return <p className="course-method-line">
    <Button variant="quiet" size="sm" wrap className="course-method-line__summary" aria-label={uiFormat('学法：第 {0} 阶段，{1}。打开课程设置看整份学法', [method.index + 1, method.stage.name])}
      onClick={() => onCourseSettings?.(courseId)}>
      <span className="course-method-line__label">{uiFormat('学法 · 第 {0} 阶段', [method.index + 1])}</span>
      <span className="course-method-line__stage">{method.stage.name}</span>
    </Button>
    {/* #777 S3b: the stage's check is enough to go on (the same count as the card's; never on the last stage). */}
    {method.gate?.ready && <span className="course-method-line__ready">{ui('够进下一阶段了')}</span>}
    {method.gate?.ready && method.nextStage && (
      <Button variant="link" size="sm" wrap className="course-method-line__advance" lock={busy} onClick={advance}>
        {uiFormat('进入下一阶段：{0}', [method.nextStage.name])}
      </Button>
    )}
  </p>;
}
