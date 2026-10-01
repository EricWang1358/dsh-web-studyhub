import React, { useId } from 'react';
import { ui } from './i18n.js';
import { useInjectCss } from './shared.js';
import css from './course-field-css.js';

export const parseCourses = value => [...new Set(String(value || '').split(/[;；\n]/).map(name => name.trim()).filter(Boolean))];

/** Add or remove one existing course in the field's text (single: replace; multiple: toggle in the list). */
export function toggleCourse(value, name, multiple = false) {
  if (!multiple) return name;
  const current = parseCourses(value);
  return (current.includes(name) ? current.filter(item => item !== name) : [...current, name]).join('; ');
}

const QUICK_PICKS = 8;

/* Existing courses come first as one-click picks (course records, WP13);
   free text still names a new course. The server gives every name its course
   id in the same transaction, so pickers stay plain text. */
export default function CourseField({ courses = [], value = '', onChange, multiple = false, disabled, label = ui('课程归属') }) {
  useInjectCss(css, 'study-course-field');
  const id = useId();
  const names = [...new Set(courses.map(course => typeof course === 'string' ? course : course?.name).filter(Boolean))];
  const chosen = multiple ? parseCourses(value) : [String(value || '').trim()];
  return <div className="course-field">
    <label>{label}<input value={value} onChange={event => onChange(event.target.value)} list={id} disabled={disabled}
      maxLength={multiple ? 6000 : 200} placeholder={ui('留空为未分类')} />
      <datalist id={id}>{names.map(name => <option key={name} value={name} />)}</datalist>
      {multiple && <small className="muted">{ui('多门课程用分号分隔；留空为未分类。')}</small>}
    </label>
    {names.length > 0 && <div className="course-field__picks" role="group" aria-label={ui('已有课程')}>
      {names.slice(0, QUICK_PICKS).map(name => <button type="button" key={name} className="course-field__pick" aria-pressed={chosen.includes(name)}
        disabled={disabled} onClick={() => onChange(toggleCourse(value, name, multiple))}>{name}</button>)}
    </div>}
  </div>;
}
