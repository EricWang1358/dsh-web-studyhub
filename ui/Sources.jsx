import { ui, uiFormat, uiLocale, errorMessage } from "./i18n.js";
import { formatNumber, formatDay } from "./format.js";
import React, { memo, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { AudioJobs } from "./audio/AudioJobs.jsx";
import { PdfConvertHistory, PdfConvertJobs } from './PdfConvertJob.jsx';
import CourseField, { parseCourses } from './CourseField.jsx';
import PageScope, { courseNamesOf, usePageScope } from './PageScope.jsx';
import { useInjectCss } from "./shared.js";
import { AddSourceButton, Badge, Button, Checkbox, CheckboxInput, ChunkedRows, ConfirmDialog, Dialog, Disclosure, Field, Icon, InlineMessage, Menu, PageHeader, SegmentedControl, Select, TextInput, Tooltip, filterItems, scrollWindowCount, useToast } from "./components/index.js";
import { browserStorage, readJSON, writeJSON } from "./storage.js";
import { useNarrow } from "./use-narrow.js";
import { useRowFit } from "./use-row-fit.js";
import { scrollToAnchor } from "./tour/anchor.js";
import { groupSourcesByDocument } from '../lib/source-groups.js';
import {
  UNASSIGNED_COURSE,
  UNFILED_FOLDER,
  folderOfItem,
  groupMaterialsByCourse,
  groupMaterialsByFolder,
  groupMaterialsFlat,
  normalizeFolderName,
  readMaterialFolders,
  sortMaterials,
} from '../lib/contexts/materials/material-folders.js';
import { displayTitle } from '../lib/document-title.js';
import { bigDocuments } from '../lib/large-documents.js';
import { chapterLabel, documentNotes, documentSearchText, inScope, relationNote, sameIndexInfo, sourceFormatLabel } from './SourcePicker.jsx';
import { materialRelations } from '../lib/source-relations.js';
import { dropRequest, pinnedKeys, splitPinned, stepRequest } from '../lib/material-pins.js';
import { MasteryLine } from './document-preview/practice/MasteryMark.jsx';
import { CoverageChip } from './coverage/Coverage.jsx';
import DocumentTopUp, { offersDocumentTopUp } from './coverage/DocumentTopUp.jsx';
import { modelReadiness } from './generation-status.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import IndexBadge, { IndexGapLine } from './IndexBadge.jsx';
import { documentIndexState } from './index-coverage.js';
import { adviceTip, indexGap, pageFacts, pageGapHint, pageGapNote } from './index-scope.js';
import useIndexCoverage from './use-index-coverage.js';
import { JevNote, JevProbabilities, JevRunNote, JevSuggestButton, useJevCourseSuggest } from './JevOrganize.jsx';
import { JevDecidedBadge } from './JevBadge.jsx';
import { experimentalShown } from './experimental-flag.js';
import { noteText, startsIncluded } from './jev-flow.js';
import { OriginalMenuEntry } from './document-preview/OriginalFile.jsx';
import OutlineDialog from './document-preview/reader/OutlineDialog.jsx';
import { RenameField } from './document-preview/RenameTitle.jsx';
import { originalNote, renameDocument, startsEditing } from './document-preview/rename.js';
import css from "./sources.css";
import PermanentDeleteDialog from './components/PermanentDeleteDialog.jsx';
import { idsOfDocuments, offerDocumentsArchived } from './archive-entries.js';
import { useStudy } from './study-context.jsx';
import { AppContext } from './app/app-context.js';
import { hasContext } from './capabilities.js';
import { useRetrievalStatus } from './retrieval-status.js';
import { HandOff } from './hand-off/HandOff.jsx';
import { CUSTOM_ROW_EDIT_LABEL, CUSTOM_ROW_EDIT_WHAT, CUSTOM_ROW_LABEL, CUSTOM_BOOK_WHAT, customRowOffer } from './custom-entry.js';
import { openCompanionTarget, resolveSourceCompanionTarget } from './companions/companion-ref.js';

/* 资料视图：一份文档一行（PDF 的各页收在行内，按需展开；P18）。按导入日期分组，
   最新一组默认展开（P23）；刚导入的资料高亮并滚动到视野里。sourceForm 是 App
   传入的导入入口（ImportHub），在空库时直接作为空状态。资料先归档，可恢复；
   永久删除需再次确认，并以一次事务删除整份文档。 */

const UNKNOWN = "unknown";
/* The 已置顶 group is not a day: its own key in the open/closed sets (lib/material-pins.js). */
const PINNED = "__pinned";
const VALID_GROUP_MODES = new Set(["course", "folder", "day", "none"]);
const VALID_SORTS = new Set(["recent", "title"]);
const groupModeKey = root => `study-sources-group-mode:v1:${root || ""}`;
const sortModeKey = root => `study-sources-sort-mode:v1:${root || ""}`;
const closedGroupsKey = (root, mode) => `study-sources-group-closed:v1:${root || ""}:${mode}`;
const readGroupMode = root => {
  const saved = readJSON(groupModeKey(root), "course", browserStorage());
  return VALID_GROUP_MODES.has(saved) ? saved : "course";
};
const readSortMode = root => {
  const saved = readJSON(sortModeKey(root), "recent", browserStorage());
  return VALID_SORTS.has(saved) ? saved : "recent";
};
const readClosedSet = (root, mode) => {
  const saved = readJSON(closedGroupsKey(root, mode), [], browserStorage());
  return new Set(Array.isArray(saved) ? saved.filter(k => typeof k === "string") : []);
};

/* A day is the midnight (local time) that starts it, as text: groups sort by it and it needs no formatting. */
const dayKey = (d) => String(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());

/* Attachment imports used to be titled with their absolute path; the list shows the file name (lib/document-title.js, #207). */

function dayLabel(key) {
  if (key === UNKNOWN) return ui("日期未知");
  const today = new Date(),
    yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === dayKey(today)) return ui("今天");
  if (key === dayKey(yesterday)) return ui("昨天");
  return formatDay(Number(key), today);
}

/* Documents by import day (local time), newest day first; inside a day sorted by the active sort mode. */
function groupByDay(items, { sort = "recent", locale = uiLocale() } = {}) {
  const groups = new Map();
  for (const item of items) {
    const t = Date.parse(item.createdAt);
    const key = Number.isFinite(t) ? dayKey(new Date(t)) : UNKNOWN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : b.localeCompare(a)))
    .map(([key, rows]) => ({
      key,
      rows: sortMaterials(rows, { sort, locale }),
      inferred: rows.every((r) => r.createdAtInferred),
      chars: rows.reduce((n, r) => n + r.chars, 0),
    }));
}

function buildSourceGroups(items, { mode, folders, sort = "recent", includeEmpty = false, locale = uiLocale(), scope = "*", known = [] }) {
  if (mode === "course") return groupMaterialsByCourse(items, { sort, locale, scope, known });
  if (mode === "folder") return groupMaterialsByFolder(items, folders, { sort, locale, includeEmpty });
  if (mode === "none") return groupMaterialsFlat(items, { sort, locale });
  return groupByDay(items, { sort, locale });
}

function groupSummaryDescription({ mode, summary }) {
  if (summary.pinned) {
    if (!summary.rest) return uiFormat(" 共 {0} 份资料，全部置顶。", [summary.count]);
    if (mode === "none") return uiFormat(" 共 {0} 份资料，其中 {1} 份置顶。", [summary.count, summary.pinned]);
    if (mode === "course") return uiFormat(" 共 {0} 份资料，其中 {1} 份置顶，其余按课程分为 {2} 组。", [summary.count, summary.pinned, summary.groups]);
    if (mode === "folder") return uiFormat(" 共 {0} 份资料，其中 {1} 份置顶，其余按文件夹分为 {2} 组。", [summary.count, summary.pinned, summary.groups]);
    return uiFormat(" 共 {0} 份资料，其中 {1} 份置顶，其余按导入日期分为 {2} 组。", [summary.count, summary.pinned, summary.groups]);
  }
  if (mode === "none") return uiFormat(" 共 {0} 份资料。", [summary.count]);
  if (mode === "course") return uiFormat(" 共 {0} 份资料，按课程分为 {1} 组。", [summary.count, summary.groups]);
  if (mode === "folder") return uiFormat(" 共 {0} 份资料，按文件夹分为 {1} 组。", [summary.count, summary.groups]);
  return uiFormat(" 共 {0} 份资料，按导入日期分为 {1} 组。", [summary.count, summary.groups]);
}

/** Delete all pages of one or more documents in one checked transaction; failures retain every page. */
export async function removeDocuments(items, { act }) {
  const sourceIds = idsOfDocuments(items);
  try {
    const result = await act('source.remove', { sourceIds, confirm: true }, undefined, { rethrow: true });
    if (result === undefined) throw new Error(ui('上一个操作还没结束，这次点击没有生效。等它结束后再点一次。'));
    return { removed: sourceIds, failed: [] };
  } catch (error) {
    return { removed: [], failed: sourceIds.map(id => ({ id, error: errorMessage(error) })) };
  }
}

/** Delete all pages in one checked transaction; failures retain every page. */
export async function removeDocument(item, { act }) {
  return removeDocuments([item], { act });
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
 * The chapters of one document, each with where it lies and its own 练这一章 / 出题 button. A chapter that starts and ends inside one page holds
 * no whole page, so generation cannot be scoped to it (the button is off); it still opens the document at its start.
 * 练这一章 practises the chapter's published questions (the very set its mastery counts) in one click; a chapter with none offers 出题 as its one action.
 */
export function ChapterList({ item, onOpen, onGenerate, onPractice, listId, mastery }) {
  const { busy } = useStudy();
  return <ul id={listId} className="source-doc__page-list source-doc__chapters" role="region" aria-label={ui('章节列表')} tabIndex={0}>
    {item.chapters.map(chapter => {
      const inside = chapter.sourceIds.length === 0, partial = chapter.partial && item.chapterUnit !== 'text';
      const practisable = !!onPractice && mastery?.chapters?.[chapter.index]?.total > 0;
      return <li key={chapter.index} data-chapter-index={chapter.index}>
        <Button variant="quiet" block align="start" className="source-doc__row" onClick={() => onOpen(chapter.startSourceId || chapter.sourceIds[0])}>
          <span>{chapterLabel(chapter, item.chapterUnit)}</span>
          <small>{[partial && (item.chapterUnit === 'part' ? ui('从文件中间开始') : ui('从页中间开始')),
            item.chapterUnit === 'text' ? '' : uiFormat(item.chapterUnit === 'part' ? '{0} 部分 · {1} 字符' : '{0} 页 · {1} 字符', [chapter.sourceIds.length, formatNumber(chapter.chars)])].filter(Boolean).join(' · ')}</small>
          <MasteryLine className="source-doc__mastery" summary={mastery?.chapters?.[chapter.index] ?? null} title={chapterLabel(chapter, item.chapterUnit)} />
        </Button>
        {practisable && <Button size="sm" variant="secondary" icon="success" className="source-doc__chapter-btn" lock={busy} onClick={() => onPractice(item, chapter)}>{ui('练这一章')}</Button>}
        {onGenerate && <Button size="sm" variant={onPractice && !practisable ? 'secondary' : 'quiet'} icon="sparkle" className="source-doc__chapter-btn" disabled={inside} lock={busy}
          title={inside ? (item.chapterUnit === 'text' ? ui('这份资料是一整段文字，出题仍以整份资料为单位') : ui('这一章在同一页内，不能单独出题')) : undefined}
          onClick={() => onGenerate(chapter.sourceIds)}>{ui('从这一章出题')}</Button>}
      </li>;
    })}
  </ul>;
}

/** The entries of a row's 更多 menu. */
export function RowMenuItems({ item, onChangeCourse, onMoveFolder, onRemove, onSegment, onRename, onArchive, onPin, onPinMove, pin }) {
  const { busy, call } = useStudy();
  const close = event => event.currentTarget.closest("details")?.removeAttribute("open");
  return <div className="source-row-menu">
    {call && <OriginalMenuEntry item={item} />}
    {onRename && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onRename(item); }}>{ui('重命名…')}</Button>}
    {/* 置顶: one entry to pin or unpin; a pinned row can also be moved without dragging (the pin's own order, lib/material-pins.js). */}
    {onPin && !item.archived && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onPin(item); }}>{pin?.pinned ? ui('取消置顶') : ui('置顶')}</Button>}
    {onPin && onPinMove && !item.archived && pin?.pinned && <>
      <Button className="source-row-menu__btn" disabled={pin.first} lock={busy} onClick={event => { close(event); onPinMove(item, 'up'); }}>{ui('上移')}</Button>
      <Button className="source-row-menu__btn" disabled={pin.last} lock={busy} onClick={event => { close(event); onPinMove(item, 'down'); }}>{ui('下移')}</Button>
      <Button className="source-row-menu__btn" disabled={pin.first} lock={busy} onClick={event => { close(event); onPinMove(item, 'front'); }}>{ui('置顶到最前')}</Button>
    </>}
    {onChangeCourse && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onChangeCourse(item); }}>{ui('改课程…')}</Button>}
    {onMoveFolder && !item.archived && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onMoveFolder(item); }}>{ui('移入文件夹…')}</Button>}
    {onSegment && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onSegment(item); }}>{ui('AI 重新分段…')}</Button>}
    {onArchive && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onArchive(item); }}>{item.archived ? ui('恢复资料') : ui('归档')}</Button>}
    {item.archived && onRemove && <Button className="source-row-menu__btn" lock={busy} onClick={event => { close(event); onRemove(item); }}>{ui('永久删除')}</Button>}
  </div>;
}

const sameRelation = (a, b) => a === b || (!!a && !!b && a.role === b.role && a.of === b.of && a.derived === b.derived && a.count === b.count);
/**
 * Below this width of the 资料 page's own column (its content box, not the window: the sidebar may take 212px of it) the page is narrow: a row's facts break in
 * two, its actions take their own line under it, and the header keeps 添加资料 with one 更多 (#1083). This is the one place the width is decided; the page
 * carries `.is-narrow` and ui/sources.css follows it.
 */
export const ROWS_NARROW = 681;
const ROW_PROPS = ['item', 'source', 'isNew', 'organizing', 'selected', 'mastery', 'coverage', 'topUp', 'canIndex', 'indexLink', 'slot', 'advice', 'retrieval', 'courses', 'defaultCourse', 'canGenerate', 'canPractice', 'canSegment', 'canRename', 'actions', 'pinned', 'pinFirst', 'pinLast', 'dragging', 'dropMark', 'custom', 'showExtraCourseBadges', 'folderDrag', 'canMoveFolder'];

/**
 * Does a row need to be drawn again? Only when its own document, its own flags, its own index state or its own relation changed (#229, as the picker's #205):
 * a coverage answer, a poll with an answer of the same content, or a click on another row leaves the other rows alone. The handlers a row calls are
 * one stable `actions` object that reads the latest state itself.
 */
export function sourceRowPropsEqual(a, b) {
  return ROW_PROPS.every(key => a[key] === b[key]) && sameIndexInfo(a.indexInfo, b.indexInfo) && sameRelation(a.relation, b.relation);
}

/* `slot`: the index badge's place at the end of the status line is kept from the first paint, so a coverage answer that arrives later fills it instead of making the
   row taller (#229). The status line is the row's own line under the title and the facts, as wide as the row: a wide row's actions sit beside the title and the
   facts only, so they never narrow it, and a narrow row's actions take the line after it (ui/sources.css). The badge never competes with the buttons (#1083). */
const DocumentRow = memo(function DocumentRow({ item, source, isNew, organizing, selected, actions, canGenerate, canPractice, canSegment, canRename, mastery, coverage = null, topUp = false, indexInfo = null, canIndex, indexLink = false, slot = false, relation = null, advice = false, retrieval = null, courses, defaultCourse, pinned = false, pinFirst = false, pinLast = false, dragging = false, dropMark = '', custom = null, showExtraCourseBadges = false, folderDrag = false, canMoveFolder = false }) {
  const { busy, openModal } = useStudy();
  const appData = useContext(AppContext)?.data;
  const companionTarget = !item.archived && source
    ? resolveSourceCompanionTarget({ source, courses: appData?.courses, sources: appData?.sources })
    : null;
  const [pagesOpen, setPagesOpen] = useState(false), [editing, setEditing] = useState(false);
  const listId = useId(), row = useRef(null), main = useRef(null), wasEditing = useRef(false);
  useEffect(() => { if (wasEditing.current && !editing) main.current?.focus({ preventScroll: true }); wasEditing.current = editing; }, [editing]);
  const editor = canRename ? actions.rename(item) : null;
  const name = displayTitle(item.title);
  // Clicking anywhere on the row opens the reader immediately (0ms); rename uses hover button, F2, or 更多 menu.
  const openRow = () => actions.open(item.sourceIds[0]);
  const startEditing = () => setEditing(true);
  const multi = item.pages.length > 1;
  // A converted book with chapters is browsed by chapter (WP28); its pages stay one click further in the picker.
  const chaptered = !!item.chapters?.length;
  useEffect(() => {
    if (!isNew || !row.current) return undefined;
    // In one scroll, not an animation, and re-checked once frames settle in case an open chunked group right above appended a batch (#900, #930).
    const jump = scrollToAnchor(row.current, { block: "center" });
    row.current.querySelector(".source-main")?.focus({ preventScroll: true });
    return jump.cancel;
  }, [isNew]);
  const corrections = source?.audio ? uiFormat("校对 {0} 处", [source.audio.corrections?.appliedCount ?? 0]) : "";
  // The facts only (#676): what it is, how big, and how it relates to the others. What the learner has to check is a Badge beside the title (below), the start of the text is not in the row.
  const details = [uiFormat("{0} 字符", [formatNumber(item.chars)]), corrections, relationNote(relation)].filter(Boolean);
  const notes = documentNotes(item);
  // One page count for the document (the pages that have text); when the original file has more, that is said once, beside it, with the reason on hover.
  const gap = pageGapNote(item), pages = pageFacts(item).readable;
  const indexSlot = (slot || indexInfo) && <span className="source-doc__index">{indexInfo && <IndexBadge info={indexInfo} coverage={{ canIndex }} onIndex={indexLink ? () => actions.buildIndex(item.courses?.[0] || '') : undefined} />}</span>;
  const dragProps = pinned && !editing
    ? { draggable: true, onDragStart: event => actions.dragStart(item.key, event), onDragOver: event => actions.dragOver(item.key, event),
        onDrop: event => actions.drop(item.key, event), onDragEnd: actions.dragEnd }
    : folderDrag && !item.archived && !editing
      ? { draggable: true, onDragStart: event => actions.folderDragStart(item.key, event), onDragEnd: actions.folderDragEnd }
      : {};
  return (
    <article ref={row} className={"source-row source-doc" + (isNew ? " is-new" : "") + (dragging ? " source-doc--dragging" : "") + (dropMark ? ` source-doc--drop-${dropMark}` : "")} data-document-key={item.key} data-new={isNew ? "true" : undefined} data-stable-row=""
      {...dragProps}>
      <div className="source-doc__line">
        {organizing && <CheckboxInput className="source-doc__check" aria-label={uiFormat('选择资料：{0}', [name])}
          checked={selected} onChange={event => actions.select(item.key, event.target.checked)} />}
        {editing && editor ? <div className="source-main source-main--editing">
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <RenameField title={item.title} original={item.renamedFrom} label={uiFormat('重命名「{0}」', [name])}
            onSave={async title => { await editor.save(title); setEditing(false); }} onRestore={async () => { await editor.restore(); setEditing(false); }} onCancel={() => setEditing(false)} />
        </div> : <button ref={main} className="source-main" onClick={openRow} aria-keyshortcuts={editor ? 'F2' : undefined}
          onKeyDown={editor ? event => { if (startsEditing(event)) { event.preventDefault(); startEditing(); } } : undefined}>
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <span>
            <strong className="source-title" title={item.title}>{pinned && <span className="source-pin" role="img" aria-label={ui('已置顶')}><Icon className="sh-icon--inline" name="pin" /></span>}{name}{isNew && <Badge size="sm" className="source-new">{ui("刚导入")}</Badge>}{notes.map(note => <Badge key={note} tone="warning" size="sm" icon wrap className="source-note">{note}</Badge>)}</strong>
            {/* One line of facts under the title (#570): where it belongs, then what it is and how big; each part ellipsises on its own. */}
            <span className="source-doc__meta">
              <small>{[item.courses.join(' · ') || ui('未分类'), item.coursesInferred ? ui('推断归属') : '',
                item.usedBy.length ? uiFormat('用于 {0}', [item.usedBy.map(deck => deck.title).join(' · ')]) : ''].filter(Boolean).join(' · ')}{showExtraCourseBadges && item.courses.length > 1 && item.courses.slice(1).map(extra => <Badge key={extra} size="sm" className="source-course-extra">{extra}</Badge>)}</small>
              <small className={gap ? "source-doc__facts--gap" : undefined}>{sourceFormatLabel(item)}{gap &&<>{" · "}<Tooltip layer content={pageGapHint(item)}><span className="source-doc__gap" tabIndex={0}>{gap}</span></Tooltip></>}{details.length > 0 && ` · ${details.join(" · ")}`}</small>
            </span>
            {item.renamedFrom && <small className="source-original" title={item.renamedFrom}>{originalNote(item)}</small>}
          </span>
        </button>}
        {/* The status line, always visible: 资料掌握度 (the snapshot's materialMastery) and 覆盖 beside it (drafts included; the mastery is only about published questions),
            then the index badge's slot, kept from the first paint so a late coverage answer fills it and moves nothing (#229). A click on it opens the material, as the title does. */}
        <div className="source-doc__status" onClick={openRow}>
          <span className="source-doc__quality"><MasteryLine className="source-doc__mastery" summary={mastery?.document ?? null} title={name} /><CoverageChip coverage={coverage} /></span>
          {indexSlot}
        </div>
        <div className="source-doc__actions">
          {companionTarget && openModal && (
            <Button size="sm" variant="secondary" icon="play" className="source-doc__action" onClick={() => openCompanionTarget(openModal, companionTarget)}>
              {ui('打开交互伴学页')}
            </Button>
          )}
          {canGenerate && <Button size="sm" variant="secondary" icon="sparkle" className="source-doc__action" lock={busy} onClick={() => actions.generate(item.sourceIds)}>{ui('从这份资料出题')}</Button>}
          {/* 为没覆盖的部分补题 of a material whose questions were published: a NEW draft, the deck's next part (ui/coverage/DocumentTopUp.jsx). */}
          {topUp && <DocumentTopUp item={item} revision={JSON.stringify(coverage)} />}
          {editor && !item.archived && <Button size="sm" variant="quiet" icon="edit" className="source-doc__action source-doc__rename" aria-label={uiFormat('重命名「{0}」', [name])} title={ui('重命名')} lock={busy} onClick={startEditing} />}
          {item.archived && <>
            <Button size="sm" variant="secondary" className="source-doc__action" lock={busy} onClick={() => actions.archive(item)}>{ui('恢复资料')}</Button>
            <Button size="sm" variant="danger" className="source-doc__action" lock={busy} onClick={() => actions.remove(item)}>{ui('永久删除')}</Button>
          </>}
          <details className="source-row-actions"><summary>{ui('更多')}</summary>
            <RowMenuItems item={item} onChangeCourse={actions.changeCourse} onMoveFolder={canMoveFolder ? actions.moveFolder : undefined}
              onArchive={item.archived ? undefined : actions.archive} onSegment={canSegment ? actions.segment : undefined} onRename={editor ? startEditing : undefined}
              onPin={actions.pin} onPinMove={actions.pinMove} pin={{ pinned, first: pinFirst, last: pinLast }} />
          </details>
        </div>
      </div>
      {(multi || chaptered) && <div className="source-doc__pages">
        <div className="source-doc__pages-bar">
          <Button variant="quiet" size="sm" iconEnd="chevron" iconEndClassName="source-doc__pages-chevron" className="source-doc__pages-toggle" aria-expanded={pagesOpen} aria-controls={listId}
            onClick={() => setPagesOpen(open => !open)}>
            {pagesOpen ? ui('收起') : chaptered ? uiFormat('查看 {0} 章', [item.chapters.length]) : item.format === 'pdf' ? uiFormat('查看 {0} 页', [item.pages.length]) : uiFormat('查看 {0} 部分', [item.pages.length])}
          </Button>
          {/* 深度定制 (skills/study-custom) for a book of CUSTOM_BOOK_PAGES pages or more: always here, not once; 查看/修改定制 once the course has a plan (ui/custom-entry.js). */}
          {custom && <HandOff id="custom.start" shape="quiet" label={custom.hasCustom ? CUSTOM_ROW_EDIT_LABEL : CUSTOM_ROW_LABEL} what={custom.hasCustom ? CUSTOM_ROW_EDIT_WHAT : CUSTOM_BOOK_WHAT}
            data-tour="custom-book-row" input={custom} aria-label={uiFormat('{0}：{1}', [ui(custom.hasCustom ? CUSTOM_ROW_EDIT_LABEL : CUSTOM_ROW_LABEL), name])} />}
        </div>
        {pagesOpen && chaptered && <ChapterList item={item} onOpen={actions.open} onGenerate={canGenerate ? actions.generate : undefined}
          onPractice={canPractice ? actions.practiceChapter : undefined} listId={listId} mastery={mastery} />}
        {pagesOpen && !chaptered && <ul id={listId} className="source-doc__page-list" role="region" aria-label={ui('页面列表')} tabIndex={0}>
          {item.pages.map(page => <li key={page.sourceId}>
            <Button variant="quiet" block align="start" className="source-doc__row" onClick={() => actions.open(page.sourceId)}>
              <span>{pageLabel(item, page)}</span><small>{uiFormat("{0} 字符", [formatNumber(page.chars)])}</small>
              <MasteryLine className="source-doc__mastery" summary={mastery?.pages?.[page.sourceId] ?? null} title={pageLabel(item, page)} />
            </Button>
          </li>)}
        </ul>}
      </div>}
      {advice && <Disclosure className="source-doc__advice" meta={ui('大教材建议')} summary={<Tooltip layer content={adviceTip()}>
          <span tabIndex={0}>{uiFormat('这份资料有 {0} 页，建议按章节使用', [pages])}</span></Tooltip>}>
        <LargeDocumentCard reason="long-document" detail={{ name, pages }} document={indexInfo ? { info: indexInfo, courses: item.courses } : undefined}
          retrieval={retrieval} onOpenSettings={actions.openSettings} runnable courses={courses} defaultCourse={item.courses?.[0] || defaultCourse} />
      </Disclosure>}
    </article>
  );
}, sourceRowPropsEqual);

const removePluginWarning = () => ui('删除资料前请启用题库和学习组件，以检查已保存题目与学习记录的引用');

export function RemoveDialog({ item, onClose, onRemoved }) {
  const { busy, act } = useStudy();
  const appData = useContext(AppContext)?.data;
  const canRemove = hasContext(appData, 'bank') && hasContext(appData, 'study');
  const blocked = item.usedBy.length > 0 || !item.archived || !canRemove;
  async function confirm() {
    const result = await removeDocument(item, { act });
    if (!result.failed.length) return;
    throw new Error(result.failed[0].error);
  }
  const pages = item.pages.length;
  return (
    <PermanentDeleteDialog title={displayTitle(item.title)} busy={busy} blocked={blocked}
      onConfirm={confirm} onDeleted={() => onRemoved(item)} onClose={onClose}>
      <p>{item.format === 'pdf' && pages > 1 ? uiFormat("这份 PDF 的 {0} 页文字都会永久删除，不能撤销。", [pages]) : ui("这份资料会永久删除，不能撤销。")}</p>
      {!canRemove && <InlineMessage tone="warning">{removePluginWarning()}</InlineMessage>}
      {!item.archived && <InlineMessage>{ui('这份资料需要先归档，才能永久删除。')}</InlineMessage>}
      {item.usedBy.length > 0 && <InlineMessage tone="warning" boxed title={ui("有题组引用这份资料，不能永久删除")}>
        {uiFormat("引用它的题组：{0}。先删除或改写这些题，再永久删除资料。", [item.usedBy.map(deck => deck.title).join(" · ")])}
      </InlineMessage>}
    </PermanentDeleteDialog>
  );
}

export function BatchRemoveDialog({ items, onClose, onRemoved }) {
  const { busy, act } = useStudy();
  const appData = useContext(AppContext)?.data;
  if (items.length === 1) return <RemoveDialog item={items[0]} onClose={onClose} onRemoved={item => onRemoved([item])} />;
  const canRemove = hasContext(appData, 'bank') && hasContext(appData, 'study');
  const cited = items.filter(item => item.usedBy.length > 0);
  const unarchived = items.filter(item => !item.archived);
  const blocked = cited.length > 0 || unarchived.length > 0 || !canRemove;
  async function confirm() {
    const result = await removeDocuments(items, { act });
    if (!result.failed.length) return;
    throw new Error(result.failed[0].error);
  }
  return (
    <ConfirmDialog title={uiFormat('永久删除这 {0} 份资料？', [items.length])} confirmLabel={ui('确认永久删除')}
      busy={busy} blocked={blocked} onConfirm={confirm} onDone={() => onRemoved(items)} onClose={onClose}>
      <p>{uiFormat('这 {0} 份资料会永久删除，不能撤销。', [items.length])}</p>
      {!canRemove && <InlineMessage tone="warning">{removePluginWarning()}</InlineMessage>}
      {unarchived.length > 0 && <InlineMessage>{ui('所选资料需要先归档，才能永久删除。')}</InlineMessage>}
      {cited.length > 0 && <InlineMessage tone="warning" boxed title={uiFormat('其中 {0} 份资料有题组引用，不能永久删除', [cited.length])}>
        {uiFormat('受引用保护的资料：{0}。先取消勾选这些资料，或先删除引用它们的题目。', [cited.map(item => displayTitle(item.title)).join(' · ')])}
      </InlineMessage>}
    </ConfirmDialog>
  );
}

/** The head of a group of rows (a course, folder, day, or the pinned ones): one button that opens and closes it. */
function GroupHead({ expanded, onToggle, className = '', children }) {
  return <button className={className ? `source-group-head ${className}` : "source-group-head"} aria-expanded={expanded} onClick={onToggle}>
    <Icon name="caret" size={14} className="sh-caret" />
    {children}
  </button>;
}

export default function Sources({ data, setModal, sourceForm, openAgent, onGenerate, onPractice, onOpenSources, onLegacyRetry, onOpenSettings, onBuildIndex, highlight }) {
  const { busy, act, call } = useStudy();
  const refresh = useContext(AppContext)?.core?.refresh;
  useInjectCss(css, "study-sources");
  const toast = useToast();
  const [scope, setScope] = usePageScope(data.root, 'sources', data.focus?.course ?? '*');
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [viewState, setViewState] = useState(() => ({ root: data.root, mode: readGroupMode(data.root), sort: readSortMode(data.root) }));
  const groupMode = viewState.root === data.root ? viewState.mode : readGroupMode(data.root);
  const sortBy = viewState.root === data.root ? viewState.sort : readSortMode(data.root);
  const chooseGroupMode = next => {
    if (!VALID_GROUP_MODES.has(next)) return;
    writeJSON(groupModeKey(data.root), next, browserStorage());
    setViewState({ root: data.root, mode: next, sort: sortBy });
  };
  const chooseSort = next => {
    if (!VALID_SORTS.has(next)) return;
    writeJSON(sortModeKey(data.root), next, browserStorage());
    setViewState({ root: data.root, mode: groupMode, sort: next });
  };
  // One measure for the page: the width of the study container, which is what the container queries of ui/sources.css read.
  const pageRef = useRef(null);
  const narrow = useNarrow(pageRef, ROWS_NARROW, { content: true });
  const allItems = useMemo(() => groupSourcesByDocument(data.sources), [data.sources]);
  const items = useMemo(() => allItems.filter(item => item.archived === showArchived), [allItems, showArchived]);
  const byId = useMemo(() => new Map(data.sources.map(source => [source.id, source])), [data.sources]);
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const scoped = useMemo(() => items.filter(item => inScope(item, scope, known)), [items, scope, known]);
  const filtering = !!query.trim();
  const filtered = useMemo(() => filtering ? filterItems(scoped, query, documentSearchText) : scoped, [scoped, filtering, query]);
  // Books of more than 300 pages get the 大教材建议; what DSH can search with is read once, and only then (WP28).
  const bigKeys = useMemo(() => new Set(bigDocuments(items).map(item => item.key)), [items]);
  // Whether each material's search index is built (the rows say so); read once, and followed while a build runs.
  const [indexCoverage, , indexStatus] = useIndexCoverage(call);
  const { data: retrieval } = useRetrievalStatus({ enabled: bigKeys.size > 0 });
  // 置顶: the pinned rows leave the groups and form their own group above them; with nothing pinned `rest` is `filtered` itself. The archive has no pins.
  const pins = useMemo(() => pinnedKeys(data.settings), [data.settings]);
  const materialFolders = useMemo(
    () => (data.materialFolders ? readMaterialFolders({ materialFolders: data.materialFolders }) : readMaterialFolders(data.settings)),
    [data.materialFolders, data.settings],
  );
  const { pinned, rest } = useMemo(() => showArchived ? { pinned: [], rest: filtered } : splitPinned(filtered, pins), [filtered, pins, showArchived]);
  const locale = uiLocale();
  const groups = useMemo(
    () => buildSourceGroups(rest, { mode: groupMode, folders: materialFolders, sort: sortBy, includeEmpty: groupMode === 'folder' && !filtering && !showArchived, locale, scope, known }),
    [rest, groupMode, materialFolders, sortBy, filtering, showArchived, locale, scope, known],
  );
  // The header describes the scope, not the filter: the filter's own count says how many match, so typing changes no line above the controls (#1085);
  // its 全部展开 / 全部收起 is there and named by the scope's groups too, so typing neither adds, removes nor renames a header button.
  const scopeView = useMemo(() => {
    const split = showArchived ? { pinned: [], rest: scoped } : splitPinned(scoped, pins);
    const scopeGroups = buildSourceGroups(split.rest, { mode: groupMode, folders: materialFolders, sort: sortBy, includeEmpty: groupMode === 'folder' && !showArchived, locale, scope, known });
    return { groupKeys: scopeGroups.map(group => group.key), summary: { count: scoped.length, pinned: split.pinned.length, rest: split.rest.length, groups: scopeGroups.length } };
  }, [scoped, pins, showArchived, groupMode, materialFolders, sortBy, locale, scope, known]);
  const scopeSummary = scopeView.summary;
  // Materials made from one original file say so on their rows (#207), as in the picker of 创建题组.
  const relations = useMemo(() => materialRelations(items), [items]);
  // One index state per document, reusing the previous object while it is unchanged: a coverage answer then touches only the rows whose badge changed (#229).
  const infoCache = useRef(new Map());
  const infos = useMemo(() => {
    const next = new Map();
    for (const item of items) {
      const info = documentIndexState(item, indexCoverage, { big: bigKeys.has(item.key) }), before = infoCache.current.get(item.key);
      next.set(item.key, sameIndexInfo(before, info) ? before : info);
    }
    infoCache.current = next;
    return next;
  }, [items, indexCoverage, bigKeys]);
  // The materials of this page that are not fully indexed: one line under the header says how many, and goes to where the index is built.
  const gap = useMemo(() => (onBuildIndex && !showArchived ? indexGap(scoped.map(item => ({ item, info: infos.get(item.key) }))) : null), [onBuildIndex, showArchived, scoped, infos]);
  const fresh = useMemo(() => new Set(items.filter(item => item.sourceIds.some(id => highlight?.ids?.includes(id))).map(item => item.key)), [items, highlight]);
  // All groups default expanded (newly appearing groups too), with closed group keys persisted in localStorage per library + groupMode (#1071).
  const foldKey = `${data.root || ''}:${groupMode}`;
  const [closedState, setClosedState] = useState(() => ({ key: foldKey, set: readClosedSet(data.root, groupMode) }));
  const closed = closedState.key === foldKey ? closedState.set : readClosedSet(data.root, groupMode);
  const updateClosed = updater => {
    setClosedState(current => {
      const base = current.key === foldKey ? current.set : readClosedSet(data.root, groupMode);
      const next = updater(base);
      writeJSON(closedGroupsKey(data.root, groupMode), [...next], browserStorage());
      return { key: foldKey, set: next };
    });
  };
  const isOpen = group => filtering || !closed.has(group.key);
  // A new import reopens its group even if the learner had closed it.
  useEffect(() => {
    if (!highlight?.at) return;
    const reopen = new Set(groups.filter(group => group.rows.some(item => fresh.has(item.key))).map(group => group.key));
    if (pinned.some(item => fresh.has(item.key))) reopen.add(PINNED);
    if (reopen.size) updateClosed(current => new Set([...current].filter(key => !reopen.has(key))));
  }, [highlight?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  // Dismiss any open row 更多 menu on outside pointerdown or Escape while keeping <details class="source-row-actions"> intact.
  useEffect(() => {
    const root = pageRef.current;
    if (!root || typeof document === 'undefined') return undefined;
    const onPointerDown = event => {
      for (const el of root.querySelectorAll('details.source-row-actions[open]')) {
        if (!el.contains(event.target)) el.removeAttribute('open');
      }
    };
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      const openMenus = [...root.querySelectorAll('details.source-row-actions[open]')];
      if (!openMenus.length) return;
      const activeMenu = openMenus.find(el => el.contains(document.activeElement));
      for (const el of openMenus) el.removeAttribute('open');
      activeMenu?.querySelector('summary')?.focus?.({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  /* A material that was just imported must be on the page the import lands on. The page is filtered by course, and the new material may belong to another one
     (or to none): then the page shows all courses, once per import, instead of hiding what the learner just added. */
  const widened = useRef(0);
  useEffect(() => {
    if (!highlight?.at || widened.current === highlight.at || !highlight.ids?.length) return;
    const landed = allItems.filter(item => item.sourceIds.some(id => highlight.ids.includes(id)));
    if (!landed.length) return;
    widened.current = highlight.at;
    if (landed.some(item => !inScope(item, scope, known))) setScope('*');
  }, [highlight?.at, allItems]); // eslint-disable-line react-hooks/exhaustive-deps
  const [organizing, setOrganizing] = useState(false), [selected, setSelected] = useState([]);
  const [courseText, setCourseText] = useState(''), [proposals, setProposals] = useState(null);
  const [batchFolder, setBatchFolder] = useState('');
  // EXPERIMENTAL (hidden unless "Show experimental features" is on, off by default): Jev's course suggestions share the AI suggestions' rows and apply button.
  const experimental = experimentalShown(data), jevOn = useJevCourseSuggest(call, experimental ? undefined : false), [jevNote, setJevNote] = useState(''), [jevRun, setJevRun] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [removingBatch, setRemovingBatch] = useState(null);
  const [editingCourse, setEditingCourse] = useState(null);
  const [movingFolder, setMovingFolder] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState(null);
  const [deletingFolder, setDeletingFolder] = useState(null);
  const [segmenting, setSegmenting] = useState(null);
  // A rename in the row says nothing more: the row shows the new name the moment the field closes (a toast that repeats it is noise, #677).
  const renameFor = (act || call) ? item => ({
    save: async title => { await renameDocument({ act, call }, item, { title }); },
    restore: async () => { await renameDocument({ act, call }, item, { restore: true }); },
  }) : undefined;
  const finish = () => { setProposals(null); setSelected([]); setJevRun(null); };
  // B6: every batch action (course attribution, AI suggest, folder move, archive, restore, permanent delete) acts strictly on visible `chosen` items in active scope/filter.
  const chosen = filtered.filter(item => selected.includes(item.key));
  const archiveChosen = async () => {
    if (!chosen.length) return;
    const done = await act('source.archive', { sourceIds: idsOfDocuments(chosen), archived: true });
    if (!done) return;
    finish();
    offerArchived(chosen);
  };
  const restoreChosen = async () => {
    if (!chosen.length) return;
    const done = await act('source.archive', { sourceIds: idsOfDocuments(chosen), archived: false });
    if (!done) return;
    finish();
    toast.success(chosen.length === 1
      ? uiFormat('已取消归档「{0}」', [displayTitle(chosen[0].title)])
      : uiFormat('已恢复 {0} 份资料', [chosen.length]));
  };
  const toggle = group => {
    const open = isOpen(group);
    updateClosed(current => { const next = new Set(current); open ? next.add(group.key) : next.delete(group.key); return next; });
  };
  // The learner's own folds (a filter opens every matching group for a while but leaves them as they were).
  const allOpen = scopeView.groupKeys.length > 0 && scopeView.groupKeys.every(key => !closed.has(key));
  // The pinned group is open unless the learner closed it (or while filtering so matching pinned rows stay visible).
  const pinnedOpen = filtering || !closed.has(PINNED);
  const togglePinned = () => updateClosed(current => { const next = new Set(current); pinnedOpen ? next.add(PINNED) : next.delete(PINNED); return next; });
  // Dragging a pinned row: `drag` is { key, over, side }; dragging a row into a folder in folder mode: `folderDragKey` & `folderDropKey`.
  const [drag, setDrag] = useState(null);
  const [folderDragKey, setFolderDragKey] = useState(null);
  const [folderDropKey, setFolderDropKey] = useState(null);
  // The handlers the rows call: one object that never changes and reads the latest state itself, so a row is drawn again only for its own data (#229).
  const latest = useRef(null);
  // 归档 says so and offers 撤销 (source.archive back) and the second step of archive-first, 永久删除…, which opens the same dialog as the archive's own button.
  // The keyboard focus after 撤销 is the row's 更多 again; after 永久删除… is closed it is that row, or the 已归档 button when the row is in the archive.
  const rowMenu = key => () => document.querySelector(`[data-document-key="${CSS.escape(key)}"] .source-row-actions > summary`);
  // One document (its row) or the checked ones (整理 panel) go through the same notice (ui/archive-entries.js); several have no single dialog, so permanent delete stays per document.
  const offerArchived = items => offerDocumentsArchived({ toast, items, onRemove: setRemoving,
    restore: async () => { await call('source.archive', { sourceIds: idsOfDocuments(items), archived: false }); Promise.resolve(refresh?.()).catch(() => {}); return true; },
    focus: items.length === 1 ? rowMenu(items[0].key) : () => document.querySelector('.source-organize > summary') });
  const closeRemoving = () => {
    const was = removing;
    setRemoving(null);
    if (was?.fromNotice) setTimeout(() => { (rowMenu(was.key)() || document.querySelector('[data-archive-toggle]'))?.focus?.(); }, 30);
  };
  latest.current = { offerArchived, setModal, byId, act, onGenerate, onPractice, toast, onOpenSettings, onBuildIndex, renameFor, drag, pinKeys: pins, shownPins: pinned.map(item => item.key) };
  const actions = useMemo(() => ({
    open: id => latest.current.setModal({ type: "source", source: latest.current.byId.get(id) }),
    select: (key, on) => { setSelected(current => on ? [...current, key] : current.filter(entry => entry !== key)); setProposals(null); },
    generate: ids => latest.current.onGenerate?.(ids),
    // 练这一章: ask which questions the chapter's number counts (materials.pages.cards { chapter }), then start the ordinary practice round on them.
    practiceChapter: async (item, chapter) => {
      const { act, onPractice: start, toast: say } = latest.current;
      const view = await act('materials.pages.cards', { documentId: item.documentId || item.key, sourceId: item.sourceIds[0], chapter: chapter.index }, undefined, { refreshAfter: false });
      if (!view) return;
      const refs = (view.cards || []).map(({ deckId, cardId }) => ({ deckId, cardId }));
      if (refs.length) start?.(refs); else say.info(ui('这一章现在没有可练的题（已斩或已归档的不算）。可以先用这份资料出题。'));
    },
    archive: async item => {
      const done = await latest.current.act('source.archive', { sourceIds: item.sourceIds, archived: !item.archived });
      if (done && !item.archived) latest.current.offerArchived([item]);
    },
    remove: item => setRemoving(item), changeCourse: item => setEditingCourse(item), moveFolder: item => setMovingFolder(item), segment: item => setSegmenting(item),
    rename: item => latest.current.renameFor(item),
    pin: item => latest.current.act('source.pin', { key: item.key, pinned: !latest.current.pinKeys.includes(item.key) }),
    pinMove: (item, step) => { const request = stepRequest(latest.current.shownPins, item.key, step); if (request) latest.current.act('source.pin.move', request); },
    // Drag to reorder (as the board's cards): only a drag that started on a pinned row is taken, and it lands as the same request as 上移 / 下移.
    dragStart: (key, event) => { event.dataTransfer.setData('application/x-study-pinned-material', key); event.dataTransfer.effectAllowed = 'move'; setDrag({ key, over: '', side: '' }); },
    dragOver: (key, event) => {
      const { drag: active, shownPins } = latest.current;
      if (!active || !shownPins.includes(key)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      const request = dropRequest(shownPins, active.key, key), side = request ? (request.before ? 'before' : 'after') : '';
      setDrag(current => current && (current.over !== key || current.side !== side) ? { ...current, over: key, side } : current);
    },
    drop: (key, event) => {
      const { drag: active, shownPins } = latest.current;
      if (!active) return;
      event.preventDefault(); setDrag(null);
      const request = dropRequest(shownPins, active.key, key);
      if (request) latest.current.act('source.pin.move', request);
    },
    dragEnd: () => setDrag(null),
    folderDragStart: (key, event) => { event.dataTransfer.setData('application/x-study-folder-material', key); event.dataTransfer.effectAllowed = 'move'; setFolderDragKey(key); },
    folderDragEnd: () => { setFolderDragKey(null); setFolderDropKey(null); },
    openSettings: (...args) => latest.current.onOpenSettings?.(...args),
    buildIndex: course => latest.current.onBuildIndex?.(course),
  }), []);
  // The 深度定制 entry of each long book, reusing the previous object while it is unchanged: a refresh that changes nothing for a row leaves the row alone.
  const offerCache = useRef(new Map());
  const offers = useMemo(() => {
    const next = new Map();
    for (const item of showArchived ? [] : items) {
      const offer = customRowOffer(item, data.courses), before = offerCache.current.get(item.key);
      if (offer) next.set(item.key, before && Object.keys(offer).every(key => before[key] === offer[key]) ? before : offer);
    }
    offerCache.current = next;
    return next;
  }, [items, data.courses, showArchived]);
  // A group draws its rows in chunks (ChunkedRows); the rows something goes to are drawn even past the first chunk: the new import, and the 深度定制 button 找功能 looks for.
  // A new course scope, filter query, grouping mode, sort mode or archive toggle starts every group from its first chunk again.
  const chunkKey = `${scope}|${showArchived}|${query.trim()}|${groupMode}|${sortBy}`;
  const rowOf = (rows, keys) => rows.findIndex(item => keys.has(item.key));
  const anchorsOf = rows => ({ 'custom-book-row': rowOf(rows, offers) });
  // One row, in a group or in the pinned group (`pin`: where it stands among the pinned rows).
  const renderRow = (item, pin = {}) => <DocumentRow key={item.key} item={item} source={byId.get(item.sourceIds[0])}
    isNew={fresh.has(item.key)} organizing={organizing} selected={selected.includes(item.key)} actions={actions}
    canGenerate={!showArchived && !!onGenerate} canPractice={!showArchived && !!onPractice} canSegment={typeof call === 'function'} canRename={!!renameFor}
    canMoveFolder={!!(act || call)} showExtraCourseBadges={groupMode === 'course'} folderDrag={groupMode === 'folder' && !showArchived}
    mastery={data.materialMastery?.[item.key]} coverage={data.materialCoverage?.[item.key]}
    topUp={!showArchived && offersDocumentTopUp({ item, coverage: data.materialCoverage?.[item.key], jobs: data.jobs, modelReady: modelReadiness(data).ready })} indexInfo={infos.get(item.key) ?? null} canIndex={indexCoverage?.canIndex} indexLink={!!onBuildIndex} slot={indexStatus !== 'unavailable'}
    relation={relations.get(item.key) ?? null} advice={bigKeys.has(item.key)} retrieval={bigKeys.has(item.key) ? retrieval : null} custom={offers.get(item.key) ?? null}
    courses={data.focus?.courses} defaultCourse={data.focus?.course}
    pinned={!!pin.pinned} pinFirst={!!pin.first} pinLast={!!pin.last} dragging={!!pin.pinned && drag?.key === item.key} dropMark={pin.pinned && drag?.over === item.key ? drag.side : ''} />;
  const addButton = <AddSourceButton variant="primary" data-tour="sources-add" data-usage="import.add"
    onClick={() => setModal({ type: "add", course: scope === '*' ? '' : scope })} />;
  const archivedCount = allItems.filter(item => item.archived).length;
  const toggleArchived = () => { setShowArchived(value => !value); setSelected([]); setProposals(null); setRemovingBatch(null); };
  const toggleGroups = () => {
    const keys = scopeView.groupKeys;
    if (allOpen) updateClosed(current => new Set([...current, ...keys]));
    else updateClosed(current => new Set([...current].filter(key => !keys.includes(key))));
  };
  const openCompanions = () => setModal({ type: "companionBuild", course: scope === '*' ? (data.focus?.course || '') : scope });
  const archiveLabel = showArchived ? ui('返回资料') : uiFormat('已归档（{0}）', [archivedCount]);
  const requestDeleteFolder = (folder, count) => {
    if (count > 0) { setDeletingFolder({ folder, count }); return; }
    act('source.folder.delete', { folder });
  };
  const groupTitle = key => {
    if (groupMode === 'course') return key === UNASSIGNED_COURSE ? ui('未分类') : key;
    if (groupMode === 'folder') return key === UNFILED_FOLDER ? ui('未归入文件夹') : key;
    if (groupMode === 'none') return ui('全部资料');
    return dayLabel(key);
  };
  // The header's actions sit on the title's row: all of them when they fit beside the title in this language and width, else 添加资料 with one 更多 before it
  // (#1083). Either way 添加资料 is last, at the right edge; whether they fit is measured (ui/use-row-fit.js), not guessed from the page's width.
  const groupsLabel = allOpen ? ui("全部收起") : ui("全部展开"), manyGroups = scopeView.groupKeys.length > 1;
  const fullHeader = useRowFit(pageRef, '.sources-page__header .sh-page-header__title-row', [archiveLabel, manyGroups && groupsLabel, locale].join('|'));
  const headerActions = fullHeader
    ? <>
      <Button variant="quiet" icon={showArchived ? 'arrow-left' : 'archive'} data-archive-toggle data-tour="sources-archived" aria-pressed={showArchived} onClick={toggleArchived}>{archiveLabel}</Button>
      {manyGroups && <Button variant="quiet" icon="list" onClick={toggleGroups}>{groupsLabel}</Button>}
      <Button variant="secondary" icon="play" onClick={openCompanions}>{ui("交互伴学")}</Button>
      {addButton}
    </>
    : <>
      <Menu label={ui('更多')} data-tour="sources-archived"
        items={[{ id: 'archived', icon: showArchived ? 'arrow-left' : 'archive', label: archiveLabel, attrs: { 'data-archive-toggle': '' } },
          ...(manyGroups ? [{ id: 'groups', icon: 'list', label: groupsLabel }] : []),
          { id: 'companions', icon: 'play', label: ui("交互伴学") }]}
        onSelect={id => (id === 'archived' ? toggleArchived : id === 'groups' ? toggleGroups : openCompanions)()}
        trigger={({ props, ref }) => <Button ref={ref} variant="quiet" {...props}>{ui('更多')}</Button>} />
      {addButton}
    </>;
  return (
    <section ref={pageRef} className={`page sources-page${narrow ? ' is-narrow' : ''}`}>
      <PageHeader className={`sources-page__header sh-page-header--measured${fullHeader ? '' : ' sh-page-header--compact-actions'}`} title={ui("资料")}
        description={<>{ui("题目从这里生长。原文与引用一直保留。")}{items.length > 0 && groupSummaryDescription({ mode: groupMode, summary: scopeSummary })}</>}
        actions={headerActions} actionsOnTitleRow />
      {gap && <IndexGapLine count={gap.count} canIndex={indexCoverage?.canIndex} onGo={() => onBuildIndex(gap.course)} />}
      {(items.length > 0 || (groupMode === 'folder' && !showArchived && materialFolders.folders.length > 0)) && <>
        {/* 课程范围 and 筛选资料 are one small form: the label in one column, both controls in the next, at one left edge and one width (#1085). */}
        <div className="page-scope-form sources-toolbar">
        <PageScope value={scope} onChange={setScope} courses={data.focus?.courses} />
        <div className="sources-filter">
          <TextInput type="search" className="sources-filter__input" value={query} placeholder={ui('筛选资料…')} aria-label={ui('筛选资料…')}
            autoComplete="off" spellCheck={false}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
              if (event.key !== 'Escape') return;
              event.preventDefault();
              if (query) { event.stopPropagation(); setQuery(''); }
              else event.currentTarget?.blur?.();
            }} />
          {/* Inside the field's end, over padding it always keeps (ui/sources.css): the numbers, said in full for a screen reader, and the × of 清除筛选. */}
          {filtering && <span className="sources-filter__state">
            <small className="sources-filter__count muted" aria-live="polite"><span aria-hidden="true">{filtered.length} / {scoped.length}</span>
              <span className="sh-visually-hidden">{scrollWindowCount(scoped.length, filtered.length, true)}</span></small>
            <Button variant="quiet" size="sm" icon="close" aria-label={ui('清除筛选')} title={ui('清除筛选')} onClick={() => setQuery('')} />
          </span>}
        </div>
        </div>
        <div className="sources-view-bar">
          <SegmentedControl size="sm" wrap label={ui('分组方式')} value={groupMode} onChange={chooseGroupMode} options={[
            { value: 'course', label: ui('按课程') },
            { value: 'folder', label: ui('按文件夹') },
            { value: 'day', label: ui('按导入日期') },
            { value: 'none', label: ui('平铺') },
          ]} />
          <Select className="sources-view-bar__sort" aria-label={ui('排序')} value={sortBy} onChange={chooseSort} options={[
            { value: 'recent', label: ui('最近导入') },
            { value: 'title', label: ui('按标题') },
          ]} />
          {groupMode === 'folder' && !showArchived && !!(act || call) && (
            <Button size="sm" variant="secondary" icon="plus" lock={busy} onClick={() => setCreatingFolder(true)}>{ui('新建文件夹')}</Button>
          )}
        </div>
        {items.length > 0 && <details className="source-organize" data-tour="sources-organize" onToggle={event => setOrganizing(event.currentTarget.open)}>
          <summary>{showArchived ? ui('批量管理已归档资料') : ui('整理课程归属')}</summary>
          <p className="muted">{showArchived ? ui('勾选已归档资料后，可批量恢复、统一永久删除，或整理课程归属。') : ui('勾选资料后统一整理。改课程归属时，原文与引用保持不变。')}</p>
          <p>{uiFormat('已选择 {0} 份资料', [chosen.length])}{' '}
            <Button disabled={!filtered.length} onClick={() => { setSelected(filtered.map(item => item.key)); setProposals(null); }}>{filtering ? ui('选择筛选结果') : ui('选择当前范围')}</Button>{' '}
            {selected.length > 0 && <Button onClick={finish}>{ui('清空选择')}</Button>}
          </p>
          <CourseField value={courseText} onChange={setCourseText} courses={data.focus?.courses} multiple disabled={busy} />
          <div className="source-organization-actions">
            <Button disabled={!chosen.length} lock={busy} onClick={() => act('source.courses.set', {
              assignments: courseAssignments(chosen, chosen.map(item => item.key), parseCourses(courseText), byId),
            }, finish)}>{ui('应用课程归属')}</Button>
            <Button disabled={!modelReadiness(data).ready || !chosen.length || chosen.length > 100} lock={busy}
              onClick={() => act('source.organize.suggest', { sourceIds: chosen.map(item => item.sourceIds[0]) }, result => {
                setJevRun(result.jev ?? null);
                setProposals(result.proposals.map(proposal => {
                  const item = items.find(entry => entry.sourceIds.includes(proposal.id));
                  // A row Jev decided starts included only if it changes something, like the Jev button's rows; the model's rows start included.
                  return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: proposal.decidedBy === 'jev' ? startsIncluded(proposal) : true, courseText: proposal.courses.join('; ') };
                }));
              })}>{ui('请 AI 建议')}</Button>
            <JevSuggestButton enabled={jevOn} disabled={busy || !chosen.length || chosen.length > 100}
              onClick={() => { setJevNote(''); act('source.organize.jev', { sourceIds: chosen.map(item => item.sourceIds[0]) }, result => {
                setJevNote(noteText(result));
                if (result.proposals.length) setProposals(result.proposals.map(proposal => {
                  const item = items.find(entry => entry.sourceIds.includes(proposal.id));
                  return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: startsIncluded(proposal), courseText: proposal.courses.join('; ') };
                }));
              }); }} />
          </div>
          {!showArchived && <div className="source-folder-actions">
            <Select className="source-folder-actions__select" aria-label={ui('目标文件夹')} value={batchFolder} onChange={setBatchFolder}
              options={[{ value: '', label: ui('未归入文件夹') }, ...materialFolders.folders.map(folder => ({ value: folder, label: folder }))]} disabled={busy} />
            <Button disabled={!chosen.length} lock={busy} onClick={() => act('source.folder.set', {
              keys: chosen.map(item => item.key),
              folder: batchFolder || null,
            }, finish)}>{ui('移入文件夹')}</Button>
          </div>}
          <ModelSetupGate variant="compact" feature="organize" model={modelReadiness(data)} />
          {experimental && <JevNote note={jevNote} />}
          {experimental && <JevRunNote jev={jevRun} />}
          {/* 归档所选: the checked documents in one go (a material is archived before it can be deleted; in 已归档, checked ones can be restored or permanently deleted together). */}
          {!showArchived ? <div className="source-organization-actions source-archive-actions">
            <Button disabled={!chosen.length} lock={busy} data-archive-selected onClick={archiveChosen}>{chosen.length ? uiFormat('归档所选（{0}）', [chosen.length]) : ui('归档所选')}</Button>
            <span className="muted">{ui('归档会把它们从这个列表收起，可以在「已归档」里恢复。')}</span>
          </div> : <div className="source-organization-actions source-archive-actions">
            <Button disabled={!chosen.length} lock={busy} data-restore-selected onClick={restoreChosen}>{chosen.length ? uiFormat('恢复所选（{0}）', [chosen.length]) : ui('恢复所选')}</Button>
            <Button variant="danger" disabled={!chosen.length} lock={busy} data-delete-selected onClick={() => setRemovingBatch(chosen)}>{chosen.length ? uiFormat('永久删除所选（{0}）', [chosen.length]) : ui('永久删除所选')}</Button>
            <span className="muted">{ui('恢复会把它们放回资料列表；永久删除不可撤销。')}</span>
          </div>}
          {proposals &&<div className="source-course-proposals">
            <p className="muted">{ui('建议尚未保存，可先修改课程，再确认应用。')}</p>
            {proposals.map(proposal => <div key={proposal.id}>
              <Checkbox checked={proposal.include} disabled={busy} label={uiFormat('采用建议：{0}', [displayTitle(proposal.title)])}
                onChange={include => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, include } : item))} />
              <CourseField label={displayTitle(proposal.title)} value={proposal.courseText} multiple courses={data.focus?.courses}
                onChange={courseText => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, courseText } : item))} disabled={busy || !proposal.include} />
              <p className="muted">{proposal.reason}{experimental && proposal.decidedBy === 'jev' && <> <JevDecidedBadge scope="row" /></>}</p>
              {experimental && <JevProbabilities jev={proposal.jev} />}
            </div>)}
            <Button disabled={!proposals.some(proposal => proposal.include)} lock={busy} onClick={() => act('source.courses.set', {
              assignments: proposals.filter(proposal => proposal.include).flatMap(proposal =>
                courseAssignments(chosen, [proposal.key], parseCourses(proposal.courseText), byId)),
            }, finish)}>{ui('确认应用建议')}</Button>
          </div>}
        </details>}
        {items.length > 0 && !scoped.length && <p className="muted">{ui('这个范围还没有资料。可切换到全部课程查看。')}</p>}
        {items.length > 0 && scoped.length > 0 && !filtered.length && <p className="muted">{uiFormat('没有匹配“{0}”的资料', [query.trim()])}</p>}
      </>}
      <AudioJobs data={data} openAgent={openAgent} onOpenSources={onOpenSources} onLegacyRetry={onLegacyRetry} onGenerate={onGenerate} />
      <PdfConvertJobs data={data} act={act} onOpenSources={onOpenSources} onOpenSettings={onOpenSettings} onGenerate={onGenerate} />
      <PdfConvertHistory data={data} act={act} onOpenSources={onOpenSources} onOpenSettings={onOpenSettings} collapsible hideWhenEmpty />
      {!items.length && !(groupMode === 'folder' && !showArchived && materialFolders.folders.length > 0) ? (
        <section className="sources-empty" data-tour="sources-list">
          <div className="sources-empty__intro">
            <h2>{showArchived ? ui('没有已归档的资料。') : ui("还没有资料")}</h2>
            {!showArchived && <p>{ui("添加讲义、笔记或录音，之后就能用它们出题；题目会引用原文。")}</p>}
          </div>
          {!showArchived && sourceForm}
        </section>
      ) : (
        <div className="source-groups" data-tour="sources-list">
          {pinned.length > 0 && <div className={"source-group" + (pinnedOpen ? " source-group--open" : "")}>
            <GroupHead expanded={pinnedOpen} onToggle={togglePinned}>
              <strong>{ui("已置顶")}</strong>
              <small className="muted">{uiFormat("{0} 份 · {1} 字符", [pinned.length, formatNumber(pinned.reduce((n, item) => n + item.chars, 0))])}</small>
            </GroupHead>
            {pinnedOpen && <ChunkedRows items={pinned} resetKey={chunkKey} reveal={rowOf(pinned, fresh)} anchors={anchorsOf(pinned)}
              render={(item, at) => renderRow(item, { pinned: true, first: at === 0, last: at === pinned.length - 1 })} />}
          </div>}
          {groups.map((g) => {
            const expanded = isOpen(g);
            const isNamedFolder = groupMode === 'folder' && g.key !== UNFILED_FOLDER;
            const folderDropProps = groupMode === 'folder' && !showArchived ? {
              'data-folder-key': g.key,
              onDragOver: event => {
                if (!folderDragKey && !event.dataTransfer?.types?.includes?.('application/x-study-folder-material')) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                if (folderDropKey !== g.key) setFolderDropKey(g.key);
              },
              onDragLeave: event => {
                if (!event.currentTarget.contains(event.relatedTarget) && folderDropKey === g.key) setFolderDropKey(null);
              },
              onDrop: event => {
                const draggedKey = event.dataTransfer?.getData('application/x-study-folder-material') || folderDragKey;
                setFolderDragKey(null);
                setFolderDropKey(null);
                if (!draggedKey) return;
                event.preventDefault();
                act('source.folder.set', { key: draggedKey, folder: g.key || null });
              },
            } : {};
            const head = (
              <GroupHead expanded={expanded} className={isNamedFolder && !showArchived && !!(act || call) ? 'source-group-head--in-row' : ''} onToggle={() => toggle(g)}>
                {isNamedFolder && <Icon name="folder" className="source-group-folder-icon sh-icon--inline" />}
                <strong>{groupTitle(g.key)}</strong>
                {groupMode === 'day' && g.inferred && <Badge size="sm" title={ui("这些资料保存时没有记录日期，按最早引用它们的题组推断")}>{ui("推断")}</Badge>}
                <small className="muted">{uiFormat("{0} 份 · {1} 字符", [g.rows.length, formatNumber(g.chars)])}</small>
              </GroupHead>
            );
            return (
              <div key={g.key} className={"source-group" + (expanded ? " source-group--open" : "") + (folderDropKey === g.key ? " source-group--drop" : "")} {...folderDropProps}>
                {isNamedFolder && !showArchived && !!(act || call) ? (
                  <div className="source-group-head-row">
                    {head}
                    <span className="source-group-actions">
                      <Button size="xs" variant="quiet" lock={busy} onClick={() => setRenamingFolder(g.key)}>{ui('重命名')}</Button>
                      <Button size="xs" variant="quiet" lock={busy} onClick={() => requestDeleteFolder(g.key, g.rows.length)}>{ui('删除')}</Button>
                    </span>
                  </div>
                ) : head}
                {expanded && (g.rows.length > 0
                  ? <ChunkedRows items={g.rows} resetKey={chunkKey} reveal={rowOf(g.rows, fresh)} anchors={anchorsOf(g.rows)} render={item => renderRow(item)} />
                  : <p className="source-group__empty muted">{ui('暂无资料。可将资料拖拽到此，或从行菜单移入。')}</p>)}
              </div>
            );
          })}
        </div>
      )}
      {editingCourse && <CourseDialog item={editingCourse} items={items} byId={byId} courses={data.focus?.courses}
        onClose={() => setEditingCourse(null)} />}
      {movingFolder && <MoveFolderDialog item={movingFolder} folders={materialFolders.folders} currentFolder={folderOfItem(materialFolders, movingFolder.key)}
        onClose={() => setMovingFolder(null)} />}
      {creatingFolder && <CreateFolderDialog onClose={() => setCreatingFolder(false)} />}
      {renamingFolder && <RenameFolderDialog folder={renamingFolder} onClose={() => setRenamingFolder(null)} />}
      {deletingFolder && <DeleteFolderDialog folder={deletingFolder.folder} count={deletingFolder.count} onClose={() => setDeletingFolder(null)} />}
      {segmenting && <OutlineDialog item={segmenting} onClose={() => setSegmenting(null)} />}
      {removing && <RemoveDialog item={removing} onClose={closeRemoving}
        onRemoved={item => { setRemoving(null); toast.success(uiFormat("已永久删除「{0}」", [displayTitle(item.title)])); }} />}
      {removingBatch && <BatchRemoveDialog items={removingBatch} onClose={() => setRemovingBatch(null)}
        onRemoved={removed => {
          setRemovingBatch(null);
          finish();
          toast.success(removed.length === 1
            ? uiFormat('已永久删除「{0}」', [displayTitle(removed[0].title)])
            : uiFormat('已永久删除 {0} 份资料', [removed.length]));
        }} />}
    </section>
  );
}

/** Fix where one document belongs, on its own row: the same field and the same source.courses.set as 整理课程归属, for one document. */
/** Saves the courses of a document through act(). Resolves '' when it worked, else the plain reason, so the dialog can say it where the learner is looking instead of in a notice that lands on top of its own buttons. */
export async function saveDocumentCourses(act, assignments, onDone) {
  try { await act('source.courses.set', { assignments }, onDone, { rethrow: true }); return ''; }
  catch (error) { return errorMessage(error); }
}

export function CourseDialog({ item, items, byId, courses, onClose }) {
  const { busy, act } = useStudy();
  const [text, setText] = useState(item.courses.join('; ')), [error, setError] = useState('');
  const save = async () => setError(await saveDocumentCourses(act, courseAssignments(items, [item.key], parseCourses(text), byId), onClose));
  return (
    <Dialog size="sm" title={uiFormat("修改「{0}」的课程", [displayTitle(item.title)])} busy={busy} onClose={onClose}
      footer={<>
        <Button variant="quiet" lock={busy} onClick={onClose}>{ui("取消")}</Button>
        <Button variant="primary" busy={busy} disabled={busy} onClick={save}>{ui("保存课程")}</Button>
      </>}>
      <p className="muted">{ui('只更改归属，原文与引用保持不变。留空就是「未分类」。')}</p>
      <CourseField value={text} onChange={value => { setText(value); setError(''); }} courses={courses} multiple disabled={busy} />
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

export function MoveFolderDialog({ item, folders = [], currentFolder = '', onClose }) {
  const { busy, act } = useStudy();
  const [name, setName] = useState(currentFolder);
  const [error, setError] = useState('');
  const save = async (target = name) => {
    try {
      const normalized = normalizeFolderName(target);
      await act('source.folder.set', { key: item.key, folder: normalized || null }, onClose, { rethrow: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog size="sm" title={uiFormat('将「{0}」移入文件夹', [displayTitle(item.title)])} busy={busy} onClose={onClose}
      footer={<>
        {currentFolder && <Button variant="quiet" lock={busy} onClick={() => save('')}>{ui('移出文件夹')}</Button>}
        <Button variant="quiet" lock={busy} onClick={onClose}>{ui('取消')}</Button>
        <Button variant="primary" busy={busy} disabled={busy} onClick={() => save(name)}>{ui('移入文件夹')}</Button>
      </>}>
      <p className="muted">{ui('选择已有文件夹，或直接输入新文件夹名称；留空则移回「未归入文件夹」。')}</p>
      {folders.length > 0 && (
        <div className="source-folder-dialog__chips">
          {folders.map(folder => (
            <Button key={folder} size="xs" variant={normalizeFolderName(name) === folder ? 'primary' : 'secondary'}
              lock={busy} onClick={() => { setName(folder); setError(''); }}>{folder}</Button>
          ))}
        </div>
      )}
      <Field label={ui('文件夹名称')}>
        <TextInput value={name} placeholder={ui('输入新文件夹名称…')} disabled={busy}
          onChange={event => { setName(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save(name); } }} />
      </Field>
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

function CreateFolderDialog({ onClose }) {
  const { busy, act } = useStudy();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    try {
      await act('source.folder.create', { name: normalizeFolderName(name) }, onClose, { rethrow: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog size="sm" title={ui('新建文件夹')} busy={busy} onClose={onClose}
      footer={<>
        <Button variant="quiet" lock={busy} onClick={onClose}>{ui('取消')}</Button>
        <Button variant="primary" busy={busy} disabled={busy || !normalizeFolderName(name)} onClick={create}>{ui('创建文件夹')}</Button>
      </>}>
      <Field label={ui('文件夹名称')}>
        <TextInput value={name} placeholder={ui('例如：第 1 周讲义、期中复习')} disabled={busy}
          onChange={event => { setName(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing && normalizeFolderName(name)) { event.preventDefault(); create(); } }} />
      </Field>
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

function RenameFolderDialog({ folder, onClose }) {
  const { busy, act } = useStudy();
  const [name, setName] = useState(folder);
  const [error, setError] = useState('');
  const save = async () => {
    try {
      await act('source.folder.rename', { from: folder, to: normalizeFolderName(name) }, onClose, { rethrow: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog size="sm" title={uiFormat('重命名文件夹「{0}」', [folder])} busy={busy} onClose={onClose}
      footer={<>
        <Button variant="quiet" lock={busy} onClick={onClose}>{ui('取消')}</Button>
        <Button variant="primary" busy={busy} disabled={busy || !normalizeFolderName(name)} onClick={save}>{ui('保存名称')}</Button>
      </>}>
      <Field label={ui('文件夹名称')}>
        <TextInput value={name} disabled={busy}
          onChange={event => { setName(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing && normalizeFolderName(name)) { event.preventDefault(); save(); } }} />
      </Field>
      {error && <InlineMessage>{error}</InlineMessage>}
    </Dialog>
  );
}

function DeleteFolderDialog({ folder, count, onClose }) {
  const { busy, act } = useStudy();
  const confirm = async () => {
    await act('source.folder.delete', { folder, unfile: true }, onClose, { rethrow: true });
  };
  return (
    <ConfirmDialog title={uiFormat('删除文件夹「{0}」？', [folder])} confirmLabel={ui('移出并删除文件夹')}
      busy={busy} onConfirm={confirm} onDone={onClose} onClose={onClose}>
      <p>{uiFormat('该文件夹内还有 {0} 份资料。删除文件夹不会删除资料本身，它们会回到「未归入文件夹」。', [count])}</p>
    </ConfirmDialog>
  );
}
