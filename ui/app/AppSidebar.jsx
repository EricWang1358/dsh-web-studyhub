import React from 'react';
import { ui } from '../i18n.js';
import { Button, Dialog, Icon } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './app-shell.css';
import drawerCss from './nav-drawer.css';
import { useApp } from './app-context.js';
import { useNavAlert } from './use-nav-alert.js';
import SidebarNav from './SidebarNav.jsx';
import SidebarFooter from './SidebarFooter.jsx';

/* The sidebar, in one of two forms (ui/app/use-app-shell.js):
   - docked: the column on the left, with a button that puts it away;
   - a drawer (#657): when the learner put it away, and whenever the workspace is narrow (a DSH panel is often 420 px wide). The top bar's
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

export default function AppSidebar() {
  useInjectCss(css, 'study-app-shell');
  useInjectCss(drawerCss, 'study-nav-drawer');
  const { shell } = useApp();
  const { alert, reason, tasks } = useNavAlert();
  const body = (<><SidebarNav alert={alert} reason={reason} tasks={tasks} /><SidebarFooter /></>);
  if (!shell.navDrawer) {
    return <aside className="sidebar"><Brand onCollapse={() => shell.setSidebarCollapsed(true)} />{body}</aside>;
  }
  if (!shell.navOpen) return null;
  const close = () => shell.setNavOpen(false);
  // A row that leads somewhere closes the drawer once it has done its work; a fold (更多, 帮助) and the glossary keep it open.
  const leave = (event) => { if (event.target.closest?.('button.nav:not([aria-expanded]):not([data-keep-open])')) close(); };
  return (
    <Dialog className="nav-drawer" headerClassName="nav-drawer__header" titleClassName="nav-drawer__title" bodyClassName="nav-drawer__body" contentClassName="nav-drawer__content" size="full" title={ui('导航')} closeLabel={ui('关闭导航')} onClose={close}>
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
}
