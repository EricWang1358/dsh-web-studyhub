import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import { Button, IconButton } from './Button.jsx';
import Icon from './Icon.jsx';
import Tooltip from './Tooltip.jsx';
import { publishToasts, retractToasts, useToastChannels, useTopDialog } from './dialog-stack.js';

const TONES = new Set(['info', 'success', 'warning', 'error']);
const toneOf = tone => TONES.has(tone) ? tone : 'info';
/** Info and success toasts leave after this long unless hovered or focused. */
export const TOAST_TIMEOUT = 6000;

/**
 * Only messages nobody needs to act on or re-read may vanish on their own. An
 * undo offer (`undo: true`, with its action) may too: it lives for `timeout`,
 * and hovering or focusing it still holds it. So may a receipt (`receipt`, the
 * 「发给主会话」 outcome, ui/hand-off/): its one action is a convenience, and it
 * lives for its own `timeout` unless it is persistent.
 */
export function shouldAutoDismiss(toast = {}) {
  const tone = toneOf(toast.tone);
  if (toast.persistent || (tone !== 'info' && tone !== 'success')) return false;
  if (toast.receipt) return Number(toast.timeout) > 0;
  return !toast.action || !!toast.undo;
}

const dismissLabel = tone => tone === 'error' ? ui('关闭错误') : ui('关闭提示');

/**
 * One notification card. action: { label, onClick, disabled? }.
 * A receipt (`receipt`: the outcome of a 「发给主会话」) has a `seal` in place of the tone's icon, its action as a quiet button and, when it leaves by
 * itself, a countdown line (`timerRef`); `stamp` changes with every new receipt, so its seal and words are pressed again in place.
 * Prefer ToastRegion (or App's setNotice) over placing Toasts by hand.
 */
export function Toast({ tone, title, children, action, secondary, onDismiss, dismissText, receipt, seal, stamp, timerRef, className, ...rest }) {
  useComponentCss(css);
  const kind = toneOf(tone);
  return (
    <div className={cx('sh-toast', `sh-toast--${kind}`, receipt && 'sh-toast--receipt', className)} data-receipt={receipt || undefined} {...rest}>
      {receipt ? <React.Fragment key={`seal:${stamp ?? ''}`}>{seal}</React.Fragment> : <Icon name={kind} size={20} className="sh-toast__icon" />}
      <div className="sh-toast__text" key={receipt ? `text:${stamp ?? ''}` : undefined}>
        {title && <strong className="sh-toast__title">{title}</strong>}
        <span className="sh-toast__message">{children}</span>
      </div>
      {action && <Button variant={receipt ? 'quiet' : 'link'} size="sm" className="sh-toast__action" disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>}
      {secondary && <Button variant="link" size="sm" className="sh-toast__action sh-toast__secondary" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</Button>}
      {onDismiss && <IconButton icon="close" size="sm" className="sh-toast__close" label={dismissText || dismissLabel(kind)} onClick={onDismiss} />}
      {timerRef && <span ref={timerRef} className="sh-toast__timer" aria-hidden="true" />}
    </div>
  );
}

/* Whether the page is hidden (another tab, a minimised window): a receipt's time does not run out unseen. */
function usePageHidden() {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

/* A receipt's time: what is left of it runs while nothing holds it (the pointer, the keyboard focus, a hidden page) and goes on where it stopped; the
   countdown line is the same time drawn (a Web Animation, so a reduced-motion rule that shortens CSS animations cannot make it lie). A new `stamp`
   starts the whole time again. */
function useReceiptTime({ active, held, timeout, stamp, timerRef, onEnd }) {
  const left = useRef(timeout), run = useRef(null), drawn = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    if (run.current !== stamp) { run.current = stamp; left.current = timeout; drawn.current?.cancel(); drawn.current = null; }
    if (held) { drawn.current?.pause(); return undefined; }
    const started = Date.now(), timer = setTimeout(() => onEnd.current?.(), left.current);
    const line = timerRef.current;
    if (!drawn.current && line?.animate) drawn.current = line.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: timeout, easing: 'linear', fill: 'forwards' });
    drawn.current?.play();
    return () => { clearTimeout(timer); left.current = Math.max(0, left.current - (Date.now() - started)); drawn.current?.pause(); };
  }, [active, held, timeout, stamp, timerRef, onEnd]);
}

/* A toast in a region: owns its timer, which pauses while the pointer or the
   keyboard focus is on it. */
function ToastItem({ toast, onDismiss }) {
  const [held, setHeld] = useState(false);
  const hidden = usePageHidden();
  const dismiss = useRef(null), timerRef = useRef(null);
  dismiss.current = toast.dismiss || (() => onDismiss?.(toast.id));
  const auto = shouldAutoDismiss(toast);
  const receipt = !!toast.receipt;
  useEffect(() => {
    if (receipt || !auto || held) return;
    const timer = setTimeout(() => dismiss.current?.(), toast.timeout ?? TOAST_TIMEOUT);
    return () => clearTimeout(timer);
  }, [receipt, auto, held, toast.timeout]);
  useReceiptTime({ active: receipt && auto, held: held || hidden, timeout: Number(toast.timeout) || TOAST_TIMEOUT, stamp: toast.stamp, timerRef, onEnd: dismiss });
  return (
    <Toast tone={toast.tone} title={toast.title} action={toast.action} secondary={toast.secondary} dismissText={toast.dismissLabel}
      receipt={toast.receipt} seal={toast.seal} stamp={toast.stamp} timerRef={receipt && auto ? timerRef : undefined}
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
 * persistent?, undo?, timeout?, dismissLabel?, receipt?, seal?, stamp? }]; onDismiss(id).
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

/* An action button of a message, with its explanation on hover and focus when it has a `tip` (a layered Tooltip, never a title attribute). */
function withTip(tip, button) {
  return tip ? <Tooltip layer content={tip} anchorClassName="sh-feedback__tip">{button}</Tooltip> : button;
}

/**
 * A message placed right next to the control it is about (a field error, a
 * gate that failed). Errors are announced assertively. `boxed` gives it a
 * tinted background for multi-line content. Give it an `id` and point the
 * control's aria-describedby at it. action / secondary: { label, onClick, disabled?, tip? } (the same shape as Banner's).
 * actionsBelow: the actions go on a row of their own under the text (a list of files, a batch summary), so a narrow box never squeezes the text beside them.
 */
export function InlineMessage({ tone = 'error', title, children, action, secondary, onDismiss, dismissText, boxed = false, actionsBelow = false, className, ...rest }) {
  useComponentCss(css);
  const kind = toneOf(tone);
  const actions = <>
    {action && withTip(action.tip, <Button variant="link" size="sm" className="sh-inline__action" disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>)}
    {secondary && withTip(secondary.tip, <Button variant="link" size="sm" className="sh-inline__action sh-inline__secondary" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</Button>)}
  </>;
  const below = actionsBelow && (action || secondary);
  return (
    <div className={cx('sh-inline', `sh-inline--${kind}`, boxed && 'sh-inline--boxed', className)} role={kind === 'error' ? 'alert' : 'status'} {...rest}>
      <Icon name={kind} size={18} className="sh-inline__icon" />
      <div className="sh-inline__text">
        {title && <strong className="sh-inline__title">{title}</strong>}
        {children}
        {below && <div className="sh-inline__actions">{actions}</div>}
      </div>
      {!below && actions}
      {onDismiss && <IconButton icon="close" size="sm" className="sh-inline__close" label={dismissText || dismissLabel(kind)} onClick={onDismiss} />}
    </div>
  );
}

/**
 * A page- or section-level message that stays until its cause is fixed (no
 * model configured, library read-only…). action / secondary: { label, onClick, disabled?, tip? } (tip: a layered Tooltip on hover and focus).
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
          {action && withTip(action.tip, <Button size="sm" variant={action.variant || 'secondary'} icon={action.icon} disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>)}
          {secondary && withTip(secondary.tip, <Button size="sm" variant="quiet" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</Button>)}
        </div>}
        {onDismiss && <IconButton icon="close" size="sm" className="sh-banner__close" label={dismissLabel(kind)} onClick={onDismiss} />}
      </div>
    </div>
  );
}

/* ── The toast context ──────────────────────────────────────────────────────
   One feedback region per app (App renders it), reached from any page without passing a setter down:
     const toast = useToast();
     toast.success('已保存'); toast.error(error, { retry }); toast.show({ tone, message, action, undo, timeout });
   The api is built by createToastApi over the app's notice and error slots; without a provider useToast is silent. */
export const ToastContext = createContext(null);

const silentToast = Object.freeze({ show() {}, success() {}, info() {}, warning() {}, error() {}, dismiss() {} });

/** The toast api of the nearest ToastContext.Provider (a silent one when there is none). */
export const useToast = () => useContext(ToastContext) || silentToast;

const failureText = error => {
  const raw = typeof error === 'string' ? error : error?.message;
  return raw ? String(raw) : ui('这次没有成功，也没有拿到具体原因。可以再试一次。');
};

/**
 * The api over the app's two feedback slots. show({ tone, message, action: { label, onClick }, secondary, persistent, undo, timeout, scope, onLeave })
 * fills the notice slot (a newer one replaces it); error(error, { retry }) fills the error slot; dismiss() clears the notice.
 * An undo offer (`undo: true`) leaves after `timeout` but is held while hovered or focused (see shouldAutoDismiss). `secondary`: a second quiet action
 * (永久删除… after an archive). `onLeave()` is called once when the notice leaves for any reason (time, close, a newer notice, another page): ui/undoable.js commits then.
 */
export function createToastApi({ setNotice, setError }) {
  const show = ({ tone = 'info', message, action, secondary, persistent, undo, timeout, scope, onLeave }) => setNotice({
    text: message, tone,
    ...(persistent ? { persistent } : {}), ...(undo ? { undo } : {}), ...(timeout ? { timeout } : {}), ...(scope !== undefined ? { scope } : {}),
    ...(action ? { action: { label: action.label, run: action.run ?? action.onClick } } : {}),
    ...(secondary ? { secondary: { label: secondary.label, run: secondary.run ?? secondary.onClick } } : {}),
    ...(onLeave ? { onLeave } : {}),
  });
  const withTone = kind => (message, options = {}) => show({ tone: kind, message, ...options });
  return {
    show,
    success: withTone('success'), info: withTone('info'), warning: withTone('warning'),
    error: (error, { retry } = {}) => setError({ text: failureText(error), ...(retry ? { action: { label: ui('重试'), run: retry } } : {}) }),
    dismiss: () => setNotice(''),
  };
}
