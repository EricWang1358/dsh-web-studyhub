import React from 'react';
import { ui, uiFormat } from '../i18n.js';

/* 学法 on the home, under the course progress (#775 S1c): which stage of the course's method the learner is on, in the method's own words — the default
   package's stages come from the catalogue (lib/course-method.js CLASSROOM_METHOD), a course's own stages are drawn exactly as its learner wrote them. Read
   from what the library holds (lib/course-method-progress.js); no model call, nothing stored. */
export default function MethodLine({ method }) {
  if (!method?.stage) return null;
  const name = method.own ? method.stage.name : ui(method.stage.name);
  return <p className="course-method-line">
    <span className="course-method-line__label">{uiFormat('学法 · 第 {0} 阶段', [method.index + 1])}</span>
    <span className="course-method-line__stage">{name}</span>
  </p>;
}
