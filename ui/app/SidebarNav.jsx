import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, uiFormat } from '../i18n.js';
import { MAIN_LIMIT, PAGES, sectionLabelOf } from '../pages.js';
import { pageAvailable } from '../capabilities.js';
import { countDocuments } from '../../lib/source-groups.js';
import { NavItem, ResumeNavItem, CoachNavItem, NavGroup, NavFold, resumeProgress } from '../SideNav.jsx';
import { bookEntryPage } from '../book/model.js';
import { NAV_DEFAULTS, NAV_GROUPS, NAV_MORE_KEY, groupOf, moreIsOpen, useNavOrder } from '../nav-order.js';
import { useReorderHint } from '../nav-reorder-hint.js';
import { liteNavOrder, liteShows } from '../lite-view.js';
import { useLiteView } from '../use-lite-view.js';
import { usePersistentState } from '../storage.js';
import { Button } from '../components/index.js';
import { flag } from './use-app-shell.js';
import { useApp } from './app-context.js';
import { useStudyBusy } from '../study-context.jsx';

/* The rows of the sidebar (#654): 回到题目 (and 为你定制 when it has questions ready), the main list, and 「更多」 with the other pages in sections
   by what they are about. Which page sits where comes from ui/pages.js through ui/nav-order.js; nothing here lists pages. 简洁版 (ui/lite-view.js) changes
   only what is drawn: the saved order is the same, and nothing here can change it while it is on. */

const moreCodec = flag('open', 'closed');
/** Where rows cannot be moved (简洁版), the line that says how to move them is never due. */
const NO_REORDER_HINT = Object.freeze({ show: false, tipChange: undefined });

/** What the number on 任务 says: what is running, and what ended since the console was last opened (and how many of those did not finish). */
const taskBadgeTitle = ({ running, unseen, failed }) => [running > 0 ? uiFormat('{0} 个任务正在进行', [running]) : '',
  unseen > 0 ? (failed > 0 ? uiFormat('{0} 个任务有新结果，其中 {1} 个没有完成', [unseen, failed]) : uiFormat('{0} 个任务有新结果', [unseen])) : ''].filter(Boolean).join(' · ');

/** Where a nav page's "go there" press leads: the old page lifts away, the new one settles in, the context trail starts afresh. */
const gotoPage = (nav, id) => nav.navigate(id, { animate: true, keepTrail: false, enter: 'user' });

/** The words the live region says after a move: where the row is now, or why it could not go there. */
function movedText(announce) {
  if (!announce) return '';
  const label = ui(PAGES[announce.id]?.label || '');
  if (announce.refused) return uiFormat('主导航最多放 {0} 项，先把其中一项拖到「更多」', [MAIN_LIMIT]);
  const place = announce.group === 'main' ? ui('主导航') : uiFormat('更多 › {0}', [ui(sectionLabelOf(announce.group) || '')]);
  return uiFormat('{0} 已移到「{1}」第 {2} 位，共 {3} 项', [label, place, announce.position, announce.count]);
}

export default function SidebarNav({ alert, reason, tasks }) {
  const { data, core, shell, nav, session, intents, board } = useApp();
  const busy = useStudyBusy();
  const { notify } = core;
  const { navPage, pageTarget, page } = nav;
  const navRef = useRef(null), [navMark, setNavMark] = useState(null);
  const navOrder = useNavOrder(NAV_DEFAULTS, navRef);
  const { order } = navOrder;
  // The order as drawn: the learner's own, or in 简洁版 a view of it (more pages under 「更多」). Moving rows is off then, so what is drawn is never saved.
  const lite = useLiteView();
  const drawn = useMemo(() => liteNavOrder(order, lite), [order, lite]);
  const canReorder = liteShows(lite, 'nav.reorder');
  /* 「更多」: open when the learner opened it (remembered), and while the page on screen is one of its pages, unless they closed it right there. */
  const [moreOpen, setMoreOpen] = usePersistentState(NAV_MORE_KEY, false, moreCodec);
  const [closedOn, setClosedOn] = useState(null);
  const more = moreIsOpen({ open: moreOpen, activePage: navPage, order: drawn, closedOn });
  const toggleMore = (next) => { setMoreOpen(next); setClosedOn(next ? null : navPage); };
  /* How to reorder is said once, in the first row tooltip the learner opens, not in all of them (ui/nav-reorder-hint.js); a learner who has
     lifted or moved a row has found it. */
  const savedHint = useReorderHint();
  const reorderHint = canReorder ? savedHint : NO_REORDER_HINT;
  const { learned } = savedHint;
  useEffect(() => { if (navOrder.lifted || navOrder.announce) learned(); }, [navOrder.lifted, navOrder.announce, learned]);
  /* A full main list says why on screen too (a drop or Alt+↑ that cannot land would otherwise look like nothing happened); the sentence is the one
     the live region reads. */
  useEffect(() => { if (navOrder.announce?.refused) notify({ text: movedText(navOrder.announce), tone: 'info' }); }, [navOrder.announce, notify]);
  // A row moved into 「更多」 with the keyboard keeps the focus: 「更多」 opens so the row is still on screen.
  useEffect(() => { if (navOrder.announce?.group && navOrder.announce.group !== 'main') setMoreOpen(true); }, [navOrder.announce, setMoreOpen]);
  const lastRun = page === 'review' ? resumeProgress(data?.lastRun, session.run) : data?.lastRun;
  /* One highlight glides to the active nav item instead of each item switching its own background, so a page change reads as movement. A row
     folded away in 「更多」 has no height and no highlight. */
  useLayoutEffect(() => {
    const element = navRef.current;
    if (!element) return undefined;
    const measure = () => {
      // checkVisibility: a row in a closed 「更多」 still has a layout box (a closed <details> only skips painting it).
      const active = [...element.querySelectorAll('.nav[aria-current="page"]')].find((row) => (row.checkVisibility ? row.checkVisibility() : row.offsetHeight > 0));
      setNavMark((mark) => {
        const next = active ? { top: active.offsetTop, height: active.offsetHeight } : null;
        return mark?.top === next?.top && mark?.height === next?.height ? mark : next;
      });
    };
    /* A ResizeObserver reports once for an element it starts to watch, after the browser has laid the page out: the rows are read there, for
       nothing. Reading them here instead made the browser lay out the whole new page in the middle of the commit, on every page change (about
       58 ms of each switch with 300 资料). Where there is no observer the rows are read here, as before. flushSync: the report comes before the
       paint, and the highlight has to be in that same paint (a row that becomes current again must not show one frame without it). */
    if (typeof ResizeObserver !== 'function') { measure(); return undefined; }
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(element);
    return () => observer.disconnect();
  }, [page, pageTarget, busy, !!data, data?.lastRun?.id, data?.lastRun?.index, drawn, more, shell.navDrawer]); // eslint-disable-line react-hooks/exhaustive-deps
  /* 复习全书: the book of the current course when it has been written, else the 总纲 page, which offers to organise the course and write it. */
  const openBookEntry = async () => {
    let target = 'book';
    try { target = bookEntryPage(await core.call('course.book.open', { course: data?.focus?.course ?? null })); } catch { /* the book page shows the failure, with a retry */ }
    gotoPage(nav, target);
  };
  const shown = (group) => drawn[group].filter((id) => pageAvailable(data, id));
  /* The number on 资料. Counting groups every page of every material into its document, so it is done once per snapshot of the library:
     the sidebar renders several times on each page change, and with 300 资料 each count took a few milliseconds of it. */
  const sources = data?.sources;
  const documentCount = useMemo(() => (sources ? countDocuments(sources) : 0), [sources]);
  const row = (id) => {
    const news = id === 'tasks' ? tasks : null;
    return (
      <NavItem key={id} {...(canReorder ? navOrder.bind(id) : { 'data-nav-id': id })} data-tour={`nav-${id}`} data-usage={`nav.${id}`}
        className={navOrder.lifted === id ? 'is-dragging' : ''} active={navPage === id}
        glyph={PAGES[id].glyph} label={ui(PAGES[id].label)} purpose={ui(PAGES[id].purpose)} alert={alert?.id === id ? reason : undefined}
        tail={reorderHint.show ? ui('长按并拖动可调整顺序（键盘：Alt+↑/↓）') : undefined} onTipChange={reorderHint.tipChange}
        onClick={() => (id === 'book' ? openBookEntry() : gotoPage(nav, id))} disabled={!data && id !== 'board'}
        hint={id === 'board' ? board.count : id === 'sources' && data ? documentCount : news?.total > 0 ? news.total : undefined}
        hintClass={news?.running > 0 ? 'nav-count is-live' : 'nav-count'}
        hintTitle={news?.total > 0 ? taskBadgeTitle(news) : undefined} />
    );
  };
  const sections = NAV_GROUPS.filter((group) => group.more && shown(group.id).length);
  // The dot of a row folded away in 「更多」 is carried by 「更多」 itself, with the same reason.
  const alertInMore = alert && alert.id !== 'review' && groupOf(drawn, alert.id) !== 'main' && !more;
  return (
    <nav ref={navRef} className={'side-nav' + (navOrder.lifted ? ' is-reordering' : '')} data-tour="nav" aria-label={ui('导航')}>
      {navMark && <span className="nav-mark" aria-hidden="true" style={{ transform: `translateY(${navMark.top}px)`, height: navMark.height }} />}
      <NavGroup id="main" label="主导航" hidden>
        <ResumeNavItem lastRun={lastRun} hasDecks={!!data?.decks.length} ready={!!data} active={navPage === 'review'} alert={alert?.id === 'review' ? reason : undefined}
          disabled={!data || busy || !pageAvailable(data, 'review')} onClick={intents.resumeOrStart} />
        {liteShows(lite, 'nav.coach') && data?.coach?.ready > 0 && pageAvailable(data, 'review') && <CoachNavItem ready={data.coach.ready} disabled={busy} onClick={session.onCoachPractice} />}
        {shown('main').map(row)}
      </NavGroup>
      {sections.length > 0 && (
        <NavFold id="more" glyph="more" label={ui('更多')} purpose={canReorder ? uiFormat('其余的功能按内容分组收在这里；按住一项拖到上方，就放进主导航（最多 {0} 项，满了先把其中一项拖下来）', [MAIN_LIMIT]) : ui('其余的功能按内容分组收在这里')}
          alert={alertInMore ? reason : undefined} open={more} onToggle={toggleMore} data-tour="nav-more" data-usage="nav.more">
          {sections.map((group) => <NavGroup key={group.id} id={group.id} label={group.label}>{shown(group.id).map(row)}</NavGroup>)}
        </NavFold>
      )}
      {canReorder && navOrder.customized && <Button variant="link" size="sm" className="nav-reset" onClick={navOrder.reset}>{ui('恢复默认顺序')}</Button>}
      <span className="sh-visually-hidden" role="status" aria-live="polite">{movedText(navOrder.announce)}</span>
    </nav>
  );
}
