import React from 'react';
import { uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';

/* 学法 on the home, under the course progress (#775 S1c): which stage of the course's own method the learner is on, in the learner's own words, as a quiet
   button that opens the course settings where the whole method is (like the 重点 line beside it). Read from what the library holds
   (lib/course-method-progress.js); no model call, nothing stored. A course on the default package gets no line: that package is today's flow, and the home of
   a course nobody customised stays exactly as it was — its 学法 is on the course settings. */
export default function MethodLine({ method, courseId, onCourseSettings }) {
  if (!method?.stage || !method.own) return null;
  return <p className="course-method-line">
    <Button variant="quiet" size="sm" wrap className="course-method-line__summary" aria-label={uiFormat('学法：第 {0} 阶段，{1}。打开课程设置看整份学法', [method.index + 1, method.stage.name])}
      onClick={() => onCourseSettings?.(courseId)}>
      <span className="course-method-line__label">{uiFormat('学法 · 第 {0} 阶段', [method.index + 1])}</span>
      <span className="course-method-line__stage">{method.stage.name}</span>
    </Button>
  </p>;
}
