import React from 'react';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import Icon from './Icon.jsx';

/**
 * What an empty area says: what is missing, why it matters, and the one action
 * that fills it. primary / secondary: { label, onClick, icon?, disabled? }.
 */
export default function EmptyState({ icon, title, description, primary, secondary, children, size = 'md', className, ...rest }) {
  useComponentCss(css);
  return (
    <div className={cx('sh-empty', size === 'sm' && 'sh-empty--sm', className)} {...rest}>
      {icon && <span className="sh-empty__icon" aria-hidden="true"><Icon name={icon} size={22} /></span>}
      <h2 className="sh-empty__title">{title}</h2>
      {description && <p className="sh-empty__description">{description}</p>}
      {children}
      {(primary || secondary) && <div className="sh-empty__actions">
        {primary && <Button variant="primary" icon={primary.icon} disabled={primary.disabled} busy={primary.busy} onClick={primary.onClick}>{primary.label}</Button>}
        {secondary && <Button variant="quiet" icon={secondary.icon} disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</Button>}
      </div>}
    </div>
  );
}
