import React from 'react';
import css from './components.css';
import scopeCss from './page-header.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';

/**
 * The one page header: optional back link, eyebrow, the page's only <h1>, a
 * short description, the page's scope picker (`scope`, e.g. <PageScope>) and
 * the page actions (put at most one primary there). titleProps go on the <h1>
 * (tabIndex={-1} / data-context-heading for pages the navigation focuses).
 * `compact` is the one-line title of a working surface (a practice session).
 * Extra props (data-tour, id…) land on the <header>.
 */
export default function PageHeader({ eyebrow, title, description, actions, scope, back, titleProps, compact = false, children, className, ...rest }) {
  useComponentCss(css);
  useComponentCss(scopeCss, 'study-page-header');
  return (
    <header className={cx('sh-page-header', compact && 'sh-page-header--compact', className)} {...rest}>
      <div className="sh-page-header__text">
        {back && <Button variant="link" size="sm" icon="arrow-left" className="sh-page-header__back" onClick={back.onClick}>{back.label}</Button>}
        {eyebrow && <p className="sh-page-header__eyebrow">{eyebrow}</p>}
        <h1 {...titleProps} className={cx('sh-page-header__title', titleProps?.className)}>{title}</h1>
        {description && <p className="sh-page-header__description">{description}</p>}
        {scope && <div className="sh-page-header__scope">{scope}</div>}
        {children}
      </div>
      {actions && <div className="sh-page-header__actions">{actions}</div>}
    </header>
  );
}
