import React from 'react';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';

/**
 * The one page header: optional back link, eyebrow, the page's only <h1>, a
 * short description and the page actions (put at most one primary there).
 * Extra props (data-tour, id…) land on the <header>.
 */
export default function PageHeader({ eyebrow, title, description, actions, back, children, className, ...rest }) {
  useComponentCss(css);
  return (
    <header className={cx('sh-page-header', className)} {...rest}>
      <div className="sh-page-header__text">
        {back && <Button variant="link" size="sm" icon="arrow-left" className="sh-page-header__back" onClick={back.onClick}>{back.label}</Button>}
        {eyebrow && <p className="sh-page-header__eyebrow">{eyebrow}</p>}
        <h1 className="sh-page-header__title">{title}</h1>
        {description && <p className="sh-page-header__description">{description}</p>}
        {children}
      </div>
      {actions && <div className="sh-page-header__actions">{actions}</div>}
    </header>
  );
}
