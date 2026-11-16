import React from 'react';
import { ui } from '../i18n.js';
import { Button } from './Button.jsx';

/** The one icon of 添加资料 (#1074): it imports a file, so it is the upload glyph on every screen. */
export const ADD_SOURCE_ICON = 'upload';
const VARIANTS = new Set(['primary', 'secondary', 'quiet', 'link']);

/**
 * 添加资料: one look (the upload icon and the words), on every screen. Only `variant` changes with the place it stands in
 * (primary: the one main action of the screen; secondary / quiet: beside others; link: inside a sentence or under a list),
 * and a screen still has one primary at most. Every other prop goes to Button (onClick, lock, size, data-*).
 */
export function AddSourceButton({ variant = 'secondary', ...rest }) {
  return <Button variant={VARIANTS.has(variant) ? variant : 'secondary'} icon={ADD_SOURCE_ICON} {...rest}>{ui('添加资料')}</Button>;
}

/** The same as an action spec for EmptyState (`primary={addSourceAction(onClick)}`): the label and icon are decided here too. */
export const addSourceAction = (onClick, extra = {}) => ({ label: ui('添加资料'), icon: ADD_SOURCE_ICON, onClick, ...extra });
