import React from 'react';
import { ui } from '../i18n.js';
import { Button } from './Button.jsx';
import { ADD_SOURCE_ICON, addSourceAction } from './add-source.js';

export { ADD_SOURCE_ICON, addSourceAction };
const VARIANTS = new Set(['primary', 'secondary', 'quiet', 'link']);

/**
 * 添加资料: one look (the upload icon and the words), on every screen. Only `variant` changes with the place it stands in
 * (primary: the one main action of the screen; secondary / quiet: beside others; link: inside a sentence or under a list),
 * and a screen still has one primary at most. Every other prop goes to Button (onClick, lock, size, flush, data-*).
 * `more`: a material is already there and the learner may add another; the same control and icon, the words 再添加资料 (the first-run line and the home desk both say it this way, #1074).
 * The same label and icon as an action spec (EmptyState, a plan) is `addSourceAction` in add-source.js.
 */
export function AddSourceButton({ variant = 'secondary', more = false, ...rest }) {
  return <Button variant={VARIANTS.has(variant) ? variant : 'secondary'} icon={ADD_SOURCE_ICON} {...rest}>{more ? ui('再添加资料') : ui('添加资料')}</Button>;
}
