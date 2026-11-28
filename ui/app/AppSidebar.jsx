import React, { useEffect, useRef } from 'react';
import { ui } from '../i18n.js';
import { Button, Dialog, Icon, focusQuietly } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './app-shell.css';
import drawerCss from './nav-drawer.css';
import { useAppSelector } from './app-context.js';
import { useStudyBusy } from '../study-context.jsx';
import { useNavAlert } from './use-nav-alert.js';
import { useDrawerFrame } from './use-drawer-frame.js';
import SidebarNav from './SidebarNav.jsx';
import SidebarFooter from './SidebarFooter.jsx';

/* The sidebar, in one of two forms (ui/app/use-app-shell.js):
   - docked: the column on the left, with a button that puts it away;
   - a drawer (#657): when the learner put it away, and whenever the workspace is narrow (a DSH panel is often 420 px wide). It opens inside
     StudyHub's own page (use-drawer-frame.js), never along the edge of the whole DSH window. The top bar's
     menu button (AppTopbar.jsx, data-tour="nav-menu") opens it; it is the shared Dialog, so it holds the focus, closes on Esc, on its close
     button and on the backdrop, and gives the focus back to the menu button when dismissed. When a nav item closes the drawer to go to a
     page (#1679), focus is handed to the destination page (the question card on Review, else <main>) rather than back to the menu button.
     It has every label: there is no row of bare icons.
   Both forms draw the same rows (SidebarNav, SidebarFooter). In the drawer, choosing a page closes it. */

/** Hand focus to the destination page after leaving the navigation drawer (the question card on Review, else <main>),
 *  without stealing focus from a dialog/sheet that opened instead or an interactive control already focused. */
export function focusDrawerDestination(root, { page } = {}) {
  if (!root || typeof document === 'undefined') return null;
  if (root.querySelector?.('dialog[open], [role="dialog"]')) return null;
  const active = document.activeElement;
  const main = root.querySelector?.(':scope > main') || root.querySelector?.('main');
  if (active && active !== document.body && active !== root && active !== main
    && !active.classList?.contains('nav-menu-toggle') && root.contains(active)) {
    return active;
  }
  const target = (page === 'review' && root.querySelector?.('.question-card')) || main || root;
  if (!target || typeof target.focus !== 'function') return null;
  focusQuietly(target, { preventScroll: true });
  return target;
}

function Brand({ onCollapse }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true"><Icon name="brand" size={30} /></span>
      <div>{ui('StudyHub')}<small>{ui('每道题都点得回原页')}</small></div>
      {onCollapse && (
        <Button variant="quiet" size="sm" className="collapse-toggle" data-tour="nav-collapse" data-usage="nav.collapse" aria-label={ui('收起侧边栏')}
          title={ui('收起侧边栏')} onClick={onCollapse}>
          <Icon name="chevron-left" size={14} />
        </Button>
      )}
    </div>
  );
}

const AppSidebar = React.memo(function AppSidebar() {
  useInjectCss(css, 'study-app-shell');
  useInjectCss(drawerCss, 'study-nav-drawer');
  const shell = useAppSelector((s) => s.shell);
  const page = useAppSelector((s) => s.nav?.page);
  const pageTarget = useAppSelector((s) => s.nav?.pageTarget);
  const runKey = useAppSelector((s) => (s.session?.run && !s.session.run.complete
    ? `${s.session.run.id}:${s.session.run.index}:${s.session.run.card?.id || ''}` : ''));
  const tourStep = useAppSelector((s) => s.tour?.tourStep);
  const modalOpen = useAppSelector((s) => Boolean(s.lib?.modal));
  const busy = useStudyBusy();
  const { alert, reason, tasks } = useNavAlert();
  useDrawerFrame(shell.rootRef, shell.navDrawer && shell.navOpen);
  const restoreFocusRef = useRef(true);
  const handoffRef = useRef(null);
  useEffect(() => {
    if (shell.navDrawer && shell.navOpen) {
      restoreFocusRef.current = true;
      handoffRef.current = null;
    }
  }, [shell.navDrawer, shell.navOpen]);
  useEffect(() => {
    const handoff = handoffRef.current;
    if (!handoff || shell.navOpen) return;
    if (handoff.openedTool || tourStep || modalOpen) {
      handoffRef.current = null;
      return;
    }
    if (pageTarget) return;
    const root = shell.rootRef?.current;
    if (root?.querySelector?.('dialog[open], [role="dialog"]')) {
      handoffRef.current = null;
      return;
    }
    if (handoff.expectReview) {
      if (page === 'review' && root?.querySelector?.('.question-card')) {
        focusDrawerDestination(root, { page });
        handoffRef.current = null;
        return;
      }
      if (page !== handoff.fromPage) {
        focusDrawerDestination(root, { page });
        handoffRef.current = null;
        return;
      }
      if (busy) return;
      focusDrawerDestination(root, { page });
      handoffRef.current = null;
      return;
    }
    if (handoff.expectPage && handoff.expectPage !== handoff.fromPage && page === handoff.fromPage && busy) return;
    focusDrawerDestination(root, { page });
    handoffRef.current = null;
  }, [shell.navOpen, shell.rootRef, page, pageTarget, runKey, busy, tourStep, modalOpen]);
  const body = (<><SidebarNav alert={alert} reason={reason} tasks={tasks} /><SidebarFooter /></>);
  if (!shell.navDrawer) {
    return <aside className="sidebar"><Brand onCollapse={() => shell.setSidebarCollapsed(true)} />{body}</aside>;
  }
  if (!shell.navOpen) return null;
  const dismiss = () => {
    restoreFocusRef.current = true;
    handoffRef.current = null;
    shell.setNavOpen(false);
  };
  // A row that leads somewhere closes the drawer once it has done its work; a fold (更多, 帮助) and the glossary keep it open.
  const leave = (event) => {
    const button = event.target.closest?.('button.nav:not([aria-expanded]):not([data-keep-open])');
    if (!button) return;
    const usage = button.dataset.usage || '';
    restoreFocusRef.current = false;
    handoffRef.current = {
      fromPage: page,
      expectReview: usage === 'nav.resume' || usage === 'nav.coach',
      expectPage: button.dataset.navId || (button.dataset.tour === 'nav-settings' ? 'settings' : null),
      openedTool: usage === 'nav.finder' || usage === 'nav.shortcut' || usage === 'nav.tour',
    };
    shell.setNavOpen(false);
  };
  return (
    <Dialog className="nav-drawer" headerClassName="nav-drawer__header" titleClassName="nav-drawer__title" bodyClassName="nav-drawer__body" contentClassName="nav-drawer__content" size="full" title={ui('导航')} closeLabel={ui('关闭导航')} returnFocus={() => restoreFocusRef.current} onClose={dismiss}>
      <div className="sidebar is-drawer" onClick={leave}>
        {body}
        {!shell.narrowWindow && (
          <Button variant="quiet" size="sm" icon="panel" className="nav-dock" data-usage="nav.collapse" onClick={() => { restoreFocusRef.current = false; handoffRef.current = null; shell.setSidebarCollapsed(false); shell.setNavOpen(false); }}>
            {ui('把侧栏固定在左边')}
          </Button>
        )}
      </div>
    </Dialog>
  );
});

export default AppSidebar;
