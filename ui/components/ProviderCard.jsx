import React from 'react';
import { ui } from '../i18n.js';
import baseCss from './components.css';
import css from './fields.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

/* The card of one service that needs a key (a transcription provider, MinerU, Jev): its name and badges, whether a key is saved,
   the numbered steps to get one, and the form. Named for what it is, not for the first feature that needed it. */

/** Numbered steps; a step with `href` is a link that opens in a new tab and says so to a screen reader. */
export function StepList({ steps = [], className, ...rest }) {
  useComponentCss(baseCss);
  useComponentCss(css, 'study-fields');
  return (
    <ol className={cx('sh-steps', className)} {...rest}>
      {steps.map((step, index) => <li key={index}>
        <span className="sh-steps__num" aria-hidden="true">{index + 1}</span>
        {step.href
          ? <a href={step.href} target="_blank" rel="noreferrer">{step.text}<span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>
          : <span>{step.text}</span>}
      </li>)}
    </ol>
  );
}

/**
 * title + badges (the head), `status` (the saved-state line: `set` marks it done), `steps`, then the form as children. layout:
 * 'rows' (default) lines the same parts up across the cards of a ProviderGrid; 'stack' is a plain column for a card with more or
 * fewer parts.
 */
export function ProviderCard({ title, badges, status, set = false, steps, layout = 'rows', className, children, ...rest }) {
  useComponentCss(css, 'study-fields');
  return (
    <article className={cx('sh-provider', set && 'is-set', layout === 'stack' && 'sh-provider--stack', className)} {...rest}>
      <header className="sh-provider__head">
        <h3 className="sh-provider__title">{title}</h3>
        {badges && <span className="sh-provider__badges">{badges}</span>}
      </header>
      {status && <p className={cx('sh-provider__status', set && 'is-set')}><Icon name={set ? 'success' : 'key'} size={16} />{status}</p>}
      {steps?.length > 0 && <StepList steps={steps} />}
      {children}
    </article>
  );
}

/** The grid the cards sit in. columns: 'auto' (as many as fit) or 2 (two once the section is wide enough). */
export function ProviderGrid({ columns = 'auto', className, children, ...rest }) {
  useComponentCss(css, 'study-fields');
  return <div className={cx('sh-provider-grid', className)} {...rest}><div className={cx('sh-provider-grid__items', columns === 2 && 'sh-provider-grid__items--two')}>{children}</div></div>;
}
