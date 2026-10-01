import React, { useId, useMemo, useState } from 'react';
import { ui, uiFormat, uiLocale } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, EmptyState, ScrollWindow, filterItems } from './components/index.js';
import PageScope from './PageScope.jsx';
import { groupSourcesByDocument, isLegacyExtraction, sourceFormat } from '../lib/source-groups.js';
import css from './source-picker.css';

/* Choosing material for generation (P18, P22). One row per document: a PDF is
   one checkbox for the whole file with an expandable page list. Counts are in
   documents. The selection itself stays a list of source ids, so the generate
   action is unchanged. */

const FORMAT_LABELS = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', md: 'Markdown', html: 'HTML', txt: 'TXT', audio: '录音逐字稿', json: 'JSON 题组', text: '文本' };

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
    if (value.format === 'pptx') return parts === 1 ? ui('PowerPoint · 1 页') : uiFormat('PowerPoint · {0} 页', [parts]);
    if (value.format === 'audio' && parts > 1) return uiFormat('{0} · {1} 部分', [base, parts]);
    return base;
  }
  const format = sourceFormat(value), base = value.document?.origin === 'converted' ? ui('转换文档') : ui(FORMAT_LABELS[format]);
  if (isLegacyExtraction(value)) return uiFormat('{0} · 旧版提取，建议重新导入', [base]);
  if ((format === 'pdf' || format === 'pptx') && Number.isInteger(value.document?.page)) return uiFormat('{0} · 第 {1} 页', [base, value.document.page]);
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

/** “第一章 进程 · 第 1–4 页”: a chapter's title and where it lies. */
export function chapterLabel(chapter) {
  const title = chapter.title || (chapter.front ? ui('前言与目录') : '');
  const range = chapter.startPage === chapter.endPage ? uiFormat('第 {0} 页', [chapter.startPage]) : uiFormat('第 {0}–{1} 页', [chapter.startPage, chapter.endPage]);
  return title ? `${title} · ${range}` : range;
}

/** Select every source of the given documents (select-all for a scope). */
export const selectDocuments = (selected, items) => [...new Set([...selected, ...items.flatMap(item => item.sourceIds)])];

/** A document is in a course scope when any of its pages belongs to it ('*' is everything, '' unassigned). */
export function inScope(item, scope) {
  if (scope === undefined || scope === null || scope === '*') return true;
  return scope === '' ? !item.courses.length : item.courses.includes(scope);
}

/** Small notes a learner should check before generating. */
export function documentNotes(item) {
  return [item.warnings.includes('sparse') && ui('文字偏少，核对正文'), item.warnings.includes('layout') && ui('排版复杂，建议对照原文'),
    item.warnings.includes('legacy-extraction') && ui('含旧版提取页，建议重新导入')].filter(Boolean);
}

/** What the picker's filter searches: title, file name, courses and format. */
export const documentSearchText = item => [item.title, item.filename, ...(item.courses || []), sourceFormatLabel(item)].filter(Boolean).join(' ');

/* The filter appears once the list is longer than a screenful of rows. */
const FILTER_AFTER = 6;

const pageLabel = (item, page) => item.format === 'pdf' || item.format === 'pptx'
  ? uiFormat('第 {0} 页', [page.page]) + (page.legacy ? ` · ${ui('旧版提取')}` : '')
  : item.format === 'audio' ? uiFormat('第 {0} 部分', [page.page]) : page.title;

function DocumentRow({ item, selected, onChange, disabled, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen), [pagesOpen, setPagesOpen] = useState(false);
  const listId = useId(), chaptersId = useId();
  const chaptered = !!item.chapters?.length;
  const state = selectionState(item, selected);
  const chosen = new Set(selected);
  const multi = item.pages.length > 1;
  const picked = item.sourceIds.filter(id => chosen.has(id)).length;
  const meta = [sourceFormatLabel(item), item.courses.join(' · ') || ui('未分类'),
    uiFormat('{0} 字符', [item.chars.toLocaleString(uiLocale())]), ...documentNotes(item)];
  return (
    <div className={`source-picker__item${state !== 'none' ? ' is-selected' : ''}`} data-document-key={item.key}>
      <div className="source-picker__row">
        <label className="source-picker__doc">
          <input type="checkbox" checked={state === 'all'} disabled={disabled}
            ref={element => { if (element) element.indeterminate = state === 'some'; }}
            onChange={event => onChange(toggleDocument(selected, item, event.target.checked))} />
          <span className="source-picker__text">
            <strong title={item.title}>{item.title}</strong>
            <small>{meta.join(' · ')}{item.coursesInferred ? ui(' · 推断归属') : ''}</small>
            {state === 'some' && <small className="source-picker__partial">{uiFormat('已选 {0} / {1} 页', [picked, item.sourceIds.length])}</small>}
          </span>
        </label>
        {multi && <Button variant="quiet" size="sm" className="source-picker__expand" aria-expanded={open} aria-controls={chaptered ? chaptersId : listId}
          iconEnd="chevron" onClick={() => setOpen(value => !value)}>
          {open ? ui('收起') : chaptered ? ui('选择章节') : item.format === 'pdf' || item.format === 'pptx' ? ui('选择页面') : ui('选择部分')}
        </Button>}
      </div>
      {multi && open && chaptered && <div id={chaptersId} className="source-picker__chapters">
        <ul className="source-picker__chapter-list" aria-label={uiFormat('「{0}」的章节', [item.title])}>
          {item.chapters.map(chapter => {
            const chapterPicked = chapterState(chapter, selected);
            return <li key={chapter.index} data-chapter-index={chapter.index}>
              <label>
                <input type="checkbox" checked={chapterPicked === 'all'} disabled={disabled}
                  ref={element => { if (element) element.indeterminate = chapterPicked === 'some'; }}
                  onChange={event => onChange(toggleChapter(selected, chapter, event.target.checked))} />
                <span>{chapterLabel(chapter)}</span>
                <small>{uiFormat('{0} 页', [chapter.sourceIds.length])}</small>
              </label>
            </li>;
          })}
        </ul>
        <Button variant="link" size="sm" aria-expanded={pagesOpen} aria-controls={listId} onClick={() => setPagesOpen(value => !value)}>
          {pagesOpen ? ui('收起页面列表') : ui('改为按页选择')}</Button>
        {pagesOpen && <ul id={listId} className="source-picker__pages" aria-label={uiFormat('「{0}」的页面', [item.title])}>
        {item.pages.map(page => <li key={page.sourceId}>
          <label>
            <input type="checkbox" checked={chosen.has(page.sourceId)} disabled={disabled}
              onChange={event => onChange(event.target.checked ? [...selected, page.sourceId] : selected.filter(id => id !== page.sourceId))} />
            <span>{pageLabel(item, page)}</span>
            <small>{uiFormat('{0} 字符', [page.chars.toLocaleString(uiLocale())])}</small>
          </label>
        </li>)}
      </ul>}
      </div>}
      {multi && open && !chaptered && <ul id={listId} className="source-picker__pages" aria-label={uiFormat('「{0}」的页面', [item.title])}>
        {item.pages.map(page => <li key={page.sourceId}>
          <label>
            <input type="checkbox" checked={chosen.has(page.sourceId)} disabled={disabled}
              onChange={event => onChange(event.target.checked ? [...selected, page.sourceId] : selected.filter(id => id !== page.sourceId))} />
            <span>{pageLabel(item, page)}</span>
            <small>{uiFormat('{0} 字符', [page.chars.toLocaleString(uiLocale())])}</small>
          </label>
        </li>)}
      </ul>}
    </div>
  );
}

/**
 * Props: sources (snapshot sources), selected (source ids), onChange(ids),
 * courses + scope + onScopeChange (course scope; omit onScopeChange to show
 * everything), disabled, onAdd (shows “添加资料”), defaultQuery (initial filter
 * text), defaultOpenKey (a document key whose pages/chapters start open), maxHeight (list window height in px). Extra props land on the root.
 * The list scrolls in a bounded window with a filter (WP14), so a course with
 * hundreds of materials never pushes the page down.
 */
export default function SourcePicker({ sources = [], selected = [], onChange, courses = [], scope = '*', onScopeChange, disabled = false,
  onAdd, defaultQuery = '', defaultOpenKey = '', maxHeight = 420, className, ...rest }) {
  useInjectCss(css, 'study-source-picker');
  const [query, setQuery] = useState(defaultQuery);
  const items = useMemo(() => groupSourcesByDocument(sources), [sources]);
  const effectiveScope = onScopeChange ? scope : '*';
  const visible = items.filter(item => inScope(item, effectiveScope));
  const filtering = !!query.trim();
  const shown = filtering ? filterItems(visible, query, documentSearchText) : visible;
  const chosen = new Set(selected);
  const chosenDocuments = items.filter(item => item.sourceIds.some(id => chosen.has(id))).length;
  const outside = selected.some(id => !visible.some(item => item.sourceIds.includes(id)));
  const change = ids => onChange?.(ids);
  if (!items.length) return (
    <div className={`source-picker${className ? ` ${className}` : ''}`} {...rest}>
      <EmptyState size="sm" icon="file" title={ui('还没有资料')} description={ui('先添加讲义或笔记，再用它们出题。')}
        primary={onAdd ? { label: ui('添加资料'), icon: 'plus', onClick: onAdd, disabled } : undefined} />
    </div>
  );
  return (
    <div className={`source-picker${className ? ` ${className}` : ''}`} {...rest}>
      {onScopeChange && <PageScope courses={courses} value={scope} onChange={onScopeChange} disabled={disabled} />}
      <div className="source-picker__bar">
        <p className="source-picker__count" role="status">{uiFormat('已选择 {0} / {1} 份资料', [chosenDocuments, items.length])}</p>
        <div className="source-picker__actions">
          <Button size="sm" variant="quiet" disabled={disabled || !shown.length} onClick={() => change(selectDocuments(selected, shown))}>
            {filtering ? ui('选择筛选结果') : ui('选择当前范围')}</Button>
          {selected.length > 0 && <Button size="sm" variant="quiet" disabled={disabled} onClick={() => change([])}>{ui('清空选择')}</Button>}
        </div>
      </div>
      {outside && <p className="source-picker__note">{ui('已选资料包含其他范围，生成时仍会保留。')}</p>}
      {visible.length ? <ScrollWindow className="source-picker__window" label={ui('资料列表')} items={visible} itemKey={item => item.key}
        match={documentSearchText} query={query} onQueryChange={setQuery} filterable={visible.length > FILTER_AFTER || filtering}
        filterPlaceholder={ui('筛选资料…')} maxHeight={maxHeight} listClassName="source-picker__list" itemClassName="source-picker__entry"
        empty={uiFormat('没有匹配“{0}”的资料', [query.trim()])}
        renderItem={item => <DocumentRow item={item} selected={selected} onChange={change} disabled={disabled} defaultOpen={item.key === defaultOpenKey} />} />
        : <p className="source-picker__note">{ui('这个范围还没有资料。可切换到全部课程查看。')}</p>}
      {onAdd && <Button variant="quiet" size="sm" icon="plus" className="source-picker__add" disabled={disabled} onClick={onAdd}>{ui('添加资料')}</Button>}
    </div>
  );
}
