import { ui } from '../i18n.js';

/** The one icon of 添加资料 (#1074): it imports a file, so it is the upload glyph on every screen. Plain module: a data module (the home plan) can use it without React. */
export const ADD_SOURCE_ICON = 'upload';

/** 添加资料 as an action spec ({ label, icon, onClick }, for an EmptyState or a plan): the label and the icon are decided here, so no screen draws its own. */
export const addSourceAction = (onClick, extra = {}) => ({ label: ui('添加资料'), icon: ADD_SOURCE_ICON, onClick, ...extra });
