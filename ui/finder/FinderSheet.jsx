import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Dialog, TextInput } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './finder.css';
import { FINDER_AREAS, FINDER_ENTRIES, entryTags } from './entries.js';
import { groupByArea, searchFeatures } from './search.js';
import { withAvailability } from './availability.js';
import { moveActive } from './keys.js';

/* 找功能 (#653): one dialog. A search field, then the results as a listbox: ↑ and ↓ move, Enter is 「带我去」, Esc closes and gives the focus back to what opened it
   (the Dialog does that). With nothing typed the list is the browsable index of every feature by area, each area a <details> (the shared chevron), so the sheet is
   also the "where is everything" tutorial; a query turns it into one list ranked by how well each entry matches (ui/finder/search.js). An entry shows its title,
   its path as crumbs, one sentence and what it needs as tags. One this host cannot take the learner to is greyed with the reason and has no 「带我去」; a term shows
   its meaning and has none. The selected row is --bg-selected, never the accent: 「带我去」 is not the page's one primary action.
   `onGo(entry)` closes the sheet and moves (ui/finder/use-finder.js); `onTour` starts the feature tour (the empty state's way on). */

/** One result row. The 「带我去」 button is drawn for every reachable row and only shown on the selected one and on hover (a per-row action, DESIGN.md Restraint). */
function Row({ entry, domId, active, onSelect, onGo }) {
  const tags = entryTags(entry, ui);
  const crumbs = entry.path.length > 1 || entry.path[0] !== entry.title ? entry.path.map((crumb) => ui(crumb)).join(' › ') : '';
  const canGo = entry.kind !== 'term' && !entry.unavailable;
  return (
    <div id={domId} role="option" aria-selected={active} aria-disabled={entry.unavailable ? 'true' : undefined} className="finder-row" data-entry={entry.id}
      data-active={active ? 'true' : undefined} data-unavailable={entry.unavailable ? 'true' : undefined} onClick={onSelect}>
      <div className="finder-row__text">
        <p className="finder-row__head"><span className="finder-row__title">{ui(entry.title)}</span>{crumbs && <span className="finder-row__crumbs">{crumbs}</span>}</p>
        <p className="finder-row__what">{ui(entry.what)}</p>
        {(tags.length > 0 || entry.unavailable) && <p className="finder-row__tags">
          {tags.map((tag) => <Badge key={tag} size="sm">{tag}</Badge>)}
          {entry.unavailable && <span className="finder-row__reason">{entry.unavailable}</span>}
        </p>}
      </div>
      {canGo && <Button size="sm" variant="secondary" className="finder-row__go" tabIndex={-1} onClick={(event) => { event.stopPropagation(); onGo(entry); }}>{ui('带我去')}</Button>}
    </div>
  );
}

export default function FinderSheet({ data, entries = FINDER_ENTRIES, initialQuery = '', onGo, onClose, onTour }) {
  useInjectCss(css, 'study-finder');
  const [query, setQuery] = useState(initialQuery);
  // The index opens with its first area; the others are one click (or one Tab and Enter) away.
  const [openAreas, setOpenAreas] = useState(() => new Set([FINDER_AREAS[0].id]));
  const [selected, setSelected] = useState(null);
  const input = useRef(null), byKey = useRef(false);
  const base = useId(), listId = `${base}-list`;
  const marked = useMemo(() => withAvailability(entries, data), [entries, data]);
  const found = useMemo(() => searchFeatures(marked, query, { translate: ui }), [marked, query]);
  const browsing = !query.trim();
  const groups = useMemo(() => (browsing ? groupByArea(found, FINDER_AREAS) : []), [browsing, found]);
  // What the arrow keys can reach: the rows that are drawn open.
  const visible = browsing ? groups.filter((group) => openAreas.has(group.area.id)).flatMap((group) => group.entries) : found;
  const ids = visible.map((entry) => entry.id);
  const active = ids.includes(selected) ? selected : ids[0] ?? null;
  const domId = (entry) => `${base}-${entry.id}`;

  // A key press that moves the selection scrolls it into view; a click does not move the list under the pointer.
  useEffect(() => {
    if (!byKey.current || !active) return;
    byKey.current = false;
    document.getElementById(`${base}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, base]);

  const go = (entry) => { if (entry && entry.kind !== 'term' && !entry.unavailable) onGo(entry); };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      byKey.current = true;
      setSelected(moveActive(ids, active, event.key));
    } else if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      go(visible.find((entry) => entry.id === active));
    }
  };
  const toggle = (area, open) => setOpenAreas((current) => {
    if (current.has(area) === open) return current;
    const next = new Set(current);
    if (open) next.add(area); else next.delete(area);
    return next;
  });
  const row = (entry) => <Row key={entry.id} entry={entry} domId={domId(entry)} active={entry.id === active} onSelect={() => setSelected(entry.id)} onGo={go} />;
  return (
    <Dialog title={ui('找功能')} description={ui('搜一个功能在哪；什么都不输入，就是完整的索引。')} size="md" className="finder-sheet" bodyClassName="finder-body" onClose={onClose} initialFocus={input}>
      <TextInput ref={input} className="finder-input" role="combobox" aria-label={ui('搜索功能')} aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={active ? `${base}-${active}` : undefined} autoComplete="off" spellCheck={false} placeholder={ui('输入功能名，例如 翻译、花费上限')}
        value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
      <div id={listId} className="finder-results" role="listbox" aria-label={ui('功能')} data-mode={browsing ? 'index' : 'search'}>
        {browsing
          ? groups.map(({ area, entries: inArea }) => (
            <details key={area.id} className="finder-group" data-area={area.id} open={openAreas.has(area.id)} onToggle={(event) => toggle(area.id, event.currentTarget.open)}>
              <summary className="finder-group__summary"><span className="finder-group__label">{ui(area.label)}</span><span className="finder-group__count">{inArea.length}</span></summary>
              <div role="group" aria-label={ui(area.label)}>{inArea.map(row)}</div>
            </details>
          ))
          : found.map(row)}
        {!browsing && found.length === 0 && (
          <div className="finder-empty">
            <p>{uiFormat('没找到『{0}』。试试换个说法，或打开功能导览。', [query.trim()])}</p>
            <Button size="sm" variant="secondary" onClick={onTour}>{ui('打开功能导览')}</Button>
          </div>
        )}
      </div>
      <p className="sh-visually-hidden" role="status" aria-live="polite">{!browsing && found.length > 0 ? uiFormat('找到 {0} 项', [found.length]) : ''}</p>
    </Dialog>
  );
}
