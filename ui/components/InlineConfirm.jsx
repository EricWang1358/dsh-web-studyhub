import React, { useEffect, useId, useRef } from 'react';
import { ui } from '../i18n.js';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import Icon from './Icon.jsx';

// tone → box tint, icon, confirm button: danger asks about losing something, warning about a change with consequences, primary about a plain choice.
const TONES = { danger: { box: 'error', icon: 'warning', button: 'danger' }, warning: { box: 'warning', icon: 'warning', button: 'primary' },
  primary: { box: 'info', icon: 'info', button: 'primary' } };

/**
 * "Are you sure?" inside a form, for a reversible edit (see DESIGN.md,
 * Confirmations). One boxed question with the same button order as
 * ConfirmDialog: cancel (quiet) first, confirm last. It takes focus on mount
 * (the trigger that opened it usually disappears) and, on cancel or Escape,
 * hands focus back to `returnFocusRef`. It is a labelled group, not a dialog:
 * the rest of the form stays usable.
 * tone: 'danger' (default) | 'warning' | 'primary'. `busy` locks it while onConfirm runs.
 */
export default function InlineConfirm({ tone = 'danger', title, children, confirmLabel, cancelLabel, busy = false, returnFocusRef,
  onConfirm, onCancel, className, ...rest }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  const cancel = useRef(null), titleId = useId();
  const look = TONES[tone] || TONES.danger;
  // A passive effect: inside a Dialog that opens in the same commit, the dialog is open by now and can take focus.
  useEffect(() => { cancel.current?.focus(); }, []);
  const back = () => {
    if (busy) return;
    onCancel?.();
    // The trigger may only come back after this renders.
    if (returnFocusRef) requestAnimationFrame(() => { const target = returnFocusRef.current; if (target?.isConnected) target.focus?.({ preventScroll: true }); });
  };
  return (
    <div role="group" aria-labelledby={titleId} aria-busy={busy || undefined}
      className={cx('sh-inline', 'sh-inline--boxed', `sh-inline--${look.box}`, 'sh-confirm', className)}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); } }} {...rest}>
      <div className="sh-confirm__row">
        <Icon name={look.icon} size={18} className="sh-inline__icon" />
        <div className="sh-inline__text">
          <strong id={titleId} className="sh-inline__title">{title}</strong>
          {children && <div className="sh-confirm__body">{children}</div>}
        </div>
      </div>
      <div className="sh-confirm__actions">
        <Button ref={cancel} variant="quiet" size="sm" disabled={busy} onClick={back}>{cancelLabel || ui('取消')}</Button>
        <Button variant={look.button} size="sm" busy={busy} onClick={() => onConfirm?.()}>{confirmLabel}</Button>
      </div>
    </div>
  );
}
