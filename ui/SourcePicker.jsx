import React, { memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { AddSourceButton, Button, CheckboxInput, EmptyState, ScrollWindow, Tooltip, addSourceAction, filterItems } from './components/index.js';
import PageScope from './PageScope.jsx';
import MaterialCategoryBar from './MaterialCategoryBar.jsx';
import { AppContext } from './app/app-context.js';
import {
  ALL_FACET,
  buildMaterialCategoryOptions,
  buildMaterialTypeOptions,
  buildSourceFlags,
  filterMaterialsByFacets,
  hasFacetOption,
  itemFolderName,
  resolveMaterialFolders,
} from './material-facets.js';
import { groupSourcesByDocument, isLegacyExtraction, sourceFormat } from '../lib/source-groups.js';
import { isAiDraftedSource } from '../lib/source-provenance.js';
import { courseScope } from '../lib/course-tree.js';
import { bigDocuments } from '../lib/large-documents.js';
import { materialRelations } from '../lib/source-relations.js';
import { displayTitle } from '../lib/document-title.js';
import { isPagedFormat, isSlideFormat } from '../lib/office/limits.js';
import IndexBadge, { IndexGapLine } from './IndexBadge.jsx';
import { documentIndexState } from './index-coverage.js';
import { indexGap } from './index-scope.js';
import css from './source-picker.css';
import { formatNumber } from './format.js';
import { useCut } from './use-cut.js';
import { sizeGroup, useFactsFit } from './picker-names.js';

/* Choosing material for generation (P18, P22). One row per document: a PDF is
   one checkbox for the whole file with an expandable page list. Counts are in
   documents. The selection itself stays a list of source ids, so the generate
   action is unchanged. */

const FORMAT_LABELS = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', ppt: 'PowerPoint', md: 'Markdown', tex: 'LaTeX', html: 'HTML', txt: 'TXT', audio: '录音逐字稿', json: 'JSON 题组', text: '文本' };

/**
 * The one label for where a material came from. Accepts a source or a
 * document item from groupSourcesByDocument. Only PDF pages from the first
 * text parser are flagged for re-import; fresh Markdown/HTML/TXT never are.
 */
export function sourceFormatLabel(value) {
  if (!value) return '';
  if (Array.isArray(value.sourceIds)) {
    const base = ui(FORMAT_LABELS[value.format] || FORMAT_LABELS.text);
    const parts = value.pages?.length || value.sourceIds.length;
    // A book imported from a converter's output (WP28): paged like a PDF, but there is no PDF.
    if (value.converted) return parts === 1 ? uiFormat('{0} · 1 页', [ui('转换文档')]) : uiFormat('{0} · {1} 页', [ui('转换文档'), parts]);
    if (value.format === 'pdf') return parts === 1 ? uiFormat('{0} · 1 页', [base]) : uiFormat('{0} · {1} 页', [base, parts]);
    if (isSlideFormat(value.format)) return parts === 1 ? ui('PowerPoint · 1 页') : uiFormat('PowerPoint · {0} 页', [parts]);
    if (value.format === 'audio' && parts > 1) return uiFormat('{0} · {1} 部分', [base, parts]);
    return base;
  }
  const format = sourceFormat(value), base = value.document?.origin === 'converted' ? ui('转换文档') : ui(FORMAT_LABELS[format]);
  if (isLegacyExtraction(value)) return uiFormat('{0} · 旧版提取，建议重新导入', [base]);
  if (isPagedFormat(format) && Number.isInteger(value.document?.page)) return uiFormat('{0} · 第 {1} 页', [base, value.document.page]);
  return base;
}

/** 'all' | 'some' | 'none' of a document's sources are selected. */
export function selectionState(item, selected) {
  const chosen = new Set(selected);
  const count = item.sourceIds.filter(id => chosen.has(id)).length;
  return count === 0 ? 'none' : count === item.sourceIds.length ? 'all' : 'some';
}

/** Add or remove every source of one document, keeping the rest of the selection in order. */
export function toggleDocument(selected, item, on) {
  const ids = new Set(item.sourceIds);
  return on ? [...new Set([...selected, ...item.sourceIds])] : selected.filter(id => !ids.has(id));
}

/** 'all' | 'some' | 'none' of a chapter's pages are selected (a chapter has `sourceIds` like a document). */
export const chapterState = selectionState;
/** Add or remove every page of one chapter. */
export const toggleChapter = toggleDocument;

/**
 * “第一章 进程 · 第 1–4 页”: a chapter's title and where it lies. `unit` (the document's chapterUnit): 'page' (default), 'part'
 * (the files of one recording) or 'text' (chapters inside one text have no page to show).
 */
export function chapterLabel(chapter, unit = 'page') {
  const title = chapter.title || (chapter.front ? ui('前言与目录') : '');
  if (unit === 'text') return title;
  const one = chapter.startPage === chapter.endPage;
  const range = unit === 'part' ? (one ? uiFormat('第 {0} 部分', [chapter.startPage]) : uiFormat('第 {0}–{1} 部分', [chapter.startPage, chapter.endPage]))
    : one ? uiFormat('第 {0} 页', [chapter.startPage]) : uiFormat('第 {0}–{1} 页', [chapter.startPage, chapter.endPage]);
  return title ? `${title} · ${range}` : range;
}

/** Chapters the picker can scope generation to: those that hold whole pages (a chapter inside one page cannot be chosen alone). */
export const chosenByChapters = item => !!item.chapters?.some(chapter => chapter.sourceIds.length) && item.pages.length > 1;

/** Select every source of the given documents (select-all for a scope). */
export const selectDocuments = (selected, items) => [...new Set([...selected, ...items.flatMap(item => item.sourceIds)])];

/**
 * A document is in a course scope when any of its pages belongs to it ('*' is everything, '' unassigned);
 * a parent course takes in its sub-courses (`known`: the library's course names, lib/course-tree.js).
 */
export function inScope(item, scope, known = []) {
  return scopeFilter(scope, known)(item);
}

/** inScope as one `item => boolean` for a whole list: the course matcher is built once, not once per document (#565). */
export function scopeFilter(scope, known = []) {
  if (scope === undefined || scope === null || scope === '*') return () => true;
  if (scope === '') return item => !item.courses.length;
  const within = courseScope(scope, known);
  return item => item.courses.some(within);
}

/** Rows the picker draws at first: about four windows of rows (a window shows about six); scrolling or tabbing near the end draws more (ScrollWindow). */
export const SOURCE_PICKER_FIRST_ROWS = 24;

/** Small notes a learner should check before generating. */
export function documentNotes(item) {
  return [item.warnings.includes('sparse') && ui('文字偏少，核对正文'), item.warnings.includes('layout') && ui('排版复杂，建议对照原文'),
    item.warnings.includes('legacy-extraction') && ui('含旧版提取页，建议重新导入'),
    isAiDraftedSource(item) && ui('AI 撰写 · 未核对')].filter(Boolean);
}

/** What the picker's filter searches: title, file name, the title before a rename, courses, content folder and format. */
export const documentSearchText = (item, materialFolders = null) =>
  [item.title, item.filename, item.renamedFrom, ...(item.courses || []), itemFolderName(item, materialFolders), sourceFormatLabel(item)].filter(Boolean).join(' ');

/* The filter appears once the list is longer than a screenful of rows. */
const FILTER_AFTER = 6;

/** The name of a facet's chosen option, without its count (「PDF (3)」 → 「PDF」), for the line that says a filter is in use. */
function facetName(options, value) {
  for (const option of options) {
    const name = option.options ? facetName(option.options, value) : option.value === value ? String(option.label).replace(/\s*\(\d+\)$/, '') : '';
    if (name) return name;
  }
  return '';
}

const pageLabel = (item, page) => isPagedFormat(item.format)
  ? uiFormat('第 {0} 页', [page.page]) + (page.legacy ? ` · ${ui('旧版提取')}` : '')
  : item.format === 'audio' ? uiFormat('第 {0} 部分', [page.page]) : displayTitle(page.title);

export const sameIndexInfo = (a, b) => a === b || (!!a && !!b && a.state === b.state && a.indexed === b.indexed && a.stale === b.stale && a.total === b.total);
const idSets = new WeakMap();
const setOfIds = ids => { let set = idSets.get(ids); if (!set) idSets.set(ids, set = new Set(ids)); return set; };

/**
 * Does a row need to render again? Only when its own document, its own selected pages, its own index state or the few shared flags changed (#205):
 * a coverage answer or a click on another row leaves the other rows alone. `apply(update)` is stable and reads the latest selection itself.
 */
export function documentRowPropsEqual(a, b) {
  if (a.item !== b.item || a.disabled !== b.disabled || a.defaultOpen !== b.defaultOpen || a.canIndex !== b.canIndex || a.relation !== b.relation || a.scope !== b.scope || a.indexColumn !== b.indexColumn
    || a.apply !== b.apply || a.indexPending !== b.indexPending || !sameIndexInfo(a.indexInfo, b.indexInfo)) return false;
  if (a.selected === b.selected) return true;
  const was = setOfIds(a.selected), now = setOfIds(b.selected);
  return a.item.sourceIds.every(id => was.has(id) === now.has(id));
}

/** How a material belongs with the others made from one file (#207), as the line under its name; '' when it has no relatives. Shared by the picker and the 资料 page. */
export const relationNote = relation => !relation ? ''
  : relation.role === 'derived' ? uiFormat('派生自 {0}', [displayTitle(relation.of)])
    : relation.role === 'original' ? (relation.derived ? uiFormat('另有 {0} 份派生资料', [relation.derived]) : '') : uiFormat('同一文件的 {0} 份资料', [relation.count]);

/* A course name this long or shorter is said whole or left out whole; a longer one, the first on a row's facts line, may be shortened (ui/source-picker.css). */
const SHORTEST_NAME = 6;

/* A figure, or a code with one (「（2026」, 「 (CS5223)」, 「Lab2」), that starts a word: with the space or the opening bracket before it. */
const FIGURE = /\s?(?<![A-Za-z0-9])[（(【[《「]?[A-Za-z]*\d/gu;

/** The words of a shortened name (`· ` and all): its head as text, then each part after a 「 · 」 with its 「·」 (round 8). Round 11: where the head has a
 *  figure after its first two characters, the head's text ends before it and the rest of the name is one word, so the name is never cut inside a
 *  figure (「分布式系统与网络协议（2026 秋季学期 · 周三晚班）」 is said 「…协议…」 or whole, never 「…（202…」); a figure in the first two characters
 *  (「第2讲」, 「CS5223」) stays in the head, which is said whole up to 6em. One word box at most where round 8 drew one, so a row keeps few elements
 *  (#565). */
export function nameWords(text) {
  const [head, ...tail] = text.split(' · ');
  const parts = tail.map(part => ` · ${part}`), at = [...head.slice(2).matchAll(FIGURE)].find(match => match.index >= 2)?.index;
  return at === undefined ? [head, ...parts] : [head.slice(0, 2 + at), head.slice(2 + at) + parts.join('')];
}

/* The shortened first course as its words: the head as text, each word after it one unbreakable box, so the name cut with 「…」 ends on a whole word,
   never on its own 「·」 (「示例课程 · …」, #1084 round 8) nor inside a figure (round 11). Only that name is boxed: the other pieces are never cut
   mid-name, and stay plain text (one run of words for the static markup and the checkbox's name, and few elements per row, #565). */
const parted = words => <>{words[0]}{words.slice(1).map((word, at) => <span key={at} className="source-picker__part">{word}</span>)}</>;

/* The first course on a row, shortened where its row is short of room (ui/source-picker.css): only while it is cut (measured with the shared observer of
   ui/use-cut.js) is it wrapped in the shared Tooltip with its whole name; a name said whole is one element and has no card (round 8 review, #565). The
   anchor takes the name's place in the line (the same size), so the name is cut the same with it and without. A box that does not start at a space puts
   one into the checkbox's name (「协议 （2026」), so such a name's drawn words are hidden from that name and the name is said once more, as written, out of
   sight beside them (round 14: no aria-label on a plain span, which ARIA 1.2 prohibits; see-through and out of the line's flow, as a piece the line
   leaves out). The name is cut as soon as its words overflow at all: a word box past its end is hidden behind the 「…」 by a pixel's overflow too,
   which the default rounding of ui/use-cut.js lets pass. */
const wordsCut = element => element.scrollWidth > element.clientWidth
  || [...element.querySelectorAll('.source-picker__part')].some(word => word.getBoundingClientRect().right > element.getBoundingClientRect().right + 0.01);

function CourseName({ name }) {
  const ref = useRef(null), cut = useCut(ref, name, wordsCut), words = nameWords(`· ${name}`), boxed = words.slice(1).some(word => !/^\s/.test(word));
  const drawn = <span ref={ref} className="source-picker__fact source-picker__fact--name source-picker__fact--short" data-name="first"
    aria-hidden={boxed ? 'true' : undefined}>{parted(words)}</span>;
  const shown = cut ? <Tooltip layer group="index-badge" anchorClassName="source-picker__fact-anchor" content={name}>{drawn}</Tooltip> : drawn;
  return boxed ? <>{shown}<span className="source-picker__said">{`· ${name}`}</span></> : shown;
}

/**
 * The words of a row's facts line (#1084): the format, its pages and its size (`kind`, `pages`: '' where it has none, `size`; together the `lead`); then the
 * names; then the notes (`notes`: what to check before generating, and an inferred course). The course 课程范围 names is said once, above the list, not
 * again here; another course the material is in comes `first` (`shortened`: it is long enough to be shortened with 「…」), then the names after it
 * (`later`: more courses, the file it comes from). Shared by the row and the list's one decision on what the rows show (ui/picker-names.js), which
 * reads every document in the scope, drawn or not. Round 10: the notes come last, so a long note gives way at the line's end instead of taking the
 * names' room on every row of the list.
 */
export function rowNames(item, scope, relation) {
  const related = relationNote(relation), label = sourceFormatLabel(item), split = label.indexOf(' · ');
  const kind = split < 0 ? label : label.slice(0, split), pages = split < 0 ? '' : label.slice(split + 3), size = uiFormat('{0} 字符', [formatNumber(item.chars)]);
  const short = uiFormat('{0}字', [formatNumber(item.chars)]), group = sizeGroup(item.format, !!pages);
  const notes = [...documentNotes(item), item.coursesInferred ? ui('推断归属') : ''].filter(Boolean);
  const courses = item.courses.length ? item.courses.filter(course => course !== scope) : scope === '' ? [] : [ui('未分类')];
  const [first = '', ...later] = [...courses, related].filter(Boolean);
  return { lead: [label, size].join(' · '), kind, pages, size, short, group, notes, first, later, shortened: courses.length > 0 && [...courses[0]].length > SHORTEST_NAME };
}

/* The lead as whole parts (#1084, round 10; #1134, #1135): the format, then its pages and its size, each one unbreakable box with its own 「·」, said whole
   or left out whole by the list's one decision for the rows of a kind (ui/picker-names.js: a document with pages says its size in pages, its characters
   give way first), so a size is never cut (「Markdown · 560 …」, 「Text · 267 charac…」) and the line never ends on a bare 「·」. A box starts at a space, so
   the words read as one run of text (the static markup, and the checkbox's name, which puts a space at a box's edge). The characters' short words
   (「180 chars」, round 11: en 320) are the lead's `data-short`, drawn after it only where the list says them (ui/source-picker.css): no element more on a
   row (#565), and not in the checkbox's name, which says the long ones. */
function leadParts({ kind, pages, size }) {
  return <>{kind}{pages && <span className="source-picker__part source-picker__part--pages">{` · ${pages}`}</span>}<span
    className="source-picker__part source-picker__part--size">{` · ${size}`}</span></>;
}

/* The index badge's slot is at the end of the facts line, after the facts in the DOM (the checkbox's name reads title, facts, badge). While the index answer is
   coming (`indexPending`) every row holds a box of fixed size for it, so a badge that comes fills it and moves nothing (#1084, round 4). Once the answer is in, the
   column keeps its width, badge or not (round 8, below), and a picker that shows no badges has none: the facts are one line
   either way, so no row changes height. The title has the whole column. The slot is in the row's last column, under 选择页面 where a wide row has it, so
   every badge ends at the row's end: one column of badges (ui/source-picker.css). The badge is no Tab stop of its own: the row's checkbox opens its hover
   while it has the keyboard focus. Round 8: in a picker that shows badges (`indexColumn`) that column is the same width on every row, coming, with a badge
   and without, so the facts line has the same room whatever the answer (round 8 review: a row without a badge lends it to nothing, so a size said while
   the answer is coming is said the same once it is in). */
const DocumentRow = memo(function DocumentRow({ item, selected, apply, disabled, defaultOpen = false, indexInfo = null, indexPending = false, canIndex, relation = null, scope = '*', indexColumn = false }) {
  const [open, setOpen] = useState(defaultOpen), [pagesOpen, setPagesOpen] = useState(false), [focused, setFocused] = useState(false);
  const listId = useId(), chaptersId = useId(), nameId = useId();
  const chaptered = chosenByChapters(item);
  const state = selectionState(item, selected);
  const chosen = new Set(selected);
  const multi = item.pages.length > 1;
  const picked = item.sourceIds.filter(id => chosen.has(id)).length;
  const name = displayTitle(item.title);
  // The facts, one line (#1084, rowNames): the format, its pages and its size; then the names; then the notes, each said whole or left out at the line's
  // end (round 10). Materials made from one original file say so (#207): "派生自 <file>" on a text version, "另有 2 份派生资料" on the file. The first name
  // is said whole or, short of room, shortened to its first words with 「…」 and its whole name on hover; the names after it are said whole or left out
  // whole with their 「·」, and only while the first is whole (round 8: the first takes the room). Which names and sizes a row shows is the list's one
  // decision (ui/picker-names.js): a run of rows reads the same. Every word stays in the words the checkbox's name reads, shown or not.
  const { notes, first, later, shortened, group, ...lead } = rowNames(item, scope, relation);
  const slot = indexInfo ? 'badge' : indexPending ? 'held' : 'none';
  return (
    <div className={`source-picker__item${state !== 'none' ? ' is-selected' : ''}`} data-document-key={item.key}>
      <div className={`source-picker__row${multi ? ' has-expand' : ''}${slot !== 'none' || indexColumn ? ' has-index' : ''}`} data-size-group={group}>
        <label className="source-picker__doc">
          {/* Its name is what the row says (title, facts, the badge's word, the pages picked), not the badge's card: the card is held open while the box has the
              keyboard focus, and a card inside the label would join the name. The card is the box's description. */}
          <CheckboxInput className="source-picker__check" checked={state === 'all'} indeterminate={state === 'some'} disabled={disabled}
            aria-labelledby={[`${nameId}-t`, `${nameId}-f`, indexInfo && `${nameId}-w`, state === 'some' && `${nameId}-p`].filter(Boolean).join(' ')}
            aria-describedby={indexInfo ? `${nameId}-c` : undefined}
            onFocus={event => setFocused(event.target.matches(':focus-visible'))} onBlur={() => setFocused(false)}
            onChange={event => { const on = event.target.checked; apply(current => toggleDocument(current, item, on)); }} />
          <span className="source-picker__text">
            <strong id={`${nameId}-t`} title={item.title}>{name}</strong>
            <small id={`${nameId}-f`} className="source-picker__facts"><span className="source-picker__fact source-picker__fact--lead"
              data-short={` · ${lead.short}`}>{leadParts(lead)}</span>
              {first && ' '}{first && (shortened ? <CourseName name={first} /> : <span className="source-picker__fact source-picker__fact--name" data-name="first">{`· ${first}`}</span>)}
              {later.length > 0 && <>{' '}<span className="source-picker__names">{later.map((other, at) => <React.Fragment key={at}>{at > 0 && ' '}<span
                className="source-picker__fact source-picker__fact--name" data-name="rest">{`· ${other}`}</span></React.Fragment>)}</span></>}
              {notes.length > 0 && <>{' '}<span className="source-picker__notes">{notes.map((note, at) => <React.Fragment key={at}>{at > 0 && ' '}<span
                className="source-picker__fact source-picker__fact--note">{`· ${note}`}</span></React.Fragment>)}</span></>}</small>
            <span className="source-picker__index" data-index-slot={slot}>{indexInfo && <IndexBadge compact info={indexInfo} coverage={{ canIndex }} open={focused} wordId={`${nameId}-w`} tipId={`${nameId}-c`} />}</span>
            {state === 'some' && <small id={`${nameId}-p`} className="source-picker__partial">{uiFormat('已选 {0} / {1} 页', [picked, item.sourceIds.length])}</small>}
          </span>
        </label>
        {multi && <Button variant="quiet" size="sm" className="source-picker__expand" aria-expanded={open} aria-controls={chaptered ? chaptersId : listId}
          iconEnd="chevron" iconEndClassName="source-picker__chevron" onClick={() => setOpen(value => !value)}>
          {open ? ui('收起') : chaptered ? ui('选择章节') : isPagedFormat(item.format) ? ui('选择页面') : ui('选择部分')}
        </Button>}
      </div>
      {multi && open && chaptered && <div id={chaptersId} className="source-picker__chapters">
        <ul className="source-picker__chapter-list" aria-label={uiFormat('「{0}」的章节', [name])}>
          {item.chapters.map(chapter => {
            const chapterPicked = chapterState(chapter, selected), inside = chapter.sourceIds.length === 0;
            return <li key={chapter.index} data-chapter-index={chapter.index}>
              <label className="source-picker__chapter">
                <CheckboxInput className="source-picker__check" checked={chapterPicked === 'all'} indeterminate={chapterPicked === 'some'} disabled={disabled || inside}
                  onChange={event => { const on = event.target.checked; apply(current => toggleChapter(current, chapter, on)); }} />
                <span>{chapterLabel(chapter, item.chapterUnit)}</span>
                <small>{inside ? ui('在同一页内，不能单独选择') : uiFormat(item.chapterUnit === 'part' ? '{0} 部分' : '{0} 页', [chapter.sourceIds.length])}</small>
              </label>
            </li>;
          })}
        </ul>
        <Button variant="link" size="sm" aria-expanded={pagesOpen} aria-controls={listId} onClick={() => setPagesOpen(value => !value)}>
          {pagesOpen ? ui('收起页面列表') : ui('改为按页选择')}</Button>
        {pagesOpen && <ul id={listId} className="source-picker__pages" aria-label={uiFormat('「{0}」的页面', [name])}>
        {item.pages.map(page => <li key={page.sourceId}>
          <label>
            <CheckboxInput className="source-picker__check" checked={chosen.has(page.sourceId)} disabled={disabled}
              onChange={event => { const on = event.target.checked; apply(current => on ? [...current, page.sourceId] : current.filter(id => id !== page.sourceId)); }} />
            <span>{pageLabel(item, page)}</span>
            <small>{uiFormat('{0} 字符', [formatNumber(page.chars)])}</small>
          </label>
        </li>)}
      </ul>}
      </div>}
      {multi && open && !chaptered && <ul id={listId} className="source-picker__pages" aria-label={uiFormat('「{0}」的页面', [name])}>
        {item.pages.map(page => <li key={page.sourceId}>
          <label>
            <CheckboxInput className="source-picker__check" checked={chosen.has(page.sourceId)} disabled={disabled}
              onChange={event => { const on = event.target.checked; apply(current => on ? [...current, page.sourceId] : current.filter(id => id !== page.sourceId)); }} />
            <span>{pageLabel(item, page)}</span>
            <small>{uiFormat('{0} 字符', [formatNumber(page.chars)])}</small>
          </label>
        </li>)}
      </ul>}
    </div>
  );
}, documentRowPropsEqual);

/**
 * Props: sources (snapshot sources), selected (source ids), onChange(ids),
 * courses + scope + onScopeChange (course scope; omit onScopeChange to show
 * everything), disabled, onAdd (shows “添加资料”), defaultQuery (initial filter
 * text), defaultOpenKey (a document key whose pages/chapters start open), maxHeight (list window height in px), indexCoverage (the index badge of each row, at the end of its facts line: a slot
 * held on every row while the answer is on its way, and kept, badge or none, so the facts' names have the same room before and after the answer; the facts are one line either way, so the answer moves no row), onIndex(course) (the way to 设置 › 检索扩展 with that course chosen: one line says how many rows are not fully indexed and leads there,
 * beside 添加资料 under the list when there is one (a line that is there anyway, so a late answer moves nothing), else above the list; none without it. The row badges only show the
 * state, #1084), indexPending (the coverage answer is still coming: every row holds the badge's slot until it is in). Extra props land on the root.
 * The list scrolls in a bounded window with a filter (WP14), so a course with
 * hundreds of materials never pushes the page down. With a course scope (onScopeChange) and that filter, the list's filter line also holds one button that
 * opens the type and category filters with AI 智能分类 (#1177) under it: shut by default, off the main path (#1182); while shut, a filter in use is said
 * on that line's next line with 「清除筛选」, so no row goes missing unexplained.
 */
export default function SourcePicker({ sources = [], selected = [], onChange, courses = [], scope = '*', onScopeChange, disabled = false,
  onAdd, defaultQuery = '', defaultOpenKey = '', maxHeight = 420, className, indexCoverage = null, indexPending = false, onIndex,
  materialFolders: materialFoldersProp, modelReady, ...rest }) {
  useInjectCss(css, 'study-source-picker');
  const appData = useContext(AppContext)?.data;
  const [query, setQuery] = useState(defaultQuery);
  const [typeScope, setTypeScope] = useState(ALL_FACET);
  const [categoryScope, setCategoryScope] = useState(ALL_FACET);
  const [facetsOpen, setFacetsOpen] = useState(false);
  const facetsId = useId();
  const root = useRef(null);
  const items = useMemo(() => groupSourcesByDocument(sources).filter(item => !item.archived), [sources]);
  const sourceFlags = useMemo(() => buildSourceFlags(sources), [sources]);
  const resolvedMaterialFolders = useMemo(
    () => resolveMaterialFolders(materialFoldersProp, appData),
    [materialFoldersProp, appData],
  );
  const bigKeys = useMemo(() => new Set(indexCoverage ? bigDocuments(items).map(item => item.key) : []), [items, indexCoverage]);
  const effectiveScope = onScopeChange ? scope : '*';
  const known = useMemo(() => courses.map(course => typeof course === 'string' ? course : course?.name).filter(Boolean), [courses]);
  const scoped = useMemo(() => items.filter(scopeFilter(effectiveScope, known)), [items, effectiveScope, known]);
  // The type and category filters come with the name filter, once the scope is longer than a screenful (#1182: a few rows need no filter).
  const showCategoryBar = Boolean(onScopeChange) && scoped.length > FILTER_AFTER;
  const typeOptions = useMemo(
    () => (showCategoryBar ? buildMaterialTypeOptions(scoped, sourceFlags) : []),
    [showCategoryBar, scoped, sourceFlags],
  );
  const categoryOptions = useMemo(
    () => (showCategoryBar ? buildMaterialCategoryOptions(scoped, resolvedMaterialFolders) : []),
    [showCategoryBar, scoped, resolvedMaterialFolders],
  );
  const activeTypeScope = showCategoryBar && hasFacetOption(typeOptions, typeScope) ? typeScope : ALL_FACET;
  const activeCategoryScope = showCategoryBar && hasFacetOption(categoryOptions, categoryScope) ? categoryScope : ALL_FACET;
  useEffect(() => {
    if (typeScope !== ALL_FACET && !hasFacetOption(typeOptions, typeScope)) setTypeScope(ALL_FACET);
  }, [typeOptions, typeScope]);
  useEffect(() => {
    if (categoryScope !== ALL_FACET && !hasFacetOption(categoryOptions, categoryScope)) setCategoryScope(ALL_FACET);
  }, [categoryOptions, categoryScope]);
  const visible = useMemo(
    () => filterMaterialsByFacets(scoped, {
      typeScope: activeTypeScope,
      categoryScope: activeCategoryScope,
      materialFolders: resolvedMaterialFolders,
      sourceFlags,
    }),
    [scoped, activeTypeScope, activeCategoryScope, resolvedMaterialFolders, sourceFlags],
  );
  const searchMatch = useCallback(item => documentSearchText(item, resolvedMaterialFolders), [resolvedMaterialFolders]);
  const visibleIds = useMemo(() => new Set(visible.flatMap(item => item.sourceIds)), [visible]);
  const filtering = !!query.trim();
  const shown = filtering ? filterItems(visible, query, searchMatch) : visible;
  const activeIds = useMemo(() => new Set(items.flatMap(item => item.sourceIds)), [items]);
  const activeSelected = useMemo(() => selected.filter(id => activeIds.has(id)), [selected, activeIds]);
  const chosen = new Set(activeSelected);
  const chosenDocuments = items.filter(item => item.sourceIds.some(id => chosen.has(id))).length;
  const outside = activeSelected.some(id => !visibleIds.has(id));
  const change = ids => onChange?.(ids);
  // Rows read the latest selection through one stable function, so a click re-renders the clicked row, not all of them (#205).
  const latest = useRef({ selected, onChange, onIndex });
  latest.current = { selected, onChange, onIndex };
  const apply = useCallback(update => latest.current.onChange?.(update(latest.current.selected)), []);
  // One index state per document, reusing the previous object while it is unchanged: a coverage answer then touches the rows whose badge changed.
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
  const canIndex = indexCoverage?.canIndex;
  // The badges ask for the index through one stable function that reads the latest handler, so a new handler each render redraws no row.
  const goIndex = useCallback(course => latest.current.onIndex?.(course), []);
  const gap = useMemo(() => (onIndex ? indexGap(visible.map(item => ({ item, info: infos.get(item.key) }))) : null), [onIndex, visible, infos]);
  const relations = useMemo(() => materialRelations(items), [items]);
  // The rows show the names and sizes every document in the scope has room for (ui/picker-names.js); a picker that shows index badges keeps their column on
  // every row.
  const nameRows = useMemo(() => visible.map(item => {
    const { kind, pages, size, short, group, first, later, shortened } = rowNames(item, scope, relations.get(item.key) ?? null);
    return { kind, pages: pages && ` · ${pages}`, size: ` · ${size}`, short: ` · ${short}`, first: first && `· ${first}`, later: later.map(name => `· ${name}`), shortened,
      multi: item.pages.length > 1, group };
  }), [visible, scope, relations]);
  useFactsFit(root, nameRows, scope === '*');
  const indexColumn = !!onIndex || indexPending || !!indexCoverage;
  const facetsOn = activeTypeScope !== ALL_FACET || activeCategoryScope !== ALL_FACET;
  const facetsSaid = [[typeOptions, activeTypeScope], [categoryOptions, activeCategoryScope]].filter(([, value]) => value !== ALL_FACET)
    .map(([options, value]) => facetName(options, value)).filter(Boolean);
  // On the filter's line, beside 「筛选资料…」: a button of the line's height, so the filters cost the first screen nothing while shut (#1182).
  const facetsToggle = showCategoryBar ? <Tooltip layer anchorClassName="source-picker__facets-tip" content={ui('按类型或内容分类筛选资料；AI 智能分类也在这里。')}>
    <Button size="sm" variant="quiet" icon="filter" className={`sh-btn--icon source-picker__facets-toggle${facetsOn ? ' is-on' : ''}`} aria-label={ui('类型与分类')}
      aria-expanded={facetsOpen} aria-controls={facetsId} data-material-filters-toggle data-tour="source-filters" onClick={() => setFacetsOpen(open => !open)} />
  </Tooltip> : null;
  const facetsBelow = showCategoryBar ? <>
    <MaterialCategoryBar id={facetsId} open={facetsOpen} className="source-picker__filters" items={scoped} targetItems={visible}
      course={effectiveScope === '*' || effectiveScope === '' ? '' : effectiveScope}
      materialFolders={resolvedMaterialFolders} sourceFlags={sourceFlags}
      typeOptions={typeOptions} categoryOptions={categoryOptions}
      typeScope={activeTypeScope} onTypeScopeChange={setTypeScope}
      categoryScope={activeCategoryScope} onCategoryScopeChange={setCategoryScope}
      disabled={disabled} modelReady={modelReady} />
    {!facetsOpen && facetsOn && <p className="source-picker__facets-on" data-material-filters-on>
      <span className="source-picker__facets-said">{uiFormat('只显示：{0}', [facetsSaid.join(' · ')])}</span>
      <Button variant="link" size="sm" onClick={() => { setTypeScope(ALL_FACET); setCategoryScope(ALL_FACET); }}>{ui('清除筛选')}</Button>
    </p>}
  </> : null;
  if (!items.length) return (
    <div ref={root} className={`source-picker${className ? ` ${className}` : ''}`} {...rest}>
      <EmptyState size="sm" icon="file" title={ui('还没有资料')} description={ui('先添加讲义或笔记，再用它们出题。')}
        primary={onAdd ? addSourceAction(onAdd, { disabled }) : undefined} />
    </div>
  );
  return (
    <div ref={root} className={`source-picker${indexColumn ? ' source-picker--index' : ''}${className ? ` ${className}` : ''}`} {...rest}>
      {onScopeChange && <PageScope courses={courses} value={scope} onChange={onScopeChange} disabled={disabled} />}
      <div className="source-picker__bar">
        <p className="source-picker__count" role="status">{uiFormat('已选择 {0} / {1} 份资料', [chosenDocuments, items.length])}</p>
        <div className="source-picker__actions">
          <Button size="sm" variant="quiet" className={`sh-btn--flush-start${activeSelected.length > 0 ? '' : ' sh-btn--flush-end'}`} disabled={disabled || !shown.length} onClick={() => change(selectDocuments(activeSelected, shown))}>
            {(filtering || facetsOn) ? ui('选择筛选结果') : ui('选择当前范围')}</Button>
          {activeSelected.length > 0 && <Button size="sm" variant="quiet" className="sh-btn--flush-end" disabled={disabled} onClick={() => change([])}>{ui('清空选择')}</Button>}
        </div>
      </div>
      {outside && <p className="source-picker__note">{ui('已选资料包含其他范围，生成时仍会保留。')}</p>}
      {gap && !onAdd && <IndexGapLine count={gap.count} canIndex={canIndex} onGo={() => goIndex(gap.course)} />}
      {/* A filter that leaves no row keeps the list's window (its filter line, the button and 「清除筛选」), with the empty line inside it. */}
      {scoped.length ? <ScrollWindow className={`source-picker__window${showCategoryBar ? ' source-picker__window--facets' : ''}`} label={ui('资料列表')} items={visible} itemKey={item => item.key} toolbar={facetsToggle} below={facetsBelow}
        match={searchMatch} query={query} onQueryChange={setQuery}
        filterable={scoped.length > FILTER_AFTER || activeTypeScope !== ALL_FACET || activeCategoryScope !== ALL_FACET || filtering}
        filterPlaceholder={ui('筛选资料…')} maxHeight={maxHeight} renderLimit={SOURCE_PICKER_FIRST_ROWS} listClassName="source-picker__list" itemClassName="source-picker__entry"
        empty={visible.length ? uiFormat('没有匹配“{0}”的资料', [query.trim()]) : ui('当前类型与分类组合下没有匹配的资料，可调整筛选条件。')}
        renderItem={item => <DocumentRow item={item} selected={selected} apply={apply} disabled={disabled} defaultOpen={item.key === defaultOpenKey}
          indexInfo={infos.get(item.key) ?? null} indexPending={indexPending && !indexCoverage} canIndex={canIndex} relation={relations.get(item.key) ?? null} scope={scope} indexColumn={indexColumn} />} />
        : <p className="source-picker__note">{ui('这个范围还没有资料。可切换到全部课程查看。')}</p>}
      {/* Under the list: 添加资料, and the index line beside it on the same line (one line whatever the answer: it ends in 「…」 where it is short of room). */}
      {onAdd && <div className="source-picker__foot">
        <AddSourceButton variant="quiet" size="sm" className="source-picker__add sh-btn--flush-start" disabled={disabled} onClick={onAdd} />
        {gap && <IndexGapLine short count={gap.count} canIndex={canIndex} onGo={() => goIndex(gap.course)} />}
      </div>}
    </div>
  );
}
