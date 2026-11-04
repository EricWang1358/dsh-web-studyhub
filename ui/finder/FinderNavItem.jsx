import React from 'react';
import { ui } from '../i18n.js';
import { Icon } from '../components/index.js';
import { NavItem } from '../SideNav.jsx';
import { useInjectCss } from '../shared.js';
import css from './finder.css';
import { finderShortcutLabel } from './keys.js';

/** 找功能 in the sidebar's footer, above 功能导览: the same row as every other (icon, label, a trailing hint), the shortcut as the hint, and in the 62 px rail an
    icon whose Tooltip names it. It opens the sheet (ui/finder/FinderSheet.jsx). */
export default function FinderNavItem({ narrow = false, disabled = false, onOpen }) {
  useInjectCss(css, 'study-finder');
  return (
    <NavItem className="finder-nav" data-tour="nav-finder" data-usage="nav.finder" icon={<Icon name="search" />} label={ui('找功能')} narrow={narrow} disabled={disabled}
      purpose={ui('搜一个功能在哪，选中后直接带你过去')} hint={finderShortcutLabel()} hintClass="nav-count nav-keys" aria-keyshortcuts="Control+K Meta+K" onClick={onOpen} />
  );
}
