import React, { forwardRef } from 'react';
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

export default DisclosureToggle;
