import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import { Button, IconButton } from './Button.jsx';
import Icon from './Icon.jsx';
import { publishToasts, retractToasts, useToastChannels, useTopDialog } from './dialog-stack.js';

const TONES = new Set(['info', 'success', 'warning', 'error']);
const toneOf = tone => TONES.has(tone) ? tone : 'info';
/** Info and success toasts leave after this long unless hovered or focused. */
export const TOAST_TIMEOUT = 6000;

/**
 * Only messages nobody needs to act on or re-read may vanish on their own. An
 * undo offer (`undo: true`, with its action) is the one action toast that may:
 * it lives for `timeout`, and hovering or focusing it still holds it.
 */
export function shouldAutoDismiss(toast = {}) {
  const tone = toneOf(toast.tone);
  if (toast.persistent || (tone !== 'info' && tone !== 'success')) return false;
  return !toast.action || !!toast.undo;
}

const dismissLabel = tone => tone === 'error' ? ui('关闭错误') : ui('关闭提示');

/**
 * One notification card. action: { label, onClick, disabled? }.
 * Prefer ToastRegion (or App's setNotice) over placing Toasts by hand.
 */
export function Toast({ tone, title, children, action, onDismiss, dismissText, className, ...rest }) {
  useComponentCss(css);
  const kind = toneOf(tone);
  return (
    <div className={cx('sh-toast', `sh-toast--${kind}`, className)} {...rest}>
      <Icon name={kind} size={20} className="sh-toast__icon" />
      <div className="sh-toast__text">
        {title && <strong className="sh-toast__title">{title}</strong>}
        <span className="sh-toast__message">{children}</span>
      </div>
      {action && <Button variant="link" size="sm" className="sh-toast__action" disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>}
      {onDismiss && <IconButton icon="close" size="sm" className="sh-toast__close" label={dismissText || dismissLabel(kind)} onClick={onDismiss} />}
    </div>
  );
}

/* A toast in a region: owns its timer, which pauses while the pointer or the
   keyboard focus is on it. */
function ToastItem({ toast, onDismiss }) {
  const [held, setHeld] = useState(false);
  const dismiss = useRef(null);
  dismiss.current = toast.dismiss || (() => onDismiss?.(toast.id));
  const auto = shouldAutoDismiss(toast);
  useEffect(() => {
    if (!auto || held) return;
    const timer = setTimeout(() => dismiss.current?.(), toast.timeout ?? TOAST_TIMEOUT);
    return () => clearTimeout(timer);
  }, [auto, held, toast.timeout]);
  return (
    <Toast tone={toast.tone} title={toast.title} action={toast.action} dismissText={toast.dismissLabel}
      onDismiss={toast.dismissible === false ? undefined : () => dismiss.current?.()}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      {toast.message}
    </Toast>
  );
}

function ToastStacks({ toasts, onDismiss }) {
  const polite = toasts.filter(toast => toneOf(toast.tone) !== 'error');
  const urgent = toasts.filter(toast => toneOf(toast.tone) === 'error');
  const item = toast => <ToastItem key={toast.key ?? toast.id} toast={toast} onDismiss={onDismiss} />;
  return (
    <div className="sh-toasts__inner">
      <div role="status" aria-live="polite" className="sh-toasts__stack">{polite.map(item)}</div>
      <div role="alert" aria-live="assertive" className="sh-toasts__stack">{urgent.map(item)}</div>
    </div>
  );
}

/**
 * Live region for toasts. toasts: [{ id, key?, tone, title?, message, action?,
 * persistent?, undo?, timeout?, dismissLabel? }]; onDismiss(id).
 * placement: 'page' (sticky under the top bar of the visible Study viewport —
 * render it as a direct child of <main>), 'inline' (in flow, next to the
 * control) or 'auto' (inline inside .action-feedback-slot, page elsewhere).
 * While a dialog other than the one containing this region is open, the toasts
 * are shown inside that dialog instead, because a modal makes the page inert.
 */
export function ToastRegion({ toasts = [], onDismiss, placement = 'page', className }) {
  useComponentCss(css);
  const ref = useRef(null), channel = useId();
  const top = useTopDialog();
  const [home, setHome] = useState(undefined);
  useLayoutEffect(() => { setHome(ref.current?.closest('dialog') || null); }, []);
  const routed = !!top?.dialog && home !== undefined && top.dialog !== home;
  useLayoutEffect(() => {
    if (routed && toasts.length) publishToasts(channel, { toasts, onDismiss, anchor: ref.current });
    else retractToasts(channel);
  });
  useEffect(() => () => retractToasts(channel), [channel]);
  return (
    <div ref={ref} className={cx('sh-toasts', `sh-toasts--${placement}`, routed && 'is-routed', className)}>
      <ToastStacks toasts={routed ? [] : toasts} onDismiss={onDismiss} />
    </div>
  );
}

const sameStudy = (anchor, dialog) => {
  const a = anchor?.closest?.('.study-app'), b = dialog?.closest?.('.study-app');
  return !a || !b || a === b;
};

/** Rendered by the topmost Dialog: the toasts of regions it covers. */
export function DialogToasts({ dialog }) {
  const channels = useToastChannels();
  const toasts = channels.filter(entry => sameStudy(entry.anchor, dialog)).flatMap(entry => entry.toasts.map(toast => ({
    ...toast, key: `${entry.id}:${toast.key ?? toast.id}`, dismiss: () => entry.onDismiss?.(toast.id),
  })));
  return <div className="sh-toasts sh-toasts--dialog"><ToastStacks toasts={toasts} /></div>;
}

/**
 * A message placed right next to the control it is about (a field error, a
 * gate that failed). Errors are announced assertively. `boxed` gives it a
 * tinted background for multi-line content. Give it an `id` and point the
 * control's aria-describedby at it.
 */
export function InlineMessage({ tone = 'error', title, children, action, onDismiss, boxed = false, className, ...rest }) {
  useComponentCss(css);
  const kind = toneOf(tone);
  return (
    <div className={cx('sh-inline', `sh-inline--${kind}`, boxed && 'sh-inline--boxed', className)} role={kind === 'error' ? 'alert' : 'status'} {...rest}>
      <Icon name={kind} size={18} className="sh-inline__icon" />
      <div className="sh-inline__text">
        {title && <strong className="sh-inline__title">{title}</strong>}
        {children}
      </div>
      {action && <Button variant="link" size="sm" className="sh-inline__action" disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>}
      {onDismiss && <IconButton icon="close" size="sm" className="sh-inline__close" label={dismissLabel(kind)} onClick={onDismiss} />}
    </div>
  );
}

/**
 * A page- or section-level message that stays until its cause is fixed (no
 * model configured, library read-only…). action / secondary: { label, onClick }.
 */
export function Banner({ tone = 'info', title, children, action, secondary, onDismiss, icon, className, ...rest }) {
  useComponentCss(css);
  const kind = toneOf(tone);
  return (
    <div className={cx('sh-banner', `sh-banner--${kind}`, className)} role={kind === 'error' ? 'alert' : undefined} {...rest}>
      <div className="sh-banner__row">
        <Icon name={icon || kind} size={20} className="sh-banner__icon" />
        <div className="sh-banner__text">
          {title && <p className="sh-banner__title">{title}</p>}
          {children && <div className="sh-banner__body">{children}</div>}
        </div>
        {(action || secondary) && <div className="sh-banner__actions">
          {action && <Button size="sm" variant={action.variant || 'secondary'} icon={action.icon} disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>}
          {secondary && <Button size="sm" variant="quiet" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</Button>}
        </div>}
        {onDismiss && <IconButton icon="close" size="sm" className="sh-banner__close" label={dismissLabel(kind)} onClick={onDismiss} />}
      </div>
    </div>
  );
}
