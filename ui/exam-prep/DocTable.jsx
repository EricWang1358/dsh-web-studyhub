import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, ScrollWindow, SegmentedControl } from '../components/index.js';
import { META_DOT, joinMeta } from '../format.js';
import SourcePicker, { chosenByChapters, documentSearchText, sourceFormatLabel } from '../SourcePicker.jsx';
import { displayTitle } from '../../lib/document-title.js';
import { sourceMatchesCourse } from '../../lib/source-courses.js';
import { roleOf } from './form.js';
import { maybePaperWords, reasonWords, roleOptions } from './form-words.js';

/* 备考补习, the one table of the create form: a row per document of the course with its role as a one-click control, the reason of the suggestion
   under it, and (for a document of many pages) a way to use only some of the pages. A role the learner set is theirs and says so. */

const FILTER_AFTER = 8;

const pagesLabel = item => chosenByChapters(item) ? ui('选择章节') : item.format === 'pdf' || item.format === 'pptx' ? ui('选择页面') : ui('选择部分');

function DocRow({ item, role, suggestion, picked, sources, disabled, onRole, onPages, courses, foreign }) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const name = displayTitle(item.title);
  const reason = role === suggestion?.role ? suggestion.reason : { code: 'chosen' };
  const partial = role !== 'none' && picked.length < item.sourceIds.length;
  const meta = joinMeta([sourceFormatLabel(item), foreign ? item.courses.join(META_DOT) : '',
    partial ? uiFormat('已选 {0} / {1} 页', [picked.length, item.sourceIds.length]) : '']);
  const choosable = item.pages.length > 1 && role !== 'none';
  return (
    <div className="exam-prep-doc">
      <div className="exam-prep-doc__main">
        <span className="exam-prep-doc__name">{name}</span>
        <span className="exam-prep-doc__meta">{meta}</span>
      </div>
      <SegmentedControl className="exam-prep-doc__role" size="sm" label={uiFormat('「{0}」的用途', [name])} value={role} options={roleOptions()}
        disabled={disabled} onChange={value => onRole(item, value)} />
      <p className="exam-prep-doc__why">
        <span className="exam-prep-doc__reason">{reasonWords(reason)}</span>
        {suggestion?.hint === 'maybe-paper' && role !== 'past-paper' && (
          <Button variant="link" size="sm" disabled={disabled} onClick={() => onRole(item, 'past-paper')}>{maybePaperWords()}</Button>
        )}
        {choosable && (
          <Button variant="quiet" size="sm" iconEnd="chevron" aria-expanded={pagesOpen} disabled={disabled} onClick={() => setPagesOpen(value => !value)}>
            {pagesOpen ? ui('收起') : pagesLabel(item)}
          </Button>
        )}
      </p>
      {choosable && pagesOpen && (
        <div className="exam-prep-doc__pages">
          <SourcePicker sources={sources.filter(source => item.sourceIds.includes(source.id))} selected={picked} onChange={ids => onPages(item, role, ids)}
            courses={courses} disabled={disabled} maxHeight={260} defaultOpenKey={item.key} aria-label={name} />
        </div>
      )}
    </div>
  );
}

/**
 * items: the documents offered (lib/source-groups.js), picks: the source ids by role, suggestions: Map of document key to its suggestion,
 * sources: the snapshot's sources (a row's pages are looked up in them), onRole(item, role), onPages(item, role, ids).
 * A short table is a plain list, every row in sight; a long one scrolls in a window with a filter (ui/components/ScrollWindow.jsx).
 */
export default function DocTable({ items, picks, suggestions, sources, course, known, disabled, onRole, onPages, courses }) {
  const foreign = item => !!course && item.courses.length > 0 && !sourceMatchesCourse({ courses: item.courses }, course, known);
  const attributes = item => ({ 'data-doc': item.key, 'data-role': roleOf(item, picks) });
  const row = item => {
    const role = roleOf(item, picks);
    return (
      <DocRow item={item} role={role} suggestion={suggestions.get(item.key)} picked={item.sourceIds.filter(id => picks[role]?.includes(id))} sources={sources}
        disabled={disabled} onRole={onRole} onPages={onPages} courses={courses} foreign={foreign(item)} />
    );
  };
  if (items.length <= FILTER_AFTER) {
    return (
      <ul className="exam-prep-docs__list" aria-label={ui('资料')}>
        {items.map(item => <li key={item.key} className="exam-prep-docs__entry" {...attributes(item)}>{row(item)}</li>)}
      </ul>
    );
  }
  return (
    <ScrollWindow className="exam-prep-docs__window" label={ui('资料')} items={items} itemKey={item => item.key} maxHeight={560} match={documentSearchText} filterable
      filterPlaceholder={ui('筛选资料…')} listClassName="exam-prep-docs__list" itemClassName="exam-prep-docs__entry" itemProps={attributes} renderItem={row} />
  );
}
