import React, { useLayoutEffect, useRef, useState } from 'react';
import { ui, uiFormat, setUiLanguage } from '../i18n.js';
import { PAGES } from '../pages.js';
import { pageAvailable } from '../capabilities.js';
import { countDocuments } from '../../lib/source-groups.js';
import { NavItem, ResumeNavItem, CoachNavItem, NavGroup } from '../SideNav.jsx';
import { NAV_DEFAULTS, NAV_GROUPS, groupIsOpen, useNavGroups, useNavOrder } from '../nav-order.js';
import { APPEARANCE_LABELS, THEME_CYCLE } from '../appearance-prefs.js';
import LanguageSwitch from '../LanguageSwitch.jsx';
import UpdateCenter from '../UpdateCenter.jsx';
import { Button, Icon } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './app-shell.css';
import { useApp } from './app-context.js';

/* The sidebar cycles auto, dark, light only; OLED black and paper are chosen in 设置 › 界面 (and show on the toggle with their base mode's glyph). */
const THEMES = THEME_CYCLE.map((id) => [id, APPEARANCE_LABELS.theme[id]]);

function ThemeCycle() {
  const { shell } = useApp();
  const { theme, resolvedTheme, setTheme } = shell;
  const at = Math.max(0, THEMES.findIndex(([id]) => id === (THEME_CYCLE.includes(theme) ? theme : resolvedTheme)));
  const [current] = THEMES[at], label = APPEARANCE_LABELS.theme[theme], [nextId, nextLabel] = THEMES[(at + 1) % THEMES.length];
  return (
    <NavItem className="theme-cycle" data-usage="nav.theme" glyph={current} label={uiFormat('外观 · {0}', [ui(label)])}
      title={uiFormat('主题：{0}（点击切换为{1}）', [ui(label), ui(nextLabel)])}
      aria-label={uiFormat('主题：{0}，切换为{1}', [ui(label), ui(nextLabel)])} onClick={() => setTheme(nextId)} />
  );
}

/** Where a nav page's "go there" press leads: the old page lifts away, the new one settles in, the context trail starts afresh. */
const gotoPage = (nav, id) => nav.navigate(id, { animate: true, keepTrail: false, enter: 'user' });

export default function AppSidebar() {
  useInjectCss(css, 'study-app-shell');
  const { data, language, host, core, shell, nav, session, intents, tour, board } = useApp();
  const { busy } = core;
  const { sidebarNarrow } = shell;
  const { navPage, pageTarget, page } = nav;
  const navRef = useRef(null), [navMark, setNavMark] = useState(null);
  const navOrder = useNavOrder(NAV_DEFAULTS, navRef);
  const navGroups = useNavGroups();
  const lastRun = data?.lastRun && page === 'review' && session.run?.id === data.lastRun.id
    ? { ...data.lastRun, index: session.run.index, total: session.run.total } : data?.lastRun;
  /* One highlight glides to the active nav item instead of each item switching its own background, so a page change reads as movement. */
  useLayoutEffect(() => {
    const element = navRef.current;
    if (!element) return undefined;
    const measure = () => {
      const active = element.querySelector('.nav.active');
      setNavMark((mark) => {
        const next = active ? { top: active.offsetTop, height: active.offsetHeight } : null;
        return mark?.top === next?.top && mark?.height === next?.height ? mark : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [page, pageTarget, sidebarNarrow, !!data, data?.lastRun?.id, data?.lastRun?.index, navOrder.order, navGroups.folded]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLabel = sidebarNarrow ? ui('展开侧边栏') : ui('收起侧边栏');
  const announced = navOrder.announce && PAGES[navOrder.announce.id];
  return (
    <aside className={sidebarNarrow ? 'sidebar is-narrow' : 'sidebar'}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><Icon name="brand" size={30} /></span>
        <div>{ui('StudyHub')}<small>{ui('自己的资料，扎实地学')}</small></div>
        <Button variant="quiet" size="sm" className="collapse-toggle" data-usage="nav.collapse" aria-label={toggleLabel} aria-expanded={!sidebarNarrow}
          title={toggleLabel} onClick={() => shell.setSidebarCollapsed((value) => !value)}>
          {sidebarNarrow ? '»' : '«'}
        </Button>
      </div>
      <nav ref={navRef} className={'side-nav' + (navOrder.lifted ? ' is-reordering' : '')} data-tour="nav">
        {navMark && <span className="nav-mark" aria-hidden="true" style={{ transform: `translateY(${navMark.top}px)`, height: navMark.height }} />}
        {NAV_GROUPS.map((group) => {
          const ids = navOrder.order[group.id].filter((id) => pageAvailable(data, id));
          // A group whose pages are all switched off in the host is not drawn; the daily one always is (it holds 回到题目).
          if (!ids.length && group.id !== 'daily') return null;
          return (
            <NavGroup key={group.id} id={group.id} label={group.label} hint={group.hint} collapsible={group.collapsible}
              open={groupIsOpen(group.id, navGroups.folded, navPage)} onToggle={() => navGroups.toggle(group.id)}>
              {group.id === 'daily' && (
                <ResumeNavItem lastRun={lastRun} hasDecks={!!data?.decks.length} ready={!!data} active={navPage === 'review'}
                  disabled={!data || busy || !pageAvailable(data, 'review')} onClick={intents.resumeOrStart} />
              )}
              {group.id === 'daily' && data?.coach?.ready > 0 && pageAvailable(data, 'review') && (
                <CoachNavItem ready={data.coach.ready} disabled={busy} onClick={session.onCoachPractice} />
              )}
              {ids.map((id) => {
                const label = ui(PAGES[id].label);
                const due = id === 'board' && board.due.overdue + board.due.today > 0;
                return (
                  <NavItem key={id} {...navOrder.bind(id)} data-tour={`nav-${id}`} data-usage={`nav.${id}`}
                    className={navOrder.lifted === id ? 'is-dragging' : ''} upkeep={group.id === 'setup'} active={navPage === id}
                    glyph={PAGES[id].glyph} label={label} title={`${label}\n${ui('长按并拖动可调整顺序（键盘：Alt+↑/↓）')}`}
                    onClick={() => gotoPage(nav, id)} disabled={!data && id !== 'board'}
                    hint={id === 'board' ? board.count : id === 'sources' && data ? countDocuments(data.sources) : undefined}
                    hintClass={due ? 'nav-count is-due' : 'nav-count'}
                    hintTitle={due ? uiFormat('{0} 项已逾期 · {1} 项今天截止', [board.due.overdue, board.due.today]) : undefined} />
                );
              })}
            </NavGroup>
          );
        })}
        {navOrder.customized && !sidebarNarrow && <Button variant="link" size="sm" className="nav-reset" onClick={navOrder.reset}>{ui('恢复默认顺序')}</Button>}
        <span className="sh-visually-hidden" role="status" aria-live="polite">
          {announced && uiFormat('{0} 已移到第 {1} 位，共 {2} 项', [ui(announced.label), navOrder.announce.position, navOrder.announce.count])}
        </span>
      </nav>
      <div className="sidebar-bottom">
        <LanguageSwitch language={language} narrow={sidebarNarrow} onChange={setUiLanguage} />
        {data && (
          <NavItem className="tour-nav" data-tour="tour-reopen" data-usage="nav.tour" icon={<Icon name="nav-tour" />} label={ui('功能导览')} disabled={tour.sampleBusy}
            aria-disabled={!!tour.tourStep || undefined} hint={tour.tourResume ? `${tour.tourResume.index + 1}/${tour.tourResume.total}` : undefined}
            title={[ui('功能导览：切到每个关键功能，看看怎么用'), tour.tourResume && uiFormat('继续 {0}/{1}', [tour.tourResume.index + 1, tour.tourResume.total])].filter(Boolean).join('\n')}
            onClick={() => { if (!tour.tourStep) tour.startTour(); }} />
        )}
        <div className="local-status"><span />{ui('本地学习工作区')}</div>
        {/* Theme: one cycling toggle. `auto` is dark; light is explicit opt-in. */}
        <ThemeCycle />
        <UpdateCenter call={core.call} host={host} compact={sidebarNarrow} />
        <NavItem glyph="settings" label={ui('设置')} active={navPage === 'settings'} title={ui('设置')} data-tour="nav-settings" data-usage="nav.settings"
          onClick={() => nav.navigate('settings', { animate: true, keepTrail: false })} />
      </div>
    </aside>
  );
}
