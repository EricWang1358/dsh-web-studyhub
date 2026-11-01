import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Icon, IconButton, TextInput, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { levelsText } from '../outline/words.js';
import { codeOf } from '../../lib/course-book-lookup.js';
import { searchBook, searchIndex, SEARCH_ROWS } from './book-search.js';
import css from './book-toc.css';

/* The review book's live 目录 (docs/review-book.md "The contents"): every heading of the stitched book (lib/course-book-links.js bookIndex), indented by level.
   The heading being read is bold with a 2 px ink line on its left. The code the printed book carries (H7) is not beside the headings: it shows on hover and
   on keyboard focus of a row. A click opens its chapter and goes to the heading. At wide widths the 目录 is a frameless column beside the text that sticks
   and scrolls on its own; on a narrow page (ui/use-narrow.js) it slides over the text from the left with a scrim, and Esc, the scrim or a row closes it.
   On top, 在书里找 (ui/book/book-search.js): typing lists the points that have the words in place of the headings; a row goes to the point with the words marked.
   A big book's 目录 shows its chapters with only the one being read open (measured, #489: scripts/qa/big-book.mjs, at 400 points the rows were the page's longest task and hundreds of tab stops). */

/** The most rows a 目录 draws whole; a book with more folds its chapters. */
export const TOC_FOLD_ABOVE = 120;

/** entries: [{ id, level, title, chapter }] (the book's own title left out); here: the heading id being read; onGo(id); opened: the chapters open when the 目录 folds (a Set; none: it does not),
    parents: the chapters with something to open, onToggle(chapter); hidden: the chapter folded over the heading being read, which takes its mark. */
export const BookTocList = memo(function BookTocList({ entries, here, onGo, opened, parents, onToggle, hidden = null }) {
  // One tab stop for the list (hundreds of rows otherwise): the row last moved to, else the one being read, else the first. The arrows, Home and End walk the rows; a chapter's caret stays its own stop.
  const [moved, setMoved] = useState(null), marked = hidden ?? here;
  const stop = entries.some(entry => entry.id === moved) ? moved : entries.some(entry => entry.id === marked) ? marked : entries[0]?.id;
  const walk = event => {
    const rows = [...event.currentTarget.querySelectorAll('.book-toc__go')], at = rows.indexOf(event.target.closest('.book-toc__go'));
    const next = at < 0 ? -1 : { ArrowDown: Math.min(at + 1, rows.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: rows.length - 1 }[event.key];
    if (next === undefined || next < 0) return;
    event.preventDefault();
    setMoved(entries[next]?.id ?? null);
    rows[next].focus();
  };
  return (
    <ol className="book-toc__list" onKeyDown={walk}>
      {entries.map(entry => (
        <li key={entry.id} className="book-toc__item" data-level={Math.min(4, entry.level)}>
          {parents?.has(entry.id) && <IconButton size="sm" className="book-toc__fold" aria-expanded={opened.has(entry.id)} data-open={opened.has(entry.id) ? '' : undefined}
            icon={<Icon name="caret" size={14} />} label={opened.has(entry.id) ? ui('收起这一章') : ui('展开这一章')} onClick={() => onToggle(entry.id)} />}
          <Tooltip layer placement="right-start" group="book-toc" content={uiFormat('编号 {0}', [codeOf(entry.id)])} anchorClassName="book-toc__anchor">
            <Button variant="quiet" size="sm" wrap className="book-toc__go" tabIndex={entry.id === stop ? 0 : -1} aria-current={entry.id === marked ? 'location' : undefined} onClick={() => onGo(entry.id)}>
              {entry.title}
            </Button>
          </Tooltip>
        </li>
      ))}
    </ol>
  );
});

/** What the search found: how many points, then a row per point with the first place the words are. */
function FoundList({ results, query, onFound }) {
  const { total, rows } = results;
  return <>
    <p className="book-toc__found" role="status">{total ? uiFormat('{0} 个知识点里有', [total]) : ui('没有找到')}{total > rows.length ? ` · ${uiFormat('这里列出前 {0} 个', [SEARCH_ROWS])}` : ''}</p>
    <ol className="book-toc__list">
      {rows.map(row => (
        <li key={row.hid} className="book-toc__item">
          <Button variant="quiet" size="sm" wrap className="book-toc__go book-toc__hit" data-book-hit={row.hid} onClick={() => onFound(row, query)}>
            <span className="book-toc__hit-title">{[row.number, row.title].filter(Boolean).join(' ')}{row.count > 1 ? ` · ${uiFormat('{0} 处', [row.count])}` : ''}</span>
            {row.match && <span className="book-toc__hit-text">{row.before}<mark>{row.match}</mark>{row.after}</span>}
          </Button>
        </li>
      ))}
    </ol>
  </>;
}

/** The 目录 itself: the book's coverage line on top (quiet, explained on hover), 在书里找, then the list. narrow: it is the slide-over (onClose closes it, the focus goes
    back to `returnRef`); coverage: course.book.open's `coverage` or null; book, query, onQuery(text), onFound(row, query): the search (the page keeps what is typed while a narrow 目录 is closed). */
export default function BookToc({ entries, here, onGo, narrow, onClose, returnRef, coverage, book, query = '', onQuery, onFound }) {
  useInjectCss(css, 'study-book-toc');
  const panel = useRef(null);
  // A row goes there, and closes the slide-over (one handler, so the memoised list is not drawn again for nothing).
  const go = useCallback(id => { onGo(id); if (narrow) onClose(); }, [onGo, narrow, onClose]);
  const found = useCallback((row, words) => { onFound?.(row, words); if (narrow) onClose(); }, [onFound, narrow, onClose]);
  // The index is made once for a book, when the first words are typed; typing stays ahead of the list.
  const typed = useDeferredValue(query), searching = !!typed.trim();
  const index = useMemo(() => (searching ? searchIndex(book) : null), [book, searching]);
  const results = useMemo(() => (index ? searchBook(index, typed) : null), [index, typed]);
  // A big book: chapters, and the one being read open, unless the learner said otherwise.
  const folds = entries.length > TOC_FOLD_ABOVE;
  const hereChapter = useMemo(() => entries.find(entry => entry.id === here)?.chapter ?? null, [entries, here]);
  const [toggled, setToggled] = useState(() => new Map());
  const { shown, opened, parents } = useMemo(() => {
    if (!folds) return { shown: entries, opened: null, parents: null };
    const owners = new Set(entries.filter(entry => entry.level > 2).map(entry => entry.chapter));
    const isOpen = new Set([...owners].filter(chapter => (toggled.has(chapter) ? toggled.get(chapter) : chapter === hereChapter)));
    return { shown: entries.filter(entry => entry.level <= 2 || isOpen.has(entry.chapter)), opened: isOpen, parents: owners };
  }, [entries, folds, toggled, hereChapter]);
  const toggle = useCallback(chapter => setToggled(current => new Map(current).set(chapter, !(current.has(chapter) ? current.get(chapter) : chapter === hereChapter))), [hereChapter]);
  // The slide-over takes the focus (the panel itself, so no row's code pops up; Tab goes to the rows) and gives it back to the 目录 button when it closes; Esc
  // closes it. The row being read is scrolled into the panel's view.
  useEffect(() => {
    if (!narrow) return undefined;
    panel.current?.focus({ preventScroll: true });
    const row = panel.current?.querySelector('[aria-current="location"]');
    if (row) panel.current.scrollTop = row.offsetTop - panel.current.clientHeight / 2;
    // A tooltip of a row also hears this Esc (it hides itself); a dialog over the page keeps its own.
    const press = event => { if (event.key === 'Escape' && !event.target?.closest?.('dialog')) { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', press);
    const back = returnRef?.current;
    return () => { document.removeEventListener('keydown', press); if (back?.isConnected) back.focus({ preventScroll: true }); };
  }, [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    {/* The scrim closes it on a press; the keyboard closes it with Esc (the focus is in the panel). */}
    {narrow && <div className="book-toc-scrim" aria-hidden="true" onClick={onClose} />}
    <nav ref={panel} className="book-toc" aria-label={ui('目录')} data-overlay={narrow ? '' : undefined} tabIndex={narrow ? -1 : undefined}>
      {coverage && <Tooltip layer content={ui('按清点出来的资料条目算：用了几份资料、读了几页，几个知识点讲全了，几个概念讲到了')} anchorClassName="book-toc__levels-tip">
        <p className="book-toc__levels" data-book-levels="" tabIndex={0}>{levelsText(coverage)}</p>
      </Tooltip>}
      {onFound && <div className="book-toc__search" role="search">
        <TextInput type="search" className="book-toc__input" value={query} autoComplete="off" spellCheck={false} placeholder={ui('在书里找')} aria-label={ui('在书里找')} onChange={event => onQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); onQuery(''); } }} />
      </div>}
      {results ? <FoundList results={results} query={typed} onFound={found} />
        : <BookTocList entries={shown} here={here} onGo={go} opened={opened} parents={parents} onToggle={toggle} hidden={opened && hereChapter && !opened.has(hereChapter) && hereChapter !== here ? hereChapter : null} />}
    </nav>
  </>;
}
