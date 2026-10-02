import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Dialog, Disclosure, EmptyState, Icon, IconButton, InlineMessage, ScrollWindow, SegmentedControl } from './components/index.js';
import SourcePicker from './SourcePicker.jsx';
import { ActiveSwitch, isParked } from './CourseActive.jsx';
import { daysUntilExam, examProfile } from '../lib/courses.js';
import { courseNameKey, findDuplicateCourses, groupCourseNames, rankCourses } from './course-names.js';
import css from './course-settings.css';

/* Course settings (WP13): one panel per course record — name and aliases,
   the exam profile, focus topics and examiner-guidance materials, plus rename
   and merge. Reached from the library's course switcher and from Settings.
   Every action is one store transaction on the server (course.save,
   course.rename, course.merge). 有效课程: a switch per course (course.setActive). */

const FORMAT_LABELS = { 'open-book-case': '开卷案例', 'closed-book': '闭卷', mixed: '混合', other: '其他' };
export const examFormatLabel = format => ui(FORMAT_LABELS[format] || FORMAT_LABELS.other);
const text = value => value === undefined || value === null ? '' : String(value);
const number = value => { const trimmed = String(value ?? '').trim(); return trimmed === '' ? undefined : Number(trimmed); };
export const splitTopics = value => [...new Set(String(value || '').split(/[;；\n]/).map(item => item.trim()).filter(Boolean))];

/** The form state for a course record (strings for inputs; empty means "use the default"). */
export function draftFromCourse(course = {}) {
  const exam = course.exam || {};
  return {
    format: exam.format || 'other', totalMarks: text(exam.totalMarks), writingMinutes: text(exam.writingMinutes),
    readingMinutes: text(exam.readingMinutes), minutesPerMark: text(exam.minutesPerMark), date: exam.date || '',
    sections: (exam.sections || []).map(section => ({ title: section.title || '', lecturer: section.lecturer || '',
      marks: text(section.marks), topics: (section.topics || []).join('; ') })),
    focusTopics: (course.focusTopics || []).join('; '), guidanceSourceIds: [...(course.guidanceSourceIds || [])],
  };
}

/** What course.save receives. An untouched empty profile does not invent an exam. */
export function payloadFromDraft(course, draft) {
  const numbers = Object.fromEntries(['totalMarks', 'writingMinutes', 'readingMinutes', 'minutesPerMark']
    .map(key => [key, number(draft[key])]).filter(([, value]) => value !== undefined));
  const sections = draft.sections.filter(section => section.title.trim()).map(section => ({
    title: section.title.trim(), ...(section.lecturer.trim() ? { lecturer: section.lecturer.trim() } : {}),
    ...(number(section.marks) !== undefined ? { marks: number(section.marks) } : {}), topics: splitTopics(section.topics) }));
  const stated = course.exam || draft.format !== 'other' || Object.keys(numbers).length || draft.date || sections.length;
  return { id: course.id, name: course.name,
    ...(stated ? { exam: { format: draft.format, ...numbers, ...(draft.date ? { date: draft.date } : {}), sections } } : {}),
    guidanceSourceIds: draft.guidanceSourceIds, focusTopics: splitTopics(draft.focusTopics) };
}

/** "距考试 N 天" for the library heading; null without a date or once the exam is past. */
export function examCountdown(exam, now = new Date()) {
  const days = daysUntilExam(exam, now);
  if (days === null || days < 0) return null;
  const label = days === 0 ? ui('今天考试') : days === 1 ? ui('距考试 1 天') : uiFormat('距考试 {0} 天', [days]);
  return { days, text: label, format: exam.format && exam.format !== 'other' ? examFormatLabel(exam.format) : '' };
}

export function ExamCountdown({ course, now }) {
  useInjectCss(css, 'study-course-settings');
  const countdown = course?.exam ? examCountdown(course.exam, now) : null;
  if (!countdown) return null;
  return <small className="course-heading-exam" title={course.exam.date}>
    {countdown.text}{countdown.format ? ` · ${countdown.format}` : ''}
  </small>;
}

const counted = (count, one, many) => count === 1 ? ui(one) : uiFormat(many, [count]);
/** Counts of a course; a parent that holds sub-courses shows what the whole subtree holds and says so (含子课程). */
const countLine = course => {
  const whole = (course.decksTotal ?? 0) > (course.decks ?? 0) || (course.sourcesTotal ?? 0) > (course.sources ?? 0);
  const decks = whole ? course.decksTotal : course.decks, sources = whole ? course.sourcesTotal : course.sources;
  const line = [decks ? counted(decks, '1 个题组', '{0} 个题组') : '', sources ? counted(sources, '1 份资料', '{0} 份资料') : ''].filter(Boolean).join(' · ');
  return whole && line ? `${line} · ${ui('含子课程')}` : line;
};

const courseMeta = course => {
  const countdown = course.exam ? examCountdown(course.exam) : null;
  return [countLine(course), course.aliases?.length ? uiFormat('也叫 {0}', [course.aliases.join(' · ')]) : '', countdown ? countdown.text : ''].filter(Boolean).join(' · ');
};

/** One compact course row: name, counts, a duplicate hint with its merge action, and 设置. */
function CourseRow({ course, label = course.name, duplicates = [], onOpen, onMerge, busy, current, all = [] }) {
  const meta = courseMeta(course);
  return <div className={`course-list__item${current ? ' is-current' : ''}${isParked(course) ? ' is-parked-row' : ''}`}>
    <span className="course-list__text">
      <strong title={course.name}>{label}</strong>
      {(meta || current) && <small>{[current ? ui('当前课程') : '', meta].filter(Boolean).join(' · ')}</small>}
      {duplicates.length > 0 && <span className="course-list__duplicate">
        <Icon name="warning" size={14} />
        <span>{uiFormat('可能与「{0}」重复', [duplicates.map(item => item.name).join('」「')])}</span>
        {onMerge && <Button size="sm" variant="link" disabled={busy} onClick={() => onMerge(course.id, duplicates.map(item => item.id))}>{ui('合并到这里')}</Button>}
      </span>}
    </span>
    {course.id && <ActiveSwitch course={course} courses={all} compact disabled={busy} />}
    {course.id && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpen?.(course.id)}>{ui('设置')}</Button>}
  </div>;
}

const entryKey = entry => entry.type === 'group' ? `group:${entry.key}` : entry.course.id || entry.course.name;
const entryText = entry => entry.type === 'group'
  ? [entry.name, ...entry.chapters.map(item => item.course.name), ...entry.chapters.flatMap(item => item.course.aliases || [])].join(' ')
  : [entry.course.name, ...(entry.course.aliases || [])].join(' ');

/**
 * Settings: every course with its panel one click away (WP13), in a bounded,
 * filterable window of compact rows (WP14). "Course / Chapter" names are
 * grouped under the course, collapsed; near-duplicate names get a hint and
 * 合并到这里, which opens the merge confirmation. Props: courses, onOpen(id),
 * onMerge(intoId, fromIds), busy, currentId, recent (name → last used, for the
 * shared ranking: current, recently used, busiest), defaultOpenGroups, defaultQuery.
 */
export function CourseList({ courses = [], onOpen, onMerge, busy, currentId, recent, defaultOpenGroups = [], defaultQuery = '' }) {
  useInjectCss(css, 'study-course-settings');
  const currentName = courses.find(course => course.id === currentId)?.name;
  const entries = useMemo(() => groupCourseNames(rankCourses({ courses, current: currentName, recent })), [courses, currentName, recent]);
  const duplicates = useMemo(() => findDuplicateCourses(courses), [courses]);
  const [open, setOpen] = useState(() => new Set(defaultOpenGroups));
  const [query, setQuery] = useState(defaultQuery);
  const filtering = !!query.trim();
  const dupesOf = course => duplicates.get(course.id || course.name) || [];
  const toggle = name => setOpen(current => { const next = new Set(current); next.has(name) ? next.delete(name) : next.add(name); return next; });
  const activeKey = entries.map(entry => entry.type === 'group'
    ? (entry.chapters.some(item => item.course.id === currentId) || (entry.parent.id && entry.parent.id === currentId)) && entryKey(entry)
    : entry.course.id === currentId && entryKey(entry)).find(Boolean) || undefined;
  const renderEntry = entry => {
    if (entry.type === 'course') return <CourseRow course={entry.course} duplicates={dupesOf(entry.course)} onOpen={onOpen} onMerge={onMerge} busy={busy}
      current={entry.course.id === currentId} all={courses} />;
    const words = query.trim().normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    const hit = item => words.every(word => item.course.name.normalize('NFKC').toLowerCase().includes(word));
    const chapters = filtering && !words.every(word => entry.name.normalize('NFKC').toLowerCase().includes(word)) ? entry.chapters.filter(hit) : entry.chapters;
    const expanded = open.has(entry.name) || (filtering && chapters.length > 0);
    const flagged = new Set(entry.chapters.filter(item => dupesOf(item.course).length).map(item => courseNameKey(item.course))).size;
    const sources = entry.parent.sourcesTotal ?? entry.chapters.reduce((sum, item) => sum + (item.course.sources || 0), entry.parent.sources || 0);
    const meta = [uiFormat('{0} 个章节', [entry.chapters.length]), sources ? uiFormat('含子课程共 {0} 份资料', [sources]) : ''].filter(Boolean).join(' · ');
    return <div className="course-list__group">
      <div className="course-list__group-head">
        <button type="button" className="course-list__toggle" aria-expanded={expanded} onClick={() => toggle(entry.name)}>
          <Icon name="chevron" size={16} />
          <span className="course-list__text">
            <strong title={entry.name}>{entry.name}</strong>
            <small>{meta}{flagged ? <span className="course-list__flag">{' · '}{uiFormat('{0} 处可能重复', [flagged])}</span> : null}</small>
          </span>
        </button>
        {/* A parent nobody filed a deck under has no record yet: it is active until parked, and parking it creates its record. */}
        <ActiveSwitch course={entry.parent.id ? entry.parent : { ...entry.parent, active: true }} courses={courses} compact disabled={busy} />
        {entry.parent.id && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpen?.(entry.parent.id)}>{ui('设置')}</Button>}
      </div>
      {expanded && <ul className="course-list__chapters" aria-label={uiFormat('「{0}」的章节', [entry.name])}>
        {chapters.map(item => <li key={item.course.id || item.course.name} className={item.depth > 1 ? 'course-list__chapter--nested' : undefined} style={item.depth > 1 ? { '--depth': item.depth - 1 } : undefined}>
          <CourseRow course={item.course} label={item.chapter} duplicates={dupesOf(item.course)} onOpen={onOpen} onMerge={onMerge} busy={busy}
            current={item.course.id === currentId} all={courses} />
        </li>)}
      </ul>}
    </div>;
  };
  return <fieldset className="course-list settings-section">
    <legend className="settings-section__title">{ui('课程')}</legend>
    <p className="settings-section__lead">{ui('每门课可以记下考试形式、日期、分值和考官指引；改名或合并会同步更新所有题组和资料。')}</p>
    <p className="settings-section__lead">{ui('未激活的课程不进入到期复习和推荐；随时可以再激活')}</p>
    {courses.length ? <ScrollWindow className="course-list__window" label={ui('课程列表')} items={entries} itemKey={entryKey} match={entryText}
      renderItem={renderEntry} filterable={entries.length > 6 || filtering} filterPlaceholder={ui('筛选课程…')} query={query} onQueryChange={setQuery}
      activeKey={activeKey} maxHeight={400} listClassName="course-list__items" itemClassName="course-list__entry" />
      : <EmptyState size="sm" icon="folder" title={ui('还没有课程')} description={ui('导入资料或发布题组时填写课程，这里就会出现。')} />}
  </fieldset>;
}

function NumberField({ label, value, placeholder, onChange, min = 0, step = 1, disabled, suffix }) {
  return <label className="course-settings__field">
    <span>{label}</span>
    <span className="course-settings__number">
      <input type="number" inputMode="decimal" min={min} step={step} value={value} placeholder={String(placeholder)} disabled={disabled}
        onChange={event => onChange(event.target.value)} />
      {suffix && <small>{suffix}</small>}
    </span>
  </label>;
}

function SectionRow({ section, index, onChange, onRemove, disabled }) {
  const set = key => event => onChange({ ...section, [key]: event.target.value });
  return <li className="course-settings__section-row">
    <div className="course-settings__section-head">
      <strong>{uiFormat('第 {0} 部分', [index + 1])}</strong>
      <IconButton icon="close" size="sm" label={uiFormat('删除第 {0} 部分', [index + 1])} disabled={disabled} onClick={onRemove} />
    </div>
    <div className="course-settings__grid">
      <label className="course-settings__field course-settings__wide"><span>{ui('标题')}</span>
        <input value={section.title} maxLength={200} disabled={disabled} onChange={set('title')} /></label>
      <label className="course-settings__field"><span>{ui('讲师')}</span>
        <input value={section.lecturer} maxLength={200} disabled={disabled} onChange={set('lecturer')} /></label>
      <label className="course-settings__field"><span>{ui('分值')}</span>
        <input type="number" min={0} step={1} value={section.marks} disabled={disabled} onChange={set('marks')} /></label>
      <label className="course-settings__field course-settings__wide"><span>{ui('考查知识点')}</span>
        <input value={section.topics} disabled={disabled} placeholder={ui('用分号分隔')} onChange={set('topics')} /></label>
    </div>
  </li>;
}

/**
 * Props: data (snapshot: courses, sources, focus), courseId, act (App's act;
 * called with rethrow so errors stay in the panel), busy, setNotice, onClose.
 */
export default function CourseSettings({ data, courseId, act, busy = false, setNotice, onClose, mergeFrom = [] }) {
  useInjectCss(css, 'study-course-settings');
  const courses = useMemo(() => data?.courses || [], [data?.courses]);
  const course = courses.find(item => item.id === courseId);
  const [draft, setDraft] = useState(() => draftFromCourse(course));
  const [name, setName] = useState(course?.name || '');
  // 合并到这里 (WP14) opens the panel with the duplicate chosen and the merge confirmation showing.
  const [confirm, setConfirm] = useState(() => mergeFrom.length ? 'merge' : null); // 'rename' | 'merge'
  const [mergeIds, setMergeIds] = useState(() => mergeFrom.filter(id => id !== courseId && courses.some(item => item.id === id)));
  const mergeCancel = useRef(null);
  useEffect(() => {
    if (!mergeFrom.length) return;
    const frame = requestAnimationFrame(() => mergeCancel.current?.scrollIntoView?.({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  if (!course) return null;
  const disabled = busy || working;
  const defaults = examProfile(payloadFromDraft(course, draft).exam);
  const others = courses.filter(item => item.id !== course.id);
  const likely = new Set([...(findDuplicateCourses(courses).get(course.id) || []).map(item => item.id), ...mergeFrom]);
  const mergeCandidates = [...others.filter(item => likely.has(item.id)), ...others.filter(item => !likely.has(item.id))];
  const change = patch => setDraft(current => ({ ...current, ...patch }));
  const run = async (action, args, done) => {
    setWorking(true); setError('');
    try { await act(action, args, done, { rethrow: true }); }
    catch (caught) { setError(caught?.message || String(caught)); }
    finally { setWorking(false); }
  };
  const save = () => run('course.save', payloadFromDraft(course, draft), () => {
    setNotice?.({ text: uiFormat('已保存「{0}」的课程信息', [course.name]), tone: 'success' });
    onClose?.('saved');
  });
  const rename = () => run('course.rename', { id: course.id, name: name.trim() }, result => {
    setConfirm(null); setName(result?.course?.name || name.trim());
    setNotice?.({ text: uiFormat('已改名为「{0}」，题组、资料和练习都已同步', [result?.course?.name || name.trim()]), tone: 'success' });
  });
  const merge = () => run('course.merge', { from: mergeIds, into: course.id }, result => {
    setConfirm(null); setMergeIds([]);
    setNotice?.({ text: uiFormat('已把 {0} 门课程并入「{1}」', [result?.merged?.length || mergeIds.length, course.name]), tone: 'success' });
  });
  const renamed = name.trim() && name.trim() !== course.name;
  const mergeNames = others.filter(item => mergeIds.includes(item.id)).map(item => item.name);
  const formats = Object.keys(FORMAT_LABELS).map(value => ({ value, label: examFormatLabel(value) }));
  return (
    <Dialog size="lg" className="course-settings" title={course.name}
      description={[ui('课程设置'), countLine(course)].filter(Boolean).join(' · ')} onClose={() => { if (!working) onClose?.('dismiss'); }}
      footer={<>
        {error && <InlineMessage className="course-settings__error">{error}</InlineMessage>}
        <Button variant="quiet" disabled={working} onClick={() => onClose?.('cancel')}>{ui('关闭')}</Button>
        <Button variant="primary" icon="check" busy={working && !confirm} disabled={disabled} onClick={save}>{ui('保存课程信息')}</Button>
      </>}>
      <section className="course-settings__block" aria-labelledby="course-settings-name">
        <h3 id="course-settings-name">{ui('名称')}</h3>
        <div className="course-settings__rename">
          <label className="course-settings__field course-settings__wide"><span>{ui('课程名称')}</span>
            <input value={name} maxLength={200} disabled={disabled} onChange={event => { setName(event.target.value); setConfirm(null); }} /></label>
          <Button variant="secondary" disabled={disabled || !renamed} onClick={() => setConfirm('rename')}>{ui('改名')}</Button>
        </div>
        {confirm === 'rename' && renamed && <InlineMessage tone="warning" boxed title={uiFormat('把「{0}」改名为「{1}」？', [course.name, name.trim()])}>
          <p>{ui('所有题组、资料、练习和学习流会一起改名；旧名称保留为别名，旧资料仍能找到这门课。')}</p>
          <div className="course-settings__confirm">
            <Button size="sm" variant="primary" busy={working} disabled={busy} onClick={rename}>{ui('确认改名')}</Button>
            <Button size="sm" variant="quiet" disabled={working} onClick={() => setConfirm(null)}>{ui('取消')}</Button>
          </div>
        </InlineMessage>}
        <p className="course-settings__aliases">
          <span>{ui('别名（旧名称，只读）')}</span>
          {course.aliases?.length ? course.aliases.map(alias => <span key={alias} className="course-settings__alias">{alias}</span>)
            : <small>{ui('还没有别名')}</small>}
        </p>
      </section>

      <section className="course-settings__block" aria-label={ui('有效课程')}>
        <ActiveSwitch course={course} courses={courses} disabled={disabled} />
      </section>

      <section className="course-settings__block" aria-labelledby="course-settings-exam">
        <h3 id="course-settings-exam">{ui('考试信息')}</h3>
        <div className="course-settings__field">
          <span>{ui('考试形式')}</span>
          <SegmentedControl size="sm" label={ui('考试形式')} value={draft.format} options={formats} disabled={disabled}
            onChange={format => change({ format })} />
        </div>
        <div className="course-settings__grid">
          <NumberField label={ui('总分')} value={draft.totalMarks} placeholder={defaults.totalMarks} min={1} disabled={disabled} onChange={totalMarks => change({ totalMarks })} />
          <NumberField label={ui('作答时间')} suffix={ui('分钟')} value={draft.writingMinutes} placeholder={defaults.writingMinutes} min={1} disabled={disabled} onChange={writingMinutes => change({ writingMinutes })} />
          <NumberField label={ui('阅读时间')} suffix={ui('分钟')} value={draft.readingMinutes} placeholder={defaults.readingMinutes} disabled={disabled} onChange={readingMinutes => change({ readingMinutes })} />
          <NumberField label={ui('每分用时')} suffix={ui('分钟')} value={draft.minutesPerMark} placeholder={defaults.minutesPerMark} min={0.1} step={0.1} disabled={disabled} onChange={minutesPerMark => change({ minutesPerMark })} />
          <label className="course-settings__field"><span>{ui('考试日期')}</span>
            <input type="date" value={draft.date} disabled={disabled} onChange={event => change({ date: event.target.value })} /></label>
        </div>
        <p className="course-settings__hint">{ui('留空的项按默认推算：每分 3 分钟，阅读时间约为作答时间的 1/5（5–30 分钟）。')}</p>
        <div className="course-settings__subhead"><strong>{ui('考试部分')}</strong>
          <Button size="sm" variant="quiet" icon="plus" disabled={disabled || draft.sections.length >= 20}
            onClick={() => change({ sections: [...draft.sections, { title: '', lecturer: '', marks: '', topics: '' }] })}>{ui('添加考试部分')}</Button></div>
        {draft.sections.length ? <ol className="course-settings__sections">
          {draft.sections.map((section, index) => <SectionRow key={index} index={index} section={section} disabled={disabled}
            onChange={next => change({ sections: draft.sections.map((item, at) => at === index ? next : item) })}
            onRemove={() => change({ sections: draft.sections.filter((_, at) => at !== index) })} />)}
        </ol> : <p className="course-settings__hint">{ui('按讲师或题型分几部分时，在这里写下每部分的分值和考查知识点。')}</p>}
      </section>

      <section className="course-settings__block" aria-labelledby="course-settings-focus">
        <h3 id="course-settings-focus">{ui('重点知识点')}</h3>
        <p className="course-settings__hint">{ui('复习、出题和案例分析会优先照顾这些知识点。')}</p>
        <label className="course-settings__field">
          <input aria-label={ui('重点知识点')} value={draft.focusTopics} disabled={disabled} placeholder={ui('用分号分隔，例如 迁移策略；数据一致性')}
            onChange={event => change({ focusTopics: event.target.value })} /></label>
      </section>

      <Disclosure className="course-settings__disclosure" summary={ui('考官指引')}
        meta={draft.guidanceSourceIds.length ? uiFormat('已选 {0} 份', [draft.guidanceSourceIds.length]) : ui('未选择')}
        defaultOpen={draft.guidanceSourceIds.length > 0}>
        <p className="course-settings__hint">{ui('选入考官讲解或考试说明（例如导入的说明会逐字稿），出案例题和批改时会参考。')}</p>
        <SourcePicker sources={data?.sources || []} selected={draft.guidanceSourceIds} disabled={disabled}
          onChange={guidanceSourceIds => change({ guidanceSourceIds })} />
      </Disclosure>

      {others.length > 0 && <Disclosure className="course-settings__disclosure" summary={ui('把其他课程合并到这里')}
        meta={mergeIds.length ? uiFormat('已选 {0} 门', [mergeIds.length]) : ''} defaultOpen={mergeFrom.length > 0}>
        {/* A long course list scrolls in a window; likely duplicates of this course come first (WP14). */}
        <ScrollWindow className="course-settings__merge-window" label={ui('可以合并的课程')} items={mergeCandidates} itemKey={item => item.id}
          match={item => [item.name, ...(item.aliases || [])].join(' ')} filterable={mergeCandidates.length > 6} filterPlaceholder={ui('筛选课程…')}
          maxHeight={260} listClassName="course-settings__merge" renderItem={item => <label>
            <input type="checkbox" checked={mergeIds.includes(item.id)} disabled={disabled}
              onChange={event => { setConfirm(null); setMergeIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); }} />
            <span><strong>{item.name}</strong>{(countLine(item) || likely.has(item.id)) && <small>{[likely.has(item.id) ? ui('名称几乎相同') : '', countLine(item)].filter(Boolean).join(' · ')}</small>}</span>
          </label>} />
        <Button variant="secondary" disabled={disabled || !mergeIds.length} onClick={() => setConfirm('merge')}>{ui('合并所选课程')}</Button>
        {confirm === 'merge' && mergeIds.length > 0 && <InlineMessage tone="warning" boxed title={uiFormat('把 {0} 门课程并入「{1}」？', [mergeNames.length, course.name])}>
          <p><strong>{mergeNames.join(' · ')}</strong></p>
          <p>{ui('它们的题组、资料和练习会归入这门课；题目、答题记录、复习进度和前置关系都保留，原名称保留为别名。')}</p>
          <div className="course-settings__confirm">
            <Button size="sm" variant="primary" busy={working} disabled={busy} onClick={merge}>{ui('确认合并')}</Button>
            <Button ref={mergeCancel} size="sm" variant="quiet" disabled={working} onClick={() => setConfirm(null)}>{ui('取消')}</Button>
          </div>
        </InlineMessage>}
      </Disclosure>}
    </Dialog>
  );
}
