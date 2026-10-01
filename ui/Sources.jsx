import { ui, uiFormat, uiLocale, getUiLanguage } from "./i18n.js";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { AudioJobs } from "./AudioImport.jsx";
import CourseField, { parseCourses } from './CourseField.jsx';
import PageScope, { usePageScope } from './PageScope.jsx';
import { useInjectCss } from "./shared.js";
import { Button, Dialog, Disclosure, Icon, InlineMessage, PageHeader } from "./components/index.js";
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { bigDocuments } from '../lib/large-documents.js';
import { chapterLabel, documentNotes, inScope, sourceFormatLabel } from './SourcePicker.jsx';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import css from "./sources.css";

/* 资料视图：一份文档一行（PDF 的各页收在行内，按需展开；P18）。按导入日期分组，
   最新一组默认展开（P23）；刚导入的资料高亮并滚动到视野里。sourceForm 是 App
   传入的导入入口（ImportHub），在空库时直接作为空状态。删除整份文档会逐页调用
   source.remove，先确认。 */

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

/**
 * Remove every source of one document: the first through App's act (busy
 * state, refresh afterwards), the rest through call inside the same act.
 * Resolves { removed: ids, failed: [{ id, error }] }; never throws.
 */
export async function removeDocument(item, { act, call }) {
  const [first, ...rest] = item.sourceIds;
  const removed = [], failed = [];
  const fail = (ids, error) => ids.forEach(id => failed.push({ id, error: error?.message || String(error) }));
  const busyError = () => new Error(ui('另一个操作还在进行，请稍后重试。'));
  try {
    const result = await act("source.remove", { id: first }, async () => {
      removed.push(first);
      if (!call) return;
      for (const id of rest) {
        try { await call("source.remove", { id }); removed.push(id); }
        catch (error) { fail([id], error); }
      }
    }, { rethrow: true });
    if (result === undefined && !removed.length) { fail(item.sourceIds, busyError()); return { removed, failed }; }
  } catch (error) {
    if (!removed.length) { fail(item.sourceIds, error); return { removed, failed }; }
  }
  // Without call, the remaining pages go one act at a time (act is single-flight).
  if (!call) for (const id of rest) {
    try {
      if (await act("source.remove", { id }, undefined, { rethrow: true }) === undefined) throw busyError();
      removed.push(id);
    } catch (error) { fail([id], error); }
  }
  return { removed, failed };
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

function DocumentRow({ item, source, busy, isNew, organizing, selected, onSelect, onOpen, onGenerate, onRemove, advice = false, retrieval = null, onOpenSettings, call, courses, defaultCourse, onRetrieval }) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const listId = useId(), row = useRef(null);
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
        <button className="source-main" onClick={() => onOpen(item.sourceIds[0])}>
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <span>
            <strong title={item.title}>{displayTitle(item.title)}{isNew && <span className="source-new">{ui("刚导入")}</span>}</strong>
            <small>{item.courses.join(' · ') || ui('未分类')}{item.coursesInferred ? ui(' · 推断归属') : ''}
              {item.usedBy.length ? uiFormat(' · 用于 {0}', [item.usedBy.map(deck => deck.title).join(' · ')]) : ''}</small>
            <small>{details.join(" · ")}{item.excerpt ? ` · ${item.excerpt.slice(0, 80)}` : ""}</small>
          </span>
        </button>
        <div className="source-doc__actions">
          {onGenerate && <Button size="sm" variant="secondary" icon="sparkle" disabled={busy} onClick={() => onGenerate(item.sourceIds)}>{ui('从这份资料出题')}</Button>}
          <details className="source-row-actions"><summary>{ui('更多')}</summary>
            <button type="button" disabled={busy} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onRemove(item); }}>{ui('移除')}</button>
          </details>
        </div>
      </div>
      {multi && <div className="source-doc__pages">
        <Button variant="quiet" size="sm" iconEnd="chevron" className="source-doc__pages-toggle" aria-expanded={pagesOpen} aria-controls={listId}
          onClick={() => setPagesOpen(open => !open)}>
          {pagesOpen ? ui('收起') : chaptered ? uiFormat('查看 {0} 章', [item.chapters.length]) : item.format === 'pdf' ? uiFormat('查看 {0} 页', [item.pages.length]) : uiFormat('查看 {0} 部分', [item.pages.length])}
        </Button>
        {pagesOpen && chaptered && <ul id={listId} className="source-doc__page-list source-doc__chapters">
          {item.chapters.map(chapter => <li key={chapter.index} data-chapter-index={chapter.index}>
            <button type="button" onClick={() => onOpen(chapter.sourceIds[0])}>
              <span>{chapterLabel(chapter)}</span><small>{uiFormat('{0} 页 · {1} 字符', [chapter.sourceIds.length, chapter.chars.toLocaleString(uiLocale())])}</small>
            </button>
            {onGenerate && <Button size="sm" variant="quiet" icon="sparkle" disabled={busy} onClick={() => onGenerate(chapter.sourceIds)}>{ui('从这一章出题')}</Button>}
          </li>)}
        </ul>}
        {pagesOpen && !chaptered && <ul id={listId} className="source-doc__page-list">
          {item.pages.map(page => <li key={page.sourceId}>
            <button type="button" onClick={() => onOpen(page.sourceId)}>
              <span>{pageLabel(item, page)}</span><small>{uiFormat("{0} 字符", [page.chars.toLocaleString(uiLocale())])}</small>
            </button>
          </li>)}
        </ul>}
      </div>}
      {advice && <Disclosure className="source-doc__advice" summary={uiFormat('这份资料有 {0} 页，建议按章节使用', [Math.max(item.pages.length, item.totalPages || 0)])} meta={ui('大教材建议')}>
        <LargeDocumentCard reason="long-document" detail={{ name: displayTitle(item.title), pages: Math.max(item.pages.length, item.totalPages || 0) }}
          retrieval={retrieval} onOpenSettings={onOpenSettings} call={call} courses={courses} defaultCourse={defaultCourse} onRetrieval={onRetrieval} />
      </Disclosure>}
    </article>
  );
}

function RemoveDialog({ item, busy, act, call, onClose, onRemoved }) {
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const blocked = item.usedBy.length > 0;
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
    <Dialog size="sm" title={uiFormat("移除「{0}」？", [displayTitle(item.title)])} onClose={() => { if (!working) onClose(); }}
      footer={<>
        <Button variant="quiet" disabled={working} onClick={onClose}>{ui("取消")}</Button>
        <Button variant="danger" busy={working} disabled={busy || blocked} onClick={confirm}>{ui("移除")}</Button>
      </>}>
      <p>{item.format === 'pdf' && pages > 1 ? uiFormat("这份 PDF 的 {0} 页文字都会从资料列表移除，无法撤销。", [pages]) : ui("这份资料会从资料列表移除，无法撤销。")}</p>
      {blocked && <InlineMessage tone="warning" boxed title={ui("有题组引用这份资料，不能移除")}>
        {uiFormat("引用它的题组：{0}。先删除或改写这些题，再移除资料。", [item.usedBy.map(deck => deck.title).join(" · ")])}
      </InlineMessage>}
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

export default function Sources({ data, busy, act, call, setModal, setNotice, sourceForm, openAgent, onGenerate, onOpenSources, onLegacyRetry, onOpenSettings, highlight }) {
  useInjectCss(css, "study-sources");
  const [scope, setScope] = usePageScope(data.root, 'sources', data.focus?.course ?? '*');
  const items = useMemo(() => groupSourcesByDocument(data.sources), [data.sources]);
  const byId = useMemo(() => new Map(data.sources.map(source => [source.id, source])), [data.sources]);
  const filtered = useMemo(() => items.filter(item => inScope(item, scope)), [items, scope]);
  // Books of more than 300 pages get the 大教材建议; what DSH can search with is read once, and only then (WP28).
  const bigKeys = useMemo(() => new Set(bigDocuments(items).map(item => item.key)), [items]);
  const [retrieval, setRetrieval] = useState(null);
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
  const [removing, setRemoving] = useState(null);
  const selectedItems = items.filter(item => selected.includes(item.key));
  const finish = () => { setProposals(null); setSelected([]); };
  const toggle = group => {
    const open = isOpen(group);
    setOpened(current => { const next = new Set(current); open ? next.delete(group.key) : next.add(group.key); return next; });
    setClosed(current => { const next = new Set(current); open ? next.add(group.key) : next.delete(group.key); return next; });
  };
  const allOpen = groups.length > 0 && groups.every(isOpen);
  const openSource = id => setModal({ type: "source", source: byId.get(id) });
  const addButton = <Button variant="primary" icon="plus" data-tour="sources-add"
    onClick={() => setModal({ type: "add", course: scope === '*' ? '' : scope })}>{ui("添加资料")}</Button>;
  return (
    <section className="page sources-page">
      <PageHeader title={ui("资料")}
        description={<>{ui("题目从这里生长。原文与引用一直保留。")}{items.length > 0 &&
          uiFormat(" 共 {0} 份资料，按导入日期分为 {1} 组。", [filtered.length, groups.length])}</>}
        actions={<>
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
              onClick={() => act('source.organize.suggest', { sourceIds: selectedItems.map(item => item.sourceIds[0]) }, result =>
                setProposals(result.proposals.map(proposal => {
                  const item = items.find(entry => entry.sourceIds.includes(proposal.id));
                  return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: true, courseText: proposal.courses.join('; ') };
                })))}>{ui('请 AI 建议')}</button>
          </div>
          {proposals && <div className="source-course-proposals">
            <p className="muted">{ui('建议尚未保存，可先修改课程，再确认应用。')}</p>
            {proposals.map(proposal => <div key={proposal.id}>
              <label className="source-proposal-select"><input type="checkbox" checked={proposal.include} disabled={busy}
                onChange={event => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, include: event.target.checked } : item))} />
                {uiFormat('采用建议：{0}', [displayTitle(proposal.title)])}</label>
              <CourseField label={displayTitle(proposal.title)} value={proposal.courseText} multiple courses={data.focus?.courses}
                onChange={courseText => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, courseText } : item))} disabled={busy || !proposal.include} />
              <p className="muted">{proposal.reason}</p>
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
      {!items.length ? (
        <section className="sources-empty" data-tour="sources-list">
          <div className="sources-empty__intro">
            <h2>{ui("还没有资料")}</h2>
            <p>{ui("添加讲义、笔记或录音，之后就能用它们出题；题目会引用原文。")}</p>
          </div>
          {sourceForm}
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
                  onOpen={openSource} onGenerate={onGenerate} onRemove={setRemoving}
                  advice={bigKeys.has(item.key)} retrieval={retrieval} onOpenSettings={onOpenSettings}
                  call={call} courses={data.focus?.courses} defaultCourse={data.focus?.course} onRetrieval={setRetrieval} />)}
              </div>
            );
          })}
        </div>
      )}
      {removing && <RemoveDialog item={removing} busy={busy} act={act} call={call} onClose={() => setRemoving(null)}
        onRemoved={item => { setRemoving(null); setNotice?.({ text: uiFormat("已移除「{0}」", [displayTitle(item.title)]), tone: "success" }); }} />}
    </section>
  );
}
