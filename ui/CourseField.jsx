import React, { useId } from 'react';
import { ui } from './i18n.js';

export const parseCourses = value => [...new Set(String(value || '').split(/[;；\n]/).map(name => name.trim()).filter(Boolean))];

export default function CourseField({ courses = [], value = '', onChange, multiple = false, disabled, label = ui('课程归属') }) {
  const id = useId();
  return <label>{label}<input value={value} onChange={event => onChange(event.target.value)} list={id} disabled={disabled}
    maxLength={multiple ? 6000 : 200} placeholder={ui('留空为未分类')} />
    <datalist id={id}>{courses.map(course => {
      const name = typeof course === 'string' ? course : course.name;
      return name ? <option key={name} value={name} /> : null;
    })}</datalist>
    {multiple && <small className="muted">{ui('多门课程用分号分隔；留空为未分类。')}</small>}
  </label>;
}
