import React from 'react';
import { ui } from '../i18n.js';
import { Icon } from '../components/index.js';
import { NavItem } from '../SideNav.jsx';
import { useInjectCss } from '../shared.js';
import css from './finder.css';
import { finderShortcutLabel } from './keys.js';

/** 找功能 at the foot of the sidebar, above 帮助: the same row as every other (icon, label, a trailing hint), the shortcut as the hint. It opens
    the sheet (ui/finder/FinderSheet.jsx). In the narrow window's drawer it is the same row, with its label. */
export default function FinderNavItem({ disabled = false, onOpen }) {
  useInjectCss(css, 'study-finder');
  return (
    <NavItem className="finder-nav" data-tour="nav-finder" data-usage="nav.finder" icon={<Icon name="search" />} label={ui('找功能')} disabled={disabled}
      purpose={ui('搜一个功能在哪，选中后直接带你过去')} hint={finderShortcutLabel()} hintClass="nav-count nav-keys" aria-keyshortcuts="Control+K Meta+K" onClick={onOpen} />
  );
}
