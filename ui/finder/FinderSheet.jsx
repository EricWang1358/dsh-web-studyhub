import React, { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Dialog, TextInput } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { StudyServicesContext } from '../study-context.jsx';
import css from './finder.css';
import { FINDER_AREAS, FINDER_ENTRIES, entryTags } from './entries.js';
import { groupByArea, searchFeatures } from './search.js';
import { withAvailability } from './availability.js';
import { moveActive } from './keys.js';
import { searchLibraryHits } from './library-hits.js';
import { highlightSnippetParts, shouldSearchContent, toFinderContentEntries } from './content-hits.js';
import { studyChainRecipes } from '../../lib/practice-settings.js';
import { buildChainRecipes } from './chain-recipes.js';
import { clearRecentFinderIds, readRecentFinderIds, recentFinderEntries, recordRecentFinderId } from './recent.js';

/* 找功能 (#653): one dialog. A search field, then the results as a listbox: ↑ and ↓ move, Enter is 「带我去」, Esc closes and gives the focus back to what opened it
   (the Dialog does that). With nothing typed the list is the browsable index of every feature by area, each area a <details> (the shared chevron), so the sheet is
   also the "where is everything" tutorial; a query turns it into one list ranked by how well each entry matches (ui/finder/search.js). An entry shows its title,
   its path as crumbs, one sentence and what it needs as tags. One this host cannot take the learner to is greyed with the reason and has no 「带我去」; a term shows
   its meaning and has none. The selected row is --bg-selected, never the accent: 「带我去」 is not the page's one primary action.
   `onGo(entry)` closes the sheet and moves (ui/finder/use-finder.js); `onTour` starts the feature tour (the empty state's way on). */

const LIBRARY_KIND_LABEL = {
  course: '课程',
  deck: '题组',
  source: '资料',
  note: '笔记',
};

const CONTENT_KIND_LABEL = {
  source: '资料',
  card: '题目',
  note: '笔记',
  book: '复习全书',
};

const CONTENT_DEBOUNCE_MS = 100;

function libraryMeta(entry) {
  const parts = [];
  if (entry.current) parts.push(ui('当前课程'));
  if (entry.libraryKind === 'deck' && entry.count > 0) parts.push(uiFormat('{0} 题', [entry.count]));
  if (entry.libraryKind === 'source' && entry.pages > 0) parts.push(uiFormat('{0} 页', [entry.pages]));
  return parts.join(' · ');
}

function contentCrumbs(entry) {
  const kindLabel = ui(CONTENT_KIND_LABEL[entry.contentKind] || '资料');
  if (entry.contentKind === 'source') {
    return [kindLabel, entry.course, entry.page ? uiFormat('第 {0} 页', [entry.page]) : ''].filter(Boolean).join(' › ');
  }
  if (entry.contentKind === 'card') {
    return [kindLabel, entry.course, entry.deckTitle, entry.topic].filter(Boolean).join(' › ');
  }
  return [kindLabel, entry.course].filter(Boolean).join(' › ');
}

function HighlightedSnippet({ snippet, query }) {
  const parts = useMemo(() => highlightSnippetParts(snippet, query), [snippet, query]);
  return parts.map((part, idx) => (part.match ? <mark key={idx} className="finder-hit-mark">{part.text}</mark> : part.text));
}

/** One result row. The 「带我去」 button is drawn for every reachable row and only shown on the selected one and on hover (a per-row action, DESIGN.md Restraint). */
function Row({ entry, domId, active, query = '', onSelect, onGo }) {
  const isLibrary = entry.kind === 'library';
  const isContent = entry.kind === 'content';
  const tags = (isLibrary || isContent) ? [] : entryTags(entry, ui);
  const crumbs = isContent
    ? contentCrumbs(entry)
    : isLibrary
      ? [ui(LIBRARY_KIND_LABEL[entry.libraryKind] || '资料'), entry.course].filter(Boolean).join(' › ')
      : (entry.path.length > 1 || entry.path[0] !== entry.title ? entry.path.map((crumb) => ui(crumb)).join(' › ') : '');
  const titleText = (isLibrary || isContent) ? (entry.title || ui('未命名笔记')) : ui(entry.title);
  const whatText = isContent ? entry.snippet : isLibrary ? libraryMeta(entry) : ui(entry.what);
  const canGo = entry.kind !== 'term' && !entry.unavailable;
  return (
    <div id={domId} role="option" aria-selected={active} aria-disabled={entry.unavailable ? 'true' : undefined} className="finder-row" data-entry={entry.id}
      data-content-kind={isContent ? entry.contentKind : undefined}
      data-active={active ? 'true' : undefined} data-unavailable={entry.unavailable ? 'true' : undefined}
      onClick={() => (isContent && canGo ? onGo(entry) : onSelect())}>
      <div className="finder-row__text">
        <p className="finder-row__head">{entry.stepNumber > 0 && <span className="finder-row__step">{entry.stepNumber}.</span>}<span className="finder-row__title">{titleText}</span>{crumbs && <span className="finder-row__crumbs">{crumbs}</span>}</p>
        {whatText && <p className="finder-row__what">{isContent ? <HighlightedSnippet snippet={whatText} query={query} /> : whatText}</p>}
        {(tags.length > 0 || entry.unavailable) && <p className="finder-row__tags">
          {tags.map((tag) => <Badge key={tag} size="sm">{tag}</Badge>)}
          {entry.unavailable && <span className="finder-row__reason">{entry.unavailable}</span>}
        </p>}
      </div>
      {canGo && <Button iconEnd="arrow-right" size="sm" variant="secondary" className="finder-row__go" tabIndex={-1} onClick={(event) => { event.stopPropagation(); onGo(entry); }}>{ui('带我去')}</Button>}
    </div>
  );
}

export default function FinderSheet({ data, entries = FINDER_ENTRIES, initialQuery = '', initialRecentIds = null, initialContentHits = null, searchContent = null, onGo, onClose, onTour }) {
  useInjectCss(css, 'study-finder');
  const services = useContext(StudyServicesContext);
  const serviceCall = services?.call;
  const runContentSearch = useMemo(
    () => searchContent || (typeof serviceCall === 'function' ? (args) => serviceCall('search.content', args) : null),
    [searchContent, serviceCall],
  );
  const [query, setQuery] = useState(initialQuery);
  // The index opens with its first area; the others are one click (or one Tab and Enter) away.
  const [openAreas, setOpenAreas] = useState(() => new Set([FINDER_AREAS[0].id]));
  const [recentIds, setRecentIds] = useState(() => (Array.isArray(initialRecentIds) ? initialRecentIds : readRecentFinderIds()));
  const [contentHits, setContentHits] = useState(() => (initialContentHits ? toFinderContentEntries(initialContentHits) : []));
  const [selected, setSelected] = useState(null);
  const [recipeToggles, setRecipeToggles] = useState(() => new Map());
  const input = useRef(null), byKey = useRef(false), searchSeq = useRef(0);
  const base = useId(), listId = `${base}-list`;
  const hasQuery = query.trim().length >= 1;
  const browsing = !hasQuery;
  const eligibleForContent = shouldSearchContent(query);
  const marked = useMemo(() => withAvailability(entries, data), [entries, data]);
  const found = useMemo(() => searchFeatures(marked, query, { translate: ui }), [marked, query]);
  const libraryHits = useMemo(() => (hasQuery ? searchLibraryHits(data, query) : []), [hasQuery, data, query]);
  const shownContentHits = eligibleForContent ? contentHits : [];
  const recentEntries = useMemo(() => (browsing ? recentFinderEntries(marked, recentIds) : []), [browsing, marked, recentIds]);
  const showRecipes = browsing && studyChainRecipes(data?.settings?.practice);
  const recipes = useMemo(() => (showRecipes ? buildChainRecipes(marked, data) : []), [showRecipes, marked, data]);
  const isRecipeOpen = (recipe) => (recipeToggles.has(recipe.id) ? recipeToggles.get(recipe.id) : Boolean(recipe.recommended));
  const toggleRecipe = (id, open) => setRecipeToggles((current) => {
    if (current.get(id) === open) return current;
    const next = new Map(current);
    next.set(id, open);
    return next;
  });
  const groups = useMemo(() => (browsing ? groupByArea(found, FINDER_AREAS) : []), [browsing, found]);

  useEffect(() => {
    const seq = ++searchSeq.current;
    if (!eligibleForContent || !runContentSearch) {
      if (!initialContentHits) setContentHits([]);
      return undefined;
    }
    const trimmed = query.trim();
    const timer = setTimeout(() => {
      Promise.resolve(runContentSearch({ query: trimmed, limit: 24 }))
        .then((res) => {
          if (searchSeq.current !== seq) return;
          setContentHits(toFinderContentEntries(res));
        })
        .catch(() => {
          if (searchSeq.current === seq) setContentHits([]);
        });
    }, CONTENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, eligibleForContent, runContentSearch, initialContentHits]);

  // What the arrow keys can reach: the rows that are drawn open.
  const visibleSlots = browsing
    ? [
      ...recentEntries.map((entry) => ({ slotKey: `recent:${entry.id}`, entry })),
      ...recipes.filter(isRecipeOpen).flatMap((recipe) => recipe.steps.map((entry) => ({ slotKey: `recipe:${recipe.id}:${entry.id}`, entry }))),
      ...groups.filter((group) => openAreas.has(group.area.id)).flatMap((group) => group.entries.map((entry) => ({ slotKey: entry.id, entry }))),
    ]
    : [
      ...found.map((entry) => ({ slotKey: entry.id, entry })),
      ...libraryHits.map((entry) => ({ slotKey: entry.id, entry })),
      ...shownContentHits.map((entry) => ({ slotKey: entry.id, entry })),
    ];
  const ids = visibleSlots.map((slot) => slot.slotKey);
  const active = ids.includes(selected) ? selected : ids[0] ?? null;
  const domId = (slotKey) => `${base}-${String(slotKey).replace(/\s+/g, '-')}`;
  const activeDomId = active ? domId(active) : undefined;

  // A key press that moves the selection scrolls it into view; a click does not move the list under the pointer.
  useEffect(() => {
    if (!byKey.current || !activeDomId) return;
    byKey.current = false;
    document.getElementById(activeDomId)?.scrollIntoView({ block: 'nearest' });
  }, [activeDomId]);

  const go = (entry) => {
    if (!entry || entry.kind === 'term' || entry.unavailable) return;
    if (entry.kind !== 'library' && entry.kind !== 'content') setRecentIds(recordRecentFinderId(entry.id));
    onGo(entry);
  };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      byKey.current = true;
      setSelected(moveActive(ids, active, event.key));
    } else if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      go(visibleSlots.find((slot) => slot.slotKey === active)?.entry);
    }
  };
  const toggle = (area, open) => setOpenAreas((current) => {
    if (current.has(area) === open) return current;
    const next = new Set(current);
    if (open) next.add(area); else next.delete(area);
    return next;
  });
  const clearRecent = () => {
    setRecentIds(clearRecentFinderIds());
    input.current?.focus();
  };
  const row = (entry, slotKey = entry.id) => (
    <Row key={slotKey} entry={entry} domId={domId(slotKey)} active={slotKey === active} query={query} onSelect={() => setSelected(slotKey)} onGo={go} />
  );
  const totalMatches = found.length + libraryHits.length + shownContentHits.length;
  return (
    <Dialog title={ui('找功能')} description={ui('搜一个功能在哪；什么都不输入，就是完整的索引。')} size="md" className="finder-sheet" bodyClassName="finder-body" onClose={onClose} initialFocus={input}>
      <TextInput ref={input} className="finder-input" role="combobox" aria-label={ui('搜索功能')} aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={activeDomId} autoComplete="off" spellCheck={false} placeholder={ui('输入功能名，例如 翻译、花费上限')}
        value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
      <div id={listId} className="finder-results" role="listbox" aria-label={ui('功能')} data-mode={browsing ? 'index' : 'search'}>
        {browsing
          ? <>
            {recentEntries.length > 0 && (
              <section className="finder-recent" aria-label={ui('最近去过')}>
                <div className="finder-recent__head">
                  <span className="finder-recent__label">{ui('最近去过')}</span>
                  <Button size="sm" variant="link" onClick={clearRecent}>{ui('清除记录')}</Button>
                </div>
                <div role="group" aria-label={ui('最近去过')}>{recentEntries.map((entry) => row(entry, `recent:${entry.id}`))}</div>
              </section>
            )}
            {recipes.length > 0 && (
              <section className="finder-recipes" data-finder-recipes="" aria-label={ui('学习场景向导')}>
                <div className="finder-recipes__head">
                  <span className="finder-recipes__label">{ui('学习场景向导')}</span>
                </div>
                {recipes.map((recipe) => (
                  <details key={recipe.id} className="finder-group finder-recipe" data-recipe={recipe.id} open={isRecipeOpen(recipe)} onToggle={(event) => toggleRecipe(recipe.id, event.currentTarget.open)}>
                    <summary className="finder-group__summary">
                      <span className="finder-group__label">{ui(recipe.title)}</span>
                      {recipe.reason && <Badge size="sm">{ui(recipe.reason)}</Badge>}
                      <span className="finder-group__count">{uiFormat('{0} 步', [recipe.steps.length])}</span>
                    </summary>
                    <div role="group" aria-label={ui(recipe.title)}>
                      {recipe.steps.map((entry) => row(entry, `recipe:${recipe.id}:${entry.id}`))}
                    </div>
                  </details>
                ))}
              </section>
            )}
            {groups.map(({ area, entries: inArea }) => (
              <details key={area.id} className="finder-group" data-area={area.id} open={openAreas.has(area.id)} onToggle={(event) => toggle(area.id, event.currentTarget.open)}>
                <summary className="finder-group__summary"><span className="finder-group__label">{ui(area.label)}</span><span className="finder-group__count">{inArea.length}</span></summary>
                <div role="group" aria-label={ui(area.label)}>{inArea.map((entry) => row(entry))}</div>
              </details>
            ))}
          </>
          : <>
            {found.map((entry) => row(entry))}
            {libraryHits.length > 0 && (
              <section className="finder-library" aria-label={ui('学习库内容')}>
                <div className="finder-library__head">
                  <span className="finder-library__label">{ui('学习库内容')}</span>
                </div>
                <div role="group" aria-label={ui('学习库内容')}>{libraryHits.map((entry) => row(entry))}</div>
              </section>
            )}
            {shownContentHits.length > 0 && (
              <section className="finder-content" aria-label={ui('全文内容')}>
                <div className="finder-content__head">
                  <span className="finder-content__label">{ui('全文内容')}</span>
                </div>
                <div role="group" aria-label={ui('全文内容')}>{shownContentHits.map((entry) => row(entry))}</div>
              </section>
            )}
          </>}
        {!browsing && totalMatches === 0 && (
          <div className="finder-empty">
            <p>{uiFormat('没找到『{0}』。试试换个说法，或打开功能导览。', [query.trim()])}</p>
            <Button iconEnd="arrow-right" size="sm" variant="secondary" onClick={onTour}>{ui('打开功能导览')}</Button>
          </div>
        )}
      </div>
      <p className="sh-visually-hidden" role="status" aria-live="polite">{!browsing && totalMatches > 0 ? uiFormat('找到 {0} 项', [totalMatches]) : ''}</p>
    </Dialog>
  );
}
