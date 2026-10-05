import React, { createContext, useContext, useId, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, InlineMessage } from './components/index.js';
import { courseScope } from '../lib/course-tree.js';
import css from './course-active.css';

/* 有效课程 (2.3.2): one switch per course, one chip, one notice for every place that parks or revives a course.
   A parked course ("未激活") stays out of due counts, the forecast, the queue and suggestions until it is activated again;
   its cards and review progress are never touched (lib/course-active.js). The pickers (ui/PageScope.jsx,
   ui/CourseField.jsx, the home's course switcher) group parked courses and say what a page leaves out. */

const Context = createContext(null);
/** App provides `{ setActive(course, active, options) -> result, activate(course), manage() }`; without it the controls that need it hide. */
export const CourseActiveProvider = Context.Provider;
export const useCourseActive = () => useContext(Context);

const nameOf = course => typeof course === 'string' ? course : String(course?.name || '');
/** A course the learner (or its parent) parked: the snapshot lists `active: false`. */
export const isParked = course => typeof course === 'object' && course !== null && course.active === false;

/** The listed courses inside `course` that parking it takes along: active, and without a setting of their own. */
export function liveSubCourses(courses = [], course) {
  const names = courses.map(nameOf), name = nameOf(course), within = courseScope(name, names);
  return courses.filter(item => nameOf(item) !== name && within(nameOf(item)) && item.active !== false && item.explicit !== true);
}

/** How many parked courses that hold decks sit inside a page scope (`*`, a course, a parent): what the page leaves out. */
export function parkedWithin(courses = [], scope = '*') {
  const within = courseScope(typeof scope === 'string' ? scope : '*', courses.map(nameOf));
  return courses.filter(item => isParked(item) && (item.count ?? item.decks ?? 0) > 0 && within(nameOf(item))).length;
}

/** The notice after course.setActive: honest numbers, never more than the backend counted. */
export function activeNotice(result = {}) {
  const name = result.name || '';
  if (!result.changed) return { tone: 'info', text: result.active ? ui('这门课已经是有效课程') : ui('这门课已经是未激活状态'), detail: '' };
  if (result.active) {
    return { tone: 'success',
      text: result.due ? uiFormat('已激活「{0}」，到期 {1} 题（其中逾期 {2} 题）', [name, result.due, result.overdue || 0]) : uiFormat('已激活「{0}」，现在没有到期的题', [name]),
      // The daily queue hands out a bounded batch; say so when the backlog is big, never promise a schedule change.
      detail: (result.overdue || 0) > 20 ? ui('复习队列一次最多 20 题，逾期的会分批排上来，不会一次全压给你。') : '' };
  }
  return { tone: 'success',
    text: result.decks
      ? uiFormat('「{0}」已设为未激活：{1} 个题组里 {2} 题的到期复习不再推给你；复习进度原样保留，随时可以再激活', [name, result.decks, result.due || 0])
      : uiFormat('「{0}」已设为未激活：不再进入到期复习和推荐；复习进度原样保留，随时可以再激活', [name]),
    detail: result.subCourses?.length ? uiFormat('同时停用了 {0} 门子课程', [result.subCourses.length]) : '' };
}

const sentence = course => isParked(course)
  ? course.inactiveBy ? uiFormat('随「{0}」未激活；可以单独设为有效', [course.inactiveBy]) : ui('未激活：不进入到期复习和推荐；复习进度原样保留，激活后恢复')
  : course.explicit === true ? ui('已单独设为有效，不受上级课程影响') : ui('未激活的课程不进入到期复习和推荐；随时可以再激活');

/**
 * The switch (Settings › 课程, a course's settings): `courses` is the snapshot's course list (for the sub-courses a parent takes
 * along). Parking a parent asks once whether its sub-courses go too. Feedback stays next to the switch as well as in the toast.
 * `compact` drops the sentence (list rows say it once above the list).
 */
export function ActiveSwitch({ course, courses = [], disabled = false, compact = false, defaultConfirm = false }) {
  useInjectCss(css, 'study-course-active');
  const api = useCourseActive();
  const [state, setState] = useState({ confirm: defaultConfirm, working: false, text: '', error: '' });
  const id = useId();
  if (!course || !api) return null;
  const parked = isParked(course), subs = liveSubCourses(courses, course);
  const set = async (active, options = {}) => {
    setState(current => ({ ...current, working: true, error: '' }));
    try {
      const note = activeNotice(await api.setActive(course, active, options));
      setState({ confirm: false, working: false, text: [note.text, note.detail].filter(Boolean).join(' '), error: '' });
    } catch (error) {
      setState(current => ({ ...current, working: false, error: errorMessage(error) }));
    }
  };
  const toggle = () => parked ? set(true) : subs.length ? setState(current => ({ ...current, confirm: true })) : set(false);
  return <div className={`course-active${compact ? ' is-compact' : ''}${parked ? ' is-parked' : ''}`}>
    <div className="course-active__row">
      <button type="button" role="switch" className="course-active__switch" aria-checked={!parked} id={id}
        aria-label={compact ? `${ui('有效课程')} · ${nameOf(course)}` : ui('有效课程')} title={sentence(course)} disabled={disabled || state.working} onClick={toggle} />
      {!compact && <label className="course-active__text" htmlFor={id}>
        <strong>{ui('有效课程')}</strong>
        <small>{sentence(course)}</small>
      </label>}
      {compact && <span className="course-active__state">{parked ? ui('未激活') : ui('有效')}</span>}
    </div>
    {state.confirm && !parked && <InlineMessage tone="warning" boxed title={uiFormat('「{0}」含 {1} 门子课程，要一起设为未激活吗？', [nameOf(course), subs.length])}>
      <div className="course-active__confirm">
        <Button size="sm" variant="primary" busy={state.working} onClick={() => set(false, { withSubCourses: true })}>{ui('连同子课程一起')}</Button>
        <Button size="sm" variant="secondary" disabled={state.working} onClick={() => set(false, { withSubCourses: false })}>{ui('只停这一门')}</Button>
        <Button size="sm" variant="quiet" disabled={state.working} onClick={() => setState(current => ({ ...current, confirm: false }))}>{ui('取消')}</Button>
      </div>
    </InlineMessage>}
    {state.error && <InlineMessage tone="error">{state.error}</InlineMessage>}
    {state.text && !state.error && <small className="course-active__result" role="status">{state.text}</small>}
  </div>;
}

/** "未激活 · 激活": the compact marker for a parked course next to its name. Nothing for an active course. */
export function ParkedChip({ course, className = '' }) {
  useInjectCss(css, 'study-course-active');
  const api = useCourseActive();
  const [state, setState] = useState({ working: false, error: '' });
  if (!isParked(course)) return null;
  const activate = async () => {
    setState({ working: true, error: '' });
    try { await api.activate(course); setState({ working: false, error: '' }); }
    catch (error) { setState({ working: false, error: errorMessage(error) }); }
  };
  return <Badge size="sm" className={`course-parked ${className}`.trim()} title={sentence(course)}>
    <span>{ui('未激活')}</span>
    {api && <Button variant="link" size="sm" busy={state.working} onClick={activate}>{ui('激活')}</Button>}
    {state.error && <span role="alert" className="course-parked__error">{state.error}</span>}
  </Badge>;
}
