import React, { useState } from 'react';
import { ui } from './i18n.js';

const storageKey = (root, page) => `study-page-scope:v1:${JSON.stringify([root || '', page])}`;
const read = key => {
  try { const value = JSON.parse(sessionStorage.getItem(key)); return typeof value === 'string' ? value : undefined; }
  catch { return undefined; }
};

export const decksInCourse = (data, course) => (data?.decks || []).filter(deck => !deck.archived && !deck.systemKind &&
  (course === '*' || (deck.course ?? deck.folder ?? '') === course));

/** Unchosen follows the visible default; explicit all (*) and unassigned ('') persist per library/page. */
export function usePageScope(root, page, defaultValue = '*') {
  const key = storageKey(root, page);
  const [saved, setSaved] = useState(() => ({ key, value: read(key) }));
  const value = saved.key === key ? saved.value : read(key);
  const choose = value => {
    setSaved({ key, value });
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* memory still works */ }
  };
  return [value ?? defaultValue, choose];
}

export default function PageScope({ courses = [], value, onChange, disabled, unassigned = true, label = ui('课程范围'), selectedLabel }) {
  const names = courses.map(course => typeof course === 'string' ? course : course.name);
  return <label className="page-scope">{label}<select value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
    <option value="*">{ui('全部课程')}</option>
    {selectedLabel && <option value="@selected">{selectedLabel}</option>}
    {names.filter(name => name && name !== '*').map(name => <option key={name} value={name}>{name}</option>)}
    {unassigned && <option value="">{ui('未分类')}</option>}
    {value && value !== '*' && value !== '@selected' && !names.includes(value) && <option value={value}>{value}</option>}
  </select></label>;
}
