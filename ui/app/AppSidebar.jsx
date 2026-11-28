import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ui } from '../i18n.js';
import { Button, Dialog, Icon, focusQuietly } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './app-shell.css';
import drawerCss from './nav-drawer.css';
import { useAppSelector } from './app-context.js';
import { useNavAlert } from './use-nav-alert.js';
import { useDrawerFrame } from './use-drawer-frame.js';
import SidebarNav from './SidebarNav.jsx';
import SidebarFooter from './SidebarFooter.jsx';

/* The sidebar, in one of two forms (ui/app/use-app-shell.js):
   - docked: the column on the left, with a button that puts it away;
   - a drawer (#657): when the learner put it away, and whenever the workspace is narrow (a DSH panel is often 420 px wide). It opens inside
     StudyHub's own page (use-drawer-frame.js), never along the edge of the whole DSH window. The top bar's
     menu button (AppTopbar.jsx, data-tour="nav-menu") opens it; it is the shared Dialog, so it holds the focus, closes on Esc, on its close
     button and on the backdrop, and gives the focus back to the menu button. It has every label: there is no row of bare icons.
   Both forms draw the same rows (SidebarNav, SidebarFooter). In the drawer, choosing a page closes it. */

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
  const { alert, reason, tasks } = useNavAlert();
  const returnFocusRef = useRef(true);
  const handoffRef = useRef(false);
  useDrawerFrame(shell.rootRef, shell.navDrawer && shell.navOpen);
  useLayoutEffect(() => {
    if (shell.navOpen) {
      returnFocusRef.current = true;
      handoffRef.current = false;
    }
  }, [shell.navOpen]);
  useEffect(() => {
    if (shell.navOpen || !handoffRef.current) return;
    handoffRef.current = false;
    const root = shell.rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (root.querySelector('dialog[open], [role="dialog"]')
      || (active && active !== document.body && active !== root && active.closest?.('dialog[open], [role="dialog"]'))) return;
    const card = root.querySelector('.review-body .question-card');
    if (card && typeof card.focus === 'function') {
      focusQuietly(card, { preventScroll: true });
      return;
    }
    focusQuietly(root, { preventScroll: true });
  }, [shell.navOpen, shell.rootRef]);
  const body = (<><SidebarNav alert={alert} reason={reason} tasks={tasks} /><SidebarFooter /></>);
  if (!shell.navDrawer) {
    return <aside className="sidebar"><Brand onCollapse={() => shell.setSidebarCollapsed(true)} />{body}</aside>;
  }
  if (!shell.navOpen) return null;
  const close = () => shell.setNavOpen(false);
  // A row that leads somewhere closes the drawer once it has done its work; a fold (更多, 帮助) and the glossary keep it open.
  // Leaving via a nav item hands focus to the destination page instead of back to the topbar menu toggle (#1679);
  // Esc, backdrop and the close button still return focus to the menu toggle.
  const leave = (event) => {
    if (!event.target.closest?.('button.nav:not([aria-expanded]):not([data-keep-open])')) return;
    returnFocusRef.current = false;
    handoffRef.current = true;
    close();
  };
  return (
    <Dialog className="nav-drawer" headerClassName="nav-drawer__header" titleClassName="nav-drawer__title" bodyClassName="nav-drawer__body" contentClassName="nav-drawer__content" size="full" title={ui('导航')} closeLabel={ui('关闭导航')} returnFocus={returnFocusRef} onClose={close}>
      <div className="sidebar is-drawer" onClick={leave}>
        {body}
        {!shell.narrowWindow && (
          <Button variant="quiet" size="sm" icon="panel" className="nav-dock" data-usage="nav.collapse" onClick={() => { shell.setSidebarCollapsed(false); close(); }}>
            {ui('把侧栏固定在左边')}
          </Button>
        )}
      </div>
    </Dialog>
  );
});

export default AppSidebar;
