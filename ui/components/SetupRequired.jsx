import React, { useId } from 'react';
import { ui } from '../i18n.js';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import Icon from './Icon.jsx';

/**
 * A calm gate shown INSTEAD of a feature that cannot work yet (no model, no
 * transcription key…), before the learner invests any effort. It says why,
 * lists the steps (external links open in a new tab) and offers the fix.
 * steps: [{ text, href?, hint? }]; primary / secondary: { label, onClick, icon? }; primary.variant (default primary) lets a page where another button leads keep this one calm.
 */
export default function SetupRequired({ title, why, steps = [], primary, secondary, tone = 'neutral', badge, icon = 'key',
  children, className, ...rest }) {
  useComponentCss(css);
  const id = useId();
  const kind = tone === 'warning' ? 'warning' : 'neutral';
  return (
    <section className={cx('sh-setup', `sh-setup--${kind}`, className)} aria-labelledby={id} {...rest}>
      <div className="sh-setup__layout">
        <span className="sh-setup__icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
        <div className="sh-setup__main">
          <p className="sh-setup__badge">{badge ?? ui('需要先配置')}</p>
          <h2 className="sh-setup__title" id={id}>{title}</h2>
          {why && <p className="sh-setup__why">{why}</p>}
          {steps.length > 0 && <ol className="sh-setup__steps">
            {steps.map((step, index) => (
              <li key={index}>
                <span className="sh-setup__num" aria-hidden="true">{index + 1}</span>
                <span className="sh-setup__step">
                  {step.href
                    ? <a href={step.href} target="_blank" rel="noreferrer">{step.text}<Icon name="external" size={14} />
                      <span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>
                    : step.text}
                  {step.hint && <span className="sh-setup__hint">{step.hint}</span>}
                </span>
              </li>
            ))}
          </ol>}
          {children}
          {(primary || secondary) && <div className="sh-setup__actions">
            {primary && <Button variant={primary.variant || 'primary'} icon={primary.icon} disabled={primary.disabled} busy={primary.busy} onClick={primary.onClick}>{primary.label}</Button>}
            {secondary && <Button variant="quiet" icon={secondary.icon} disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</Button>}
          </div>}
        </div>
      </div>
    </section>
  );
}
