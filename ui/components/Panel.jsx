import React from 'react';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

/** A flat desk surface with an optional heading row and actions. */
export function Panel({ title, description, actions, children, as: Tag = 'section', className, ...rest }) {
  useComponentCss(css);
  return (
    <Tag className={cx('sh-panel', className)} {...rest}>
      {(title || description || actions) && <div className="sh-panel__head">
        <div className="sh-panel__heading">
          {title && <h3 className="sh-panel__title">{title}</h3>}
          {description && <p className="sh-panel__description">{description}</p>}
        </div>
        {actions && <div className="sh-panel__actions">{actions}</div>}
      </div>}
      {children}
    </Tag>
  );
}

/**
 * Progressive disclosure for advanced or rarely used settings. Uncontrolled by
 * default (`defaultOpen`); pass `open` + `onToggle(open)` to control it.
 */
export function Disclosure({ summary, meta, defaultOpen = false, open, onToggle, children, className, ...rest }) {
  useComponentCss(css);
  return (
    <details className={cx('sh-disclosure', className)} open={open ?? defaultOpen}
      onToggle={onToggle ? event => onToggle(event.currentTarget.open) : undefined} {...rest}>
      <summary className="sh-disclosure__summary">
        <Icon name="chevron" size={16} className="sh-disclosure__chevron" />
        <span className="sh-disclosure__label">{summary}</span>
        {meta && <span className="sh-disclosure__meta">{meta}</span>}
      </summary>
      <div className="sh-disclosure__body">{children}</div>
    </details>
  );
}
