import React, { useState } from 'react';
import { ui } from './i18n.js';
import { courseScope, courseSegments, courseTree } from '../lib/course-tree.js';

const storageKey = (root, page) => `study-page-scope:v1:${JSON.stringify([root || '', page])}`;
const read = key => {
  try { const value = JSON.parse(sessionStorage.getItem(key)); return typeof value === 'string' ? value : undefined; }
  catch { return undefined; }
};

/** The names of the library's courses (the snapshot's course list), for the no-space slash rule of lib/course-tree.js. */
export const courseNamesOf = data => (data?.focus?.courses || []).map(course => typeof course === 'string' ? course : course?.name).filter(name => typeof name === 'string');

/** "Is this course inside the scope?" for the snapshot's course list: a parent scope takes in its sub-courses; `*` all, `''` uncategorised. */
export const courseMatcher = (data, course) => courseScope(course, courseNamesOf(data));

/** The active decks inside a course scope (a parent includes the decks of its sub-courses; reading only). */
export function decksInCourse(data, course) {
  const within = courseMatcher(data, course);
  return (data?.decks || []).filter(deck => !deck.archived && !deck.systemKind && within(deck.course ?? deck.folder ?? ''));
}

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

/* Depth is shown as padding on the option: the open list indents, the closed select shows the chosen name flush left (leading
   spaces in the label would have been shown in the closed select too). */
const indent = depth => depth > 0 ? { paddingInlineStart: `${(depth * 1.25).toFixed(2)}em` } : undefined;

/**
 * Scope of a page: all, one course (a parent includes its sub-courses), or uncategorised. Courses form a tree:
 * children are indented under their parent and show their last segment; the value is always the full name.
 */
export default function PageScope({ courses = [], value, onChange, disabled, unassigned = true, label = ui('课程范围'), selectedLabel }) {
  const names = courses.map(course => typeof course === 'string' ? course : course.name).filter(name => name && name !== '*');
  const rows = courseTree(names);
  const listed = new Set(rows.flatMap(row => row.names));
  const chosen = typeof value === 'string' && value !== '*' && value !== '@selected' ? rows.find(row => row.names.includes(value) || row.name === value) : null;
  const path = chosen && chosen.depth > 0 ? courseSegments(chosen.name, names).join(' › ') : '';
  return <label className="page-scope">{label}<select value={value} onChange={event => onChange(event.target.value)} disabled={disabled}
    title={chosen ? chosen.name : undefined}>
    <option value="*">{ui('全部课程')}</option>
    {selectedLabel && <option value="@selected">{selectedLabel}</option>}
    {rows.flatMap(row => (row.names.length ? row.names : [row.name]).map((name, index) =>
      <option key={name} value={name} title={row.depth > 0 ? name : undefined} style={indent(row.depth)}>{row.label}{row.childCount && index === 0 ? ` · ${ui('含子课程')}` : ''}</option>))}
    {unassigned && <option value="">{ui('未分类')}</option>}
    {value && value !== '*' && value !== '@selected' && !listed.has(value) && !rows.some(row => row.name === value) && <option value={value}>{value}</option>}
  </select>{path && <small className="page-scope__path" title={chosen.name}>{path}</small>}</label>;
}
