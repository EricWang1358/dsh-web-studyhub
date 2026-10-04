import { ui, uiFormat, uiLocale, getUiLanguage } from "./i18n.js";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { AudioJobs } from "./AudioImport.jsx";
import { PdfConvertHistory, PdfConvertJobs } from './PdfConvertJob.jsx';
import CourseField, { parseCourses } from './CourseField.jsx';
import PageScope, { courseNamesOf, usePageScope } from './PageScope.jsx';
import { useInjectCss } from "./shared.js";
import { Button, Dialog, Disclosure, Icon, InlineMessage, PageHeader } from "./components/index.js";
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { bigDocuments } from '../lib/large-documents.js';
import { chapterLabel, documentNotes, inScope, sourceFormatLabel } from './SourcePicker.jsx';
import { MasteryLine } from './document-preview/practice/MasteryMark.jsx';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import IndexBadge from './IndexBadge.jsx';
import { documentIndexState } from './index-coverage.js';
import useIndexCoverage from './use-index-coverage.js';
import { JevDecidedBadge, JevNote, JevProbabilities, JevRunNote, JevSuggestButton, useJevCourseSuggest } from './JevOrganize.jsx';
import { experimentalShown } from './experimental-flag.js';
import { noteText, startsIncluded } from './jev-flow.js';
import { OriginalMenuEntry } from './document-preview/OriginalFile.jsx';
import OutlineDialog from './document-preview/reader/OutlineDialog.jsx';
import { RenameField } from './document-preview/RenameTitle.jsx';
import { originalNote, renameDocument, startsEditing } from './document-preview/rename.js';
import css from "./sources.css";

/* 资料视图：一份文档一行（PDF 的各页收在行内，按需展开；P18）。按导入日期分组，
   最新一组默认展开（P23）；刚导入的资料高亮并滚动到视野里。sourceForm 是 App
   传入的导入入口（ImportHub），在空库时直接作为空状态。资料先归档，可恢复；
   永久删除需再次确认，并以一次事务删除整份文档。 */

const UNKNOWN = "unknown";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* Attachment imports can be titled with their absolute path; the list shows
   the file name and keeps the full path in the tooltip. */
const displayTitle = (title) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(title))
    ? String(title).replace(/^.*[\\/]/, "")
    : title;

function dayLabel(key) {
  if (key === UNKNOWN) return ui("日期未知");
  const today = new Date(),
    yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === dayKey(today)) return ui("今天");
  if (key === dayKey(yesterday)) return ui("昨天");
  const [y, m, d] = key.split("-").map(Number),
    date = new Date(y, m - 1, d);
  if (getUiLanguage() === 'en') return date.toLocaleDateString(uiLocale(), { weekday: 'short', month: 'short', day: 'numeric', ...(y !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return uiFormat("{0}{1} 月 {2} 日 · {3}", [y === today.getFullYear() ? "" : `${y} 年 `, m, d, WEEKDAYS[date.getDay()]]);
}

/* Documents by import day (local time), newest day first; inside a day the
   newest import first, then natural title order. */
function groupByDay(items) {
  const groups = new Map();
  for (const item of items) {
    const t = Date.parse(item.createdAt);
    const key = Number.isFinite(t) ? dayKey(new Date(t)) : UNKNOWN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const titleOrder = (a, b) => String(a.title).localeCompare(String(b.title), uiLocale(), { numeric: true });
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : b.localeCompare(a)))
    .map(([key, rows]) => ({
      key,
      rows: rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || titleOrder(a, b)),
      inferred: rows.every((r) => r.createdAtInferred),
      chars: rows.reduce((n, r) => n + r.chars, 0),
    }));
}

/** Delete all pages in one checked transaction; failures retain every page. */
export async function removeDocument(item, { act }) {
  try {
    const result = await act('source.remove', { sourceIds: item.sourceIds, confirm: true }, undefined, { rethrow: true });
    if (result === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
    return { removed: item.sourceIds, failed: [] };
  } catch (error) {
    return { removed: [], failed: item.sourceIds.map(id => ({ id, error: error?.message || String(error) })) };
  }
}

/** source.courses.set assignments for every page of the chosen documents. */
export function courseAssignments(items, keys, courses, sourcesById) {
  const chosen = new Set(keys);
  return items.filter(item => chosen.has(item.key)).flatMap(item => item.sourceIds.map(id => ({
    id, courses, expectedCourses: sourcesById.get(id)?.courses || [] })));
}

const pageLabel = (item, page) => item.format === 'pdf'
  ? uiFormat('第 {0} 页', [page.page]) + (page.legacy ? ` · ${ui('旧版提取')}` : '')
  : item.format === 'audio' ? uiFormat('第 {0} 部分', [page.page]) : displayTitle(page.title);

/**
 * The chapters of one document, each with where it lies and its own 出题 button. A chapter that starts and ends inside one page holds
 * no whole page, so generation cannot be scoped to it (the button is off); it still opens the document at its start.
 */
export function ChapterList({ item, busy, onOpen, onGenerate, listId, mastery }) {
  return <ul id={listId} className="source-doc__page-list source-doc__chapters" role="region" aria-label={ui('章节列表')} tabIndex={0}>
    {item.chapters.map(chapter => {
      const inside = chapter.sourceIds.length === 0, partial = chapter.partial && item.chapterUnit !== 'text';
      return <li key={chapter.index} data-chapter-index={chapter.index}>
        <button type="button" onClick={() => onOpen(chapter.startSourceId || chapter.sourceIds[0])}>
          <span>{chapterLabel(chapter, item.chapterUnit)}</span>
          <small>{[partial && (item.chapterUnit === 'part' ? ui('从文件中间开始') : ui('从页中间开始')),
            item.chapterUnit === 'text' ? '' : uiFormat(item.chapterUnit === 'part' ? '{0} 部分 · {1} 字符' : '{0} 页 · {1} 字符', [chapter.sourceIds.length, chapter.chars.toLocaleString(uiLocale())])].filter(Boolean).join(' · ')}</small>
          <MasteryLine className="source-doc__mastery" summary={mastery?.chapters?.[chapter.index] ?? null} title={chapterLabel(chapter, item.chapterUnit)} />
        </button>
        {onGenerate && <Button size="sm" variant="quiet" icon="sparkle" disabled={busy || inside}
          title={inside ? (item.chapterUnit === 'text' ? ui('这份资料是一整段文字，出题仍以整份资料为单位') : ui('这一章在同一页内，不能单独出题')) : undefined}
          onClick={() => onGenerate(chapter.sourceIds)}>{ui('从这一章出题')}</Button>}
      </li>;
    })}
  </ul>;
}

/** The entries of a row's 更多 menu. */
export function RowMenuItems({ item, busy, call, onChangeCourse, onRemove, onSegment, onRename, onArchive }) {
  const close = event => event.currentTarget.closest("details")?.removeAttribute("open");
  return <div className="source-row-menu">
    {call && <OriginalMenuEntry item={item} call={call} busy={busy} />}
    {onRename && <button type="button" disabled={busy} onClick={event => { close(event); onRename(item); }}>{ui('重命名…')}</button>}
    {onChangeCourse && <button type="button" disabled={busy} onClick={event => { close(event); onChangeCourse(item); }}>{ui('改课程…')}</button>}
    {onSegment && <button type="button" disabled={busy} onClick={event => { close(event); onSegment(item); }}>{ui('AI 重新分段…')}</button>}
    {onArchive && <button type="button" disabled={busy} onClick={event => { close(event); onArchive(item); }}>{item.archived ? ui('恢复资料') : ui('归档')}</button>}
    {item.archived && <button type="button" disabled={busy} onClick={event => { close(event); onRemove(item); }}>{ui('永久删除')}</button>}
  </div>;
}

function DocumentRow({ item, source, busy, isNew, organizing, selected, onSelect, onOpen, onGenerate, onRemove, onArchive, onChangeCourse, onSegment, mastery, rename, indexInfo = null, indexCoverage = null, advice = false, retrieval = null, onOpenSettings, call, courses, defaultCourse, onRetrieval }) {
  const [pagesOpen, setPagesOpen] = useState(false), [editing, setEditing] = useState(false);
  const listId = useId(), row = useRef(null), opening = useRef(0), main = useRef(null), wasEditing = useRef(false);
  useEffect(() => () => clearTimeout(opening.current), []);
  useEffect(() => { if (wasEditing.current && !editing) main.current?.focus({ preventScroll: true }); wasEditing.current = editing; }, [editing]);
  const editor = rename ? rename(item) : null;
  // A click on the title opens the reader a moment late, so a double-click on it can rename instead; everything else opens at once.
  const openRow = event => {
    if (!editor || !event.target.closest?.('.source-title')) { onOpen(item.sourceIds[0]); return; }
    if (event.detail > 1) return;
    clearTimeout(opening.current); opening.current = setTimeout(() => onOpen(item.sourceIds[0]), 260);
  };
  const startEditing = () => { clearTimeout(opening.current); setEditing(true); };
  const multi = item.pages.length > 1;
  // A converted book with chapters is browsed by chapter (WP28); its pages stay one click further in the picker.
  const chaptered = !!item.chapters?.length;
  useEffect(() => {
    if (!isNew || !row.current) return;
    row.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
    row.current.querySelector(".source-main")?.focus({ preventScroll: true });
  }, [isNew]);
  const corrections = source?.audio ? uiFormat("校对 {0} 处", [source.audio.corrections?.appliedCount ?? 0]) : "";
  const details = [sourceFormatLabel(item), uiFormat("{0} 字符", [item.chars.toLocaleString(uiLocale())]), corrections, ...documentNotes(item)].filter(Boolean);
  return (
    <article ref={row} className={"source-row source-doc" + (isNew ? " is-new" : "")} data-document-key={item.key} data-new={isNew ? "true" : undefined}>
      <div className="source-doc__line">
        {organizing && <input type="checkbox" aria-label={uiFormat('选择资料：{0}', [displayTitle(item.title)])}
          checked={selected} onChange={event => onSelect(event.target.checked)} />}
        {editing && editor ? <div className="source-main source-main--editing">
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <RenameField title={item.title} original={item.renamedFrom} label={uiFormat('重命名「{0}」', [displayTitle(item.title)])}
            onSave={async title => { await editor.save(title); setEditing(false); }} onRestore={async () => { await editor.restore(); setEditing(false); }} onCancel={() => setEditing(false)} />
        </div> : <button ref={main} className="source-main" onClick={openRow} aria-keyshortcuts={editor ? 'F2' : undefined}
          onKeyDown={editor ? event => { if (startsEditing(event)) { event.preventDefault(); startEditing(); } } : undefined}>
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <span>
            <strong className="source-title" title={item.title} onDoubleClick={editor ? startEditing : undefined}>{displayTitle(item.title)}{isNew && <span className="source-new">{ui("刚导入")}</span>}</strong>
            <small>{item.courses.join(' · ') || ui('未分类')}{item.coursesInferred ? ui(' · 推断归属') : ''}
              {item.usedBy.length ? uiFormat(' · 用于 {0}', [item.usedBy.map(deck => deck.title).join(' · ')]) : ''}</small>
            <small>{details.join(" · ")}{item.excerpt ? ` · ${item.excerpt.slice(0, 80)}` : ""}</small>
            {indexInfo && <small className="source-doc__index"><IndexBadge info={indexInfo} coverage={indexCoverage} /></small>}
            {/* 资料掌握度: from the review state of the questions linked to this material (the snapshot's materialMastery). */}
            <MasteryLine className="source-doc__mastery" summary={mastery?.document ?? null} title={displayTitle(item.title)} />
            {item.renamedFrom && <small className="source-original" title={item.renamedFrom}>{originalNote(item)}</small>}
          </span>
        </button>}
        <div className="source-doc__actions">
          {onGenerate && <Button size="sm" variant="secondary" icon="sparkle" disabled={busy} onClick={() => onGenerate(item.sourceIds)}>{ui('从这份资料出题')}</Button>}
          <details className="source-row-actions"><summary>{ui('更多')}</summary>
            <RowMenuItems item={item} busy={busy} call={call} onChangeCourse={onChangeCourse} onRemove={onRemove} onArchive={onArchive} onSegment={onSegment} onRename={editor ? startEditing : undefined} />
          </details>
        </div>
      </div>
      {(multi || chaptered) && <div className="source-doc__pages">
        <Button variant="quiet" size="sm" iconEnd="chevron" className="source-doc__pages-toggle" aria-expanded={pagesOpen} aria-controls={listId}
          onClick={() => setPagesOpen(open => !open)}>
          {pagesOpen ? ui('收起') : chaptered ? uiFormat('查看 {0} 章', [item.chapters.length]) : item.format === 'pdf' ? uiFormat('查看 {0} 页', [item.pages.length]) : uiFormat('查看 {0} 部分', [item.pages.length])}
        </Button>
        {pagesOpen && chaptered && <ChapterList item={item} busy={busy} onOpen={onOpen} onGenerate={onGenerate} listId={listId} mastery={mastery} />}
        {pagesOpen && !chaptered && <ul id={listId} className="source-doc__page-list" role="region" aria-label={ui('页面列表')} tabIndex={0}>
          {item.pages.map(page => <li key={page.sourceId}>
            <button type="button" onClick={() => onOpen(page.sourceId)}>
              <span>{pageLabel(item, page)}</span><small>{uiFormat("{0} 字符", [page.chars.toLocaleString(uiLocale())])}</small>
              <MasteryLine className="source-doc__mastery" summary={mastery?.pages?.[page.sourceId] ?? null} title={pageLabel(item, page)} />
            </button>
          </li>)}
        </ul>}
      </div>}
      {advice && <Disclosure className="source-doc__advice" summary={uiFormat('这份资料有 {0} 页，建议按章节使用', [Math.max(item.pages.length, item.totalPages || 0)])} meta={ui('大教材建议')}>
        <LargeDocumentCard reason="long-document" detail={{ name: displayTitle(item.title), pages: Math.max(item.pages.length, item.totalPages || 0) }}
          retrieval={retrieval} onOpenSettings={onOpenSettings} call={call} courses={courses} defaultCourse={item.courses?.[0] || defaultCourse} onRetrieval={onRetrieval} />
      </Disclosure>}
    </article>
  );
}

/** Fix where one document belongs, on its own row: the same field and the same source.courses.set as 整理课程归属, for one document. */
/** Saves the courses of a document through act(). Resolves '' when it worked, else the plain reason, so the dialog can say it where the learner is looking instead of in a notice that lands on top of its own buttons. */
export async function saveDocumentCourses(act, assignments, onDone) {
  try { await act('source.courses.set', { assignments }, onDone, { rethrow: true }); return ''; }
  catch (error) { return error?.message || String(error); }
}

export function CourseDialog({ item, items, byId, courses, busy, act, onClose }) {
  const [text, setText] = useState(item.courses.join('; ')), [error, setError] = useState('');
  const save = async () => setError(await saveDocumentCourses(act, courseAssignments(items, [item.key], parseCourses(text), byId), onClose));
  return (
    <Dialog size="sm" title={uiFormat("修改「{0}」的课程", [displayTitle(item.title)])} onClose={() => { if (!busy) onClose(); }}
      footer={<>
        <Button variant="quiet" disabled={busy} onClick={onClose}>{ui("取消")}</Button>
        <Button variant="primary" busy={busy} disabled={busy} onClick={save}>{ui("保存课程")}</Button>
      </>}>
      <p className="muted">{ui('只更改归属，原文与引用保持不变。留空就是「未分类」。')}</p>
      <CourseField value={text} onChange={value => { setText(value); setError(''); }} courses={courses} multiple disabled={busy} />
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

export function RemoveDialog({ item, busy, act, call, onClose, onRemoved }) {
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const blocked = item.usedBy.length > 0 || !item.archived;
  async function confirm() {
    setWorking(true); setError("");
    const result = await removeDocument(item, { act, call });
    setWorking(false);
    if (!result.failed.length) { onRemoved(item); return; }
    setError(result.removed.length
      ? uiFormat("已移除 {0} 部分，还有 {1} 部分没有移除：{2}", [result.removed.length, result.failed.length, result.failed[0].error])
      : result.failed[0].error);
  }
  const pages = item.pages.length;
  return (
    <Dialog size="sm" title={uiFormat("永久删除「{0}」？", [displayTitle(item.title)])} onClose={() => { if (!working) onClose(); }}
      footer={<>
        <Button variant="quiet" disabled={working} onClick={onClose}>{ui("取消")}</Button>
        <Button variant="danger" busy={working} disabled={busy || blocked} onClick={confirm}>{ui("确认永久删除")}</Button>
      </>}>
      <p>{item.format === 'pdf' && pages > 1 ? uiFormat("这份 PDF 的 {0} 页文字都会从资料列表移除，无法撤销。", [pages]) : ui("这份资料会从资料列表移除，无法撤销。")}</p>
      {!item.archived && <InlineMessage>{ui('请先归档这份资料，再永久删除。')}</InlineMessage>}
      {item.usedBy.length > 0 && <InlineMessage tone="warning" boxed title={ui("有题组引用这份资料，不能移除")}>
        {uiFormat("引用它的题组：{0}。先删除或改写这些题，再移除资料。", [item.usedBy.map(deck => deck.title).join(" · ")])}
      </InlineMessage>}
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

export default function Sources({ data, busy, act, call, setModal, setNotice, sourceForm, openAgent, onGenerate, onOpenSources, onLegacyRetry, onOpenSettings, highlight }) {
  useInjectCss(css, "study-sources");
  const [scope, setScope] = usePageScope(data.root, 'sources', data.focus?.course ?? '*');
  const [showArchived, setShowArchived] = useState(false);
  const allItems = useMemo(() => groupSourcesByDocument(data.sources), [data.sources]);
  const items = useMemo(() => allItems.filter(item => item.archived === showArchived), [allItems, showArchived]);
  const byId = useMemo(() => new Map(data.sources.map(source => [source.id, source])), [data.sources]);
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = useMemo(() => items.filter(item => inScope(item, scope, known)), [items, scope, known]);
  // Books of more than 300 pages get the 大教材建议; what DSH can search with is read once, and only then (WP28).
  const bigKeys = useMemo(() => new Set(bigDocuments(items).map(item => item.key)), [items]);
  const [retrieval, setRetrieval] = useState(null);
  // Whether each material's search index is built (the rows say so); read once, and followed while a build runs.
  const [indexCoverage] = useIndexCoverage(call);
  useEffect(() => {
    if (!bigKeys.size || retrieval || typeof call !== 'function') return undefined;
    let live = true;
    Promise.resolve(call('retrieval.status', {})).then(value => { if (live) setRetrieval(value); }, () => {});
    return () => { live = false; };
  }, [bigKeys.size > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const fresh = useMemo(() => new Set(items.filter(item => item.sourceIds.some(id => highlight?.ids?.includes(id))).map(item => item.key)), [items, highlight]);
  // Explicit choices win; otherwise the newest day and any day holding a fresh import are open.
  const [opened, setOpened] = useState(() => new Set()), [closed, setClosed] = useState(() => new Set());
  const isOpen = group => opened.has(group.key) || (!closed.has(group.key) && (group === groups[0] || group.rows.some(item => fresh.has(item.key))));
  // A new import reopens its day even if the learner had closed it.
  useEffect(() => {
    if (!highlight?.at) return;
    const reopen = new Set(groups.filter(group => group.rows.some(item => fresh.has(item.key))).map(group => group.key));
    if (reopen.size) setClosed(current => new Set([...current].filter(key => !reopen.has(key))));
  }, [highlight?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [organizing, setOrganizing] = useState(false), [selected, setSelected] = useState([]);
  const [courseText, setCourseText] = useState(''), [proposals, setProposals] = useState(null);
  // EXPERIMENTAL (hidden unless "Show experimental features" is on, off by default): Jev's course suggestions share the AI suggestions' rows and apply button.
  const experimental = experimentalShown(data), jevOn = useJevCourseSuggest(call, experimental ? undefined : false), [jevNote, setJevNote] = useState(''), [jevRun, setJevRun] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [editingCourse, setEditingCourse] = useState(null);
  const [segmenting, setSegmenting] = useState(null);
  const renameFor = (act || call) ? item => ({
    save: async title => { await renameDocument({ act, call }, item, { title }); setNotice?.({ text: uiFormat('已重命名为「{0}」', [title]), tone: 'success' }); },
    restore: async () => { const done = await renameDocument({ act, call }, item, { restore: true }); setNotice?.({ text: uiFormat('已恢复原名「{0}」', [done.title]), tone: 'success' }); },
  }) : undefined;
  const selectedItems = items.filter(item => selected.includes(item.key));
  const finish = () => { setProposals(null); setSelected([]); setJevRun(null); };
  const toggle = group => {
    const open = isOpen(group);
    setOpened(current => { const next = new Set(current); open ? next.delete(group.key) : next.add(group.key); return next; });
    setClosed(current => { const next = new Set(current); open ? next.add(group.key) : next.delete(group.key); return next; });
  };
  const allOpen = groups.length > 0 && groups.every(isOpen);
  const openSource = id => setModal({ type: "source", source: byId.get(id) });
  const addButton = <Button variant="primary" icon="plus" data-tour="sources-add" data-usage="import.add"
    onClick={() => setModal({ type: "add", course: scope === '*' ? '' : scope })}>{ui("添加资料")}</Button>;
  return (
    <section className="page sources-page">
      <PageHeader title={ui("资料")}
        description={<>{ui("题目从这里生长。原文与引用一直保留。")}{items.length > 0 &&
          uiFormat(" 共 {0} 份资料，按导入日期分为 {1} 组。", [filtered.length, groups.length])}</>}
        actions={<>
          <Button variant="quiet" aria-pressed={showArchived} onClick={() => { setShowArchived(value => !value); setSelected([]); setProposals(null); }}>{showArchived ? ui('返回资料') : uiFormat('已归档（{0}）', [allItems.filter(item => item.archived).length])}</Button>
          {groups.length > 1 && <Button variant="quiet" onClick={() => {
            if (allOpen) { setOpened(new Set()); setClosed(new Set(groups.map(group => group.key))); }
            else { setOpened(new Set(groups.map(group => group.key))); setClosed(new Set()); }
          }}>{allOpen ? ui("全部收起") : ui("全部展开")}</Button>}
          {addButton}
        </>} />
      {items.length > 0 && <>
        <PageScope value={scope} onChange={setScope} courses={data.focus?.courses} />
        <details className="source-organize" onToggle={event => setOrganizing(event.currentTarget.open)}>
          <summary>{ui('整理课程归属')}</summary>
          <p className="muted">{ui('勾选资料后统一整理。只更改归属，原文与引用保持不变。')}</p>
          <p>{uiFormat('已选择 {0} 份资料', [selectedItems.length])}{' '}
            <button type="button" onClick={() => { setSelected(filtered.map(item => item.key)); setProposals(null); }}>{ui('选择当前范围')}</button>{' '}
            {selected.length > 0 && <button type="button" onClick={finish}>{ui('清空选择')}</button>}
          </p>
          <CourseField value={courseText} onChange={setCourseText} courses={data.focus?.courses} multiple disabled={busy} />
          <div className="source-organization-actions">
            <button disabled={busy || !selectedItems.length} onClick={() => act('source.courses.set', {
              assignments: courseAssignments(items, selected, parseCourses(courseText), byId),
            }, finish)}>{ui('应用课程归属')}</button>
            <button disabled={busy || !data.modelReady || !selectedItems.length || selectedItems.length > 100}
              onClick={() => act('source.organize.suggest', { sourceIds: selectedItems.map(item => item.sourceIds[0]) }, result => {
                setJevRun(result.jev ?? null);
                setProposals(result.proposals.map(proposal => {
                  const item = items.find(entry => entry.sourceIds.includes(proposal.id));
                  // A row Jev decided starts included only if it changes something, like the Jev button's rows; the model's rows start included.
                  return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: proposal.decidedBy === 'jev' ? startsIncluded(proposal) : true, courseText: proposal.courses.join('; ') };
                }));
              })}>{ui('请 AI 建议')}</button>
            <JevSuggestButton enabled={jevOn} disabled={busy || !selectedItems.length || selectedItems.length > 100}
              onClick={() => { setJevNote(''); act('source.organize.jev', { sourceIds: selectedItems.map(item => item.sourceIds[0]) }, result => {
                setJevNote(noteText(result));
                if (result.proposals.length) setProposals(result.proposals.map(proposal => {
                  const item = items.find(entry => entry.sourceIds.includes(proposal.id));
                  return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: startsIncluded(proposal), courseText: proposal.courses.join('; ') };
                }));
              }); }} />
          </div>
          {experimental && <JevNote note={jevNote} />}
          {experimental && <JevRunNote jev={jevRun} />}
          {proposals && <div className="source-course-proposals">
            <p className="muted">{ui('建议尚未保存，可先修改课程，再确认应用。')}</p>
            {proposals.map(proposal => <div key={proposal.id}>
              <label className="source-proposal-select"><input type="checkbox" checked={proposal.include} disabled={busy}
                onChange={event => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, include: event.target.checked } : item))} />
                {uiFormat('采用建议：{0}', [displayTitle(proposal.title)])}</label>
              <CourseField label={displayTitle(proposal.title)} value={proposal.courseText} multiple courses={data.focus?.courses}
                onChange={courseText => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, courseText } : item))} disabled={busy || !proposal.include} />
              <p className="muted">{proposal.reason}{experimental && proposal.decidedBy === 'jev' && <> <JevDecidedBadge /></>}</p>
              {experimental && <JevProbabilities jev={proposal.jev} />}
            </div>)}
            <button disabled={busy || !proposals.some(proposal => proposal.include)} onClick={() => act('source.courses.set', {
              assignments: proposals.filter(proposal => proposal.include).flatMap(proposal =>
                courseAssignments(items, [proposal.key], parseCourses(proposal.courseText), byId)),
            }, finish)}>{ui('确认应用建议')}</button>
          </div>}
        </details>
        {!filtered.length && <p className="muted">{ui('这个范围还没有资料。可切换到全部课程查看。')}</p>}
      </>}
      <AudioJobs data={data} busy={busy} act={act} openAgent={openAgent} onOpenSources={onOpenSources} onLegacyRetry={onLegacyRetry} />
      <PdfConvertJobs data={data} act={act} call={call} onOpenSources={onOpenSources} onOpenSettings={onOpenSettings} />
      <PdfConvertHistory data={data} act={act} call={call} onOpenSources={onOpenSources} onOpenSettings={onOpenSettings} collapsible hideWhenEmpty />
      {!items.length ? (
        <section className="sources-empty" data-tour="sources-list">
          <div className="sources-empty__intro">
            <h2>{showArchived ? ui('没有已归档的资料。') : ui("还没有资料")}</h2>
            {!showArchived && <p>{ui("添加讲义、笔记或录音，之后就能用它们出题；题目会引用原文。")}</p>}
          </div>
          {!showArchived && sourceForm}
        </section>
      ) : (
        <div className="source-groups" data-tour="sources-list">
          {groups.map((g) => {
            const expanded = isOpen(g);
            return (
              <div key={g.key} className={"source-group" + (expanded ? " open" : "")}>
                <button className="source-group-head" aria-expanded={expanded} onClick={() => toggle(g)}>
                  <span className="source-group-caret" aria-hidden="true">▸</span>
                  <strong>{dayLabel(g.key)}</strong>
                  {g.inferred && <span className="source-group-tag" title={ui("这些资料保存时没有记录日期，按最早引用它们的题组推断")}>{ui("推断")}</span>}
                  <small className="muted">{uiFormat("{0} 份 · {1} 字符", [g.rows.length, g.chars.toLocaleString(uiLocale())])}</small>
                </button>
                {expanded && g.rows.map(item => <DocumentRow key={item.key} item={item} source={byId.get(item.sourceIds[0])} busy={busy}
                  isNew={fresh.has(item.key)} organizing={organizing} selected={selected.includes(item.key)}
                  onSelect={on => { setSelected(current => on ? [...current, item.key] : current.filter(key => key !== item.key)); setProposals(null); }}
                  onOpen={openSource} onGenerate={showArchived ? undefined : onGenerate} onRemove={setRemoving}
                  onArchive={item => act('source.archive', { sourceIds: item.sourceIds, archived: !item.archived })} onChangeCourse={setEditingCourse} onSegment={typeof call === 'function' ? setSegmenting : undefined} rename={renameFor}
                  mastery={data.materialMastery?.[item.key]} indexInfo={documentIndexState(item, indexCoverage, { big: bigKeys.has(item.key) })} indexCoverage={indexCoverage} advice={bigKeys.has(item.key)} retrieval={retrieval} onOpenSettings={onOpenSettings}
                  call={call} courses={data.focus?.courses} defaultCourse={data.focus?.course} onRetrieval={setRetrieval} />)}
              </div>
            );
          })}
        </div>
      )}
      {editingCourse && <CourseDialog item={editingCourse} items={items} byId={byId} courses={data.focus?.courses} busy={busy} act={act}
        onClose={() => setEditingCourse(null)} />}
      {segmenting && <OutlineDialog item={segmenting} call={call} act={act} onClose={() => setSegmenting(null)} />}
      {removing && <RemoveDialog item={removing} busy={busy} act={act} call={call} onClose={() => setRemoving(null)}
        onRemoved={item => { setRemoving(null); setNotice?.({ text: uiFormat("已移除「{0}」", [displayTitle(item.title)]), tone: "success" }); }} />}
    </section>
  );
}
