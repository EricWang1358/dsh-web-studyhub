import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { IconButton, ScrollWindow } from './components/index.js';
import { groupCourseNames, isParkedCourse, rankCourses } from './course-names.js';
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

/**
 * Pick an existing course from the list. Multiple mode toggles it and drops a
 * half-typed last part ("Databases; Stat" + Statistics → "Databases; Statistics").
 */
export function pickCourse(value, name, multiple = false, names = []) {
  if (!multiple) return name;
  const last = courseQuery(value, true);
  const current = parseCourses(value).filter(item => !(item === last && item !== name && !names.includes(item)));
  return (current.includes(name) ? current.filter(item => item !== name) : [...current, name]).join('; ');
}

/* More courses than this: ranked quick picks (chapters folded under their
   course) plus 全部课程 (N), a filterable list driven by the input. */
const MAX_CHIPS = 6;
const words = query => String(query || '').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
const hits = (text, terms) => { const value = String(text || '').normalize('NFKC').toLowerCase(); return terms.every(term => value.includes(term)); };
const uniqueCourses = courses => {
  const seen = new Set();
  return courses.map(course => typeof course === 'string' ? { name: course } : course)
    .filter(course => course?.name && !seen.has(course.name) && seen.add(course.name));
};

/**
 * The rows of the 全部课程 list: courses, collapsible course groups and their chapters, filtered by the typed text. Parked
 * (inactive) courses follow under one collapsed heading, open while filtering or when one of them is chosen.
 */
function listRows(entries, terms, openGroups, parked = { entries: [], count: 0, open: false }) {
  const live = rowsOf(entries, terms, openGroups), left = parked.entries.length ? rowsOf(parked.entries, terms, openGroups) : { rows: [], matched: 0 };
  if (!left.matched) return live;
  const expanded = parked.open || terms.length > 0;
  return { rows: [...live.rows, { key: 'parked-head', type: 'parked-head', count: terms.length ? left.matched : parked.count, expanded }, ...(expanded ? left.rows : [])],
    matched: live.matched + left.matched };
}

function rowsOf(entries, terms, openGroups) {
  const filtering = terms.length > 0, rows = [];
  let matched = 0;
  for (const entry of entries) {
    if (entry.type === 'course') {
      if (filtering && !hits(entry.course.name, terms)) continue;
      matched++;
      rows.push({ key: entry.course.name, type: 'course', course: entry.course, label: entry.course.name, depth: 0 });
      continue;
    }
    const members = [{ course: entry.parent, chapter: entry.parent.name, depth: 1 }, ...entry.chapters];
    const nameHit = filtering && hits(entry.name, terms);
    const shown = !filtering || nameHit ? members : members.filter(member => hits(member.course.name, terms));
    if (!shown.length) continue;
    matched += shown.length;
    const expanded = openGroups.has(entry.key) || filtering;
    rows.push({ key: `group:${entry.key}`, type: 'group', entry, count: shown.filter(member => member.course !== entry.parent).length, expanded });
    if (expanded) for (const member of shown)
      rows.push({ key: member.course.name, type: 'course', course: member.course, label: member.chapter, depth: member.depth || 1 });
  }
  return { rows, matched };
}

/* Existing courses come first as one-click picks (course records, WP13);
   free text still names a new course. The server gives every name its course
   id in the same transaction, so pickers stay plain text. WP14: an × clears
   the field; with many courses the picks are ranked (current, recently used,
   busiest), "Course / Chapter" names fold into one chip per course, and
   全部课程 (N) opens a list filtered by the input (↑/↓, Enter, Esc). */
export default function CourseField({ courses = [], value = '', onChange, multiple = false, disabled, label = ui('课程归属'), current, initialOpen = false }) {
  useInjectCss(css, 'study-course-field');
  const id = useId(), inputId = useId(), hintId = useId(), panelId = useId(), listboxId = useId(), chaptersId = useId();
  const input = useRef(null), root = useRef(null);
  const list = useMemo(() => uniqueCourses(courses), [courses]);
  const names = list.map(course => course.name);
  const parkedList = useMemo(() => list.filter(isParkedCourse), [list]);
  const liveList = useMemo(() => list.filter(course => !isParkedCourse(course)), [list]);
  const chosen = multiple ? parseCourses(value) : [String(value || '').trim()].filter(Boolean);
  const query = courseQuery(value, multiple);
  const exact = !!query && names.includes(query);
  const filled = !!String(value || '').trim();
  const large = names.length > MAX_CHIPS;
  const lead = current ?? chosen[0];
  const entries = useMemo(() => large ? groupCourseNames(rankCourses({ courses: liveList, current: lead })) : [], [large, liveList, lead]);
  const parkedEntries = useMemo(() => large ? groupCourseNames(rankCourses({ courses: parkedList, current: lead })) : [], [large, parkedList, lead]);
  const parkedChosen = parkedList.some(course => chosen.includes(course.name));
  const [parkedOpen, setParkedOpen] = useState(parkedChosen);
  const chosenGroup = entries.find(entry => entry.type === 'group' && (entry.chapters.some(item => chosen.includes(item.course.name)) || chosen.includes(entry.parent.name)))?.key ?? null;
  const [expanded, setExpanded] = useState(chosenGroup);
  const [open, setOpen] = useState(initialOpen && large);
  const [openGroups, setOpenGroups] = useState(() => new Set(chosenGroup ? [chosenGroup] : []));
  const [active, setActive] = useState(0);
  const terms = exact ? [] : words(query);
  const termKey = terms.join(' ');
  const { rows, matched } = useMemo(() => open ? listRows(entries, termKey ? termKey.split(' ') : [], openGroups, { entries: parkedEntries, count: parkedList.length, open: parkedOpen }) : { rows: [], matched: 0 },
    [open, entries, termKey, openGroups, parkedEntries, parkedList, parkedOpen]);
  const activeIndex = Math.min(active, rows.length - 1), activeRow = rows[activeIndex];
  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const pick = name => onChange(pickCourse(value, name, multiple, names));
  const clear = () => { onChange(''); setExpanded(null); input.current?.focus(); };
  const activate = row => {
    if (!row) return;
    if (row.type === 'parked-head') { setParkedOpen(value => !value); return; }
    if (row.type === 'group') {
      setOpenGroups(currentGroups => { const next = new Set(currentGroups); if (next.has(row.entry.key)) next.delete(row.entry.key); else next.add(row.entry.key); return next; });
      return;
    }
    pick(row.course.name);
    if (!multiple) setOpen(false);
    input.current?.focus();
  };
  const onKeyDown = event => {
    if (!large) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (!open) setOpen(true); else setActive(Math.min(activeIndex + 1, rows.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(activeIndex - 1, 0)); }
    else if (event.key === 'Enter' && open && activeRow) { event.preventDefault(); activate(activeRow); }
    else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  const chip = (course, text = course.name) => <button type="button" key={course.name} className={`course-field__pick${isParkedCourse(course) ? ' is-parked' : ''}`} aria-pressed={chosen.includes(course.name)}
    title={course.name} aria-label={text === course.name ? undefined : course.name} disabled={disabled} onClick={() => pick(course.name)}>
    <span className="course-field__pick-name">{text}</span></button>;
  const groupChip = entry => {
    const inside = entry.chapters.some(item => chosen.includes(item.course.name)) || chosen.includes(entry.parent.name);
    const isOpen = expanded === entry.key;
    return <button type="button" key={`group:${entry.key}`} className={`course-field__pick course-field__pick--group${inside ? ' has-chosen' : ''}`}
      aria-expanded={isOpen} aria-controls={isOpen ? chaptersId : undefined} title={entry.name} disabled={disabled}
      onClick={() => { if (!isOpen) pick(entry.parent.name); setExpanded(isOpen ? null : entry.key); }}>
      <span className="course-field__pick-name">{entry.name}</span>
      <span className="course-field__pick-meta">{`· ${uiFormat('{0} 章', [entry.chapters.length])}`}</span>
    </button>;
  };
  const chips = large ? entries.slice(0, MAX_CHIPS) : [];
  const expandedEntry = entries.find(entry => entry.type === 'group' && entry.key === expanded);
  const hint = multiple ? ui('多门课程用分号分隔；留空为未分类。') : names.length ? ui('输入新课程名，或点下方已有课程直接切换；点 × 清空。') : '';
  const renderRow = row => row.type === 'parked-head'
    ? <><span className="course-field__option-chevron" aria-hidden="true" /><span className="course-field__option-name">{uiFormat('未激活的课程 ({0})', [row.count])}</span></>
    : row.type === 'group'
    ? <><span className="course-field__option-chevron" aria-hidden="true" /><span className="course-field__option-name">{row.entry.name}</span>
      <small>{uiFormat('{0} 章', [row.count])}</small></>
    : <><span className="course-field__option-name" title={row.course.name}>{row.label}</span>
      {chosen.includes(row.course.name) && <small className="course-field__option-check">{ui('已选')}</small>}</>;
  return <div className="course-field" ref={root}>
    <label className="course-field__label" htmlFor={inputId}>{label}</label>
    <div className={`course-field__control${filled ? ' has-value' : ''}`}>
      <input ref={input} id={inputId} value={value} disabled={disabled} maxLength={multiple ? 6000 : 200} autoComplete="off"
        list={large || exact ? undefined : id} aria-describedby={hint ? hintId : undefined}
        {...(large ? { role: 'combobox', 'aria-expanded': open, 'aria-controls': listboxId, 'aria-autocomplete': 'list',
          'aria-activedescendant': open && activeRow ? `${listboxId}-${activeIndex}` : undefined } : {})}
        onChange={event => { onChange(event.target.value); if (large) setOpen(true); }} onKeyDown={onKeyDown}
        placeholder={ui('留空为未分类')} />
      {!large && !exact && <datalist id={id}>{names.map(name => <option key={name} value={name} />)}</datalist>}
      {filled && <IconButton icon="close" size="sm" className="course-field__clear" label={ui('清空课程')} disabled={disabled} onClick={clear} />}
    </div>
    {hint && <small id={hintId} className="course-field__hint">{hint}</small>}
    {names.length > 0 && <div className="course-field__picks" role="group" aria-label={ui('已有课程')}>
      {large ? chips.map(entry => entry.type === 'group' ? groupChip(entry) : chip(entry.course)) : [...liveList, ...parkedList].map(course => chip(course))}
      {large && <button type="button" className="course-field__pick course-field__more" aria-expanded={open} aria-controls={panelId} disabled={disabled}
        onClick={() => { setOpen(state => !state); input.current?.focus(); }}>
        {uiFormat('全部课程 ({0})', [names.length])}<span className="course-field__caret" aria-hidden="true" /></button>}
    </div>}
    {expandedEntry && !open && <div className="course-field__chapters" id={chaptersId} role="group" aria-label={uiFormat('「{0}」的章节', [expandedEntry.name])}>
      {chip(expandedEntry.parent)}
      {expandedEntry.chapters.map(item => chip(item.course, item.relative))}
    </div>}
    {open && <div className="course-field__panel" id={panelId}>
      <div className="course-field__panel-head">
        <strong>{ui('全部课程')}</strong>
        <small aria-live="polite">{terms.length ? uiFormat('显示 {0} / 共 {1} 门', [matched, names.length]) : uiFormat('共 {0} 门', [names.length])}</small>
        <IconButton icon="close" size="sm" label={ui('关闭课程列表')} onClick={() => { setOpen(false); input.current?.focus(); }} />
      </div>
      <ScrollWindow label={ui('全部课程')} items={rows} itemKey={row => row.key} renderItem={renderRow} focusable={false} maxHeight={280}
        activeKey={activeRow?.key} listClassName="course-field__options"
        listProps={{ role: 'listbox', id: listboxId, 'aria-label': ui('全部课程'), 'aria-multiselectable': multiple || undefined }}
        itemProps={(row, index) => ({ role: 'option', id: `${listboxId}-${index}`,
          className: `course-field__option course-field__option--${row.type !== 'course' ? 'group' : row.depth ? 'chapter' : 'course'}${index === activeIndex ? ' is-active' : ''}${row.course && isParkedCourse(row.course) ? ' is-parked' : ''}`,
          ...(row.depth > 1 ? { style: { '--depth': row.depth } } : { style: { '--depth': 1 } }),
          'aria-selected': row.type !== 'course' ? false : chosen.includes(row.course.name),
          ...(row.type !== 'course' ? { 'aria-expanded': row.expanded } : {}),
          onMouseDown: event => event.preventDefault(), onClick: () => activate(row) })}
        empty={uiFormat('没有名为“{0}”的课程，保存时会新建这门课。', [query])} />
    </div>}
  </div>;
}
