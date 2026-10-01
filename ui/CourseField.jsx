import React, { useId, useRef } from 'react';
import { ui } from './i18n.js';
import { useInjectCss } from './shared.js';
import { IconButton, ScrollWindow } from './components/index.js';
import css from './course-field-css.js';

export const parseCourses = value => [...new Set(String(value || '').split(/[;；\n]/).map(name => name.trim()).filter(Boolean))];

/** Add or remove one existing course in the field's text (single: replace; multiple: toggle in the list). */
export function toggleCourse(value, name, multiple = false) {
  if (!multiple) return name;
  const current = parseCourses(value);
  return (current.includes(name) ? current.filter(item => item !== name) : [...current, name]).join('; ');
}

/** The text being typed: the whole value, or the part after the last semicolon in a multi-course field. */
export const courseQuery = (value, multiple = false) => (multiple ? String(value || '').split(/[;；\n]/).pop() : String(value || '')).trim();

/* Up to this many chips sit inline; more go into a small scroll window. */
const INLINE_PICKS = 8;

/* Existing courses come first as one-click picks (course records, WP13);
   free text still names a new course. The server gives every name its course
   id in the same transaction, so pickers stay plain text. A × clears the field
   in one click (WP14); with many courses the picks scroll in a small window
   filtered by what is typed, unless the text already names a course. */
export default function CourseField({ courses = [], value = '', onChange, multiple = false, disabled, label = ui('课程归属') }) {
  useInjectCss(css, 'study-course-field');
  const id = useId(), inputId = useId(), hintId = useId();
  const input = useRef(null);
  const names = [...new Set(courses.map(course => typeof course === 'string' ? course : course?.name).filter(Boolean))];
  const chosen = multiple ? parseCourses(value) : [String(value || '').trim()];
  const query = courseQuery(value, multiple);
  const exact = !!query && names.includes(query);
  const filled = !!String(value || '').trim();
  const clear = () => { onChange(''); input.current?.focus(); };
  const pick = name => <button type="button" className="course-field__pick" aria-pressed={chosen.includes(name)} title={name}
    disabled={disabled} onClick={() => onChange(toggleCourse(value, name, multiple))}>{name}</button>;
  const hint = multiple ? ui('多门课程用分号分隔；留空为未分类。') : names.length ? ui('输入新课程名，或点下方已有课程直接切换；点 × 清空。') : '';
  return <div className="course-field">
    <label className="course-field__label" htmlFor={inputId}>{label}</label>
    <div className={`course-field__control${filled ? ' has-value' : ''}`}>
      <input ref={input} id={inputId} value={value} onChange={event => onChange(event.target.value)} list={exact ? undefined : id} disabled={disabled}
        maxLength={multiple ? 6000 : 200} aria-describedby={hint ? hintId : undefined} autoComplete="off" placeholder={ui('留空为未分类')} />
      {!exact && <datalist id={id}>{names.map(name => <option key={name} value={name} />)}</datalist>}
      {filled && <IconButton icon="close" size="sm" className="course-field__clear" label={ui('清空课程')} disabled={disabled} onClick={clear} />}
    </div>
    {hint && <small id={hintId} className="course-field__hint">{hint}</small>}
    {names.length > 0 && (names.length > INLINE_PICKS
      ? <ScrollWindow className="course-field__window" label={ui('已有课程')} items={names} itemKey={name => name} query={exact ? '' : query}
        showCount={!exact && !!query} maxHeight={124} listClassName="course-field__picks" itemClassName="course-field__pick-item"
        activeKey={multiple ? undefined : chosen[0] || undefined} renderItem={pick} empty={ui('没有同名课程，保存时会新建这门课。')} />
      : <div className="course-field__picks" role="group" aria-label={ui('已有课程')}>
        {names.map(name => <React.Fragment key={name}>{pick(name)}</React.Fragment>)}
      </div>)}
  </div>;
}
