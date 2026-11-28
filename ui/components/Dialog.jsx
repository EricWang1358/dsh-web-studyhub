import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';
import { DialogToasts } from './Feedback.jsx';
import { guardFileDrag } from './FileDrop.jsx';
import mediaCss from './dialog-media.css';
import { pushDialog, useTopDialog } from './dialog-stack.js';
import { appearanceAttrs, appearanceStyle, loadAppearance } from '../appearance-prefs.js';

const SIZES = new Set(['sm', 'md', 'lg', 'media', 'full']);

/** True when the dialog sits outside every study surface (the host's own page, DSH's preview slot): then it has no tokens to inherit. */
export const needsOwnScope = (dialog) => !dialog?.parentElement?.closest?.('.study-app, .study-seat');

/** What such a dialog wears to be a study surface of its own: the saved appearance as the app root would stamp it. */
export function ownScope() {
  const prefs = loadAppearance();
  return { attrs: appearanceAttrs(prefs), style: appearanceStyle(prefs) };
}

/** What Escape does: close, nothing (non-dismissible) or wait for the browser's close event. */
export function cancelDecision({ cancelable, dismissible }) {
  if (!dismissible) return 'block';
  return cancelable ? 'close' : 'defer';
}

/** Whether unmounting a Dialog should return focus to its opener (boolean, ref, or predicate; defaults to true). */
export function shouldRestoreDialogFocus(restoreFocus) {
  if (typeof restoreFocus === 'function') return Boolean(restoreFocus());
  if (restoreFocus && typeof restoreFocus === 'object' && 'current' in restoreFocus) return Boolean(restoreFocus.current);
  return restoreFocus !== false;
}

/** A click closes from the backdrop only if it also started there (not a text selection dragged out or a click inside the sheet box). */
export function isBackdropClick(event, dialog, downTarget) {
  if (event.target !== dialog || downTarget !== dialog) return false;
  if (typeof dialog?.getBoundingClientRect === 'function' && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0)) {
    const rect = dialog.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom) return false;
  }
  return true;
}

const scrollLocks = new WeakMap();
function lockScroll(dialog) {
  const app = dialog?.parentElement?.closest?.('.study-app');
  if (!app) return () => {};
  const next = (scrollLocks.get(app) || 0) + 1;
  scrollLocks.set(app, next);
  if (next === 1) app.setAttribute('data-scroll-locked', 'true');
  return () => {
    const left = (scrollLocks.get(app) || 1) - 1;
    if (left <= 0) {
      scrollLocks.delete(app);
      app.removeAttribute('data-scroll-locked');
    } else {
      scrollLocks.set(app, left);
    }
  };
}

/**
 * Every modal in StudyHub. A native <dialog> opened with showModal(): it sits
 * in the browser's top layer (above the DSH composer and any z-index), makes
 * the rest of the page inert, closes on Escape / the close button / a backdrop
 * click, and returns focus to whatever opened it. Mount it to open it and
 * unmount it to close it; onClose(reason) asks the owner to unmount it.
 * size: sm | md | lg | media (fits an image, below 70dvh) | full. `footer` stays visible while the body scrolls.
 * Outside every study surface it carries its own scope (the .study-app class and the saved appearance), so it is styled wherever it opens.
 * `busy` (work is running) implies non-dismissible: the close button stays but
 * is marked aria-disabled, Escape and the backdrop do nothing, and the dialog
 * is aria-busy. `guardDrops` keeps a stray file drop on the dialog (its header
 * or margins) away from the browser and the host chat.
 */
export default function Dialog({ title, description, onClose, size = 'md', footer, children, dismissible = true, initialFocus, restoreFocus = true,
  bodyLabel, closeLabel, busy = false, guardDrops = false, className, headerClassName, titleClassName, bodyClassName, contentClassName, footerClassName, open: _open, ...rest }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  useComponentCss(mediaCss, 'study-dialog-media');
  const [own, setOwn] = useState(null);
  const [scrollable, setScrollable] = useState(false);
  const ref = useRef(null), bodyRef = useRef(null), pointerDown = useRef(null), closing = useRef(false), onCloseRef = useRef(onClose), restoreFocusRef = useRef(restoreFocus);
  const canDismiss = dismissible && !busy;
  const [entry] = useState(() => ({ dialog: null }));
  const top = useTopDialog();
  const titleId = useId(), descriptionId = useId();
  const kind = SIZES.has(size) ? size : 'md';
  useLayoutEffect(() => { onCloseRef.current = onClose; restoreFocusRef.current = restoreFocus; });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const sync = () => setScrollable(body.scrollHeight > body.clientHeight + 1);
    sync();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(sync);
    observer.observe(body);
    if (body.firstElementChild) observer.observe(body.firstElementChild);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    closing.current = false;
    entry.dialog = dialog;
    if (needsOwnScope(dialog)) setOwn(ownScope());
    if (dialog.open && typeof dialog.matches === 'function' && !dialog.matches(':modal')) {
      try { dialog.close(); } catch { dialog.removeAttribute('open'); }
    }
    if (!dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    }
    initialFocus?.current?.focus?.();
    const remove = pushDialog(entry);
    const unlockScroll = lockScroll(dialog);
    return () => {
      closing.current = true;
      unlockScroll();
      remove();
      if (dialog.open) {
        try { dialog.close(); } catch { dialog.removeAttribute('open'); }
      }
      const active = document.activeElement;
      if (shouldRestoreDialogFocus(restoreFocusRef.current)
        && opener?.isConnected
        && typeof opener.focus === 'function'
        && (!active || active === document.body || dialog.contains(active)))
        opener.focus({ preventScroll: true });
    };
    // Opening is tied to mounting; the owner unmounts the dialog to close it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => (guardDrops && ref.current ? guardFileDrag(ref.current) : undefined), [guardDrops]);
  const requestClose = reason => { if (!closing.current && canDismiss) onCloseRef.current?.(reason); };
  return (
    <dialog ref={ref} className={cx('sh-dialog', `sh-dialog--${kind}`, own && 'study-app', className)} style={own?.style} {...own?.attrs} role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy || undefined}
      onCancel={event => {
        const decision = cancelDecision({ cancelable: event.cancelable, dismissible: canDismiss });
        if (decision !== 'defer') event.preventDefault();
        if (decision === 'close') requestClose('escape');
      }}
      onClose={() => {
        // The browser closed it without asking (a forced Escape). Tell the
        // owner, and reopen if the owner keeps it mounted.
        if (closing.current) return;
        if (canDismiss) requestClose('escape');
        requestAnimationFrame(() => { const dialog = ref.current; if (!closing.current && dialog?.isConnected && !dialog.open) dialog.showModal(); });
      }}
      onPointerDown={event => { pointerDown.current = event.target; }}
      onClick={event => { if (canDismiss && isBackdropClick(event, ref.current, pointerDown.current)) requestClose('backdrop'); }}
      {...rest}>
      <header className={cx('sh-dialog__header', headerClassName)}>
        <div className="sh-dialog__heading">
          <h2 id={titleId} className={cx('sh-dialog__title', titleClassName)} title={typeof title === 'string' ? title : undefined}>{title}</h2>
          {description && <p id={descriptionId} className="sh-dialog__description">{description}</p>}
        </div>
        {dismissible && <IconButton icon="close" className="sh-dialog__close" label={closeLabel || ui('关闭')} aria-disabled={busy || undefined}
          onClick={() => requestClose('button')} />}
      </header>
      <div ref={bodyRef} className={cx('sh-dialog__body', bodyClassName)} tabIndex={scrollable ? 0 : undefined} role="region" aria-label={bodyLabel || (typeof title === 'string' ? title : undefined)}>
        <div className={cx('sh-dialog__content', contentClassName)}>{children}</div>
      </div>
      <div className="sh-dialog__toasts">{top === entry && entry.dialog && <DialogToasts dialog={entry.dialog} />}</div>
      {footer && <footer className={cx('sh-dialog__footer', footerClassName)}>{footer}</footer>}
    </dialog>
  );
}
