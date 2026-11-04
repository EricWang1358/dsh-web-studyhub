import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { PAGES } from '../pages.js';
import { NavItem, NavFold } from '../SideNav.jsx';
import { GLOSSARY } from '../mastery-terms.js';
import FinderNavItem from '../finder/FinderNavItem.jsx';
import UpdateCenter from '../UpdateCenter.jsx';
import { Icon } from '../components/index.js';
import { useApp } from './app-context.js';

/* The foot of the sidebar (#656): three controls. 找功能 (look a feature up), 帮助 (opens 功能导览, 快捷键 and 名词解释 below it) and 设置. The
   interface language and the appearance are chosen in 设置 › 界面 only: they are set once or now and then, and a second switch in the sidebar
   made the same choice live in two places. The update notice joins them only while there is an update. */

/** The one line the glossary entry shows on hover/focus: every word the interface assumes, with what it means (ui/mastery-terms.js). */
const glossaryText = () => [ui('界面里这些词的意思：'), ...Object.values(GLOSSARY).map((term) => `${ui(term.label)} — ${ui(term.hint)}`)].join('\n');

export default function SidebarFooter() {
  const { nav, session, tour, finder } = useApp();
  const [help, setHelp] = useState(false);
  const resume = tour.tourResume;
  return (
    <div className="sidebar-bottom">
      <UpdateCenter />
      <FinderNavItem disabled={!!tour.tourStep} onOpen={finder.openFinder} />
      <NavFold id="help" glyph="help" label={ui('帮助')} purpose={ui('功能导览、快捷键和名词解释')} open={help} onToggle={setHelp}
        data-tour="nav-help" data-usage="nav.help">
        <NavItem className="tour-nav" data-tour="tour-reopen" data-usage="nav.tour" icon={<Icon name="nav-tour" />} label={ui('功能导览')} disabled={tour.sampleBusy}
          aria-disabled={!!tour.tourStep || undefined} hint={resume ? `${resume.index + 1}/${resume.total}` : undefined}
          purpose={[ui('功能导览：切到每个关键功能，看看怎么用'), resume && uiFormat('继续 {0}/{1}', [resume.index + 1, resume.total])].filter(Boolean).join('\n')}
          onClick={() => { if (!tour.tourStep) tour.startTour(); }} />
        <NavItem className="shortcut-nav" data-tour="nav-shortcuts" data-usage="nav.shortcut" icon={<Icon name="key" />} label={ui('快捷键')}
          purpose={ui('看这一页能用的键；按 ? 也能打开')} hint="?" onClick={() => session.actions.openShortcutHelp()} />
        {/* The glossary is words to read: pressing the row (or moving to it) shows them, in a Tooltip the pointer may enter to scroll. */}
        <NavItem className="glossary-nav" data-tour="nav-glossary" data-keep-open="" icon={<Icon name="book" />} label={ui('名词解释')}
          purpose={glossaryText()} tipInteractive tipPlacement="right-start" onClick={(event) => event.currentTarget.focus()} />
      </NavFold>
      <NavItem glyph="settings" label={ui('设置')} active={nav.navPage === 'settings'} purpose={ui(PAGES.settings.purpose)} data-tour="nav-settings" data-usage="nav.settings"
        onClick={() => nav.navigate('settings', { animate: true, keepTrail: false })} />
    </div>
  );
}
