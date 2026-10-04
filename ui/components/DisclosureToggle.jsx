import React, { forwardRef } from 'react';
import { uiFormat } from '../i18n.js';
import css from './disclosure.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';

/**
 * The fold arrow of a row, group or section: an icon button with the caret
 * icon, named by `label` (say what it opens: "展开 数据结构"), reporting
 * aria-expanded. The caret turns a quarter in CSS, so the glyph is the same
 * on every platform. controls: the id of the region it opens.
 */
export const DisclosureToggle = forwardRef(function DisclosureToggle({ open, onToggle, label, controls, size = 'sm', className, ...rest }, ref) {
  useComponentCss(css, 'study-disclosure');
  return <IconButton ref={ref} icon="caret" size={size} label={label} aria-expanded={!!open} aria-controls={controls}
    className={cx('sh-disclosure-toggle', className)} onClick={() => onToggle?.(!open)} {...rest} />;
});

/** The toggle's accessible name: what it opens or closes ("展开 数据结构"). */
export const foldLabel = (open, name) => (open ? uiFormat('收起 {0}', [name]) : uiFormat('展开 {0}', [name]));

export default DisclosureToggle;
