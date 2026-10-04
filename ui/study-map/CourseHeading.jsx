import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Icon } from '../components/index.js';
import { ExamCountdown } from '../CourseSettings.jsx';
import { isParked } from '../CourseActive.jsx';
import { groupCourseNames, rankCourses } from '../course-names.js';

/**
 * The home's heading: the study-mode's role input in interview mode, else the
 * current course as a course switcher (a transparent native select over the
 * heading keeps keyboard and screen-reader behaviour; its last entry opens the
 * course's settings), else the day's headline. `role` is { draft, setDraft }
 * from useRoleDraft.
 */
export default function CourseHeading({ data, headline, onFocus, onCourseSettings, role }) {
  const focus = data.focus || {};
  const courses = focus.courses || [];
  if (focus.mode === 'interview') {
    return (
      <input className="course-heading-input" aria-label={ui('岗位方向')} placeholder={ui('输入岗位方向')} value={role.draft}
        onChange={(event) => role.setDraft(event.target.value)} onBlur={() => {
          const next = role.draft.trim();
          if (next !== (focus.role || '')) onFocus?.({ role: next });
        }} />
    );
  }
  if (!courses.length) return <h1 className="course-heading">{headline}</h1>;
  const parkedChoices = courses.filter(isParked);
  return (
    <h1 className="course-heading" data-tour="home-course">
      <span>{focus.course === '' ? ui('未分类课程') : focus.course || headline}</span>
      <Icon name="caret" size={14} className="course-heading__caret" />
      <ExamCountdown course={(data.courses || []).find((course) => course.id === focus.courseId)} />
      <select aria-label={ui('切换当前课程')} value={focus.course || ''}
        onChange={(event) => (event.target.value === '@course-settings' ? onCourseSettings?.(focus.courseId) : onFocus?.({ course: event.target.value }))}>
        {/* Ranked like every course picker (current, recently used, busiest) with "Course / Chapter" names grouped (WP14). */}
        {groupCourseNames(rankCourses({ courses: courses.filter((course) => !isParked(course)), current: focus.course })).map((entry) => (entry.type === 'group'
          ? <optgroup key={`group:${entry.key}`} label={entry.name}>
            <option value={entry.parent.name}>{entry.parent.name} · {ui('含子课程')}</option>
            {entry.chapters.map(({ course, chapter, depth }) => <option key={course.name} value={course.name}>{'  '.repeat(Math.max(0, depth - 1))}{chapter}</option>)}
          </optgroup>
          : <option key={entry.course.name} value={entry.course.name}>{entry.course.name || ui('未分类课程')}</option>))}
        {/* Parked courses stay reachable, grouped apart; the heading's value may be one of them. */}
        {parkedChoices.length > 0 && <optgroup label={uiFormat('未激活的课程 ({0})', [parkedChoices.length])}>
          {parkedChoices.map((course) => <option key={course.name} value={course.name}>{course.name}</option>)}
        </optgroup>}
        {onCourseSettings && focus.courseId && <option value="@course-settings">{ui('课程设置…')}</option>}
      </select>
    </h1>
  );
}
