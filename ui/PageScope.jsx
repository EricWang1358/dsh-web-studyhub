import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { browserSession, readJSON, writeJSON } from './storage.js';
import { courseScope, courseSegments, courseTree } from '../lib/course-tree.js';
import { isParked, parkedWithin, useCourseActive } from './CourseActive.jsx';
import { useInjectCss } from './shared.js';
import { Button, Combobox } from './components/index.js';
import activeCss from './course-active.css';

const storageKey = (root, page) => `study-page-scope:v1:${JSON.stringify([root || '', page])}`;
const read = key => {
  const value = readJSON(key, undefined, browserSession());
  return typeof value === 'string' ? value : undefined;
};

/** The names of the library's courses (the snapshot's course list), for the no-space slash rule of lib/course-tree.js. */
export const courseNamesOf = data => (data?.focus?.courses || []).map(course => typeof course === 'string' ? course : course?.name).filter(name => typeof name === 'string');

/** "Is this course inside the scope?" for the snapshot's course list: a parent scope takes in its sub-courses; `*` all, `''` uncategorised. */
export const courseMatcher = (data, course) => courseScope(course, courseNamesOf(data));

/** Is this course (a name from the scope picker) parked? A parked course the learner picks on purpose is read like any other. */
export const courseParked = (data, course) => typeof course === 'string' && course !== '*' &&
  isParked((data?.focus?.courses || []).find(item => item?.name === course));

/**
 * The decks inside a course scope (a parent includes the decks of its sub-courses; reading only). Decks of parked courses
 * (lib/course-active.js; the snapshot flags them `inactive`) are left out, except inside a parked course picked on purpose
 * or when the page shows parked courses (`includeInactive`).
 */
export function decksInCourse(data, course, includeInactive = false) {
  const within = courseMatcher(data, course), counts = countsDeck(data, course, includeInactive);
  return (data?.decks || []).filter(deck => !deck.archived && !deck.systemKind && within(deck.course ?? deck.folder ?? '') && counts(deck));
}

/** `deck => boolean`: does a snapshot deck count on a page with this scope? (the rule of decksInCourse, for pages that filter decks themselves) */
export function countsDeck(data, course, includeInactive = false) {
  const parkedScope = courseParked(data, course);
  return deck => includeInactive || parkedScope || !deck.inactive;
}

/** "显示未激活的课程" for one page view (kept for this tab with the page's scope). */
export function useShowInactive(root, page) {
  const [value, choose] = usePageScope(root, `${page}:inactive`, '');
  return [value === '1', show => choose(show ? '1' : '')];
}

/** The arguments a page sends with its scope: the course, and `includeInactive` when the learner chose to show parked courses. */
export const scopeArgs = (course, showInactive = false) => showInactive ? { course, includeInactive: true } : { course };

/** Unchosen follows the visible default; explicit all (*) and unassigned ('') persist per library/page. */
export function usePageScope(root, page, defaultValue = '*') {
  const key = storageKey(root, page);
  const [saved, setSaved] = useState(() => ({ key, value: read(key) }));
  const value = saved.key === key ? saved.value : read(key);
  const choose = value => {
    setSaved({ key, value });
    writeJSON(key, value, browserSession()); // memory still works when the storage refuses it
  };
  return [value ?? defaultValue, choose];
}

/**
 * Scope of a page: all, one course (a parent includes its sub-courses), or uncategorised. Courses form a tree:
 * children hang under their parent (a level-2 option on the hairline) and show their last segment; the value is always the full name.
 */
export default function PageScope({ courses = [], value, onChange, disabled, unassigned = true, label = ui('课程范围'), selectedLabel, showInactive, onShowInactive }) {
  useInjectCss(activeCss, 'study-course-active');
  const active = useCourseActive();
  const entries = courses.map(course => typeof course === 'string' ? { name: course } : course).filter(course => course?.name && course.name !== '*');
  const names = entries.map(course => course.name);
  const rows = courseTree(names);
  const listed = new Set(rows.flatMap(row => row.names));
  const parkedNames = new Set(entries.filter(isParked).map(course => course.name));
  const parkedRow = row => (row.names.length ? row.names : [row.name]).every(name => parkedNames.has(name));
  const live = rows.filter(row => !parkedRow(row)), parked = rows.filter(parkedRow);
  const chosen = typeof value === 'string' && value !== '*' && value !== '@selected' ? rows.find(row => row.names.includes(value) || row.name === value) : null;
  const path = chosen && chosen.depth > 0 ? courseSegments(chosen.name, names).join(' › ') : '';
  const chosenCourse = chosen ? entries.find(course => chosen.names.includes(course.name) || course.name === chosen.name) : null;
  // What this page leaves out, and the one-click way to see it (only for pages that send includeInactive, see scopeArgs).
  const hidden = chosenCourse && isParked(chosenCourse) ? 0 : parkedWithin(courses, value === '@selected' ? '*' : value);
  // A parked chapter whose parent is not parked is listed with its whole path: its parent is not in the same group.
  const optionsOf = (row, group = live) => (row.names.length ? row.names : [row.name]).map((name, index) => {
    const alone = row.parent && !group.some(item => item.name === row.parent);
    return { value: name, label: alone ? name : row.label, level: alone ? 1 : Math.min(row.depth + 1, 3), hint: row.childCount && index === 0 ? ui('含子课程') : undefined };
  });
  const strayValue = value && value !== '*' && value !== '@selected' && !listed.has(value) && !rows.some(row => row.name === value);
  const options = [{ value: '*', label: ui('全部课程') },
    ...(selectedLabel ? [{ value: '@selected', label: selectedLabel }] : []),
    ...live.flatMap(row => optionsOf(row)),
    ...(unassigned ? [{ value: '', label: ui('未分类') }] : []),
    ...(parked.length > 0 ? [{ group: uiFormat('未激活的课程 ({0})', [parked.length]), options: parked.flatMap(row => optionsOf(row, parked)) }] : []),
    ...(strayValue ? [{ value, label: value }] : [])];
  return <label className="page-scope">{label}<Combobox value={value} onChange={onChange} disabled={disabled} options={options} label={label} searchPlaceholder={ui('搜索课程或章节')}
    emptyText={query => uiFormat('没有叫「{0}」的课程或章节', [query])} title={chosen ? chosen.name : undefined} />{path && <small className="page-scope__path" title={chosen.name}>{path}</small>}
    {chosenCourse && isParked(chosenCourse) && <small className="page-scope__note">
      <span>{ui('这门课未激活')}</span>
      {active && <span aria-hidden="true">·</span>}
      {active && <Button variant="link" size="sm" onClick={() => active.activate(chosenCourse).catch(() => {})}>{ui('激活')}</Button>}
    </small>}
    {onShowInactive && hidden > 0 && <small className="page-scope__note">
      <span>{showInactive ? uiFormat('含 {0} 门未激活的课程', [hidden]) : uiFormat('不含 {0} 门未激活的课程', [hidden])}</span>
      <span aria-hidden="true">·</span>
      <Button variant="link" size="sm" aria-pressed={!!showInactive} onClick={() => onShowInactive(!showInactive)}>{showInactive ? ui('隐藏') : ui('显示')}</Button>
    </small>}
  </label>;
}
