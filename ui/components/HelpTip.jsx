import React from 'react';
import { ui } from '../i18n.js';
import css from './help-tip.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';
import Tooltip from './Tooltip.jsx';

/**
 * A small quiet 「?」 that holds an explanation instead of printing it: the words show on hover, on keyboard focus (a click focuses it) and on a long press,
 * in a layered Tooltip the pointer may rest on (to read a longer text). Put it beside the thing it explains, where a muted paragraph used to stand.
 * children: the explanation (a sentence, or a node); label: the button's accessible name (「说明」 by default); placement: as Tooltip.
 */
export function HelpTip({ children, label, placement = 'bottom-start', className, ...rest }) {
  useComponentCss(css, 'study-help-tip');
  if (!children) return null;
  return (
    <Tooltip layer interactive placement={placement} content={children} anchorClassName="sh-help-tip__anchor">
      <button type="button" className={cx('sh-help-tip', className)} aria-label={label || ui('说明')} {...rest}><Icon name="help" size={14} /></button>
    </Tooltip>
  );
}

export default HelpTip;
