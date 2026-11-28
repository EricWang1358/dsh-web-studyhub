import { ui, uiFormat, uiLocale, errorMessage, getUiLanguage } from "./i18n.js";
import { formatNumber, formatDay } from "./format.js";
import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AudioJobs } from "./audio/AudioJobs.jsx";
import { PdfConvertHistory, PdfConvertJobs } from './PdfConvertJob.jsx';
import CourseField, { parseCourses } from './CourseField.jsx';
import PageScope, { courseNamesOf, usePageScope } from './PageScope.jsx';
import MaterialCategoryBar, { FacetsOnLine } from './MaterialCategoryBar.jsx';
import { LIVE_MATERIAL_JOB_STATUSES, consumeOpenSourcesOrganize } from './use-material-classify.js';
import {
  ALL_FACET,
  buildMaterialCategoryOptions,
  buildMaterialTypeOptions,
  buildSourceFlags,
  facetNames,
  filterMaterialsByFacets,
  hasFacetOption,
} from './material-facets.js';
import { useInjectCss } from "./shared.js";
import { AddSourceButton, Badge, Button, Checkbox, CheckboxInput, ChunkedRows, ConfirmDialog, Dialog, Disclosure, Field, Icon, InlineMessage, Menu, PageHeader, ProgressBar, SegmentedControl, Select, TextInput, Tooltip, filterItems, scrollWindowCount, useToast } from "./components/index.js";
import { browserStorage, readJSON, writeJSON } from "./storage.js";
import { useNarrow } from "./use-narrow.js";
import { useRowFit } from "./use-row-fit.js";
import { useCut } from "./use-cut.js";
import { REVEAL_ANCHORS_EVENT, scrollToAnchor } from "./tour/anchor.js";
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
import { compareMaterialReview, pickPracticeRefs, reviewUrgencyOf } from '../lib/contexts/materials/material-practice.js';
import { dropRequest, pinnedKeys, splitPinned, stepRequest } from '../lib/material-pins.js';
import { JOB_STATUS } from '../lib/job-status.js';
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
import { useOptionalAppSelector } from './app/app-context.js';
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
const pendingOrganizeEdits = new Map();
function rememberOrganizeEdit(jobKey, proposalId, patch) {
  if (!jobKey || !proposalId) return;
  if (!pendingOrganizeEdits.has(jobKey)) {
    if (pendingOrganizeEdits.size >= 16) pendingOrganizeEdits.delete(pendingOrganizeEdits.keys().next().value);
    pendingOrganizeEdits.set(jobKey, new Map());
  }
  const map = pendingOrganizeEdits.get(jobKey);
  map.set(proposalId, { ...(map.get(proposalId) || {}), ...patch });
}
const VALID_GROUP_MODES = new Set(["course", "folder", "day", "none"]);
const VALID_SORTS = new Set(["recent", "title", "review"]);
const groupModeKey = root => `study-sources-group-mode:v1:${root || ""}`;
const sortModeKey = root => `study-sources-sort-mode:v1:${root || ""}`;
const closedGroupsKey = (root, mode) => `study-sources-group-closed:v1:${root || ""}:${mode}`;
const toolsOpenKey = root => `study-sources-tools-open:v1:${root || ""}`;
const readToolsOpen = root => readJSON(toolsOpenKey(root), false, browserStorage()) === true;
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

function buildSourceGroups(items, { mode, folders, sort = "recent", includeEmpty = false, locale = uiLocale(), scope = "*", known = [], materialMastery = null } = {}) {
  const baseSort = sort === "review" ? "recent" : sort;
  const groups = mode === "course" ? groupMaterialsByCourse(items, { sort: baseSort, locale, scope, known })
    : mode === "folder" ? groupMaterialsByFolder(items, folders, { sort: baseSort, locale, includeEmpty })
      : mode === "none" ? groupMaterialsFlat(items, { sort: baseSort, locale })
        : groupByDay(items, { sort: baseSort, locale });
  if (sort !== "review") return groups;
  return groups.map(group => ({
    ...group,
    rows: [...group.rows].sort((a, b) => compareMaterialReview(a, b, materialMastery, locale)),
  }));
}

/** The page header's description: its fixed sentence, then the summary of what the library holds. The summary templates keep a leading space (the one the English
    singular lookup of ui/i18n.js is keyed by), so the join decides the space: none after a Chinese full stop, one after a Latin one (#1073 round 10). */
export function joinSummary(lead, summary) {
  const rest = String(summary || '').trim();
  return rest ? `${lead}${/[!-~]$/.test(lead) ? ' ' : ''}${rest}` : lead;
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
        {practisable && <Button size="sm" variant="secondary" iconEnd="arrow-right" className="source-doc__chapter-btn" lock={busy} onClick={() => onPractice(item, chapter)}>{ui('练这一章')}</Button>}
        {onGenerate && <Button size="sm" variant={onPractice && !practisable ? 'secondary' : 'quiet'} iconEnd="arrow-right" className="source-doc__chapter-btn" disabled={inside} lock={busy}
          title={inside ? (item.chapterUnit === 'text' ? ui('这份资料是一整段文字，出题仍以整份资料为单位') : ui('这一章在同一页内，不能单独出题')) : undefined}
          onClick={() => onGenerate(chapter.sourceIds)}>{ui('从这一章出题')}</Button>}
      </li>;
    })}
  </ul>;
}

/** The entries of a row's 更多 menu. */
export function RowMenuItems({ item, onPracticeUrgent, onPractice, onGenerate, onCompanion, onChangeCourse, onMoveFolder, onRemove, onSegment, onRename, onArchive, onPin, onPinMove, pin }) {
  const { busy, call } = useStudy();
  const close = event => event.currentTarget.closest("details")?.removeAttribute("open");
  return <div className="source-row-menu">
    {/* What the row does not show beside its one action (#1083): 从这份资料出题 when 补题 is that action, and the material's interactive companion. */}
    {onPracticeUrgent && <Button className="source-row-menu__btn" iconEnd="arrow-right" lock={busy} onClick={event => { close(event); return onPracticeUrgent(item); }}>{ui('练待巩固的题')}</Button>}
    {onPractice && <Button className="source-row-menu__btn" iconEnd="arrow-right" lock={busy} onClick={event => { close(event); return onPractice(item); }}>{ui('练整份资料')}</Button>}
    {onGenerate && <Button className="source-row-menu__btn" iconEnd="arrow-right" lock={busy} onClick={event => { close(event); onGenerate(item); }}>{ui('从这份资料出题')}</Button>}
    {onCompanion && <Button className="source-row-menu__btn" iconEnd="arrow-right" onClick={event => { close(event); onCompanion(item); }}>{ui('打开交互伴学页')}</Button>}
    {call && <OriginalMenuEntry item={item} />}
    {onRename && <Button className="source-row-menu__btn" lock={busy} aria-keyshortcuts="F2" onClick={event => { close(event); onRename(item); }}>{ui('重命名…')}</Button>}
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
const sameCompanionTarget = (a, b) => a === b || (!!a && !!b
  && a.companionId === b.companionId
  && a.course === b.course
  && a.slide === b.slide
  && a.anchor === b.anchor
  && a.label === b.label
  && a.companionTitle === b.companionTitle
  && a.lessonMode === b.lessonMode);
/**
 * Below this width of the 资料 page's own column (its content box, not the window: the sidebar may take 212px of it) the page is narrow: a row's facts break in
 * two, its actions take their own line under it, and the header keeps 添加资料 with one 更多 (#1083). This is the one place the width is decided; the page
 * carries `.is-narrow` and ui/sources.css follows it.
 */
export const ROWS_NARROW = 681;
/** Below this width of the column, 「筛选与分组」 beside the search box is its icon: its words would leave the course and the box too little room. The English
    words (and the label before the course) are wider, so English gives them up sooner. */
const TOOLS_TIGHT = { zh: 360, en: 440 };
const ROW_PROPS = ['item', 'source', 'isNew', 'organizing', 'selected', 'mastery', 'coverage', 'topUp', 'canIndex', 'indexLink', 'slot', 'advice', 'retrieval', 'courses', 'defaultCourse', 'canGenerate', 'canPractice', 'canSegment', 'canRename', 'actions', 'pinned', 'pinFirst', 'pinLast', 'dragging', 'dropMark', 'custom', 'showExtraCourseBadges', 'folderDrag', 'canMoveFolder'];

/**
 * Does a row need to be drawn again? Only when its own document, its own flags, its own index state or its own relation changed (#229, as the picker's #205):
 * a coverage answer, a poll with an answer of the same content, or a click on another row leaves the other rows alone. The handlers a row calls are
 * one stable `actions` object that reads the latest state itself.
 */
export function sourceRowPropsEqual(a, b) {
  return ROW_PROPS.every(key => a[key] === b[key])
    && sameIndexInfo(a.indexInfo, b.indexInfo)
    && sameRelation(a.relation, b.relation)
    && sameCompanionTarget(a.companionTarget, b.companionTarget);
}

/* `slot`: the index badge's place at the end of the status line is kept from the first paint, so a coverage answer that arrives later fills it instead of making the
   row taller (#229). The status line is the row's own line under the title and the facts, as wide as the row: a wide row's actions sit beside the title and the
   facts only, so they never narrow it, and a narrow row's actions take the line after it (ui/sources.css). The badge never competes with the buttons (#1083). */
export const DocumentRow = memo(function DocumentRow({ item, source, companionTarget = null, isNew, organizing, selected, actions, canGenerate, canPractice, canSegment, canRename, mastery, coverage = null, topUp = false, indexInfo = null, canIndex, indexLink = false, slot = false, relation = null, advice = false, retrieval = null, courses, defaultCourse, pinned = false, pinFirst = false, pinLast = false, dragging = false, dropMark = '', custom = null, showExtraCourseBadges = false, folderDrag = false, canMoveFolder = false }) {
  const { busy, openModal } = useStudy();
  const [pagesOpen, setPagesOpen] = useState(false), [editing, setEditing] = useState(false);
  // The open 更多 menu hangs below the row: the row tells its stylesheet, which otherwise clips a row to itself (ui/sources.css).
  const [menuOpen, setMenuOpen] = useState(false);
  // The title button holds the facts line, so a cut courses piece's tip cannot see the button's keyboard focus: the row tells it (#1083).
  const [titleFocus, setTitleFocus] = useState(false);
  const listId = useId(), row = useRef(null), main = useRef(null), wasEditing = useRef(false);
  useEffect(() => { if (wasEditing.current && !editing) main.current?.focus({ preventScroll: true }); wasEditing.current = editing; }, [editing]);
  const editor = canRename ? actions.rename(item) : null;
  const name = displayTitle(item.title);
  // Clicking anywhere on the row opens the reader immediately (0ms); rename is F2 on the title or 重命名… in 更多.
  const openRow = () => actions.open(item.sourceIds[0]);
  const startEditing = () => setEditing(true);
  const multi = item.pages.length > 1;
  // A converted book with chapters is browsed by chapter (WP28); its pages stay one click further in the picker.
  const chaptered = !!item.chapters?.length;
  useEffect(() => {
    if (!isNew || !row.current) return undefined;
    // In one scroll, not an animation, and re-checked once frames settle in case an open chunked group right above appended a batch (#900, #930).
    const jump = scrollToAnchor(row.current, { block: "center" });
    const focusRow = () => main.current?.focus({ preventScroll: true });
    // The refreshed list can render before the import dialog closes. Outside
    // buttons are inert until the native dialog releases focus.
    const dialog = row.current.ownerDocument.querySelector('dialog:modal');
    if (dialog) dialog.addEventListener('close', focusRow, { once: true });
    else focusRow();
    return () => {
      dialog?.removeEventListener('close', focusRow);
      jump.cancel();
    };
  }, [isNew]);
  // The courses and 用于 piece of the facts ellipsises on its own; once it is cut, a hover tip says all of it.
  const coursesRef = useRef(null);
  const coursesText = [item.courses.join(' · ') || ui('未分类'), item.coursesInferred ? ui('推断归属') : '',
    item.usedBy.length ? uiFormat('用于 {0}', [item.usedBy.map(deck => deck.title).join(' · ')]) : ''].filter(Boolean).join(' · ');
  const coursesCut = useCut(coursesRef, coursesText);
  const corrections = source?.audio ? uiFormat("校对 {0} 处", [source.audio.corrections?.appliedCount ?? 0]) : "";
  // The facts only (#676): what it is, how big, and how it relates to the others. What the learner has to check is a Badge beside the title (below), the start of the text is not in the row.
  const details = [uiFormat("{0} 字符", [formatNumber(item.chars)]), corrections, relationNote(relation)].filter(Boolean);
  const notes = documentNotes(item);
  // One page count for the document (the pages that have text); when the original file has more, that is said once, beside it, with the reason on hover.
  const gap = pageGapNote(item), pages = pageFacts(item).readable;
  const docUrgency = !item.archived ? reviewUrgencyOf(mastery?.document) : reviewUrgencyOf(null);
  const indexSlot = (slot || indexInfo) && <span className="source-doc__index">{indexInfo && <IndexBadge info={indexInfo} coverage={{ canIndex }} onIndex={indexLink ? () => actions.buildIndex(item.courses?.[0] || '') : undefined} />}</span>;
  const dragProps = pinned && !editing
    ? { draggable: true, onDragStart: event => actions.dragStart(item.key, event), onDragOver: event => actions.dragOver(item.key, event),
        onDrop: event => actions.drop(item.key, event), onDragEnd: actions.dragEnd }
    : folderDrag && !item.archived && !editing
      ? { draggable: true, onDragStart: event => actions.folderDragStart(item.key, event), onDragEnd: actions.folderDragEnd }
      : {};
  return (
    <article ref={row} className={"source-row source-doc" + (isNew ? " is-new" : "") + (dragging ? " source-doc--dragging" : "") + (dropMark ? ` source-doc--drop-${dropMark}` : "") + (menuOpen ? " source-doc--menu" : "")} data-document-key={item.key} data-new={isNew ? "true" : undefined} data-stable-row=""
      {...dragProps}>
      <div className="source-doc__line">
        {organizing && <CheckboxInput className="source-doc__check" aria-label={uiFormat('选择资料：{0}', [name])}
          checked={selected} onChange={event => actions.select(item.key, event.target.checked)} />}
        {editing && editor ? <div className="source-main source-main--editing">
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <RenameField title={item.title} original={item.renamedFrom} label={uiFormat('重命名「{0}」', [name])}
            onSave={async title => { await editor.save(title); setEditing(false); }} onRestore={async () => { await editor.restore(); setEditing(false); }} onCancel={() => setEditing(false)} />
        </div> : <button ref={main} className="source-main" onClick={openRow} aria-keyshortcuts={editor ? 'F2' : undefined}
          onFocus={event => setTitleFocus(event.currentTarget.matches(':focus-visible'))} onBlur={() => setTitleFocus(false)}
          onKeyDown={event => { if (event.key === 'Escape') setTitleFocus(false); if (editor && startsEditing(event)) { event.preventDefault(); startEditing(); } }}>
          <Icon name={item.format === "audio" ? "audio" : "file"} size={20} className="source-doc__icon" />
          <span>
            <strong className="source-title" title={item.title}>{pinned && <span className="source-pin" role="img" aria-label={ui('已置顶')}><Icon className="sh-icon--inline" name="pin" /></span>}{name}{isNew && <Badge size="sm" className="source-new">{ui("刚导入")}</Badge>}{notes.map(note => <Badge key={note} tone="warning" size="sm" icon wrap className="source-note">{note}</Badge>)}</strong>
            {/* One line of facts under the title (#570): where it belongs, then what it is and how big; each part ellipsises on its own. */}
            <span className="source-doc__meta">
              <small ref={coursesRef}><Tooltip layer group="source-facts" anchorClassName="source-doc__facts-tip" content={coursesCut ? coursesText : ''} forceOpen={titleFocus}><span>{coursesText}</span></Tooltip>{showExtraCourseBadges && item.courses.length > 1 && item.courses.slice(1).map(extra => <Badge key={extra} size="sm" className="source-course-extra">{extra}</Badge>)}</small>
              <small className={gap ? "source-doc__facts--gap" : undefined}>{sourceFormatLabel(item)}{gap &&<>{" · "}<Tooltip layer content={pageGapHint(item)}><span className="source-doc__gap" tabIndex={0}>{gap}</span></Tooltip></>}{details.length > 0 && ` · ${details.join(" · ")}`}</small>
            </span>
            {item.renamedFrom && <small className="source-original" title={item.renamedFrom}>{originalNote(item)}</small>}
          </span>
        </button>}
        {/* The row's actions, beside the title (line 1) on a wide row: before the status line in the DOM too, so Tab goes title, actions, then the index link under them. */}
        <div className="source-doc__actions">
          {/* ONE action beside the title (#1083): 为没覆盖的部分补题 where a published deck leaves part of the material without questions (a NEW draft, the deck's
              next part, ui/coverage/DocumentTopUp.jsx), else 从这份资料出题. The others (从这份资料出题 then, the interactive companion) are in 更多. */}
          {topUp ? <DocumentTopUp item={item} revision={JSON.stringify(coverage)} buttonClassName="source-doc__action" />
            : canGenerate && <Button size="sm" variant="secondary" iconEnd="arrow-right" className="source-doc__action" lock={busy} onClick={() => actions.generate(item.sourceIds)}>{ui('从这份资料出题')}</Button>}
          {item.archived && <>
            <Button size="sm" variant="secondary" className="source-doc__action" lock={busy} onClick={() => actions.archive(item)}>{ui('恢复资料')}</Button>
            <Button size="sm" variant="danger" className="source-doc__action" lock={busy} onClick={() => actions.remove(item)}>{ui('永久删除')}</Button>
          </>}
          <details className="source-row-actions" onToggle={event => setMenuOpen(event.currentTarget.open)}><summary>{ui('更多')}</summary>
            <RowMenuItems item={item}
              onPracticeUrgent={canPractice && docUrgency.hasUrgent ? actions.practiceUrgent : undefined}
              onPractice={canPractice && docUrgency.total > 0 ? actions.practiceDocument : undefined}
              onGenerate={topUp && canGenerate ? () => actions.generate(item.sourceIds) : undefined}
              onCompanion={companionTarget && openModal ? () => openCompanionTarget(openModal, companionTarget) : undefined} onChangeCourse={actions.changeCourse} onMoveFolder={canMoveFolder ? actions.moveFolder : undefined}
              onArchive={item.archived ? undefined : actions.archive} onSegment={canSegment ? actions.segment : undefined} onRename={editor ? startEditing : undefined}
              onPin={actions.pin} onPinMove={actions.pinMove} pin={{ pinned, first: pinFirst, last: pinLast }} />
          </details>
        </div>
        {/* The status line, always visible: 资料掌握度 (the snapshot's materialMastery) and 覆盖 beside it (drafts included; the mastery is only about published questions),
            then the index badge's slot, kept from the first paint so a late coverage answer fills it and moves nothing (#229). A click on it opens the material, as the title does. */}
        <div className="source-doc__status" onClick={openRow}>
          <span className="source-doc__quality"><MasteryLine className="source-doc__mastery" summary={mastery?.document ?? null} title={name} /><CoverageChip coverage={coverage} /></span>
          {docUrgency.hasUrgent && (
            <span className="source-doc__urgency">
              <Badge size="sm">{[docUrgency.weak > 0 && uiFormat('{0} 题薄弱', [docUrgency.weak]), docUrgency.due > 0 && uiFormat('{0} 题到期', [docUrgency.due])].filter(Boolean).join(' · ')}</Badge>
            </span>
          )}
          {indexSlot}
        </div>
      </div>
      {(multi || chaptered) && <div className="source-doc__pages">
        <div className="source-doc__pages-bar">
          <Button variant="quiet" size="sm" iconEnd="chevron" iconEndClassName="source-doc__pages-chevron" className="source-doc__pages-toggle sh-btn--flush-start" aria-expanded={pagesOpen} aria-controls={listId}
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

export function RemoveDialog({ item, onClose, onRemoved, canRemove: canRemoveProp }) {
  const { busy, act } = useStudy();
  const appData = useOptionalAppSelector((s) => s.data);
  const canRemove = canRemoveProp !== undefined ? Boolean(canRemoveProp) : (hasContext(appData, 'bank') && hasContext(appData, 'study'));
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

export function BatchRemoveDialog({ items, onClose, onRemoved, canRemove: canRemoveProp }) {
  const { busy, act } = useStudy();
  const appData = useOptionalAppSelector((s) => s.data);
  if (items.length === 1) return <RemoveDialog item={items[0]} onClose={onClose} onRemoved={item => onRemoved([item])} canRemove={canRemoveProp} />;
  const canRemove = canRemoveProp !== undefined ? Boolean(canRemoveProp) : (hasContext(appData, 'bank') && hasContext(appData, 'study'));
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
  const refresh = useOptionalAppSelector((s) => s.core?.refresh);
  const showTask = useOptionalAppSelector((s) => s.nav?.show?.task);
  useInjectCss(css, "study-sources");
  const toast = useToast();
  const [scope, setScope] = usePageScope(data.root, 'sources', data.focus?.course ?? '*');
  const [showArchived, setShowArchived] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [typeScope, setTypeScope] = useState(ALL_FACET);
  const [categoryScope, setCategoryScope] = useState(ALL_FACET);
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
  const tight = useNarrow(pageRef, TOOLS_TIGHT[getUiLanguage()] ?? TOOLS_TIGHT.zh, { content: true });
  const allItems = useMemo(() => groupSourcesByDocument(data.sources), [data.sources]);
  const sourceFlags = useMemo(() => buildSourceFlags(data.sources), [data.sources]);
  const items = useMemo(() => allItems.filter(item => item.archived === showArchived), [allItems, showArchived]);
  const byId = useMemo(() => new Map(data.sources.map(source => [source.id, source])), [data.sources]);
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const materialFolders = useMemo(
    () => (data.materialFolders ? readMaterialFolders({ materialFolders: data.materialFolders }) : readMaterialFolders(data.settings)),
    [data.materialFolders, data.settings],
  );
  const courseScoped = useMemo(() => items.filter(item => inScope(item, scope, known)), [items, scope, known]);
  const showCategoryBar = !showArchived && courseScoped.length > 1;
  const typeOptions = useMemo(
    () => (showCategoryBar ? buildMaterialTypeOptions(courseScoped, sourceFlags) : []),
    [showCategoryBar, courseScoped, sourceFlags],
  );
  const categoryOptions = useMemo(
    () => (showCategoryBar ? buildMaterialCategoryOptions(courseScoped, materialFolders) : []),
    [showCategoryBar, courseScoped, materialFolders],
  );
  const activeTypeScope = showCategoryBar && hasFacetOption(typeOptions, typeScope) ? typeScope : ALL_FACET;
  const activeCategoryScope = showCategoryBar && hasFacetOption(categoryOptions, categoryScope) ? categoryScope : ALL_FACET;
  useEffect(() => {
    if (typeScope !== ALL_FACET && !hasFacetOption(typeOptions, typeScope)) setTypeScope(ALL_FACET);
  }, [typeOptions, typeScope]);
  useEffect(() => {
    if (categoryScope !== ALL_FACET && !hasFacetOption(categoryOptions, categoryScope)) setCategoryScope(ALL_FACET);
  }, [categoryOptions, categoryScope]);
  const scoped = useMemo(
    () => (showArchived ? courseScoped : filterMaterialsByFacets(courseScoped, {
      typeScope: activeTypeScope,
      categoryScope: activeCategoryScope,
      materialFolders,
      sourceFlags,
    })),
    [showArchived, courseScoped, activeTypeScope, activeCategoryScope, materialFolders, sourceFlags],
  );
  const searchMatch = useCallback(item => documentSearchText(item, materialFolders), [materialFolders]);
  const filtering = !!query.trim();
  const urgentScopedCount = useMemo(
    () => (showArchived ? 0 : scoped.filter(item => reviewUrgencyOf(data.materialMastery?.[item.key]?.document).hasUrgent).length),
    [scoped, showArchived, data.materialMastery],
  );
  const activeReviewFilter = !showArchived && reviewOnly;
  const narrowing = filtering || activeReviewFilter;
  const filtered = useMemo(() => {
    const base = activeReviewFilter
      ? scoped.filter(item => reviewUrgencyOf(data.materialMastery?.[item.key]?.document).hasUrgent)
      : scoped;
    return filtering ? filterItems(base, query, searchMatch) : base;
  }, [scoped, activeReviewFilter, data.materialMastery, filtering, query, searchMatch]);
  // Books of more than 300 pages get the 大教材建议; what DSH can search with is read once, and only then (WP28).
  const bigKeys = useMemo(() => new Set(bigDocuments(items).map(item => item.key)), [items]);
  // Whether each material's search index is built (the rows say so); read once, and followed while a build runs.
  const [indexCoverage, , indexStatus] = useIndexCoverage(call);
  const { data: retrieval } = useRetrievalStatus({ enabled: bigKeys.size > 0 });
  // 置顶: the pinned rows leave the groups and form their own group above them; with nothing pinned `rest` is `filtered` itself. The archive has no pins.
  const pins = useMemo(() => pinnedKeys(data.settings), [data.settings]);
  const facetNarrowed = activeTypeScope !== ALL_FACET || activeCategoryScope !== ALL_FACET;
  const { pinned, rest } = useMemo(() => showArchived ? { pinned: [], rest: filtered } : splitPinned(filtered, pins), [filtered, pins, showArchived]);
  const locale = uiLocale();
  const groups = useMemo(
    () => buildSourceGroups(rest, { mode: groupMode, folders: materialFolders, sort: sortBy, includeEmpty: groupMode === 'folder' && !narrowing && !showArchived && !facetNarrowed, locale, scope, known, materialMastery: showArchived ? null : data.materialMastery }),
    [rest, groupMode, materialFolders, sortBy, narrowing, showArchived, facetNarrowed, locale, scope, known, data.materialMastery],
  );
  // The header describes the scope, not the filter: the filter's own count says how many match, so typing changes no line above the controls (#1085);
  // its 全部展开 / 全部收起 is there and named by the scope's groups too, so typing neither adds, removes nor renames a header button.
  // `groupsInEither`: whether the scope has more than one group in the archive or out of it, so the header's fit counts 全部展开 in both views (below).
  const scopeView = useMemo(() => {
    const view = (rows, archived) => {
      const split = archived ? { pinned: [], rest: rows } : splitPinned(rows, pins);
      return { split, groups: buildSourceGroups(split.rest, { mode: groupMode, folders: materialFolders, sort: sortBy, includeEmpty: groupMode === 'folder' && !archived && !facetNarrowed, locale, scope, known, materialMastery: archived ? null : data.materialMastery }) };
    };
    const { split, groups: scopeGroups } = view(scoped, showArchived);
    const other = view(allItems.filter(item => item.archived !== showArchived && inScope(item, scope, known)), !showArchived).groups;
    return { groupKeys: scopeGroups.map(group => group.key), groupsInEither: scopeGroups.length > 1 || other.length > 1,
      summary: { count: scoped.length, pinned: split.pinned.length, rest: split.rest.length, groups: scopeGroups.length } };
  }, [scoped, allItems, pins, showArchived, groupMode, materialFolders, sortBy, facetNarrowed, locale, scope, known, data.materialMastery]);
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
  const isOpen = group => narrowing || !closed.has(group.key);
  // A new import reopens its group even if the learner had closed it (waiting until filter relaxation exposes it).
  const reopenedFor = useRef(0);
  useEffect(() => {
    if (!highlight?.at || reopenedFor.current === highlight.at) return;
    const reopen = new Set(groups.filter(group => group.rows.some(item => fresh.has(item.key))).map(group => group.key));
    if (pinned.some(item => fresh.has(item.key))) reopen.add(PINNED);
    if (reopen.size) {
      reopenedFor.current = highlight.at;
      updateClosed(current => new Set([...current].filter(key => !reopen.has(key))));
    }
  }, [highlight?.at, groups, pinned, fresh]); // eslint-disable-line react-hooks/exhaustive-deps
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
  /* A material that was just imported must be on the page the import lands on. The page may be filtered by course, archive view,
     search query, review-only toggle, or facets: relax only the filters that hide what the learner just added, once per import. */
  const widened = useRef(0);
  useEffect(() => {
    if (!highlight?.at || widened.current === highlight.at || !highlight.ids?.length) return;
    const landed = allItems.filter(item => item.sourceIds.some(id => highlight.ids.includes(id)));
    if (!landed.length) return;
    widened.current = highlight.at;
    if (showArchived && landed.some(item => !item.archived)) setShowArchived(false);
    if (landed.some(item => !inScope(item, scope, known))) setScope('*');
    if (reviewOnly && landed.some(item => !reviewUrgencyOf(data.materialMastery?.[item.key]?.document).hasUrgent)) setReviewOnly(false);
    if (query.trim() && landed.some(item => !filterItems([item], query, searchMatch).length)) setQuery('');
    if (typeScope !== ALL_FACET && landed.some(item => !filterMaterialsByFacets([item], { typeScope, categoryScope: ALL_FACET, materialFolders, sourceFlags }).length)) setTypeScope(ALL_FACET);
    if (categoryScope !== ALL_FACET && landed.some(item => !filterMaterialsByFacets([item], { typeScope: ALL_FACET, categoryScope, materialFolders, sourceFlags }).length)) setCategoryScope(ALL_FACET);
  }, [highlight?.at, allItems]); // eslint-disable-line react-hooks/exhaustive-deps
  const snapshotOrganizeJob = useMemo(
    () => (Array.isArray(data.jobs) ? data.jobs.find(job => job?.type === 'material-organize' && LIVE_MATERIAL_JOB_STATUSES.has(job?.contract?.status || job?.status)) || null : null),
    [data.jobs],
  );
  const pendingOrganize = useMemo(() => {
    const raw = data.settings?.materialOrganizePending;
    return raw && Array.isArray(raw.proposals) && raw.proposals.length > 0 ? raw : null;
  }, [data.settings?.materialOrganizePending]);
  const [optimisticOrganizeJob, setOptimisticOrganizeJob] = useState(null);
  useEffect(() => {
    if (!optimisticOrganizeJob) return;
    const inSnapshot = Array.isArray(data.jobs) && data.jobs.find(job => job?.id === optimisticOrganizeJob.id);
    if (inSnapshot || (pendingOrganize && (!pendingOrganize.jobId || pendingOrganize.jobId === optimisticOrganizeJob.id))) {
      setOptimisticOrganizeJob(null);
    }
  }, [optimisticOrganizeJob, data.jobs, pendingOrganize]);
  const activeOrganizeJob = snapshotOrganizeJob || (optimisticOrganizeJob && LIVE_MATERIAL_JOB_STATUSES.has(optimisticOrganizeJob.contract?.status || optimisticOrganizeJob.status) ? optimisticOrganizeJob : null);
  const pendingOrganizeKey = pendingOrganize ? String(pendingOrganize.jobId || pendingOrganize.createdAt || 'pending') : '';
  const [organizing, setOrganizing] = useState(() => Boolean(activeOrganizeJob || pendingOrganize || consumeOpenSourcesOrganize()));
  // 「筛选与分组」 (#1694): shut unless the learner left it open (kept per library). A job or a request to look at the course suggestions opens it, and so does
  // 找功能 on its way to 整理课程归属; neither changes what is kept.
  const [toolsState, setToolsState] = useState(() => ({ root: data.root, open: organizing || readToolsOpen(data.root) }));
  const toolsOpen = toolsState.root === data.root ? toolsState.open : readToolsOpen(data.root);
  const showTools = useCallback(() => setToolsState({ root: data.root, open: true }), [data.root]);
  const chooseTools = open => { writeJSON(toolsOpenKey(data.root), open, browserStorage()); setToolsState({ root: data.root, open }); };
  const toolsId = useId();
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const reveal = event => { if (event.detail?.anchors?.includes('sources-organize')) flushSync(showTools); };
    document.addEventListener(REVEAL_ANCHORS_EVENT, reveal);
    return () => document.removeEventListener(REVEAL_ANCHORS_EVENT, reveal);
  }, [showTools]);
  const [selected, setSelected] = useState([]);
  const [courseText, setCourseText] = useState(''), [proposals, setProposals] = useState(null);
  const [organizeStartingCount, setOrganizeStartingCount] = useState(0);
  const [organizeStopping, setOrganizeStopping] = useState(false);
  const [organizeError, setOrganizeError] = useState('');
  const [organizeEditRev, setOrganizeEditRev] = useState(0);
  const prevOrganizeSignal = useRef({ jobId: activeOrganizeJob?.id || '', pendingKey: pendingOrganizeKey });
  useEffect(() => {
    const requested = consumeOpenSourcesOrganize();
    const newJob = Boolean(activeOrganizeJob?.id && activeOrganizeJob.id !== prevOrganizeSignal.current.jobId);
    const newPending = Boolean(pendingOrganizeKey && pendingOrganizeKey !== prevOrganizeSignal.current.pendingKey);
    prevOrganizeSignal.current = { jobId: activeOrganizeJob?.id || '', pendingKey: pendingOrganizeKey };
    if (requested) setShowArchived(false);
    if (requested || newJob || newPending) { setOrganizing(true); showTools(); }
  }, [activeOrganizeJob?.id, pendingOrganizeKey, showTools]);
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
  const hydratedProposals = useMemo(() => {
    if (!pendingOrganize) return null;
    const edits = pendingOrganizeKey ? pendingOrganizeEdits.get(pendingOrganizeKey) : null;
    return pendingOrganize.proposals.map(proposal => {
      const item = allItems.find(entry => entry.sourceIds.includes(proposal.id));
      const edit = edits?.get(proposal.id);
      const defaultInclude = proposal.decidedBy === 'jev' ? startsIncluded(proposal) : true;
      const defaultCourseText = Array.isArray(proposal.courses) ? proposal.courses.join('; ') : '';
      return {
        ...proposal,
        key: item?.key ?? proposal.key,
        title: item?.title ?? proposal.title,
        include: edit?.include !== undefined ? Boolean(edit.include) : defaultInclude,
        courseText: edit?.courseText !== undefined ? edit.courseText : defaultCourseText,
      };
    });
  }, [pendingOrganize, pendingOrganizeKey, allItems, organizeEditRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownProposals = proposals || hydratedProposals;
  const shownJevRun = proposals ? jevRun : (pendingOrganize?.jev ?? null);
  const organizeRunning = Boolean(activeOrganizeJob || organizeStartingCount > 0);
  // The organizer is in 「筛选与分组」; shut, it stays while it has something to show (a run, suggestions to review, why it failed). Without it no row has a box.
  const organizeShown = toolsOpen || organizeRunning || Boolean(shownProposals) || Boolean(organizeError);
  const organizeDone = activeOrganizeJob ? Number(activeOrganizeJob.contract?.progress?.done ?? activeOrganizeJob.done ?? 0) : 0;
  const organizeTotal = activeOrganizeJob
    ? Number(activeOrganizeJob.contract?.progress?.total ?? activeOrganizeJob.total ?? 0)
    : organizeStartingCount;
  // B6: every batch action (course attribution, AI suggest, folder move, archive, restore, permanent delete) acts strictly on visible `chosen` items in active scope/filter.
  const chosen = filtered.filter(item => selected.includes(item.key));
  const loadOrganizeSuggestions = async () => {
    const sourceIds = chosen.map(item => item.sourceIds[0]).filter(Boolean);
    if (!sourceIds.length) return;
    setOrganizeError('');
    if (!Array.isArray(data.jobs)) {
      await act('source.organize.suggest', { sourceIds }, result => {
        setJevRun(result.jev ?? null);
        setProposals(result.proposals.map(proposal => {
          const item = allItems.find(entry => entry.sourceIds.includes(proposal.id));
          return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: proposal.decidedBy === 'jev' ? startsIncluded(proposal) : true, courseText: proposal.courses.join('; ') };
        }));
      });
      return;
    }
    setOrganizeStartingCount(sourceIds.length);
    try {
      const res = await call('source.organize.start', { sourceIds });
      if (res?.job && LIVE_MATERIAL_JOB_STATUSES.has(res.job.contract?.status || res.job.status)) {
        setOptimisticOrganizeJob(res.job);
      }
      await Promise.resolve(refresh?.()).catch(() => {});
    } catch (err) {
      if (/unknown action|not found|未知操作|未注册/i.test(String(err?.message || ''))) {
        setOrganizeStartingCount(0);
        await act('source.organize.suggest', { sourceIds }, result => {
          setJevRun(result.jev ?? null);
          setProposals(result.proposals.map(proposal => {
            const item = allItems.find(entry => entry.sourceIds.includes(proposal.id));
            return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: proposal.decidedBy === 'jev' ? startsIncluded(proposal) : true, courseText: proposal.courses.join('; ') };
          }));
        });
        return;
      }
      setOrganizeError(errorMessage(err));
    } finally {
      setOrganizeStartingCount(0);
    }
  };
  const organizeCancelling = Boolean(activeOrganizeJob && (activeOrganizeJob.contract?.status || activeOrganizeJob.status) === JOB_STATUS.CANCELLING);
  const stopOrganizeJob = async () => {
    if (organizeStopping || organizeCancelling || !activeOrganizeJob?.id) return;
    setOrganizeStopping(true);
    setOrganizeError('');
    try {
      await call('job.control', { jobId: activeOrganizeJob.id, action: 'cancel' });
      setOrganizeStartingCount(0);
      setOptimisticOrganizeJob(null);
      await Promise.resolve(refresh?.()).catch(() => {});
    } catch (err) {
      setOrganizeError(errorMessage(err));
    } finally {
      setOrganizeStopping(false);
    }
  };
  const toggleProposalInclude = (proposalId, include) => {
    if (proposals) {
      setProposals(current => current.map(item => (item.id === proposalId ? { ...item, include } : item)));
      return;
    }
    if (pendingOrganizeKey) {
      rememberOrganizeEdit(pendingOrganizeKey, proposalId, { include });
      setOrganizeEditRev(v => v + 1);
    }
  };
  const changeProposalCourses = (proposalId, nextCourseText) => {
    if (proposals) {
      setProposals(current => current.map(item => (item.id === proposalId ? { ...item, courseText: nextCourseText } : item)));
      return;
    }
    if (pendingOrganizeKey) {
      rememberOrganizeEdit(pendingOrganizeKey, proposalId, { courseText: nextCourseText });
      setOrganizeEditRev(v => v + 1);
    }
  };
  const applyOrganizeProposals = () => {
    if (!shownProposals?.length) return;
    const assignments = shownProposals.filter(proposal => proposal.include).flatMap(proposal => {
      const courses = parseCourses(proposal.courseText);
      if (proposal.key) {
        const mapped = courseAssignments(allItems, [proposal.key], courses, byId);
        if (mapped.length) return mapped;
      }
      if (!proposal.id) return [];
      return [{ id: proposal.id, courses, expectedCourses: byId.get(proposal.id)?.courses || [] }];
    });
    if (!assignments.length) return;
    act('source.courses.set', { assignments }, () => {
      if (pendingOrganizeKey) pendingOrganizeEdits.delete(pendingOrganizeKey);
      setOrganizeEditRev(v => v + 1);
      finish();
    });
  };
  const dismissOrganizeProposals = () => {
    setOrganizeError('');
    if (pendingOrganize && !proposals) {
      act(
        'source.organize.dismiss',
        pendingOrganize.jobId ? { jobId: pendingOrganize.jobId } : {},
        () => {
          if (pendingOrganizeKey) pendingOrganizeEdits.delete(pendingOrganizeKey);
          setOrganizeEditRev(v => v + 1);
          finish();
        },
      );
      return;
    }
    finish();
  };
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
  const pinnedOpen = narrowing || !closed.has(PINNED);
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
    // Several: the organizer they were ticked in; put away by then, 「筛选与分组」. (Two queries: one selector list answers with whichever comes first on the page.)
    focus: items.length === 1 ? rowMenu(items[0].key) : () => document.querySelector('.source-organize > summary') || document.querySelector('[data-tour="sources-tools"]') });
  const closeRemoving = () => {
    const was = removing;
    setRemoving(null);
    if (was?.fromNotice) setTimeout(() => { (rowMenu(was.key)() || document.querySelector('[data-archive-toggle]'))?.focus?.(); }, 30);
  };
  latest.current = { offerArchived, setModal, byId, act, onGenerate, onPractice, toast, onOpenSettings, onBuildIndex, renameFor, drag, pinKeys: pins, shownPins: pinned.map(item => item.key) };
  const practiceMaterialCards = async ({ item, params, only, empty, capped }) => {
    const { act, onPractice: startPractice, toast: say } = latest.current;
    const view = await act('materials.pages.cards', { documentId: item.documentId || item.key, ...(item.sourceIds?.[0] ? { sourceId: item.sourceIds[0] } : {}), ...params }, undefined, { refreshAfter: false });
    if (!view) return;
    const { refs, totalUnique, capped: truncated } = pickPracticeRefs(view.cards || [], { only });
    if (!refs.length) { say.info(empty); return; }
    const result = startPractice?.(refs);
    if (!truncated) return result;
    const notice = uiFormat(capped, [refs.length, totalUnique]);
    if (result && typeof result.then === 'function') {
      try {
        if (await result) say.info(notice);
      } catch {
        // practice start failed or was cancelled; suppress stale truncation toast
      }
    } else if (result !== false) {
      say.info(notice);
    }
  };
  const actions = useMemo(() => ({
    open: id => latest.current.setModal({ type: "source", source: latest.current.byId.get(id) }),
    select: (key, on) => { setSelected(current => on ? [...current, key] : current.filter(entry => entry !== key)); setProposals(null); },
    generate: ids => latest.current.onGenerate?.(ids),
    // 练这一章 / 练整份资料 / 练待巩固的题: ask which questions the chapter or whole document owns (materials.pages.cards), prioritize urgency, and cap at 200.
    practiceChapter: (item, chapter) => practiceMaterialCards({
      item,
      params: { chapter: chapter.index },
      only: 'all',
      empty: ui('这一章现在没有可练的题（已斩或已归档的不算）。可以先用这份资料出题。'),
      capped: '这一章可练题目较多，本次先练最需巩固的 {0} 道（共 {1} 道）。',
    }),
    practiceDocument: item => practiceMaterialCards({
      item,
      params: {},
      only: 'all',
      empty: ui('这份资料现在没有可练的题（已斩或已归档的不算）。可以先从它出题。'),
      capped: '这份资料可练题目较多，本次先练最需巩固的 {0} 道（共 {1} 道）。',
    }),
    practiceUrgent: item => practiceMaterialCards({
      item,
      params: {},
      only: 'urgent',
      empty: ui('这份资料暂时没有薄弱或到期题，可以在菜单里选「练整份资料」。'),
      capped: '这份资料可练题目较多，本次先练最需巩固的 {0} 道（共 {1} 道）。',
    }),
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
  // Companion deep-link target per row, derived once in the parent with identity stability so DocumentRow never subscribes to AppContext.
  const companionTargetCache = useRef(new Map());
  const companionTargets = useMemo(() => {
    const next = new Map();
    if (!showArchived) {
      for (const item of items) {
        const src = byId.get(item.sourceIds[0]);
        const target = src
          ? resolveSourceCompanionTarget({ source: src, courses: data.courses, sources: data.sources })
          : null;
        if (!target) continue;
        const before = companionTargetCache.current.get(item.key);
        next.set(item.key, before && sameCompanionTarget(before, target) ? before : target);
      }
    }
    companionTargetCache.current = next;
    return next;
  }, [items, byId, data.courses, data.sources, showArchived]);
  const canRemoveSources = hasContext(data, 'bank') && hasContext(data, 'study');
  // A group draws its rows in chunks (ChunkedRows); the rows something goes to are drawn even past the first chunk: the new import, and the 深度定制 button 找功能 looks for.
  // A new course scope, filter query, grouping mode, sort mode or archive toggle starts every group from its first chunk again.
  const chunkKey = `${scope}|${activeTypeScope}|${activeCategoryScope}|${showArchived}|${activeReviewFilter}|${query.trim()}|${groupMode}|${sortBy}`;
  const rowOf = (rows, keys) => rows.findIndex(item => keys.has(item.key));
  const anchorsOf = rows => ({ 'custom-book-row': rowOf(rows, offers) });
  // One row, in a group or in the pinned group (`pin`: where it stands among the pinned rows).
  const renderRow = (item, pin = {}) => <DocumentRow key={item.key} item={item} source={byId.get(item.sourceIds[0])} companionTarget={companionTargets.get(item.key) ?? null}
    isNew={fresh.has(item.key)} organizing={organizing && organizeShown} selected={selected.includes(item.key)} actions={actions}
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
  const archiveLabels = [uiFormat('已归档（{0}）', [archivedCount]), ui('返回资料')], archiveLabel = archiveLabels[showArchived ? 1 : 0];
  // What hides rows while 「筛选与分组」 is shut is said under the search box, with one way back. Grouping and sorting hide nothing.
  const facetsSaid = [...facetNames([[typeOptions, activeTypeScope], [categoryOptions, activeCategoryScope]]), ...(activeReviewFilter ? [ui('待巩固')] : [])];
  const clearFacets = () => { setTypeScope(ALL_FACET); setCategoryScope(ALL_FACET); setReviewOnly(false); };
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
  // (#1083). Either way 添加资料 is last, at the right edge; whether they fit is measured (ui/use-row-fit.js) on a hidden copy of the full set, not guessed
  // from the page's width, and never by drawing the visible set again.
  const groupsLabels = [ui("全部展开"), ui("全部收起")], groupsLabel = groupsLabels[allOpen ? 1 : 0], manyGroups = scopeView.groupKeys.length > 1;
  const fullHeader = useRowFit(pageRef, '.sources-page__header .sh-page-header__title-row', '.sources-page__fit > .sh-page-header__actions');
  // The full set: `live` on the title row; otherwise the copy it is measured on, without handlers or the anchors 找功能 and the tour look for. In the copy a
  // button that changes its words is as wide as the wider of them, and 全部展开 is there when either view of the archive has it, so a choice in 更多
  // (opening or leaving the archive, expanding every group) never swaps the header under the focus (#1083, round 5).
  const either = labels => <span className="sources-page__fit-labels">{labels.map(label => <span key={label}>{label}</span>)}</span>;
  const fullActions = live => <>
    <Button variant="quiet" icon={showArchived ? 'arrow-left' : 'archive'} aria-pressed={showArchived}
      {...(live && { 'data-archive-toggle': '', 'data-tour': 'sources-archived', onClick: toggleArchived })}>{live ? archiveLabel : either(archiveLabels)}</Button>
    {(live ? manyGroups : scopeView.groupsInEither) && <Button variant="quiet" icon="list" onClick={live ? toggleGroups : undefined}>{live ? groupsLabel : either(groupsLabels)}</Button>}
    <Button variant="secondary" icon="play" onClick={live ? openCompanions : undefined}>{ui("交互伴学")}</Button>
    {live ? addButton : <AddSourceButton variant="primary" />}
  </>;
  const headerActions = fullHeader
    ? fullActions(true)
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
    <section ref={pageRef} className={`page sources-page${narrow ? ' is-narrow' : ''}${tight ? ' is-tight' : ''}`}>
      <PageHeader className={`sources-page__header sh-page-header--measured${fullHeader ? '' : ' sh-page-header--compact-actions'}`} title={ui("资料")}
        description={joinSummary(ui("题目从这里生长。原文与引用一直保留。"), items.length > 0 ? groupSummaryDescription({ mode: groupMode, summary: scopeSummary }) : "")}
        actions={headerActions} actionsOnTitleRow />
      <div className="sources-page__fit" aria-hidden="true" inert><div className="sh-page-header__actions">{fullActions(false)}</div></div>
      {gap && <IndexGapLine count={gap.count} canIndex={indexCoverage?.canIndex} onGo={() => onBuildIndex(gap.course)} />}
      {(items.length > 0 || (groupMode === 'folder' && !showArchived && materialFolders.folders.length > 0)) && <>
        {/* 课程范围 and 筛选资料 are one small form: the label in one column, both controls in the next, at one left edge and one width (#1085). They are all that
            stands over the list by default (#1694): everything else is behind 「筛选与分组」, on the line of the search box. */}
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
          {/* Inside the field's end, over padding it keeps while filtering (ui/sources.css): the numbers, said in full for a screen reader, and the × of 清除筛选.
              The numbers hold the room of the widest count this scope can show (all of it), so they keep one width while you type; the field's padding is that
              width, measured here when they appear. */}
          {filtering && <span className="sources-filter__state" ref={state => state?.parentElement.style.setProperty('--sources-filter-count', `${state.offsetWidth}px`)}>
            <small className="sources-filter__count muted" aria-live="polite"><span aria-hidden="true" className="sources-filter__figures" data-widest={`${scoped.length} / ${scoped.length}`}><span>{filtered.length} / {scoped.length}</span></span>
              <span className="sh-visually-hidden">{scrollWindowCount(scoped.length, filtered.length, true)}</span></small>
            <Button variant="quiet" size="sm" icon="close" aria-label={ui('清除筛选')} title={ui('清除筛选')} onClick={() => setQuery('')} />
          </span>}
        </div>
          <Tooltip layer anchorClassName="sources-tools-anchor" content={tight ? ui('筛选与分组') : ''}>
            <Button variant="quiet" size="sm" icon="filter" className={`material-facets-toggle sources-tools-toggle${facetsSaid.length ? ' is-on' : ''}`}
              aria-expanded={toolsOpen} aria-controls={toolsId} data-tour="sources-tools" onClick={() => chooseTools(!toolsOpen)}>
              <span className="sources-tools-toggle__label">{ui('筛选与分组')}</span>
            </Button>
          </Tooltip>
        </div>
        {!toolsOpen && facetsSaid.length > 0 && <FacetsOnLine className="sources-tools-said" names={facetsSaid} onClear={clearFacets} />}
        <div id={toolsId} className="sources-tools">
        {showCategoryBar && <MaterialCategoryBar open={toolsOpen} className="sources-facets" items={courseScoped} targetItems={scoped}
          course={scope === '*' || scope === '' ? '' : scope}
          materialFolders={materialFolders} sourceFlags={sourceFlags}
          typeOptions={typeOptions} categoryOptions={categoryOptions}
          typeScope={activeTypeScope} onTypeScopeChange={setTypeScope}
          categoryScope={activeCategoryScope} onCategoryScopeChange={setCategoryScope}
          modelReady={modelReadiness(data).ready} />}
        {toolsOpen && <div className="sources-view-bar">
          <SegmentedControl size="sm" wrap className="sources-view-bar__group" label={ui('分组方式')} value={groupMode} onChange={chooseGroupMode} options={[
            { value: 'course', label: ui('按课程') },
            { value: 'folder', label: ui('按文件夹') },
            { value: 'day', label: ui('按导入日期') },
            { value: 'none', label: ui('平铺') },
          ]} />
          <Select className="sources-view-bar__sort" aria-label={ui('排序')} value={sortBy} onChange={chooseSort} options={[
            { value: 'recent', label: ui('最近导入') },
            { value: 'title', label: ui('按标题') },
            { value: 'review', label: ui('待巩固优先') },
          ]} />
          {!showArchived && (urgentScopedCount > 0 || reviewOnly) && (
            <Button aria-pressed={reviewOnly} className="sources-view-bar__review" onClick={() => setReviewOnly(current => !current)}>
              {uiFormat('只看待巩固（{0}）', [urgentScopedCount])}
            </Button>
          )}
          {groupMode === 'folder' && !showArchived && !!(act || call) && (
            <Button variant="secondary" icon="plus" lock={busy} onClick={() => setCreatingFolder(true)}>{ui('新建文件夹')}</Button>
          )}
        </div>}
        {items.length > 0 && organizeShown && <details className="source-organize" data-tour="sources-organize" open={organizing || undefined} onToggle={event => setOrganizing(event.currentTarget.open)}>
          <summary>{showArchived ? ui('批量管理已归档资料') : ui('整理课程归属')}</summary>
          <p className="muted">{showArchived ? ui('勾选已归档资料后，可批量恢复、统一永久删除，或整理课程归属。') : ui('勾选资料后统一整理。改课程归属时，原文与引用保持不变。')}</p>
          <p>{uiFormat('已选择 {0} 份资料', [chosen.length])}{' '}
            <Button disabled={!filtered.length} onClick={() => { setSelected(filtered.map(item => item.key)); setProposals(null); }}>{narrowing ? ui('选择筛选结果') : ui('选择当前范围')}</Button>{' '}
            {selected.length > 0 && <Button onClick={finish}>{ui('清空选择')}</Button>}
          </p>
          <CourseField value={courseText} onChange={setCourseText} courses={data.focus?.courses} multiple disabled={busy} />
          <div className="source-organization-actions">
            <Button disabled={!chosen.length} lock={busy} onClick={() => act('source.courses.set', {
              assignments: courseAssignments(chosen, chosen.map(item => item.key), parseCourses(courseText), byId),
            }, finish)}>{ui('应用课程归属')}</Button>
            <Button busy={organizeRunning} disabled={!modelReadiness(data).ready || !chosen.length} lock={busy}
              data-organize-ai onClick={loadOrganizeSuggestions}>{ui('请 AI 建议')}</Button>
            <JevSuggestButton enabled={jevOn} disabled={busy || !chosen.length || chosen.length > 100}
              onClick={() => { setJevNote(''); act('source.organize.jev', { sourceIds: chosen.map(item => item.sourceIds[0]) }, result => {
                setJevNote(noteText(result));
                if (result.proposals.length) setProposals(result.proposals.map(proposal => {
                  const item = items.find(entry => entry.sourceIds.includes(proposal.id));
                  return { ...proposal, key: item?.key, title: item?.title ?? proposal.title, include: startsIncluded(proposal), courseText: proposal.courses.join('; ') };
                }));
              }); }} />
          </div>
          {organizeRunning && (
            <div className="source-organize-progress" role="status" aria-live="polite" data-organize-phase="running">
              <div className="source-organize-progress__head">
                <span className="source-organize-progress__text">
                  {uiFormat('正在整理课程归属（{0} / {1}）…', [organizeDone, organizeTotal])}
                </span>
                <div className="source-organize-progress__actions">
                  {activeOrganizeJob?.id && showTask && (
                    <Button size="sm" variant="quiet" iconEnd="arrow-right" data-open-organize-task
                      onClick={() => showTask(activeOrganizeJob.id)}>{ui('查看任务')}</Button>
                  )}
                  <Button size="sm" variant="quiet" busy={organizeStopping || organizeCancelling} busyLabel={ui('正在停止…')} disabled={!activeOrganizeJob?.id || organizeStopping || organizeCancelling} lock={busy} data-stop-organize onClick={stopOrganizeJob}>{ui('停止')}</Button>
                </div>
              </div>
              <ProgressBar size="sm" value={organizeDone} max={Math.max(organizeTotal, 1)} indeterminate={organizeDone === 0} label={ui('课程归属整理进度')} />
            </div>
          )}
          {organizeError && (
            <InlineMessage tone="error" className="source-organize-error">
              <span>{organizeError}</span>{' '}
              <Button size="sm" variant="link" onClick={() => setOrganizeError('')}>{ui('关闭')}</Button>
            </InlineMessage>
          )}
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
          {experimental && <JevRunNote jev={shownJevRun} />}
          {/* 归档所选: the checked documents in one go (a material is archived before it can be deleted; in 已归档, checked ones can be restored or permanently deleted together). */}
          {!showArchived ? <div className="source-organization-actions source-archive-actions">
            <Button disabled={!chosen.length} lock={busy} data-archive-selected onClick={archiveChosen}>{chosen.length ? uiFormat('归档所选（{0}）', [chosen.length]) : ui('归档所选')}</Button>
            <span className="muted">{ui('归档会把它们从这个列表收起，可以在「已归档」里恢复。')}</span>
          </div> : <div className="source-organization-actions source-archive-actions">
            <Button disabled={!chosen.length} lock={busy} data-restore-selected onClick={restoreChosen}>{chosen.length ? uiFormat('恢复所选（{0}）', [chosen.length]) : ui('恢复所选')}</Button>
            <Button variant="danger" disabled={!chosen.length} lock={busy} data-delete-selected onClick={() => setRemovingBatch(chosen)}>{chosen.length ? uiFormat('永久删除所选（{0}）', [chosen.length]) : ui('永久删除所选')}</Button>
            <span className="muted">{ui('恢复会把它们放回资料列表；永久删除不可撤销。')}</span>
          </div>}
          {shownProposals && <div className="source-course-proposals" data-organize-phase="review">
            <p className="muted">{ui('建议尚未保存，可先修改课程，再确认应用。')}</p>
            {shownProposals.map(proposal => <div key={proposal.id}>
              <Checkbox checked={proposal.include} disabled={busy} label={uiFormat('采用建议：{0}', [displayTitle(proposal.title)])}
                onChange={include => toggleProposalInclude(proposal.id, include)} />
              <CourseField label={displayTitle(proposal.title)} value={proposal.courseText} multiple courses={data.focus?.courses}
                onChange={nextCourseText => changeProposalCourses(proposal.id, nextCourseText)} disabled={busy || !proposal.include} />
              <p className="muted">{proposal.reason}{experimental && proposal.decidedBy === 'jev' && <> <JevDecidedBadge scope="row" /></>}</p>
              {experimental && <JevProbabilities jev={proposal.jev} />}
            </div>)}
            <div className="source-organization-actions">
              <Button disabled={!shownProposals.some(proposal => proposal.include)} lock={busy} data-apply-organize onClick={applyOrganizeProposals}>{ui('确认应用建议')}</Button>
              <Button variant="quiet" lock={busy} data-discard-organize onClick={dismissOrganizeProposals}>{ui('放弃建议')}</Button>
            </div>
          </div>}
        </details>}
        </div>
        {items.length > 0 && !courseScoped.length && <p className="muted">{ui('这个范围还没有资料。可切换到全部课程查看。')}</p>}
        {items.length > 0 && courseScoped.length > 0 && !scoped.length && <p className="muted">{ui('当前类型与分类组合下没有匹配的资料，可调整筛选条件。')}</p>}
        {items.length > 0 && scoped.length > 0 && !filtered.length && (
          activeReviewFilter
            ? <p className="muted">{filtering ? uiFormat('待巩固资料中没有匹配“{0}”的项。', [query.trim()]) : ui('当前范围没有待巩固的资料。')} <Button variant="link" size="sm" onClick={() => setReviewOnly(false)}>{ui('显示全部资料')}</Button></p>
            : <p className="muted">{uiFormat('没有匹配“{0}”的资料', [query.trim()])}</p>
        )}
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
      {removing && <RemoveDialog item={removing} canRemove={canRemoveSources} onClose={closeRemoving}
        onRemoved={item => { setRemoving(null); toast.success(uiFormat("已永久删除「{0}」", [displayTitle(item.title)])); }} />}
      {removingBatch && <BatchRemoveDialog items={removingBatch} canRemove={canRemoveSources} onClose={() => setRemovingBatch(null)}
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
