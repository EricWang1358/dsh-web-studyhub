import React, { useState } from 'react';
import css from './components.css';
import toneCss from './panel-tones.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

export const PANEL_TONES = Object.freeze(['plain', 'sunken', 'accent', 'dashed', 'paper']);

/**
 * A flat desk surface with an optional heading row and actions.
 * tone: plain (default) | sunken (a recessed well) | accent (the one highlighted block) | dashed (an optional or
 * empty area) | paper (the physical card: renders `.sh-paper-card`, the one card look of ui/paper.css). density: normal | compact.
 * `as` swaps the element (section, article, li, div…).
 */
export function Panel({ title, description, actions, children, tone = 'plain', density = 'normal', as: Tag = 'section', className, ...rest }) {
  useComponentCss(css);
  useComponentCss(toneCss, 'study-panel-tones');
  return (
    <Tag className={cx('sh-panel', tone === 'paper' ? 'sh-paper-card' : tone !== 'plain' && PANEL_TONES.includes(tone) && `sh-panel--${tone}`, density === 'compact' && 'sh-panel--compact', className)} {...rest}>
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
 * `lazy`: the body is drawn the first time the fold opens and kept from then on. A shut <details> still holds its whole
 * body in the page, so a heavy one (a list of materials) cost every visit to the page it sits on (#565).
 */
export function Disclosure({ summary, meta, defaultOpen = false, open, onToggle, lazy = false, children, className, ...rest }) {
  useComponentCss(css);
  const shown = open ?? defaultOpen;
  const [opened, setOpened] = useState(shown);
  const drawn = !lazy || opened || shown;
  const toggle = onToggle || lazy ? event => {
    const now = event.currentTarget.open;
    if (lazy && now && !opened) setOpened(true);
    onToggle?.(now);
  } : undefined;
  return (
    <details className={cx('sh-disclosure', className)} open={shown} onToggle={toggle} {...rest}>
      <summary className="sh-disclosure__summary">
        <Icon name="chevron" size={16} className="sh-disclosure__chevron" />
        <span className="sh-disclosure__label">{summary}</span>
        {meta && <span className="sh-disclosure__meta">{meta}</span>}
      </summary>
      <div className="sh-disclosure__body">{drawn ? children : null}</div>
    </details>
  );
}
