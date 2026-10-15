import React, { forwardRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Combobox, PageHeader } from '../components/index.js';
import { ExamCountdown } from '../CourseSettings.jsx';
import { courseEntries } from '../course-picker-entries.js';

/** The current course as a heading-size course switcher (the home's heading and the review book's title share it): a searchable Combobox ranked like every course
    picker, its trigger the text passed as children. onFocus({ course }) makes another course current (the whole app follows). */
export const CourseSwitch = forwardRef(function CourseSwitch({ data, onFocus, actions = [], children, ...rest }, ref) {
  const focus = data.focus || {};
  return <Combobox ref={ref} variant="heading" label={ui('切换当前课程')} value={focus.course || ''} onChange={(course) => onFocus?.({ course })}
    options={courseEntries({ courses: focus.courses || [], current: focus.course })} searchPlaceholder={ui('搜索课程或章节')}
    emptyText={(query) => uiFormat('没有叫「{0}」的课程或章节', [query])} actions={actions} {...rest}>{children}</Combobox>;
});

/**
 * The home's heading: the study-mode's role input in interview mode, else the
 * current course as a course switcher (a searchable Combobox whose trigger is
 * the heading itself, with the course's settings as a footer action instead of
 * a fake option), else the day's headline. `role` is { draft, setDraft }
 * from useRoleDraft. Always the page's title (h1), drawn by PageHeader; `aside` (the way to the 总纲) sits at its right.
 */
export default function CourseHeading({ data, headline, onFocus, onCourseSettings, role, aside }) {
  const focus = data.focus || {};
  const courses = focus.courses || [];
  const frame = (title, titleProps) => <PageHeader className="course-header" title={title} titleProps={titleProps} actions={aside} />;
  if (focus.mode === 'interview') {
    return frame(
      <input className="course-heading-input" aria-label={ui('岗位方向')} placeholder={ui('输入岗位方向')} value={role.draft}
        onChange={(event) => role.setDraft(event.target.value)} onBlur={() => {
          const next = role.draft.trim();
          if (next !== (focus.role || '')) onFocus?.({ role: next });
        }} />, { className: 'course-heading-title' });
  }
  if (!courses.length) return frame(headline, { className: 'course-heading' });
  // Ranked like every course picker (current, recently used, busiest) with "Course / Chapter" names as a tree; parked courses stay reachable, last.
  const actions = onCourseSettings && focus.courseId
    ? [{ id: 'course-settings', label: ui('课程设置…'), icon: 'settings', onSelect: () => onCourseSettings(focus.courseId) }] : [];
  return frame(<>
      <CourseSwitch data={data} onFocus={onFocus} actions={actions}>{focus.course === '' ? ui('未分类课程') : focus.course || headline}</CourseSwitch>
      <ExamCountdown course={(data.courses || []).find((course) => course.id === focus.courseId)} />
    </>, { className: 'course-heading', 'data-tour': 'home-course' });
}
